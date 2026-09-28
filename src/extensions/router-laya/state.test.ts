import type { Model } from "@earendil-works/pi-ai"
import type { ModelRegistry, SessionEntry } from "@earendil-works/pi-coding-agent"
import { afterEach, describe, expect, it, vi } from "vitest"
import { clearAutoRoutingState, resolvedEntry, resolveEffectiveModel } from "../router/state.js"
import { formatLayaPickNotice, hydrateLayaRoutingState, LAYA_RESOLUTION_ENTRY, sessionSelectsLaya } from "./state.js"

const SESSION_ID = "laya-state-session"

function model(id: string): Model<string> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider: "kimchi-dev",
		baseUrl: "https://example.test",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 16000,
	}
}

function layaResolution(modelId: string): SessionEntry {
	return {
		type: "custom",
		id: crypto.randomUUID(),
		parentId: null,
		timestamp: new Date().toISOString(),
		customType: LAYA_RESOLUTION_ENTRY,
		data: resolvedEntry(model(modelId)),
	}
}

function modelChange(modelId: string): SessionEntry {
	return {
		type: "model_change",
		id: crypto.randomUUID(),
		parentId: null,
		timestamp: new Date().toISOString(),
		provider: "kimchi-dev",
		modelId,
	}
}

function registry(models: Model<string>[]): Pick<ModelRegistry, "find" | "getAvailable"> {
	return {
		find: vi.fn((provider: string, id: string) => models.find((m) => m.provider === provider && m.id === id)),
		getAvailable: vi.fn(() => models),
	}
}

afterEach(() => {
	clearAutoRoutingState(SESSION_ID)
	vi.restoreAllMocks()
})

describe("sessionSelectsLaya", () => {
	it("is true when the history holds a laya resolution", () => {
		expect(sessionSelectsLaya([layaResolution("routed")])).toBe(true)
	})

	it("is false for malformed resolution entries", () => {
		const malformed: SessionEntry = {
			type: "custom",
			id: crypto.randomUUID(),
			parentId: null,
			timestamp: new Date().toISOString(),
			customType: LAYA_RESOLUTION_ENTRY,
			data: { version: 1, status: "not-real" },
		}
		expect(sessionSelectsLaya([malformed])).toBe(false)
	})

	it("follows the latest model_change entry", () => {
		expect(sessionSelectsLaya([layaResolution("routed"), modelChange("override"), modelChange("laya")])).toBe(true)
		expect(sessionSelectsLaya([layaResolution("routed"), modelChange("override")])).toBe(false)
		// Auto does not masquerade as laya.
		expect(sessionSelectsLaya([layaResolution("routed"), modelChange("auto")])).toBe(false)
	})
})

describe("hydrateLayaRoutingState", () => {
	it("resolves the persisted pick and stamps requestedId for laya-only resolution", () => {
		const target = model("routed")
		const state = hydrateLayaRoutingState(
			SESSION_ID,
			[layaResolution("routed"), modelChange("laya")],
			registry([target]),
		)

		expect(state).toEqual({ status: "resolved", model: target, requestedId: "laya" })
		expect(resolveEffectiveModel(model("laya"), SESSION_ID)).toBe(target)
		// The same session asked for a different virtual model: no resolution.
		expect(resolveEffectiveModel(model("auto"), SESSION_ID)).toEqual(model("auto"))
	})

	it("fails with unavailable_recommendation when the persisted model is gone", () => {
		const state = hydrateLayaRoutingState(SESSION_ID, [layaResolution("gone")], registry([]))
		expect(state).toEqual({ status: "failed", reason: "unavailable_recommendation" })
	})

	it("stays unresolved without a persisted resolution", () => {
		const state = hydrateLayaRoutingState(SESSION_ID, [modelChange("laya")], registry([model("routed")]))
		expect(state).toEqual({ status: "unresolved" })
	})
})

describe("formatLayaPickNotice", () => {
	it("renders the laya pick like Auto's notice", () => {
		expect(formatLayaPickNotice("kimi-k3")).toBe("Laya picked kimi-k3.")
	})
})
