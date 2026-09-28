import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { BENCHMARK_CANDIDATES, loadSuite, parseSuite, SUITE_CATEGORIES, SuiteError } from "./suite.js"

const VALID_LINE = {
	id: "quick-fix-99",
	category: "quick-fix",
	prompt: "Fix the typo in the footer copy.",
	expectedModel: "kimi-k2.5-fast",
	vision: false,
}

describe("parseSuite", () => {
	it("parses valid JSONL and counts categories", () => {
		const raw = [VALID_LINE, { ...VALID_LINE, id: "chat-copy-99", category: "chat-copy" }]
			.map((entry) => JSON.stringify(entry))
			.join("\n")
		const suite = parseSuite(raw)
		expect(suite.entries).toHaveLength(2)
		expect(suite.byCategory.get("quick-fix")).toBe(1)
		expect(suite.byCategory.get("chat-copy")).toBe(1)
	})

	it("skips blank lines", () => {
		const suite = parseSuite(`${JSON.stringify(VALID_LINE)}\n\n  \n`)
		expect(suite.entries).toHaveLength(1)
	})

	it("rejects invalid JSON with the line number", () => {
		expect(() => parseSuite(`{"id":\n`)).toThrowError(/suite\.jsonl:1: invalid JSON/)
	})

	it("rejects schema violations (short prompt, unknown category)", () => {
		expect(() => parseSuite(JSON.stringify({ ...VALID_LINE, prompt: "short" }))).toThrowError(SuiteError)
		expect(() => parseSuite(JSON.stringify({ ...VALID_LINE, category: "nope" }))).toThrowError(/1:/)
	})

	it("rejects duplicate ids", () => {
		const raw = [VALID_LINE, VALID_LINE].map((entry) => JSON.stringify(entry)).join("\n")
		expect(() => parseSuite(raw)).toThrowError(/duplicate id "quick-fix-99"/)
	})

	it("rejects expectedModel values outside the benchmark roster", () => {
		expect(() => parseSuite(JSON.stringify({ ...VALID_LINE, expectedModel: "gpt-5" }))).toThrowError(
			/not in the benchmark candidate roster/,
		)
	})

	it("rejects vision prompts labeled toward non-vision candidates", () => {
		expect(() => parseSuite(JSON.stringify({ ...VALID_LINE, vision: true }))).toThrowError(
			/vision prompt labeled toward non-vision candidate/,
		)
	})

	it("rejects an empty suite", () => {
		expect(() => parseSuite("\n  \n")).toThrowError(/no entries found/)
	})
})

describe("benchmark/routing/suite.jsonl integrity", () => {
	const suite = loadSuite(join(__dirname, "suite.jsonl"))

	it("is labeled with the full candidate roster documented in the README", () => {
		expect(BENCHMARK_CANDIDATES.map((c) => c.id)).toEqual([
			"kimi-k3-flagship",
			"kimi-k2.6-code",
			"kimi-k2.5-fast",
			"kimi-k1.6-reason",
			"kimi-vl-vision",
		])
	})

	it("has between 60 and 120 entries", () => {
		expect(suite.entries.length).toBeGreaterThanOrEqual(60)
		expect(suite.entries.length).toBeLessThanOrEqual(120)
	})

	it("covers every bucket with at least 9 prompts", () => {
		for (const category of SUITE_CATEGORIES) {
			expect(suite.byCategory.get(category) ?? 0).toBeGreaterThanOrEqual(9)
		}
	})

	it("labels vision-bearing prompts only toward the vision candidate", () => {
		for (const entry of suite.entries.filter((e) => e.vision)) {
			expect(entry.expectedModel).toBe("kimi-vl-vision")
		}
		expect(suite.entries.filter((e) => e.category === "vision").every((e) => e.vision)).toBe(true)
	})

	it("keeps prompts English-only (protocol assumption documented in README)", () => {
		// Printable-ASCII range: avoids control characters in the pattern itself.
		const nonAscii = suite.entries.filter((e) => /[^ -~]/.test(e.prompt))
		expect(nonAscii.map((e) => e.id)).toEqual([])
	})

	it("uses ids prefixed by their category", () => {
		for (const entry of suite.entries) {
			expect(entry.id.startsWith(`${entry.category}-`)).toBe(true)
		}
	})
})
