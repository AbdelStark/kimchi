import type { Model } from "@earendil-works/pi-ai"
import { describe, expect, it } from "vitest"
import { createContext } from "../__mocks__/context.js"
import type { LayaChoiceAnswer, LayaDecision } from "./laya-client.js"
import { layaChoiceToRecommendation, resolveLayaRoutingPick } from "./laya-selection.js"

function model(id: string, input: ("text" | "image")[] = ["text"], provider = "kimchi-dev"): Model<string> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider,
		baseUrl: "https://example.test",
		reasoning: false,
		input,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 16000,
	}
}

function context(available: Model<string>[], scopedModels: Model<string>[] = []) {
	return createContext({
		modelRegistry: { getAvailable: () => available },
		scopedModels: scopedModels.map((entry) => ({ model: entry })),
	})
}

function choiceAnswer(choice: string, probabilities: Record<string, number> = {}, choiceIndex = 0): LayaChoiceAnswer {
	return { kind: "choice", choiceIndex, choice, probabilities }
}

function decision(answers: Record<string, LayaChoiceAnswer>): LayaDecision {
	return { answers, latencyMs: 1 }
}

describe("layaChoiceToRecommendation", () => {
	it("maps the chosen criterion to bestModel and carries per-option probabilities", () => {
		expect(layaChoiceToRecommendation(choiceAnswer("kimi-k3", { "kimi-k3": 0.8, "glm-5.2": 0.2 }))).toEqual({
			bestModel: "kimi-k3",
			probabilities: { "kimi-k3": 0.8, "glm-5.2": 0.2 },
		})
	})

	it("tolerates missing probabilities", () => {
		expect(layaChoiceToRecommendation(choiceAnswer("kimi-k3"))).toEqual({ bestModel: "kimi-k3", probabilities: {} })
	})

	it("does not alias the answer's probabilities record", () => {
		const probabilities = { "kimi-k3": 1 }
		const recommendation = layaChoiceToRecommendation(choiceAnswer("kimi-k3", probabilities))
		probabilities["kimi-k3"] = 0
		expect(recommendation.probabilities).toEqual({ "kimi-k3": 1 })
	})
})

describe("resolveLayaRoutingPick", () => {
	const vision = model("vision", ["text", "image"])
	const textOnly = model("text-only")

	it("resolves the laya pick through the shared recommendation path", () => {
		const target = model("kimi-k3")
		const result = resolveLayaRoutingPick(
			decision({ "best-model": choiceAnswer("kimi-k3", { "kimi-k3": 0.9 }) }),
			"best-model",
			context([target]),
			false,
		)
		expect(result).toEqual({
			ok: true,
			model: target,
			answer: choiceAnswer("kimi-k3", { "kimi-k3": 0.9 }),
			recommendation: { bestModel: "kimi-k3", probabilities: { "kimi-k3": 0.9 } },
		})
	})

	it("fails when the choice answer is missing", () => {
		expect(resolveLayaRoutingPick(decision({}), "best-model", context([vision]), false)).toEqual({
			ok: false,
			reason: "missing_choice_answer",
		})
	})

	it("fails with unavailable_recommendation for an unknown pick", () => {
		expect(
			resolveLayaRoutingPick(
				decision({ "best-model": choiceAnswer("unknown-model") }),
				"best-model",
				context([vision]),
				false,
			),
		).toEqual({ ok: false, reason: "unavailable_recommendation" })
	})

	it("falls back to the ranked vision-capable probability when requiresVision", () => {
		expect(
			resolveLayaRoutingPick(
				decision({ "best-model": choiceAnswer("text-only", { "text-only": 0.6, vision: 0.4 }) }),
				"best-model",
				context([textOnly, vision]),
				true,
			),
		).toMatchObject({ ok: true, model: vision })
	})

	it("stops with vision_required when no ranked candidate supports vision", () => {
		expect(
			resolveLayaRoutingPick(
				decision({ "best-model": choiceAnswer("text-only", { "text-only": 1 }) }),
				"best-model",
				context([textOnly]),
				true,
			),
		).toEqual({ ok: false, reason: "vision_required" })
	})
})
