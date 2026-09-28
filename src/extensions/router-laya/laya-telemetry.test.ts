import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
	appendRoutingDecision,
	createRoutingDecision,
	hashRoutingQuery,
	type LayaRoutingDecision,
	layaTelemetryEnabled,
	layaTelemetryPath,
	recordRoutingDecision,
} from "./laya-telemetry.js"

const fixedNow = () => new Date("2026-09-28T10:15:30.000Z")

function decisionInput(overrides: Partial<Parameters<typeof createRoutingDecision>[0]> = {}) {
	return {
		sessionId: "session-1",
		query: "how do i centre a div",
		provider: "kimchi-dev",
		modelId: "kimi-k2.5",
		confidence: 0.91,
		probabilities: { "gpt-5.2": 0.09, "kimi-k2.5": 0.91 },
		layaLatencyMs: 212,
		llmLatencyMs: null,
		source: "laya" as const,
		visionGated: false,
		...overrides,
	}
}

describe("createRoutingDecision", () => {
	it("builds the versioned decision schema with a sha256 prompt hash", () => {
		const decision = createRoutingDecision(decisionInput(), fixedNow)
		expect(decision).toEqual({
			version: 1,
			timestamp: "2026-09-28T10:15:30.000Z",
			sessionId: "session-1",
			promptHash: hashRoutingQuery("how do i centre a div"),
			pickedModel: { provider: "kimchi-dev", id: "kimi-k2.5" },
			confidence: 0.91,
			probabilities: { "gpt-5.2": 0.09, "kimi-k2.5": 0.91 },
			layaLatencyMs: 212,
			llmLatencyMs: null,
			source: "laya",
			visionGated: false,
		})
	})

	it("never embeds the raw prompt — only its hash", () => {
		const decision = createRoutingDecision(decisionInput())
		expect(JSON.stringify(decision)).not.toContain("how do i centre a div")
	})
})

describe("layaTelemetryEnabled", () => {
	it("is enabled by default and disabled only by an explicit 0", () => {
		expect(layaTelemetryEnabled({})).toBe(true)
		expect(layaTelemetryEnabled({ KIMCHI_LAYA_TELEMETRY: "0" })).toBe(false)
		expect(layaTelemetryEnabled({ KIMCHI_LAYA_TELEMETRY: "false" })).toBe(true) // only "0" is the kill switch
	})
})

describe("layaTelemetryPath", () => {
	it("writes one JSONL file per session under laya-routing/", () => {
		expect(layaTelemetryPath("/agent", "session-1")).toBe(join("/agent", "laya-routing", "session-1.jsonl"))
	})

	it("sanitizes session ids that are unsafe for filenames", () => {
		expect(layaTelemetryPath("/agent", "a/b:c")).toBe(join("/agent", "laya-routing", "a_b_c.jsonl"))
	})
})

describe("appendRoutingDecision + recordRoutingDecision", () => {
	let dir: string
	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "laya-telemetry-"))
	})
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true })
	})

	it("appends one JSON object per line and creates the directory", async () => {
		const first = createRoutingDecision(decisionInput(), fixedNow)
		const second = createRoutingDecision(
			decisionInput({
				query: "summarize this repo",
				modelId: "gpt-5.2",
				confidence: null,
				probabilities: null,
				layaLatencyMs: 205,
				llmLatencyMs: 1800,
				source: "llm-fallback",
				visionGated: true,
			}),
			fixedNow,
		)
		const path = layaTelemetryPath(dir, first.sessionId)
		expect(await appendRoutingDecision(path, first)).toBe(true)
		expect(await appendRoutingDecision(path, second)).toBe(true)

		const lines = (await readFile(path, "utf8")).trim().split("\n")
		expect(lines).toHaveLength(2)
		const parsed = lines.map((line) => JSON.parse(line) as LayaRoutingDecision)
		expect(parsed[0]).toMatchObject({ source: "laya", pickedModel: { id: "kimi-k2.5" }, llmLatencyMs: null })
		expect(parsed[1]).toMatchObject({ source: "llm-fallback", pickedModel: { id: "gpt-5.2" }, llmLatencyMs: 1800 })
	})

	it("returns false instead of throwing when the write fails", async () => {
		const decision = createRoutingDecision(decisionInput({ sessionId: "x" }))
		// Use a file (not a dir) as the parent so mkdir/append necessarily fail.
		const blocker = join(dir, "blocker")
		await appendRoutingDecision(join(blocker, "x"), decision) // may or may not fail; create the file below instead
		const path = join("/definitely/not-writable-\0", "x", "y.jsonl")
		expect(await appendRoutingDecision(path, decision)).toBe(false)
	})

	it("honors the opt-out flag and returns the decision on success", async () => {
		const decision = createRoutingDecision(decisionInput(), fixedNow)
		expect(await recordRoutingDecision(decision, { agentDir: dir })).toBe(decision)
		expect(await readFile(layaTelemetryPath(dir, "session-1"), "utf8")).toContain('"source":"laya"')

		expect(
			await recordRoutingDecision(decision, { agentDir: dir, env: { KIMCHI_LAYA_TELEMETRY: "0" } }),
		).toBeUndefined()
	})
})
