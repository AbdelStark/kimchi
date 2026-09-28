import {
	type Api,
	type AssistantMessage,
	createAssistantMessageEventStream,
	getApiProvider,
	type Model,
	registerApiProvider,
	unregisterApiProviders,
} from "@earendil-works/pi-ai/compat"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { clearRoutingAttempt, stageRoutingAttempt } from "../router/routed-model-shared.js"
import { type AutoRoutingState, clearAutoRoutingState, setAutoRoutingState } from "../router/state.js"
import { registerLayaApiProvider } from "./api-provider.js"
import { LAYA_MODEL_API, LAYA_MODEL_ID } from "./constants.js"

const SESSION_ID = "laya-provider-test-session"
const TARGET_API = "kimchi-laya-test-target"
const TARGET_SOURCE = "kimchi-laya-test-target-source"

function model(id: string, api: string): Model<Api> {
	return {
		id,
		name: id,
		api,
		provider: "kimchi-dev",
		baseUrl: "https://llm.kimchi.dev/openai/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4000,
	}
}

function doneMessage(target: Model<Api>): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "delegated" }],
		api: target.api,
		provider: target.provider,
		model: target.id,
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	}
}

const targetStream = vi.fn((target: Model<Api>) => {
	const stream = createAssistantMessageEventStream()
	queueMicrotask(() => stream.push({ type: "done", reason: "stop", message: doneMessage(target) }))
	return stream
})

beforeAll(() => {
	registerLayaApiProvider()
	registerApiProvider({ api: TARGET_API, stream: targetStream, streamSimple: targetStream }, TARGET_SOURCE)
})

afterEach(() => {
	clearRoutingAttempt(SESSION_ID)
	clearAutoRoutingState(SESSION_ID)
	targetStream.mockClear()
	vi.restoreAllMocks()
})

afterAll(() => unregisterApiProviders(TARGET_SOURCE))

describe("Laya model API provider", () => {
	it("delegates with the concrete model identity when laya resolved", async () => {
		const laya = model(LAYA_MODEL_ID, LAYA_MODEL_API)
		const target = model("concrete", TARGET_API)
		setAutoRoutingState(SESSION_ID, { status: "resolved", model: target, requestedId: LAYA_MODEL_ID })

		const provider = getApiProvider(LAYA_MODEL_API)
		if (!provider) throw new Error("Laya API provider was not registered")
		const result = await provider
			.streamSimple(laya, { messages: [] }, { sessionId: SESSION_ID, maxTokens: 3000 })
			.result()

		expect(result).toMatchObject({ provider: "kimchi-dev", model: "concrete", api: TARGET_API })
		expect(targetStream).toHaveBeenCalledWith(
			target,
			{ messages: [] },
			expect.objectContaining({ sessionId: SESSION_ID, maxTokens: 3000 }),
		)
	})

	it("consumes the staged routing attempt with the request's signal and headers", async () => {
		const laya = model(LAYA_MODEL_ID, LAYA_MODEL_API)
		const target = model("concrete", TARGET_API)
		const headers = { "X-Session-Id": "process-session" }
		const attempt = vi.fn(
			async () =>
				({
					status: "resolved",
					model: target,
					requestedId: LAYA_MODEL_ID,
				}) satisfies AutoRoutingState,
		)
		setAutoRoutingState(SESSION_ID, { status: "attempting" })
		stageRoutingAttempt(SESSION_ID, attempt)

		const provider = getApiProvider(LAYA_MODEL_API)
		if (!provider) throw new Error("Laya API provider was not registered")
		await provider.streamSimple(laya, { messages: [] }, { sessionId: SESSION_ID, headers }).result()

		expect(attempt).toHaveBeenCalledWith({ signal: undefined, headers })
	})

	it("returns an actionable terminal error naming Laya when there is no usable resolution", async () => {
		const laya = model(LAYA_MODEL_ID, LAYA_MODEL_API)
		const provider = getApiProvider(LAYA_MODEL_API)
		if (!provider) throw new Error("Laya API provider was not registered")

		const result = await provider.streamSimple(laya, { messages: [] }, { sessionId: SESSION_ID }).result()

		expect(result.stopReason).toBe("error")
		expect(result.errorMessage).toContain("Laya is unavailable")
		expect(result.errorMessage).toContain("retry Laya")
		expect(result.errorMessage).toContain("/model")
		expect(targetStream).not.toHaveBeenCalled()
	})
})
