#!/usr/bin/env tsx
import { writeFileSync } from "node:fs"
import { arch, cpus, platform } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import type { Model } from "@earendil-works/pi-ai"
import { routeQuery } from "../../src/extensions/router/router-client.js"
import type { RouterConfig } from "../../src/extensions/router/router-config.js"
import { ROUTER_IMAGE_METADATA } from "../../src/extensions/router/router-query.js"
import { queryLaya } from "../../src/extensions/router-laya/laya-client.js"
import { buildLayaRoutingQuestions } from "../../src/extensions/router-laya/laya-questions.js"
import { ensureLayaServer, resolveLayaApiKey } from "../../src/extensions/router-laya/laya-serve.js"
import { BENCHMARK_CANDIDATES, type BenchmarkCandidate, loadSuite, type SuiteEntry } from "./suite.js"

/**
 * Offline routing benchmark runner.
 *
 * For every suite entry it asks the laya sidecar (phase-1 client, same choice
 * question the production extension builds) and the existing LLM router for a
 * model pick, then reports pick agreement, per-category expected-model
 * accuracy, p50/p95 latency, and the LLM routing cost versus $0 local laya.
 *
 * Modes:
 *   (default)        real laya sidecar + real LLM router
 *   --laya-only      only the laya side
 *   --llm-only       only the LLM router side
 *   --mock-routers   deterministic fakes; CI-safe end-to-end proof of the
 *                    pipeline, answers no question about real routing quality.
 */

const HERE = dirname(fileURLToPath(import.meta.url))

/** Estimated input tokens for one LLM routing call: prompt ~chars/4 plus routing instructions. */
const LLM_OVERHEAD_TOKENS = 600
const LLM_OUTPUT_TOKENS = 80

// ---------------------------------------------------------------------------
// CLI args

export interface BenchArgs {
	mock: boolean
	layaOnly: boolean
	llmOnly: boolean
	suitePath: string
	outJson: string
	outMd: string
	help: boolean
}

const USAGE = `Usage: pnpm bench:routing [--mock-routers] [--laya-only | --llm-only]
                          [--suite PATH] [--out-json PATH] [--out-md PATH]`

export function parseBenchArgs(argv: readonly string[]): BenchArgs {
	const args: BenchArgs = {
		mock: false,
		layaOnly: false,
		llmOnly: false,
		suitePath: join(HERE, "suite.jsonl"),
		outJson: join(HERE, "results.json"),
		outMd: join(HERE, "results.md"),
		help: false,
	}
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]
		if (arg === "--") continue // pnpm forwards a literal separator: `pnpm bench:routing -- --mock-routers`
		const takeValue = () => {
			const value = argv[++i]
			if (value === undefined) throw new Error(`${arg} requires a value`)
			return value
		}
		switch (arg) {
			case "--mock-routers":
				args.mock = true
				break
			case "--laya-only":
				args.layaOnly = true
				break
			case "--llm-only":
				args.llmOnly = true
				break
			case "--suite":
				args.suitePath = takeValue()
				break
			case "--out-json":
				args.outJson = takeValue()
				break
			case "--out-md":
				args.outMd = takeValue()
				break
			case "--help":
			case "-h":
				args.help = true
				break
			default:
				throw new Error(`unknown flag: ${arg}\n${USAGE}`)
		}
	}
	if (args.layaOnly && args.llmOnly) throw new Error(`--laya-only and --llm-only are mutually exclusive\n${USAGE}`)
	return args
}

// ---------------------------------------------------------------------------
// Archetype mapping: whatever a router returns must land on the benchmark
// roster so picks compare against curated labels. Live catalog ids are
// translated by an explicit alias table; unmatched ids are reported as
// "unmapped" (never silently coerced).

const ARCHETYPE_ALIASES: ReadonlyArray<readonly [RegExp, string]> = [
	[/vl|vision/i, "kimi-vl-vision"],
	[/k1\.6|reason|deepseek-r1|\bo1\b|\bo3\b/i, "kimi-k1.6-reason"],
	[/k2\.6|code|coder|sonnet/i, "kimi-k2.6-code"],
	[/k2\.5|lite|fast|mini|haiku/i, "kimi-k2.5-fast"],
	[/k3|flagship|pro/i, "kimi-k3-flagship"],
]

export function toArchetype(modelId: string): string | undefined {
	const rosterIds = new Set(BENCHMARK_CANDIDATES.map((c) => c.id))
	if (rosterIds.has(modelId)) return modelId
	for (const [pattern, archetype] of ARCHETYPE_ALIASES) {
		if (pattern.test(modelId)) return archetype
	}
	return undefined
}

// ---------------------------------------------------------------------------
// Router abstraction

export interface RouterPick {
	/** Raw model id returned by the router. */
	model: string
	/** Archetype id after toArchetype(); undefined when unmapped. */
	archetype?: string
	latencyMs: number
	confidence?: number
	answerConfidence?: number
	/** Checkpoint that produced the pick (laya routing.repo), when reported. */
	checkpoint?: string
	probabilities?: Record<string, number>
	error?: string
}

export interface BenchRouter {
	readonly name: "laya" | "llm"
	prepare?(): Promise<string | undefined>
	call(entry: SuiteEntry): Promise<RouterPick>
}

function rosterModel(candidate: BenchmarkCandidate): Model<string> {
	const archetypeMetadata: Record<string, { reasoning: boolean; maxTokens: number }> = {
		"kimi-k3-flagship": { reasoning: true, maxTokens: 64000 },
		"kimi-k2.6-code": { reasoning: false, maxTokens: 32000 },
		"kimi-k2.5-fast": { reasoning: false, maxTokens: 16000 },
		"kimi-k1.6-reason": { reasoning: true, maxTokens: 64000 },
		"kimi-vl-vision": { reasoning: false, maxTokens: 32000 },
	}
	const meta = archetypeMetadata[candidate.id]
	return {
		id: candidate.id,
		name: candidate.id,
		api: "openai-completions",
		provider: "benchmark",
		baseUrl: "https://benchmark.invalid",
		reasoning: meta.reasoning,
		input: candidate.vision ? ["text", "image"] : ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: candidate.contextWindow,
		maxTokens: meta.maxTokens,
	}
}

// ---------------------------------------------------------------------------
// Real routers

function realLayaRouter(): BenchRouter {
	return {
		name: "laya",
		async prepare() {
			const started = Date.now()
			const server = await ensureLayaServer()
			if (!server.ok) {
				throw new Error(
					`laya sidecar unavailable (${server.reason}): ${server.detail}\ninstall with: pip install 'laya[serve]'`,
				)
			}
			return `laya-serve ${server.reused ? "reused" : "spawned"} at ${server.baseUrl} in ${Date.now() - started}ms`
		},
		async call(entry) {
			const built = buildLayaRoutingQuestions(new Map(BENCHMARK_CANDIDATES.map((c) => [c.id, rosterModel(c)])), {
				requiresVision: entry.vision,
			})
			if (!built.ok) throw new Error(`cannot build laya question: ${built.reason}`)
			const started = Date.now()
			const result = await queryLaya(
				entry.prompt,
				built.questions,
				{
					endpoint: process.env.KIMCHI_LAYA_ENDPOINT?.trim() || "http://127.0.0.1:8000",
					apiKey: resolveLayaApiKey(),
				},
				{},
			)
			if (!result.ok) return { model: "", latencyMs: Date.now() - started, error: result.reason }
			const answer = result.decision.answers[built.choiceId]
			if (answer.kind !== "choice") return { model: "", latencyMs: result.decision.latencyMs, error: "not_a_choice" }
			return {
				model: answer.choice,
				archetype: toArchetype(answer.choice),
				latencyMs: result.decision.latencyMs,
				confidence: answer.confidence,
				answerConfidence: answer.answerConfidence,
				checkpoint: result.decision.routing?.repo ?? result.decision.routing?.model,
				probabilities: { ...answer.probabilities },
			}
		},
	}
}

function realLlmRouter(config: RouterConfig): BenchRouter {
	return {
		name: "llm",
		async call(entry) {
			const query = entry.vision ? `${entry.prompt}\n\n${ROUTER_IMAGE_METADATA}` : entry.prompt
			const started = Date.now()
			const result = await routeQuery(query, config)
			if (!result.ok) return { model: "", latencyMs: Date.now() - started, error: result.reason }
			return {
				model: result.recommendation.bestModel,
				archetype: toArchetype(result.recommendation.bestModel),
				latencyMs: Date.now() - started,
				probabilities: { ...result.recommendation.probabilities },
			}
		},
	}
}

// ---------------------------------------------------------------------------
// Mock routers (deterministic, CI-safe)

/**
 * The mock laya mis-picks a fixed, documented subset: entries whose id ends in
 * "3" or "7" within the quick-fix, chat-copy, and code-refactor buckets pick
 * the adjacent role instead of the label. On the full 100-prompt suite this
 * yields exactly 6 mis-picks (94% mock agreement / accuracy).
 */
const MOCK_MISPICK_CATEGORIES = new Set(["quick-fix", "chat-copy", "code-refactor"])
const MOCK_MISPICK_TARGETS: Record<string, string> = {
	"quick-fix": "kimi-k2.6-code",
	"chat-copy": "kimi-k2.6-code",
	"code-refactor": "kimi-k2.5-fast",
}

export function mockLayaMispicks(entry: SuiteEntry): boolean {
	return MOCK_MISPICK_CATEGORIES.has(entry.category) && /[37]$/.test(entry.id)
}

function mockRouter(name: "laya" | "llm"): BenchRouter {
	return {
		name,
		async call(entry) {
			const index = Number(/(\d+)$/.exec(entry.id)?.[1] ?? "0")
			const latencyMs = name === "llm" ? 900 + (index % 5) * 20 : 120 + (index % 3) * 10
			const model =
				name === "laya" && mockLayaMispicks(entry) ? MOCK_MISPICK_TARGETS[entry.category] : entry.expectedModel
			const pick: RouterPick = { model, archetype: model, latencyMs, probabilities: { [model]: 0.9 } }
			if (name === "laya") {
				pick.confidence = 0.85
				pick.answerConfidence = 0.9
			}
			return pick
		},
	}
}

// ---------------------------------------------------------------------------
// Metrics

export function percentile(sorted: readonly number[], p: number): number {
	if (sorted.length === 0) return 0
	const index = Math.ceil((p / 100) * sorted.length) - 1
	return sorted[Math.min(Math.max(index, 0), sorted.length - 1)]
}

/** Estimated LLM routing call tokens: prompt text ~(chars/4) + routing instructions overhead. */
export function estimateLlmInputTokens(promptChars: number): number {
	return Math.ceil(promptChars / 4) + LLM_OVERHEAD_TOKENS
}

export interface BenchRecord {
	id: string
	category: string
	expected: string
	vision: boolean
	/** Prompt length in characters, retained for cost estimation (raw prompts are never persisted). */
	promptChars: number
	laya?: RouterPick
	llm?: RouterPick
	agree?: boolean
}

export interface RouterSummary {
	attempts: number
	errors: number
	correct: number
	accuracy: number
	accuracyByCategory: Record<string, { correct: number; total: number; accuracy: number }>
	latency: { p50: number; p95: number; mean: number }
	/** Calibrated answer_confidence statistics over picks that reported it (laya side). */
	answerConfidence?: { mean: number; correctMean: number; incorrectMean: number | null }
	unmapped: string[]
}

export interface BenchSummary {
	meta: {
		startedAt: string
		durationMs: number
		mode: string
		suitePath: string
		entryCount: number
		notes: string[]
		/** Environment the run executed in — citation material for the findings doc. */
		environment?: {
			platform: string
			arch: string
			cpuModel: string
			cpuCount: number
			nodeVersion: string
			layaCheckpoint?: string
			routerEndpoint?: string
		}
	}
	agreement?: { pairs: number; agree: number; rate: number; rateByCategory: Record<string, number> }
	routers: Partial<Record<"laya" | "llm", RouterSummary>>
	cost: {
		llm?: { estimatedInputTokens: number; estimatedOutputTokens: number; estimatedUsd?: number }
		laya: { estimatedUsd: number; note: string }
	}
}

function summarizeRouter(records: readonly BenchRecord[], name: "laya" | "llm"): RouterSummary {
	const picks = records.flatMap((record) => {
		const pick = record[name]
		return pick ? [{ record, pick }] : []
	})
	const latencies = picks
		.filter(({ pick }) => !pick.error)
		.map(({ pick }) => pick.latencyMs)
		.sort((a, b) => a - b)
	const errors = picks.filter(({ pick }) => pick.error).length
	const byCategory = new Map<string, { correct: number; total: number }>()
	let correct = 0
	const unmapped = new Set<string>()
	for (const { record, pick } of picks) {
		if (pick.error) continue
		const bucket = byCategory.get(record.category) ?? { correct: 0, total: 0 }
		bucket.total++
		if (pick.archetype === undefined && pick.model) unmapped.add(pick.model)
		if (pick.archetype === record.expected) {
			correct++
			bucket.correct++
		}
		byCategory.set(record.category, bucket)
	}
	const scored = picks.length - errors
	const accuracyByCategory: RouterSummary["accuracyByCategory"] = {}
	for (const [category, bucket] of [...byCategory.entries()].sort()) {
		accuracyByCategory[category] = { ...bucket, accuracy: bucket.total === 0 ? 0 : bucket.correct / bucket.total }
	}
	const confident = picks.filter(({ pick }) => !pick.error && pick.answerConfidence !== undefined)
	const meanOf = (rows: readonly { pick: RouterPick }[]): number | null =>
		rows.length === 0
			? null
			: Math.round((rows.reduce((sum, { pick }) => sum + (pick.answerConfidence ?? 0), 0) / rows.length) * 10000) /
				10000
	const answerConfidence =
		confident.length === 0
			? undefined
			: {
					mean: meanOf(confident) ?? 0,
					correctMean: meanOf(confident.filter(({ record, pick }) => pick.archetype === record.expected)) ?? 0,
					incorrectMean: meanOf(confident.filter(({ record, pick }) => pick.archetype !== record.expected)),
				}
	return {
		attempts: picks.length,
		errors,
		correct,
		accuracy: scored === 0 ? 0 : correct / scored,
		accuracyByCategory,
		answerConfidence,
		latency: {
			p50: percentile(latencies, 50),
			p95: percentile(latencies, 95),
			mean: latencies.length === 0 ? 0 : Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length),
		},
		unmapped: [...unmapped].sort(),
	}
}

export function computeSummary(
	records: readonly BenchRecord[],
	meta: Omit<BenchSummary["meta"], "entryCount">,
	pricePer1M: { input?: number; output?: number },
): BenchSummary {
	const summary: BenchSummary = {
		meta: { ...meta, entryCount: records.length },
		routers: {},
		cost: { laya: { estimatedUsd: 0, note: "local sidecar; zero marginal routing cost" } },
	}

	const both = records.filter((record) => record.laya && record.llm && !record.laya.error && !record.llm.error)
	if (both.length > 0) {
		const byCategory = new Map<string, { agree: number; total: number }>()
		let agree = 0
		for (const record of both) {
			const match = record.laya?.archetype === record.llm?.archetype && record.laya?.archetype !== undefined
			const bucket = byCategory.get(record.category) ?? { agree: 0, total: 0 }
			bucket.total++
			if (match) {
				agree++
				bucket.agree++
			}
			byCategory.set(record.category, bucket)
		}
		const rateByCategory: Record<string, number> = {}
		for (const [category, bucket] of [...byCategory.entries()].sort()) {
			rateByCategory[category] = bucket.total === 0 ? 0 : bucket.agree / bucket.total
		}
		summary.agreement = { pairs: both.length, agree, rate: agree / both.length, rateByCategory }
	}

	if (records.some((record) => record.laya)) summary.routers.laya = summarizeRouter(records, "laya")
	if (records.some((record) => record.llm)) {
		summary.routers.llm = summarizeRouter(records, "llm")
		const llmAttempts = records.filter((record) => record.llm)
		const inputTokens = llmAttempts.reduce((sum, record) => sum + estimateLlmInputTokens(record.promptChars), 0)
		const outputTokens = llmAttempts.length * LLM_OUTPUT_TOKENS
		const estimatedUsd =
			pricePer1M.input !== undefined && pricePer1M.output !== undefined
				? (inputTokens * pricePer1M.input + outputTokens * pricePer1M.output) / 1_000_000
				: undefined
		summary.cost.llm = { estimatedInputTokens: inputTokens, estimatedOutputTokens: outputTokens, estimatedUsd }
	}

	return summary
}

// ---------------------------------------------------------------------------
// Results rendering

function pct(value: number): string {
	return `${(value * 100).toFixed(1)}%`
}

export function renderResultsMarkdown(records: readonly BenchRecord[], summary: BenchSummary): string {
	const lines: string[] = []
	lines.push("# Routing benchmark results", "")
	lines.push(`- Suite: \`${summary.meta.suitePath}\` (${summary.meta.entryCount} prompts)`)
	lines.push(`- Mode: ${summary.meta.mode}`)
	lines.push(`- Started: ${summary.meta.startedAt} | duration: ${(summary.meta.durationMs / 1000).toFixed(1)}s`)
	for (const note of summary.meta.notes) lines.push(`- ${note}`)
	const env = summary.meta.environment
	if (env) {
		lines.push(`- Environment: ${env.platform}/${env.arch}, ${env.cpuCount}x ${env.cpuModel}, node ${env.nodeVersion}`)
		if (env.layaCheckpoint) lines.push(`- laya checkpoint: ${env.layaCheckpoint}`)
		if (env.routerEndpoint) lines.push(`- LLM router backend: ${env.routerEndpoint}`)
	}
	lines.push("")

	if (summary.agreement) {
		lines.push("## Agreement (laya vs LLM router)", "")
		lines.push(`**${pct(summary.agreement.rate)}** (${summary.agreement.agree}/${summary.agreement.pairs} pairs)`, "")
	}
	lines.push("## Headline", "")
	lines.push("| router | accuracy vs labels | latency p50 | latency p95 | errors | est. routing cost |")
	lines.push("| ------ | ------------------ | ----------- | ----------- | ------ | ----------------- |")
	if (summary.routers.laya) {
		const r = summary.routers.laya
		lines.push(
			`| laya   | ${pct(r.accuracy)} (${r.correct}/${r.attempts - r.errors}) | ${r.latency.p50}ms | ${r.latency.p95}ms | ${r.errors} | $0 (local) |`,
		)
	}
	if (summary.routers.llm) {
		const r = summary.routers.llm
		const cost =
			summary.cost.llm?.estimatedUsd !== undefined ? `$${summary.cost.llm.estimatedUsd.toFixed(6)}` : "tokens only"
		lines.push(
			`| LLM    | ${pct(r.accuracy)} (${r.correct}/${r.attempts - r.errors}) | ${r.latency.p50}ms | ${r.latency.p95}ms | ${r.errors} | ${cost} |`,
		)
	}
	lines.push("")
	const layaConf = summary.routers.laya?.answerConfidence
	if (layaConf) {
		lines.push(
			`laya mean answer_confidence: ${layaConf.mean.toFixed(3)} ` +
				`(correct: ${layaConf.correctMean.toFixed(3)}, incorrect: ${layaConf.incorrectMean === null ? "n/a" : layaConf.incorrectMean.toFixed(3)})`,
			"",
		)
	}

	lines.push("## Per-category", "")
	lines.push("| category | expected model | laya accuracy | LLM accuracy | agreement |")
	lines.push("| -------- | -------------- | ------------- | ------------ | --------- |")
	const categories = [...new Set(records.map((record) => record.category))].sort()
	for (const category of categories) {
		const expected = records.find((record) => record.category === category)?.expected ?? "?"
		const laya = summary.routers.laya?.accuracyByCategory[category]
		const llm = summary.routers.llm?.accuracyByCategory[category]
		const agreement = summary.agreement?.rateByCategory[category]
		lines.push(
			`| ${category} | ${expected} | ${laya ? pct(laya.accuracy) : "-"} | ${llm ? pct(llm.accuracy) : "-"} | ${agreement !== undefined ? pct(agreement) : "-"} |`,
		)
	}
	lines.push("")

	const disagreements = records.filter(
		(record) =>
			record.laya &&
			record.llm &&
			!record.laya.error &&
			!record.llm.error &&
			record.laya.archetype !== record.llm.archetype,
	)
	if (disagreements.length > 0) {
		lines.push("## Disagreements", "")
		lines.push("| id | category | label | laya | LLM |")
		lines.push("| -- | -------- | ----- | ---- | --- |")
		for (const record of disagreements) {
			lines.push(
				`| ${record.id} | ${record.category} | ${record.expected} | ${record.laya?.archetype ?? "unmapped"} | ${record.llm?.archetype ?? "unmapped"} |`,
			)
		}
		lines.push("")
	}

	const unmapped = [...(summary.routers.laya?.unmapped ?? []), ...(summary.routers.llm?.unmapped ?? [])]
	if (unmapped.length > 0) {
		lines.push(
			`> Note: ${new Set(unmapped).size} returned model id(s) could not be mapped to the benchmark roster and count as non-matching: ${[...new Set(unmapped)].join(", ")}`,
			"",
		)
	}

	if (summary.meta.mode.includes("mock")) {
		lines.push(
			"> These numbers come from --mock-routers: they verify the benchmark pipeline end-to-end and say **nothing** about real routing quality.",
		)
	}
	return `${lines.join("\n")}\n`
}

// ---------------------------------------------------------------------------
// Main

export async function main(argv = process.argv.slice(2)): Promise<number> {
	let args: BenchArgs
	try {
		args = parseBenchArgs(argv)
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error))
		return 1
	}
	if (args.help) {
		console.log(USAGE)
		return 0
	}

	const suite = loadSuite(args.suitePath)
	const notes: string[] = []
	const startedAt = Date.now()
	let routerEndpointUsed: string | undefined

	const routers: BenchRouter[] = []
	if (!args.llmOnly) routers.push(args.mock ? mockRouter("laya") : realLayaRouter())
	if (!args.layaOnly) {
		if (args.mock) {
			routers.push(mockRouter("llm"))
		} else {
			const endpoint = process.env.KIMCHI_ROUTER_ENDPOINT?.trim()
			const apiKey = process.env.KIMCHI_ROUTER_API_KEY?.trim() || process.env.CASTAI_API_KEY?.trim() || ""
			if (!endpoint || !apiKey) {
				const degrade =
					"LLM router credentials missing (KIMCHI_ROUTER_ENDPOINT + KIMCHI_ROUTER_API_KEY / CASTAI_API_KEY) — " +
					"degrading to a laya-only real run; agreement and LLM-side metrics stay unmeasured."
				console.error(degrade)
				notes.push(degrade)
			} else {
				const llmConfig: RouterConfig = { endpoint, apiKey }
				routers.push(realLlmRouter(llmConfig))
				routerEndpointUsed = new URL(endpoint).origin
			}
		}
	}

	for (const router of routers) {
		if (!router.prepare) continue
		try {
			const note = await router.prepare()
			if (note) notes.push(note)
		} catch (error) {
			console.error(error instanceof Error ? error.message : String(error))
			return 1
		}
	}

	const records: BenchRecord[] = []
	for (const entry of suite.entries) {
		const record: BenchRecord = {
			id: entry.id,
			category: entry.category,
			expected: entry.expectedModel,
			vision: entry.vision,
			promptChars: entry.prompt.length,
		}
		for (const router of routers) {
			record[router.name] = await router.call(entry)
		}
		if (record.laya && record.llm) {
			record.agree = record.laya.archetype !== undefined && record.laya.archetype === record.llm.archetype
		}
		records.push(record)
		if (records.length % 10 === 0) console.log(`... ${records.length}/${suite.entries.length}`)
	}

	const pricePer1M = {
		input: process.env.KIMCHI_BENCH_LLM_PRICE_INPUT_PER_1M
			? Number(process.env.KIMCHI_BENCH_LLM_PRICE_INPUT_PER_1M)
			: undefined,
		output: process.env.KIMCHI_BENCH_LLM_PRICE_OUTPUT_PER_1M
			? Number(process.env.KIMCHI_BENCH_LLM_PRICE_OUTPUT_PER_1M)
			: undefined,
	}
	const checkpoint = records.map((record) => record.laya?.checkpoint).find((value) => value !== undefined)
	const summary = computeSummary(
		records,
		{
			startedAt: new Date(startedAt).toISOString(),
			durationMs: Date.now() - startedAt,
			mode: [
				args.mock ? "mock" : "real",
				routers.length === 2 ? "both" : `${routers[0]?.name ?? "none"}-only`,
			].join(" "),
			suitePath: args.suitePath,
			notes,
			environment: {
				platform: platform(),
				arch: arch(),
				cpuModel: cpus()[0]?.model ?? "unknown",
				cpuCount: cpus().length,
				nodeVersion: process.version,
				...(checkpoint ? { layaCheckpoint: checkpoint } : {}),
				...(routerEndpointUsed ? { routerEndpoint: routerEndpointUsed } : {}),
			},
		},
		pricePer1M,
	)

	writeFileSync(args.outJson, `${JSON.stringify({ summary, records }, null, "\t")}\n`)
	writeFileSync(args.outMd, renderResultsMarkdown(records, summary))

	console.log(`\nwrote ${args.outJson}`)
	console.log(`wrote ${args.outMd}`)
	if (summary.agreement)
		console.log(`agreement: ${pct(summary.agreement.rate)} (${summary.agreement.agree}/${summary.agreement.pairs})`)
	if (summary.routers.laya) {
		console.log(
			`laya accuracy: ${pct(summary.routers.laya.accuracy)} | p50 ${summary.routers.laya.latency.p50}ms | p95 ${summary.routers.laya.latency.p95}ms`,
		)
	}
	if (summary.routers.llm) {
		console.log(
			`LLM  accuracy: ${pct(summary.routers.llm.accuracy)} | p50 ${summary.routers.llm.latency.p50}ms | p95 ${summary.routers.llm.latency.p95}ms`,
		)
	}
	return 0
}

const isDirectRun = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]
if (isDirectRun) {
	main().then(
		(code) => process.exit(code),
		(error) => {
			console.error(error)
			process.exit(1)
		},
	)
}
