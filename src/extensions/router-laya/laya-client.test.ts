import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { type LayaClientConfig, type LayaQuestion, queryLaya } from "./laya-client.js"

const config: LayaClientConfig = { endpoint: "http://127.0.0.1:8000/", apiKey: "laya-secret" }

const choiceQuestion: LayaQuestion = {
	type: "choice",
	instructions: "Pick the model that best fits this task.",
	criteria: ["kimi-k3", "glm-5.2", "claude-sonnet-4.6"],
}
const scoreQuestion: LayaQuestion = {
	type: "score",
	instructions: "Rate routing confidence per model.",
	criteria: ["kimi-k3", "glm-5.2"],
}
const noulQuestion: LayaQuestion = { type: "noul", instructions: "Summarize the task in one word." }

function response(body: unknown, ok = true): Response {
	return { ok, json: async () => body } as Response
}

function hangingFetch() {
	return vi.fn<typeof fetch>(
		async (_input, init) =>
			new Promise<Response>((_resolve, reject) =>
				init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))),
			),
	)
}

describe("queryLaya", () => {
	beforeEach(() => vi.useFakeTimers())
	afterEach(() => {
		vi.useRealTimers()
		vi.restoreAllMocks()
	})

	it("posts state and questions to /v1/systemone with bearer auth and parses a choice answer", async () => {
		const body = {
			answers: {
				"best-model": {
					choice: 1,
					probabilities: { "kimi-k3": 0.15, "glm-5.2": 0.6, "claude-sonnet-4.6": 0.25 },
					confidence: 0.55,
					answer_confidence: 0.6,
				},
			},
			usage: { input_tokens: 412, output_tokens: 3 },
			routing: { model: "convaiinnovations/laya", repo: "laya", reason: "auto" },
		}
		const fetchImpl = vi.fn<typeof fetch>(async () => response(body))
		const questions = { "best-model": choiceQuestion } as const

		await expect(queryLaya("write a haiku about rust", questions, config, { fetchImpl })).resolves.toEqual({
			ok: true,
			decision: {
				answers: {
					"best-model": {
						kind: "choice",
						choiceIndex: 1,
						choice: "glm-5.2",
						probabilities: { "kimi-k3": 0.15, "glm-5.2": 0.6, "claude-sonnet-4.6": 0.25 },
						confidence: 0.55,
						answerConfidence: 0.6,
					},
				},
				usage: { inputTokens: 412, outputTokens: 3 },
				routing: { model: "convaiinnovations/laya", repo: "laya", reason: "auto" },
				latencyMs: expect.any(Number),
			},
		})
		expect(fetchImpl).toHaveBeenCalledWith(
			new URL("http://127.0.0.1:8000/v1/systemone"),
			expect.objectContaining({
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: "Bearer laya-secret" },
				body: JSON.stringify({ state: "write a haiku about rust", questions }),
			}),
		)
	})

	it("resolves string and numeric-string choice values", async () => {
		const fetchImpl = vi.fn<typeof fetch>(async () =>
			response({ answers: { q1: { choice: "claude-sonnet-4.6" }, q2: { choice: "0", probabilities: {} } } }),
		)
		const questions = { q1: choiceQuestion, q2: choiceQuestion }

		const result = await queryLaya("state", questions, config, { fetchImpl })

		expect(result.ok).toBe(true)
		if (!result.ok) return
		expect(result.decision.answers.q1).toMatchObject({ kind: "choice", choiceIndex: 2, choice: "claude-sonnet-4.6" })
		expect(result.decision.answers.q2).toMatchObject({ kind: "choice", choiceIndex: 0, choice: "kimi-k3" })
	})

	it("parses score and noul answers and tolerates missing usage/routing blocks", async () => {
		const body = {
			answers: {
				rating: { score: 0.9, probabilities: { "kimi-k3": 0.1, "glm-5.2": 0.9 }, answer_confidence: 0.9 },
				summary: { noul: "dedupe" },
			},
		}
		const fetchImpl = vi.fn<typeof fetch>(async () => response(body))

		const result = await queryLaya("state", { rating: scoreQuestion, summary: noulQuestion }, config, { fetchImpl })

		expect(result.ok).toBe(true)
		if (!result.ok) return
		expect(result.decision.answers.rating).toEqual({
			kind: "score",
			score: 0.9,
			probabilities: { "kimi-k3": 0.1, "glm-5.2": 0.9 },
			confidence: undefined,
			answerConfidence: 0.9,
		})
		expect(result.decision.answers.summary).toEqual({
			kind: "noul",
			noul: "dedupe",
			confidence: undefined,
			answerConfidence: undefined,
		})
		expect(result.decision.usage).toBeUndefined()
		expect(result.decision.routing).toBeUndefined()
	})

	it.each([
		["HTTP failure", { q: choiceQuestion }, response({}, false), "http"],
		["null body", { q: choiceQuestion }, response(null), "malformed"],
		["missing answers object", { q: choiceQuestion }, response({ usage: {} }), "malformed"],
		["non-object answer", { q: choiceQuestion }, response({ answers: { q: "glm-5.2" } }), "malformed"],
		[
			"missing answer for a question",
			{ q: choiceQuestion, other: scoreQuestion },
			response({ answers: { q: { choice: 0 } } }),
			"malformed",
		],
		["choice index out of range", { q: choiceQuestion }, response({ answers: { q: { choice: 7 } } }), "malformed"],
		[
			"unknown choice label",
			{ q: choiceQuestion },
			response({ answers: { q: { choice: "not-a-model" } } }),
			"malformed",
		],
		["negative choice index", { q: choiceQuestion }, response({ answers: { q: { choice: -1 } } }), "malformed"],
		["fractional choice index", { q: choiceQuestion }, response({ answers: { q: { choice: 1.5 } } }), "malformed"],
		["missing score", { q: scoreQuestion }, response({ answers: { q: { choice: 0 } } }), "malformed"],
		["non-numeric score", { q: scoreQuestion }, response({ answers: { q: { score: "high" } } }), "malformed"],
		["missing noul", { q: noulQuestion }, response({ answers: { q: { score: 1 } } }), "malformed"],
		[
			"non-numeric probabilities",
			{ q: choiceQuestion },
			response({ answers: { q: { choice: 0, probabilities: { "kimi-k3": "high" } } } }),
			"malformed",
		],
	] as const)("classifies %s responses", async (_label, questions, result, reason) => {
		const fetchImpl = vi.fn<typeof fetch>(async () => result)
		await expect(queryLaya("task", questions, config, { fetchImpl })).resolves.toEqual({ ok: false, reason })
	})

	it("rejects empty choice questions before any network call", async () => {
		const fetchImpl = vi.fn<typeof fetch>(async () => response({}))
		await expect(
			queryLaya("t", { q: { type: "choice", instructions: "x", criteria: [] } }, config, { fetchImpl }),
		).rejects.toBeInstanceOf(TypeError)
		expect(fetchImpl).not.toHaveBeenCalled()
	})

	it("distinguishes cancellation from timeout", async () => {
		const external = new AbortController()
		const cancelled = queryLaya("task", { q: choiceQuestion }, config, {
			fetchImpl: hangingFetch(),
			signal: external.signal,
		})
		external.abort()
		await expect(cancelled).resolves.toEqual({ ok: false, reason: "cancelled" })

		const timedOut = queryLaya("task", { q: choiceQuestion }, config, { fetchImpl: hangingFetch() })
		await vi.advanceTimersByTimeAsync(30100)
		await expect(timedOut).resolves.toEqual({ ok: false, reason: "timeout" })
	})

	it("honors config.timeoutMs overrides and classifies network errors", async () => {
		const timedOut = queryLaya(
			"task",
			{ q: choiceQuestion },
			{ ...config, timeoutMs: 50 },
			{ fetchImpl: hangingFetch() },
		)
		await vi.advanceTimersByTimeAsync(60)
		await expect(timedOut).resolves.toEqual({ ok: false, reason: "timeout" })

		const fetchImpl = vi.fn<typeof fetch>(async () => {
			throw new Error("connect ECONNREFUSED")
		})
		await expect(queryLaya("task", { q: choiceQuestion }, config, { fetchImpl })).resolves.toEqual({
			ok: false,
			reason: "network",
		})
	})
})
