import type { Model } from "@earendil-works/pi-ai"
import { describe, expect, it } from "vitest"
import { buildLayaRoutingQuestions, describeRoutingCandidate } from "./laya-questions.js"

function model(
	id: string,
	options: { input?: ("text" | "image")[]; reasoning?: boolean; contextWindow?: number; maxTokens?: number } = {},
): Model<string> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider: "kimchi-dev",
		baseUrl: "https://example.test",
		reasoning: options.reasoning ?? false,
		input: options.input ?? ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: options.contextWindow ?? 128000,
		maxTokens: options.maxTokens ?? 16000,
	}
}

function candidates(...models: Model<string>[]): Map<string, Model<string>> {
	return new Map(models.map((item) => [item.id, item] as const))
}

describe("describeRoutingCandidate", () => {
	it("renders capability metadata from the router model fields", () => {
		expect(
			describeRoutingCandidate(
				model("kimi-k3", { reasoning: true, input: ["text", "image"], contextWindow: 262144, maxTokens: 64000 }),
			),
		).toBe("- kimi-k3: reasoning=yes, vision=yes, context_window=262144, max_output=64000")
		expect(describeRoutingCandidate(model("glm-5.2", { reasoning: false }))).toBe(
			"- glm-5.2: reasoning=no, vision=no, context_window=128000, max_output=16000",
		)
	})
})

describe("buildLayaRoutingQuestions", () => {
	const three = candidates(
		model("kimi-k3", { input: ["text", "image"], contextWindow: 262144 }),
		model("glm-5.2", { reasoning: true }),
		model("claude-sonnet-4.6"),
	)

	it("builds a choice question over sorted model ids with capability metadata in the instructions", () => {
		const result = buildLayaRoutingQuestions(three)
		expect(result).toMatchObject({
			ok: true,
			choiceId: "best-model",
			confidenceId: undefined,
			candidateIds: ["claude-sonnet-4.6", "glm-5.2", "kimi-k3"],
		})
		if (!result.ok) return
		const choice = result.questions[result.choiceId]
		expect(choice.type).toBe("choice")
		if (choice.type !== "choice") return
		expect(choice.criteria).toEqual(["claude-sonnet-4.6", "glm-5.2", "kimi-k3"])
		expect(choice.instructions).toContain("exactly one worker LLM")
		expect(choice.instructions).toContain(
			"- kimi-k3: reasoning=no, vision=yes, context_window=262144, max_output=16000",
		)
		expect(choice.instructions).toContain(
			"- glm-5.2: reasoning=yes, vision=no, context_window=128000, max_output=16000",
		)
		expect(choice.instructions).not.toContain("contains images")
		expect(Object.keys(result.questions).sort()).toEqual(["best-model"])
	})

	it("single candidate short-circuits with its id instead of a question", () => {
		expect(buildLayaRoutingQuestions(candidates(model("only-model")))).toEqual({
			ok: false,
			reason: "single_candidate",
			candidateId: "only-model",
		})
	})

	it("zero candidates fail with no_candidates", () => {
		expect(buildLayaRoutingQuestions(new Map())).toEqual({ ok: false, reason: "no_candidates" })
	})

	it("requiresVision adds the image note steering to vision-capable models", () => {
		const result = buildLayaRoutingQuestions(three, { requiresVision: true })
		expect(result.ok).toBe(true)
		if (!result.ok) return
		const choice = result.questions[result.choiceId]
		if (choice.type !== "choice") return
		expect(choice.instructions).toContain("contains images")
		expect(choice.instructions).toContain("do not pick a text-only model")
	})

	it("includeConfidence adds a score question over the same criteria", () => {
		const result = buildLayaRoutingQuestions(three, { includeConfidence: true })
		expect(result).toMatchObject({ ok: true, confidenceId: "routing-confidence" })
		if (!result.ok || !result.confidenceId) return
		expect(result.questions[result.confidenceId]).toEqual({
			type: "score",
			instructions: "Rate how confident you are in the model pick: higher means the task clearly maps to one option.",
			criteria: ["claude-sonnet-4.6", "glm-5.2", "kimi-k3"],
		})
	})
})
