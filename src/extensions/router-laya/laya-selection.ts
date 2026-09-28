import type { Model } from "@earendil-works/pi-ai"
import type { ExtensionContext } from "@earendil-works/pi-coding-agent"
import type { RouteRecommendation } from "../router/router-client.js"
import { resolveRecommendation } from "../router/selection.js"
import type { LayaChoiceAnswer, LayaDecision } from "./laya-client.js"

/**
 * Convert a laya choice answer into the LLM router's RouteRecommendation
 * shape so the unchanged resolveRecommendation can own eligibility, vision
 * gating, and the probability-ordered ranked fallback.
 */
export function layaChoiceToRecommendation(answer: LayaChoiceAnswer): RouteRecommendation {
	return { bestModel: answer.choice, probabilities: { ...answer.probabilities } }
}

export type LayaResolution =
	| { ok: true; model: Model<string>; answer: LayaChoiceAnswer; recommendation: RouteRecommendation }
	| { ok: false; reason: "missing_choice_answer" | "unavailable_recommendation" | "vision_required" }

/**
 * Resolve the model laya picked for the routing choice question. The choice
 * question's criteria are model ids (see laya-questions.ts), so the chosen
 * criterion maps directly onto the recommendation shape. The answer is
 * returned alongside the model so callers can log confidence metadata.
 */
export function resolveLayaRoutingPick(
	decision: LayaDecision,
	choiceId: string,
	ctx: Pick<ExtensionContext, "modelRegistry" | "scopedModels">,
	requiresVision: boolean,
): LayaResolution {
	const answer = decision.answers[choiceId]
	if (answer?.kind !== "choice") return { ok: false, reason: "missing_choice_answer" }
	const recommendation = layaChoiceToRecommendation(answer)
	const resolution = resolveRecommendation(recommendation, ctx, requiresVision)
	if (!resolution.ok) return { ok: false, reason: resolution.reason }
	return { ok: true, model: resolution.model, answer, recommendation }
}
