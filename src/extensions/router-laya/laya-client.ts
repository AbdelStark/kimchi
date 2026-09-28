import type { StreamOptions } from "@earendil-works/pi-ai"
import { Type } from "typebox"
import { Value } from "typebox/value"
import { selectTelemetryProviderHeaders } from "../telemetry/provider-headers.js"

/**
 * Question types accepted by laya's /v1/systemone endpoint (see the model card
 * at https://huggingface.co/convaiinnovations/laya). `criteria` enumerates the
 * options a choice/score question picks or rates.
 */
export type LayaQuestion =
	| { readonly type: "choice"; readonly instructions: string; readonly criteria: readonly string[] }
	| { readonly type: "score"; readonly instructions: string; readonly criteria: readonly string[] }
	| { readonly type: "noul"; readonly instructions: string }

const LayaAnswerSchema = Type.Object(
	{
		choice: Type.Optional(Type.Union([Type.String(), Type.Number()])),
		score: Type.Optional(Type.Number()),
		noul: Type.Optional(Type.String()),
		probabilities: Type.Optional(Type.Record(Type.String(), Type.Number())),
		confidence: Type.Optional(Type.Number()),
		answer_confidence: Type.Optional(Type.Number()),
	},
	{ additionalProperties: true },
)

const LayaResponseSchema = Type.Object(
	{
		answers: Type.Record(Type.String(), LayaAnswerSchema),
		usage: Type.Optional(
			Type.Object(
				{
					input_tokens: Type.Optional(Type.Number()),
					output_tokens: Type.Optional(Type.Number()),
				},
				{ additionalProperties: true },
			),
		),
		routing: Type.Optional(
			Type.Object(
				{
					model: Type.String(),
					repo: Type.Optional(Type.String()),
					reason: Type.Optional(Type.String()),
				},
				{ additionalProperties: true },
			),
		),
	},
	{ additionalProperties: true },
)

interface LayaAnswerMeta {
	/** 1 - normalized entropy across options; higher means a flatter distribution. */
	readonly confidence?: number
	/** Calibrated max-probability per the model card's reliability tests; gate routing on this. */
	readonly answerConfidence?: number
}

export interface LayaChoiceAnswer extends LayaAnswerMeta {
	readonly kind: "choice"
	/** Index into the question's criteria. */
	readonly choiceIndex: number
	/** The chosen criterion string. */
	readonly choice: string
	readonly probabilities: Readonly<Record<string, number>>
}

export interface LayaScoreAnswer extends LayaAnswerMeta {
	readonly kind: "score"
	readonly score: number
	readonly probabilities: Readonly<Record<string, number>>
}

export interface LayaNoulAnswer extends LayaAnswerMeta {
	readonly kind: "noul"
	readonly noul: string
}

export type LayaAnswer = LayaChoiceAnswer | LayaScoreAnswer | LayaNoulAnswer

export interface LayaDecision {
	readonly answers: Readonly<Record<string, LayaAnswer>>
	readonly usage?: { readonly inputTokens?: number; readonly outputTokens?: number }
	readonly routing?: { readonly model: string; readonly repo?: string; readonly reason?: string }
	readonly latencyMs: number
}

export type LayaQueryResult =
	| { ok: true; decision: LayaDecision }
	| { ok: false; reason: "cancelled" | "timeout" | "network" | "http" | "malformed" }

export const LAYA_TIMEOUT_MS = 30000

export interface LayaClientConfig {
	readonly endpoint: string
	readonly apiKey?: string
	readonly timeoutMs?: number
}

type LayaQueryOptions = Pick<StreamOptions, "signal" | "headers"> & { fetchImpl?: typeof fetch }

type RawAnswer = {
	choice?: string | number
	score?: number
	noul?: string
	probabilities?: Record<string, number>
	confidence?: number
	answer_confidence?: number
}

function meta(raw: RawAnswer): LayaAnswerMeta {
	return { confidence: raw.confidence, answerConfidence: raw.answer_confidence }
}

function parseChoice(
	questionId: string,
	question: Extract<LayaQuestion, { type: "choice" }>,
	raw: RawAnswer,
): LayaChoiceAnswer {
	if (raw.choice === undefined) throw new Error(`answer "${questionId}" has no choice field`)
	const criteria = question.criteria
	let choiceIndex: number
	if (typeof raw.choice === "number") {
		choiceIndex = raw.choice
	} else {
		const asIndex = /^\d+$/.test(raw.choice) ? Number(raw.choice) : criteria.indexOf(raw.choice)
		choiceIndex = asIndex
	}
	if (!Number.isInteger(choiceIndex) || choiceIndex < 0 || choiceIndex >= criteria.length) {
		throw new Error(`answer "${questionId}" choice ${String(raw.choice)} is outside ${criteria.length} options`)
	}
	return {
		kind: "choice",
		choiceIndex,
		choice: criteria[choiceIndex],
		probabilities: raw.probabilities ?? {},
		...meta(raw),
	}
}

function parseAnswers(
	questions: Readonly<Record<string, LayaQuestion>>,
	answers: Record<string, RawAnswer>,
): Record<string, LayaAnswer> {
	const parsed: Record<string, LayaAnswer> = {}
	for (const [questionId, question] of Object.entries(questions)) {
		const raw = answers[questionId]
		if (raw === undefined) throw new Error(`missing answer for question "${questionId}"`)
		switch (question.type) {
			case "choice":
				parsed[questionId] = parseChoice(questionId, question, raw)
				break
			case "score": {
				if (typeof raw.score !== "number" || !Number.isFinite(raw.score)) {
					throw new Error(`answer "${questionId}" has no finite score`)
				}
				parsed[questionId] = {
					kind: "score",
					score: raw.score,
					probabilities: raw.probabilities ?? {},
					...meta(raw),
				}
				break
			}
			case "noul": {
				if (typeof raw.noul !== "string") throw new Error(`answer "${questionId}" has no noul string`)
				parsed[questionId] = { kind: "noul", noul: raw.noul, ...meta(raw) }
				break
			}
		}
	}
	return parsed
}

/**
 * POST /v1/systemone against a laya-serve endpoint, validating the response
 * into typed answers. Error contract mirrors router-client routeQuery() so the
 * extension can degrade identically when the sidecar misbehaves.
 */
export async function queryLaya(
	state: string,
	questions: Readonly<Record<string, LayaQuestion>>,
	config: LayaClientConfig,
	options: LayaQueryOptions = {},
): Promise<LayaQueryResult> {
	for (const [id, question] of Object.entries(questions)) {
		if (question.type === "choice" && question.criteria.length === 0) {
			throw new TypeError(`laya choice question "${id}" requires at least one criterion`)
		}
	}

	const endpoint = config.endpoint.replace(/\/+$/, "")
	const controller = new AbortController()
	let timedOut = false
	const timeout = setTimeout(() => {
		timedOut = true
		controller.abort()
	}, config.timeoutMs ?? LAYA_TIMEOUT_MS)
	const onExternalAbort = () => controller.abort()
	if (options.signal?.aborted) controller.abort()
	else options.signal?.addEventListener("abort", onExternalAbort, { once: true })
	const startedAt = Date.now()

	try {
		const headers: Record<string, string> = {
			...selectTelemetryProviderHeaders(options.headers),
			"Content-Type": "application/json",
		}
		if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`
		const response = await (options.fetchImpl ?? fetch)(new URL("/v1/systemone", endpoint), {
			method: "POST",
			headers,
			body: JSON.stringify({ state, questions }),
			signal: controller.signal,
		})
		if (!response.ok) return { ok: false, reason: "http" }

		let data: unknown
		try {
			data = await response.json()
		} catch {
			return { ok: false, reason: "malformed" }
		}
		if (!Value.Check(LayaResponseSchema, data)) return { ok: false, reason: "malformed" }
		try {
			const answers = parseAnswers(questions, data.answers)
			return {
				ok: true,
				decision: {
					answers,
					usage: data.usage
						? { inputTokens: data.usage.input_tokens, outputTokens: data.usage.output_tokens }
						: undefined,
					routing: data.routing
						? { model: data.routing.model, repo: data.routing.repo, reason: data.routing.reason }
						: undefined,
					latencyMs: Date.now() - startedAt,
				},
			}
		} catch {
			return { ok: false, reason: "malformed" }
		}
	} catch {
		if (options.signal?.aborted) return { ok: false, reason: "cancelled" }
		if (timedOut) return { ok: false, reason: "timeout" }
		return { ok: false, reason: "network" }
	} finally {
		clearTimeout(timeout)
		options.signal?.removeEventListener("abort", onExternalAbort)
	}
}
