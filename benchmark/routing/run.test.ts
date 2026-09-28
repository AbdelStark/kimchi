import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
	type computeSummary,
	estimateLlmInputTokens,
	main,
	mockLayaMispicks,
	parseBenchArgs,
	percentile,
	toArchetype,
} from "./run.js"
import { parseSuite, type SuiteEntry } from "./suite.js"

const MINI_ENTRIES = [
	{
		id: "quick-fix-01",
		category: "quick-fix",
		prompt: "Fix the typo in the footer copy please.",
		expectedModel: "kimi-k2.5-fast",
		vision: false,
	},
	{
		id: "quick-fix-03",
		category: "quick-fix",
		prompt: "Remove the unused import from downloader.ts now.",
		expectedModel: "kimi-k2.5-fast",
		vision: false,
	},
	{
		id: "chat-copy-07",
		category: "chat-copy",
		prompt: "Rewrite this commit message to follow conventional commits.",
		expectedModel: "kimi-k2.5-fast",
		vision: false,
	},
	{
		id: "chat-copy-02",
		category: "chat-copy",
		prompt: "Write a friendly short release note for dark mode support.",
		expectedModel: "kimi-k2.5-fast",
		vision: false,
	},
	{
		id: "code-refactor-07",
		category: "code-refactor",
		prompt: "Introduce a Result type and refactor the loaders to stop throwing.",
		expectedModel: "kimi-k2.6-code",
		vision: false,
	},
	{
		id: "code-feature-03",
		category: "code-feature",
		prompt: "Add support for TOML config files with schema validation.",
		expectedModel: "kimi-k2.6-code",
		vision: false,
	},
	{
		id: "vision-01",
		category: "vision",
		prompt: "The settings dialog in this screenshot has a misaligned toggle.",
		expectedModel: "kimi-vl-vision",
		vision: true,
	},
	{
		id: "agentic-multifile-10",
		category: "agentic-multifile",
		prompt: "Port the export feature from HTML-only to also emit PDF end to end.",
		expectedModel: "kimi-k3-flagship",
		vision: false,
	},
]

function miniSuite(dir: string): string {
	const path = join(dir, "suite.jsonl")
	writeFileSync(path, `${MINI_ENTRIES.map((entry) => JSON.stringify(entry)).join("\n")}\n`)
	return path
}

describe("parseBenchArgs", () => {
	it("defaults to the co-located suite and results paths", () => {
		const args = parseBenchArgs([])
		expect(args.mock).toBe(false)
		expect(args.layaOnly).toBe(false)
		expect(args.llmOnly).toBe(false)
		expect(args.suitePath.endsWith(join("benchmark", "routing", "suite.jsonl"))).toBe(true)
		expect(args.outJson.endsWith(join("benchmark", "routing", "results.json"))).toBe(true)
	})

	it("parses modes and explicit paths", () => {
		const args = parseBenchArgs([
			"--mock-routers",
			"--suite",
			"/tmp/s.jsonl",
			"--out-json",
			"/tmp/a.json",
			"--out-md",
			"/tmp/a.md",
		])
		expect(args).toMatchObject({ mock: true, suitePath: "/tmp/s.jsonl", outJson: "/tmp/a.json", outMd: "/tmp/a.md" })
	})

	it("rejects --laya-only combined with --llm-only and unknown flags", () => {
		expect(() => parseBenchArgs(["--laya-only", "--llm-only"])).toThrowError(/mutually exclusive/)
		expect(() => parseBenchArgs(["--nope"])).toThrowError(/unknown flag/)
		expect(() => parseBenchArgs(["--suite"])).toThrowError(/requires a value/)
	})
})

describe("percentile", () => {
	it("handles the empty and singleton cases", () => {
		expect(percentile([], 50)).toBe(0)
		expect(percentile([10], 95)).toBe(10)
	})

	it("picks the nearest-rank sample", () => {
		const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
		expect(percentile(values, 50)).toBe(5)
		expect(percentile(values, 95)).toBe(10)
		expect(percentile(values, 0)).toBe(1)
		expect(percentile(values, 100)).toBe(10)
	})
})

describe("toArchetype", () => {
	it("passes roster ids through unchanged", () => {
		expect(toArchetype("kimi-k2.6-code")).toBe("kimi-k2.6-code")
	})

	it("maps live catalog ids through the alias table", () => {
		expect(toArchetype("kimi-k3")).toBe("kimi-k3-flagship")
		expect(toArchetype("kimi-k2.6")).toBe("kimi-k2.6-code")
		expect(toArchetype("kimi-k2.5-turbo-preview")).toBe("kimi-k2.5-fast")
		expect(toArchetype("claude-sonnet-4.6")).toBe("kimi-k2.6-code")
		expect(toArchetype("claude-haiku-4.5")).toBe("kimi-k2.5-fast")
		expect(toArchetype("deepseek-r1-0528")).toBe("kimi-k1.6-reason")
		expect(toArchetype("kimi-latest-vl")).toBe("kimi-vl-vision")
	})

	it("returns undefined for unmappable ids", () => {
		expect(toArchetype("llama-3.3-70b-instruct")).toBeUndefined()
		expect(toArchetype("mistral-nemo")).toBeUndefined()
	})
})

describe("mockLayaMispicks", () => {
	const entry = (id: string, category: SuiteEntry["category"]) =>
		({ id, category, prompt: "x".repeat(20), expectedModel: "kimi-k2.5-fast", vision: false }) as SuiteEntry

	it("mis-picks only the documented fixed subset", () => {
		expect(mockLayaMispicks(entry("quick-fix-03", "quick-fix"))).toBe(true)
		expect(mockLayaMispicks(entry("chat-copy-07", "chat-copy"))).toBe(true)
		expect(mockLayaMispicks(entry("code-refactor-07", "code-refactor"))).toBe(true)
		expect(mockLayaMispicks(entry("quick-fix-02", "quick-fix"))).toBe(false)
		expect(mockLayaMispicks(entry("debugging-03", "debugging"))).toBe(false)
		expect(mockLayaMispicks(entry("vision-07", "vision"))).toBe(false)
	})
})

describe("end-to-end --mock-routers", () => {
	it("produces results.json + results.md with exact deterministic numbers", async () => {
		const dir = mkdtempSync(join(tmpdir(), "routing-bench-"))
		const suitePath = miniSuite(dir)
		const outJson = join(dir, "results.json")
		const outMd = join(dir, "results.md")

		const code = await main(["--mock-routers", "--suite", suitePath, "--out-json", outJson, "--out-md", outMd])
		expect(code).toBe(0)

		const parsed = JSON.parse(readFileSync(outJson, "utf8"))
		const { summary, records } = parsed as { summary: ReturnType<typeof computeSummary>; records: unknown[] }
		expect(records).toHaveLength(8)
		expect(summary.meta).toMatchObject({ mode: "mock both", entryCount: 8, suitePath })

		// Mock contract: LLM = labels; laya mis-picks quick-fix-03, chat-copy-07, code-refactor-07.
		expect(summary.agreement).toMatchObject({ pairs: 8, agree: 5, rate: 0.625 })
		expect(summary.agreement?.rateByCategory["quick-fix"]).toBe(0.5)
		expect(summary.agreement?.rateByCategory.vision).toBe(1)
		expect(summary.routers.llm).toMatchObject({ attempts: 8, errors: 0, correct: 8, accuracy: 1, unmapped: [] })
		expect(summary.routers.laya?.accuracy).toBe(0.625)
		expect(summary.routers.laya?.accuracyByCategory["chat-copy"]).toEqual({ correct: 1, total: 2, accuracy: 0.5 })
		expect(summary.routers.laya?.latency).toEqual({ p50: 130, p95: 140, mean: 129 })
		expect(summary.routers.llm?.latency).toEqual({ p50: 940, p95: 960, mean: 935 })

		expect(summary.cost.llm?.estimatedOutputTokens).toBe(640)
		expect(summary.cost.llm && "estimatedUsd" in summary.cost.llm).toBe(false)
		expect(summary.cost.laya.estimatedUsd).toBe(0)

		const md = readFileSync(outMd, "utf8")
		expect(md).toContain("**62.5%** (5/8 pairs)")
		expect(md).toContain("| quick-fix | kimi-k2.5-fast | 50.0% | 100.0% | 50.0% |")
		expect(md).toContain("## Disagreements")
		expect(md).toContain("| quick-fix-03 | quick-fix | kimi-k2.5-fast | kimi-k2.6-code | kimi-k2.5-fast |")
		expect(md).toContain("--mock-routers: they verify the benchmark pipeline end-to-end")
	})
})

describe("estimateLlmInputTokens", () => {
	it("counts prompt text at chars/4 plus the routing-instruction overhead", () => {
		const entry = parseSuite(`${JSON.stringify(MINI_ENTRIES[0])}\n`).entries[0]
		expect(estimateLlmInputTokens(entry.prompt.length)).toBe(Math.ceil(entry.prompt.length / 4) + 600)
	})
})
