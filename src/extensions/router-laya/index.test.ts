import type { Model } from "@earendil-works/pi-ai"
import type { BeforeAgentStartEvent, SessionEntry, SessionStartEvent, Theme } from "@earendil-works/pi-coding-agent"
import { Text } from "@earendil-works/pi-tui"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createContext } from "../__mocks__/context.js"
import { createExtensionApi } from "../__mocks__/extension-api.js"
import { clearRoutingAttempt, consumeRoutingAttempt } from "../router/routed-model-shared.js"
import { clearAutoRoutingState, getAutoRoutingState, resolvedEntry } from "../router/state.js"
import { createLayaModelExtension, type LayaModelExtensionOptions } from "./index.js"
import type { LayaChoiceAnswer, LayaDecision } from "./laya-client.js"
import type { LayaServerResult } from "./laya-serve.js"
import type { LayaRoutingDecision } from "./laya-telemetry.js"
import { LAYA_RESOLUTION_ENTRY } from "./state.js"

const SESSION_ID = "laya-index-session"

function model(id: string, input: ("text" | "image")[] = ["text"], api = "openai-completions"): Model<string> {
	return {
		id,
		name: id,
		api: id === "laya" ? "kimchi-laya" : api,
		provider: "kimchi-dev",
		baseUrl: "https://llm.kimchi.dev/openai/v1",
		reasoning: true,
		input,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 16000,
	}
}

function layaChoice(modelId: string): LayaChoiceAnswer {
	// Criteria are locale-sorted model ids (see laya-questions.ts): "gpt-5.2" -> 0, "kimi-k2.5" -> 1.
	return {
		kind: "choice",
		choice: modelId,
		choiceIndex: modelId === "gpt-5.2" ? 0 : 1,
		probabilities: { [modelId]: 0.9 },
		confidence: 0.9,
		answerConfidence: 0.9,
	}
}

function layaDecision(modelId: string): LayaDecision {
	return {
		answers: { "best-model": layaChoice(modelId) },
		latencyMs: 42,
	}
}

interface HarnessDeps {
	ensureServer?: LayaModelExtensionOptions["ensureServer"]
	queryLaya?: LayaModelExtensionOptions["queryLaya"]
	routeQuery?: LayaModelExtensionOptions["routeQuery"]
	getRouterConfig?: LayaModelExtensionOptions["getRouterConfig"]
}

function harness(deps: HarnessDeps = {}, models: Model<string>[] = [model("kimi-k2.5"), model("gpt-5.2")]) {
	const extension = createExtensionApi()
	const decisions: LayaRoutingDecision[] = []
	createLayaModelExtension({ recordDecision: async (decision) => void decisions.push(decision), ...deps })(
		extension.api,
	)
	const notifications: string[] = []
	const ctx = createContext({
		model: model("laya"),
		sessionManager: { getSessionId: () => SESSION_ID, getBranch: () => [], getEntries: () => [] },
		modelRegistry: {
			getAvailable: () => models,
			find: (provider: string, id: string) => models.find((m) => m.provider === provider && m.id === id),
			getApiKeyForProvider: vi.fn(async () => "gateway-key"),
		},
		scopedModels: [],
		ui: {
			notify: (message: string) => {
				notifications.push(message)
			},
		},
	})
	return { ...extension, ctx, models, notifications, decisions }
}

function beforeEvent(overrides: Partial<BeforeAgentStartEvent> = {}): BeforeAgentStartEvent {
	return {
		type: "before_agent_start",
		prompt: "implement the feature",
		systemPrompt: "system",
		systemPromptOptions: {},
		...overrides,
	} as BeforeAgentStartEvent
}

const serverUp: LayaServerResult = { ok: true, baseUrl: "http://127.0.0.1:8000", reused: true, managed: false }

/** Run the real lifecycle start so per-session state (fallback notice, attempts, state) is fresh. */
async function freshLayaSession(extension: ReturnType<typeof createExtensionApi>, ctx: unknown) {
	await extension.getHandler<SessionStartEvent>("session_start")(
		{ type: "session_start", reason: "new" } as SessionStartEvent,
		ctx as never,
	)
}

afterEach(() => {
	clearRoutingAttempt(SESSION_ID)
	clearAutoRoutingState(SESSION_ID)
	vi.restoreAllMocks()
})

describe("Laya routing hooks", () => {
	it("routes via laya when the sidecar answers, persisting requestedId and the pick entry", async () => {
		const routeQuery = vi.fn(async () => {
			throw new Error("LLM router must not run when laya succeeds")
		})
		const queryLaya: NonNullable<HarnessDeps["queryLaya"]> = async () => ({
			ok: true,
			decision: layaDecision("gpt-5.2"),
		})
		const largePick = { ...model("gpt-5.2"), contextWindow: 1_000_000 }
		const extension = harness({ ensureServer: async () => serverUp, queryLaya, routeQuery }, [
			model("kimi-k2.5"),
			largePick,
		])
		const { ctx, getHandler } = extension
		await freshLayaSession(extension, ctx)

		await getHandler<BeforeAgentStartEvent>("before_agent_start")(beforeEvent(), ctx)
		const state = await consumeRoutingAttempt(SESSION_ID)

		expect(state).toEqual({ status: "resolved", model: largePick, requestedId: "laya" })
		expect(getAutoRoutingState(SESSION_ID)).toMatchObject({ status: "resolved", requestedId: "laya" })
		expect(extension.getAppendedEntries(LAYA_RESOLUTION_ENTRY)).toEqual([resolvedEntry(model("gpt-5.2"))])
		expect(routeQuery).not.toHaveBeenCalled()
		expect(extension.setModel).toHaveBeenCalled() // capability sync toward the pick
		expect(extension.decisions).toHaveLength(1)
		expect(extension.decisions[0]).toMatchObject({
			source: "laya",
			pickedModel: { provider: "kimchi-dev", id: "gpt-5.2" },
			confidence: 0.9,
			probabilities: { "gpt-5.2": 0.9 },
			layaLatencyMs: 42,
			llmLatencyMs: null,
			visionGated: false,
		})
	})

	it("falls back to the LLM router with a one-time notice when laya-serve is missing", async () => {
		const queryLaya = vi.fn(async () => {
			throw new Error("no server, no call")
		})
		const routeQuery: NonNullable<HarnessDeps["routeQuery"]> = async () => ({
			ok: true,
			recommendation: { bestModel: "kimi-k2.5", probabilities: {} },
		})
		const getRouterConfig: NonNullable<HarnessDeps["getRouterConfig"]> = async () => ({
			endpoint: "https://router.test",
			apiKey: "key",
		})
		const extension = harness({
			ensureServer: async () => ({ ok: false, reason: "missing_binary", detail: "ENOENT" }),
			queryLaya,
			routeQuery,
			getRouterConfig,
		})
		const { ctx, getHandler, notifications } = extension
		await freshLayaSession(extension, ctx)

		await getHandler<BeforeAgentStartEvent>("before_agent_start")(beforeEvent(), ctx)
		const first = await consumeRoutingAttempt(SESSION_ID)
		expect(first).toMatchObject({ status: "resolved", model: expect.objectContaining({ id: "kimi-k2.5" }) })
		expect(queryLaya).not.toHaveBeenCalled()
		expect(notifications).toHaveLength(1)
		expect(notifications[0]).toContain("laya-serve is not installed")
		expect(notifications[0]).toContain("Falling back to the LLM router")
		expect(extension.decisions).toHaveLength(1)
		expect(extension.decisions[0]).toMatchObject({
			source: "llm-fallback",
			pickedModel: { provider: "kimchi-dev", id: "kimi-k2.5" },
			confidence: null,
			layaLatencyMs: null,
			llmLatencyMs: expect.any(Number),
		})

		// A second prompt reuses the fallback without re-notifying.
		await getHandler<BeforeAgentStartEvent>("before_agent_start")(beforeEvent(), ctx)
		await consumeRoutingAttempt(SESSION_ID)
		expect(notifications).toHaveLength(1)
	})

	it("falls back when laya /v1/systemone itself fails", async () => {
		const queryLaya: NonNullable<HarnessDeps["queryLaya"]> = async () => ({ ok: false, reason: "http" })
		const routeQuery: NonNullable<HarnessDeps["routeQuery"]> = async () => ({
			ok: true,
			recommendation: { bestModel: "gpt-5.2", probabilities: {} },
		})
		const extension = harness({
			ensureServer: async () => serverUp,
			queryLaya,
			routeQuery,
			getRouterConfig: async () => ({ endpoint: "https://router.test", apiKey: "key" }),
		})
		const { ctx, getHandler, notifications } = extension
		await freshLayaSession(extension, ctx)

		await getHandler<BeforeAgentStartEvent>("before_agent_start")(beforeEvent(), ctx)
		const state = await consumeRoutingAttempt(SESSION_ID)
		expect(state).toMatchObject({ status: "resolved" })
		expect(notifications[0]).toContain("laya-serve returned an HTTP error")
	})

	it("does not fall back when the laya call is cancelled by the user", async () => {
		const queryLaya: NonNullable<HarnessDeps["queryLaya"]> = async () => ({ ok: false, reason: "cancelled" })
		const routeQuery = vi.fn(async () => {
			throw new Error("no fallback on user cancellation")
		})
		const extension = harness({
			ensureServer: async () => serverUp,
			queryLaya,
			routeQuery,
		})
		const { ctx, getHandler, notifications } = extension
		await freshLayaSession(extension, ctx)

		await getHandler<BeforeAgentStartEvent>("before_agent_start")(beforeEvent(), ctx)
		const state = await consumeRoutingAttempt(SESSION_ID)
		expect(state).toEqual({ status: "failed", reason: "cancelled" })
		expect(getAutoRoutingState(SESSION_ID)).toEqual({ status: "unresolved" })
		expect(routeQuery).not.toHaveBeenCalled()
		expect(notifications).toHaveLength(0)
	})

	it("resolves directly without any server when a single candidate exists", async () => {
		const ensureServer = vi.fn(async (): Promise<LayaServerResult> => serverUp)
		const queryLaya = vi.fn(async () => {
			throw new Error("no laya call for one candidate")
		})
		const routeQuery = vi.fn(async () => {
			throw new Error("no LLM router for one candidate")
		})
		const extension = harness({ ensureServer, queryLaya, routeQuery }, [model("kimi-k2.5")])
		const { ctx, getHandler } = extension
		await freshLayaSession(extension, ctx)

		await getHandler<BeforeAgentStartEvent>("before_agent_start")(beforeEvent(), ctx)
		const state = await consumeRoutingAttempt(SESSION_ID)
		expect(state).toMatchObject({ status: "resolved", model: expect.objectContaining({ id: "kimi-k2.5" }) })
		expect(ensureServer).not.toHaveBeenCalled()
		expect(queryLaya).not.toHaveBeenCalled()
		// No decision was made — nothing is logged.
		expect(extension.decisions).toHaveLength(0)
	})

	it("fails with the LLM router's reason when both laya and the fallback fail", async () => {
		const extension = harness({
			ensureServer: async () => ({ ok: false, reason: "boot_failed", detail: "port in use" }),
			routeQuery: async () => ({ ok: false, reason: "network" }),
			getRouterConfig: async () => ({ endpoint: "https://router.test", apiKey: "key" }),
		})
		const { ctx, getHandler, notifications } = extension
		await freshLayaSession(extension, ctx)

		await getHandler<BeforeAgentStartEvent>("before_agent_start")(beforeEvent(), ctx)
		const state = await consumeRoutingAttempt(SESSION_ID)
		expect(state).toEqual({ status: "failed", reason: "network" })
		expect(notifications[0]).toContain("could not start laya-serve")
	})

	it("falls back when laya's pick cannot process the images in the prompt", async () => {
		const queryLaya: NonNullable<HarnessDeps["queryLaya"]> = async () => ({
			ok: true,
			decision: layaDecision("gpt-5.2"),
		})
		const routeQuery: NonNullable<HarnessDeps["routeQuery"]> = async () => ({
			ok: true,
			recommendation: { bestModel: "kimi-k2.5", probabilities: {} },
		})
		const visionModel = model("kimi-k2.5", ["text", "image"])
		const extension = harness(
			{
				ensureServer: async () => serverUp,
				queryLaya,
				routeQuery,
				getRouterConfig: async () => ({ endpoint: "https://router.test", apiKey: "key" }),
			},
			[visionModel, model("gpt-5.2", ["text"])],
		)
		const { ctx, getHandler, notifications } = extension
		await freshLayaSession(extension, ctx)

		await getHandler<BeforeAgentStartEvent>("before_agent_start")(
			beforeEvent({ images: [{ type: "image", data: "abc", mimeType: "image/png" }] }),
			ctx,
		)
		const state = await consumeRoutingAttempt(SESSION_ID)
		expect(state).toMatchObject({ status: "resolved", model: expect.objectContaining({ id: "kimi-k2.5" }) })
		expect(notifications[0]).toContain("images")
	})
})

describe("Laya resolution entry renderer", () => {
	it("renders the persisted pick notice like Auto's", () => {
		const { getEntryRenderer } = harness()
		const renderer = getEntryRenderer(LAYA_RESOLUTION_ENTRY)
		const entry: SessionEntry = {
			type: "custom",
			id: crypto.randomUUID(),
			parentId: null,
			timestamp: new Date().toISOString(),
			customType: LAYA_RESOLUTION_ENTRY,
			data: resolvedEntry(model("kimi-k2.5")),
		}
		const rendered = renderer(entry, {} as never, { fg: (_t: string, text: string) => text } as unknown as Theme)
		expect(rendered).toBeInstanceOf(Text)
		expect(rendered?.render(120).join("\n").trimEnd()).toBe("Laya picked kimi-k2.5.")
	})
})

describe("Laya session_start hydration", () => {
	it("hydrates a persisted laya resolution when the history selects laya", async () => {
		const { ctx, getHandler } = harness({}, [model("kimi-k2.5"), model("gpt-5.2")])
		const resolution: SessionEntry = {
			type: "custom",
			id: crypto.randomUUID(),
			parentId: null,
			timestamp: new Date().toISOString(),
			customType: LAYA_RESOLUTION_ENTRY,
			data: resolvedEntry(model("gpt-5.2")),
		}
		const entries = [
			resolution,
			{
				type: "model_change",
				id: crypto.randomUUID(),
				parentId: null,
				timestamp: new Date().toISOString(),
				provider: "kimchi-dev",
				modelId: "laya",
			} as SessionEntry,
		]
		const hydratedCtx = createContext({
			...ctx,
			model: model("laya"),
			sessionManager: { getSessionId: () => SESSION_ID, getBranch: () => [], getEntries: () => entries },
		})

		const event: SessionStartEvent = { type: "session_start", reason: "resume" } as SessionStartEvent
		await getHandler<SessionStartEvent>("session_start")(event, hydratedCtx)

		expect(getAutoRoutingState(SESSION_ID)).toMatchObject({ status: "resolved", requestedId: "laya" })
	})
})
