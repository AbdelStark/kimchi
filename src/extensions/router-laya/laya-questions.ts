import type { Model } from "@earendil-works/pi-ai"
import type { LayaQuestion } from "./laya-client.js"

export const ROUTING_CHOICE_QUESTION_ID = "best-model"
export const ROUTING_CONFIDENCE_QUESTION_ID = "routing-confidence"

export type LayaRoutingQuestions =
	| {
			ok: true
			questions: Record<string, LayaQuestion>
			choiceId: typeof ROUTING_CHOICE_QUESTION_ID
			confidenceId?: typeof ROUTING_CONFIDENCE_QUESTION_ID
			/** Model ids in criteria order — the choice answer indexes into this list. */
			candidateIds: readonly string[]
	  }
	| { ok: false; reason: "no_candidates" }
	| { ok: false; reason: "single_candidate"; candidateId: string }

export interface BuildLayaRoutingQuestionsOptions {
	/** Note in the instructions that images are present, steering laya toward vision-capable models. */
	requiresVision?: boolean
	/** Add a score question rating the router's own confidence in the pick. */
	includeConfidence?: boolean
}

export function describeRoutingCandidate(model: Model<string>): string {
	const reasoning = model.reasoning ? "yes" : "no"
	const vision = model.input.includes("image") ? "yes" : "no"
	return `- ${model.id}: reasoning=${reasoning}, vision=${vision}, context_window=${model.contextWindow}, max_output=${model.maxTokens}`
}

const SUMMARY = {
	header:
		"You are routing one coding-agent prompt to exactly one worker LLM. Pick the single model whose capabilities best match the task.",
	visionNote: "The prompt contains images, so only a model with vision=yes is usable; do not pick a text-only model.",
	footer:
		"Multi-file, long-context, or deep-reasoning work favors larger context windows and reasoning=yes models; short, simple tasks favor fast non-reasoning models. Choose exactly one option.",
	confidence: "Rate how confident you are in the model pick: higher means the task clearly maps to one option.",
}

/**
 * Build the laya choice question over the given routing candidates. Model ids
 * are the criteria keys (sorted for determinism); per-model capability
 * metadata is embedded in the instructions so the decision model sees more
 * than bare ids. Zero candidates means there is nothing to route to; one
 * candidate is short-circuited by the caller without a laya round-trip.
 */
export function buildLayaRoutingQuestions(
	candidates: ReadonlyMap<string, Model<string>>,
	options: BuildLayaRoutingQuestionsOptions = {},
): LayaRoutingQuestions {
	const candidateIds = [...candidates.keys()].sort((left, right) => left.localeCompare(right))
	if (candidateIds.length === 0) return { ok: false, reason: "no_candidates" }
	if (candidateIds.length === 1) return { ok: false, reason: "single_candidate", candidateId: candidateIds[0] }

	const blocks = candidateIds.map((id) => describeRoutingCandidate(candidates.get(id) as Model<string>))
	const instructions = [
		SUMMARY.header,
		...(options.requiresVision === true ? [SUMMARY.visionNote] : []),
		...blocks,
		SUMMARY.footer,
	].join("\n")

	const questions: Record<string, LayaQuestion> = {
		[ROUTING_CHOICE_QUESTION_ID]: { type: "choice", instructions, criteria: candidateIds },
	}
	let confidenceId: typeof ROUTING_CONFIDENCE_QUESTION_ID | undefined
	if (options.includeConfidence === true) {
		confidenceId = ROUTING_CONFIDENCE_QUESTION_ID
		questions[confidenceId] = { type: "score", instructions: SUMMARY.confidence, criteria: candidateIds }
	}

	return { ok: true, questions, choiceId: ROUTING_CHOICE_QUESTION_ID, confidenceId, candidateIds }
}
