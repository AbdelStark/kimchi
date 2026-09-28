import { readFileSync } from "node:fs"
import { z } from "zod"

/**
 * Offline routing benchmark suite: labeled prompt -> expected target model.
 *
 * The suite is model-roster-agnostic: entries reference the fixed benchmark
 * candidate roster below (same role archetypes Kimchi's Auto router sees at
 * runtime) rather than live catalog ids, so the suite stays stable as the
 * real lineup churns. run.ts maps the roster onto live candidates when
 * available; --mock-routers mode uses it verbatim.
 */

export interface BenchmarkCandidate {
	/** Stable benchmark id (what suite entries reference in expectedModel). */
	id: string
	/** One-line capability blurb, mirroring what routing instructions surface. */
	blurb: string
	/** Whether the candidate accepts image input. */
	vision: boolean
	/** Context window size in tokens. */
	contextWindow: number
}

export const BENCHMARK_CANDIDATES: readonly BenchmarkCandidate[] = [
	{
		id: "kimi-k3-flagship",
		blurb: "Frontier flagship: strongest general, agentic multi-step tool use, long-context reasoning",
		vision: true,
		contextWindow: 262144,
	},
	{
		id: "kimi-k2.6-code",
		blurb: "Code-specialized mid-tier: fast, strong at features, refactors, tests and debugging",
		vision: false,
		contextWindow: 131072,
	},
	{
		id: "kimi-k2.5-fast",
		blurb: "Cheap low-latency model for simple questions, small edits, chat and copy",
		vision: false,
		contextWindow: 131072,
	},
	{
		id: "kimi-k1.6-reason",
		blurb: "Deep-reasoning thinking model: math, proofs, architecture trade-offs; slower and pricier",
		vision: false,
		contextWindow: 262144,
	},
	{
		id: "kimi-vl-vision",
		blurb: "Multimodal vision model: screenshots, diagrams, UI mockups; mid general reasoning",
		vision: true,
		contextWindow: 131072,
	},
] as const

export const SUITE_CATEGORIES = [
	"agentic-multifile",
	"code-feature",
	"code-refactor",
	"test-writing",
	"debugging",
	"quick-fix",
	"chat-copy",
	"deep-reasoning",
	"long-context",
	"vision",
] as const

export type SuiteCategory = (typeof SUITE_CATEGORIES)[number]

export const SuiteEntrySchema = z.object({
	id: z.string().min(1),
	category: z.enum(SUITE_CATEGORIES),
	prompt: z.string().min(10).max(8000),
	expectedModel: z.string().min(1),
	vision: z.boolean(),
})

export type SuiteEntry = z.infer<typeof SuiteEntrySchema>

export interface LoadedSuite {
	entries: SuiteEntry[]
	/** category -> entry count, in SUITE_CATEGORIES order. */
	byCategory: Map<SuiteCategory, number>
}

export class SuiteError extends Error {
	constructor(message: string) {
		super(message)
		this.name = "SuiteError"
	}
}

/** Parse and validate suite.jsonl content. Throws SuiteError on the first problem. */
export function parseSuite(raw: string, source = "suite.jsonl"): LoadedSuite {
	const candidateIds = new Set(BENCHMARK_CANDIDATES.map((c) => c.id))
	const seen = new Set<string>()
	const entries: SuiteEntry[] = []
	const byCategory = new Map<SuiteCategory, number>()

	const lines = raw.split("\n")
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].trim()
		if (line.length === 0) continue
		const label = `${source}:${i + 1}`
		let parsedJson: unknown
		try {
			parsedJson = JSON.parse(line)
		} catch {
			throw new SuiteError(`${label}: invalid JSON`)
		}
		const result = SuiteEntrySchema.safeParse(parsedJson)
		if (!result.success) {
			throw new SuiteError(`${label}: ${result.error.issues.map((issue) => issue.message).join("; ")}`)
		}
		const entry = result.data
		if (seen.has(entry.id)) throw new SuiteError(`${label}: duplicate id "${entry.id}"`)
		seen.add(entry.id)
		if (!candidateIds.has(entry.expectedModel)) {
			throw new SuiteError(`${label}: expectedModel "${entry.expectedModel}" is not in the benchmark candidate roster`)
		}
		// A vision-bearing prompt can only be labeled toward a vision-capable candidate.
		if (entry.vision) {
			const target = BENCHMARK_CANDIDATES.find((c) => c.id === entry.expectedModel)
			if (target && !target.vision) {
				throw new SuiteError(`${label}: vision prompt labeled toward non-vision candidate "${entry.expectedModel}"`)
			}
		}
		entries.push(entry)
		byCategory.set(entry.category, (byCategory.get(entry.category) ?? 0) + 1)
	}

	if (entries.length === 0) throw new SuiteError(`${source}: no entries found`)
	return { entries, byCategory }
}

/** Load and validate the suite from disk. */
export function loadSuite(path: string): LoadedSuite {
	let raw: string
	try {
		raw = readFileSync(path, "utf8")
	} catch (error) {
		throw new SuiteError(`cannot read suite at ${path}: ${error instanceof Error ? error.message : String(error)}`)
	}
	return parseSuite(raw, path)
}
