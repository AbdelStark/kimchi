import type { Model, ProviderHeaders } from "@earendil-works/pi-ai"
import type { ExtensionAPI, ExtensionContext, ExtensionFactory } from "@earendil-works/pi-coding-agent"
import { Text } from "@earendil-works/pi-tui"
import { autoModelForTarget, hasTargetCapabilities, syncAutoCapabilities } from "../router/capabilities.js"
import { clearRoutingAttempt, stageRoutingAttempt } from "../router/routed-model-shared.js"
import { routeQuery } from "../router/router-client.js"
import { getRouterConfig, type RouterConfig } from "../router/router-config.js"
import { prepareRouterQuery } from "../router/router-query.js"
import { enumerateRoutingCandidates, resolveRecommendation } from "../router/selection.js"
import {
	type AutoFailureReason,
	type AutoRoutingState,
	clearAutoRoutingState,
	getAutoRoutingState,
	resolvedEntry,
	setAutoRoutingState,
} from "../router/state.js"
import { registerLayaApiProvider } from "./api-provider.js"
import { isLayaModel, LAYA_MODEL_ID, LAYA_MODEL_PROVIDER } from "./constants.js"
import { queryLaya } from "./laya-client.js"
import { buildLayaRoutingQuestions } from "./laya-questions.js"
import { resolveLayaRoutingPick } from "./laya-selection.js"
import { ensureLayaServer, resolveLayaApiKey, resolveLayaBaseUrl } from "./laya-serve.js"
import { createRoutingDecision, type LayaRoutingDecision, recordRoutingDecision } from "./laya-telemetry.js"
import {
	formatLayaPickNotice,
	hydrateLayaRoutingState,
	isPersistedLayaResolution,
	LAYA_RESOLUTION_ENTRY,
	sessionSelectsLaya,
} from "./state.js"

/** Session ids already shown the laya→LLM-router fallback notice; reset on session start/shutdown. */
const fallbackNoticeShown = new Set<string>()

type RoutedModel =
	| {
			ok: true
			model: Model<string>
			via: "direct" | "laya" | "llm-router"
			/** Telemetry fields; undefined for the direct single-candidate path (no decision was made). */
			telemetry?: {
				confidence: number | null
				probabilities: Readonly<Record<string, number>> | null
				layaLatencyMs: number | null
				llmLatencyMs: number | null
			}
	  }
	| { ok: false; reason: AutoFailureReason }

/** Why the laya path could not route; phrased for the user-visible fallback notice. */
function layaFailureReason(
	server:
		| { ok: false; reason: "disabled" | "missing_binary" | "boot_failed" | "not_ready"; detail: string }
		| undefined,
	query: { reason: "cancelled" | "timeout" | "network" | "http" | "malformed" } | undefined,
	pick: { reason: "missing_choice_answer" | "unavailable_recommendation" | "vision_required" } | undefined,
): string {
	if (server) {
		if (server.reason === "missing_binary") return "laya-serve is not installed (pip install 'laya[serve]')"
		if (server.reason === "disabled") return "laya-serve autostart is disabled (KIMCHI_LAYA_AUTOSTART=0)"
		return `could not start laya-serve (${server.detail})`
	}
	if (query) {
		if (query.reason === "cancelled") return "routing was cancelled"
		if (query.reason === "timeout") return "laya-serve did not answer in time"
		if (query.reason === "network") return "laya-serve is unreachable"
		if (query.reason === "http") return "laya-serve returned an HTTP error"
		return "laya-serve returned an unreadable response"
	}
	if (pick) {
		if (pick.reason === "vision_required") return "laya picked a model that cannot process this prompt's images"
		if (pick.reason === "unavailable_recommendation") return "laya picked a model that is not available here"
		return "laya did not answer the routing question"
	}
	return "unknown error"
}

export interface LayaModelExtensionOptions {
	/** Require a vision-capable pick for context forwarded as image paths. Mirrors Auto's option. */
	requiresVision?: boolean
	/** Test seams: override the sidecar lifecycle, laya client, and LLM router call. */
	ensureServer?: typeof ensureLayaServer
	queryLaya?: typeof queryLaya
	routeQuery?: typeof routeQuery
	getRouterConfig?: typeof getRouterConfig
	/** Test seams: capture decisions and override the clock for telemetry. */
	recordDecision?: (decision: LayaRoutingDecision) => Promise<unknown>
	now?: () => number
}

export function createLayaModelExtension(options: LayaModelExtensionOptions = {}): ExtensionFactory {
	const ensureServerImpl = options.ensureServer ?? ensureLayaServer
	const queryLayaImpl = options.queryLaya ?? queryLaya
	const routeQueryImpl = options.routeQuery ?? routeQuery
	const getRouterConfigImpl = options.getRouterConfig ?? getRouterConfig
	const recordDecision = options.recordDecision ?? ((decision: LayaRoutingDecision) => recordRoutingDecision(decision))
	const now = options.now ?? Date.now

	return (pi: ExtensionAPI) => {
		// Pi clears custom API handlers on /reload, so register with each extension lifecycle.
		registerLayaApiProvider()

		// The resolution entry doubles as the persisted pick notice, mirroring Auto.
		pi.registerEntryRenderer(LAYA_RESOLUTION_ENTRY, (entry, _options, theme) => {
			if (!isPersistedLayaResolution(entry.data)) return undefined
			return new Text(theme.fg("dim", formatLayaPickNotice(entry.data.modelId)), 0, 0)
		})

		const notifyFallback = (ctx: ExtensionContext, why: string): void => {
			const sessionId = ctx.sessionManager.getSessionId()
			if (fallbackNoticeShown.has(sessionId)) return
			fallbackNoticeShown.add(sessionId)
			ctx.ui.notify(`Laya routing unavailable: ${why}. Falling back to the LLM router for this session.`, "warning")
		}

		/**
		 * Route one prompt: laya-serve System 1 first (skipping the round-trip entirely
		 * when only one candidate exists), then the existing LLM router on any laya-side
		 * failure with a one-time user-visible notice.
		 */
		const routeWithLaya = async (
			ctx: ExtensionContext,
			input: {
				query: string
				requiresVision: boolean
				signal?: AbortSignal
				headers?: ProviderHeaders
			},
		): Promise<RoutedModel> => {
			const candidates = enumerateRoutingCandidates(ctx)

			// One candidate needs no decision model at all — resolve directly, even
			// when the sidecar is down.
			const server = candidates.size > 1 ? await ensureServerImpl() : undefined
			let layaWhy: string | undefined
			let layaLatencyMs: number | null = null

			if (server?.ok === false) {
				layaWhy = layaFailureReason(server, undefined, undefined)
			} else if (server === undefined || server.ok) {
				const built = buildLayaRoutingQuestions(candidates, { requiresVision: input.requiresVision })
				if (built.ok) {
					const baseUrl = server?.ok ? server.baseUrl : resolveLayaBaseUrl()
					const layaResult = await queryLayaImpl(
						input.query,
						built.questions,
						{ endpoint: baseUrl, apiKey: resolveLayaApiKey() },
						{ signal: input.signal },
					)
					if (layaResult.ok) {
						layaLatencyMs = layaResult.decision.latencyMs
						const pick = resolveLayaRoutingPick(layaResult.decision, built.choiceId, ctx, input.requiresVision)
						if (pick.ok) {
							return {
								ok: true,
								model: pick.model,
								via: "laya",
								telemetry: {
									confidence: pick.answer.answerConfidence ?? null,
									probabilities: pick.answer.probabilities,
									layaLatencyMs,
									llmLatencyMs: null,
								},
							}
						}
						layaWhy = layaFailureReason(undefined, undefined, pick)
					} else if (layaResult.reason === "cancelled") {
						return { ok: false, reason: "cancelled" }
					} else {
						layaWhy = layaFailureReason(undefined, layaResult, undefined)
					}
				} else if (!built.ok && built.reason === "single_candidate") {
					const candidate = candidates.get(built.candidateId)
					if (candidate && (!input.requiresVision || candidate.input.includes("image"))) {
						return { ok: true, model: candidate, via: "direct" }
					}
				}
			}

			if (layaWhy) notifyFallback(ctx, layaWhy)

			// LLM router fallback — identical to Auto's flow.
			let config: RouterConfig | undefined
			try {
				config = await getRouterConfigImpl(ctx.modelRegistry)
			} catch {
				config = undefined
			}
			if (!config) return { ok: false, reason: "no_auth" }

			const llmStarted = now()
			const route = await routeQueryImpl(input.query, config, { signal: input.signal, headers: input.headers })
			const llmLatencyMs = now() - llmStarted
			if (!route.ok) {
				return { ok: false, reason: route.reason === "http" ? "router_http" : route.reason }
			}
			const resolution = resolveRecommendation(route.recommendation, ctx, input.requiresVision)
			if (!resolution.ok) return { ok: false, reason: resolution.reason }
			return {
				ok: true,
				model: resolution.model,
				via: "llm-router",
				telemetry: { confidence: null, probabilities: null, layaLatencyMs, llmLatencyMs },
			}
		}

		/** Persist one machine-readable decision (telemetry failures must never break routing). */
		const logDecision = async (
			ctx: ExtensionContext,
			query: string,
			requiresVision: boolean,
			resolution: Extract<RoutedModel, { ok: true }>,
		): Promise<void> => {
			if (!resolution.telemetry) return
			await recordDecision(
				createRoutingDecision({
					sessionId: ctx.sessionManager.getSessionId(),
					query,
					provider: resolution.model.provider,
					modelId: resolution.model.id,
					source: resolution.via === "laya" ? "laya" : "llm-fallback",
					visionGated: requiresVision,
					confidence: resolution.telemetry.confidence,
					probabilities: resolution.telemetry.probabilities,
					layaLatencyMs: resolution.telemetry.layaLatencyMs,
					llmLatencyMs: resolution.telemetry.llmLatencyMs,
				}),
			)
		}

		pi.on("session_start", async (_event, ctx) => {
			const sessionId = ctx.sessionManager.getSessionId()
			clearRoutingAttempt(sessionId)
			fallbackNoticeShown.delete(sessionId)
			const entries = ctx.sessionManager.getEntries()
			let layaModel = ctx.model
			if (!isLayaModel(layaModel)) {
				if (!sessionSelectsLaya(entries)) return
				layaModel = ctx.modelRegistry.find(LAYA_MODEL_PROVIDER, LAYA_MODEL_ID)
				if (!layaModel) return
			}
			const state = hydrateLayaRoutingState(sessionId, entries, ctx.modelRegistry)
			if (state.status !== "resolved") return
			const sessionLayaModel = autoModelForTarget(layaModel, state.model)
			if (!hasTargetCapabilities(ctx.model ?? layaModel, state.model)) {
				await pi.setModel(sessionLayaModel)
			}
		})

		pi.on("model_select", async (event, ctx) => {
			if (!isLayaModel(event.model)) return
			const sessionId = ctx.sessionManager.getSessionId()
			let state = getAutoRoutingState(sessionId)
			if (state.status === "unresolved") {
				state = hydrateLayaRoutingState(sessionId, ctx.sessionManager.getEntries(), ctx.modelRegistry)
			}
			if (state.status !== "resolved") return
			await syncAutoCapabilities(pi, event.model, state.model)
		})

		pi.on("input", (event, ctx) => {
			if (!isLayaModel(ctx.model) || !event.images?.length) return
			const state = getAutoRoutingState(ctx.sessionManager.getSessionId())
			if (state.status !== "resolved" || state.model.input.includes("image")) return
			ctx.ui.notify(
				"Laya cannot process images in this session. Select a vision model with /model, or use /strip-images for existing images.",
				"warning",
			)
			return { action: "handled" }
		})

		pi.on("before_agent_start", (event, ctx) => {
			const layaModel = ctx.model
			if (!isLayaModel(layaModel)) return
			const sessionId = ctx.sessionManager.getSessionId()
			if (getAutoRoutingState(sessionId).status === "unresolved") {
				hydrateLayaRoutingState(sessionId, ctx.sessionManager.getEntries(), ctx.modelRegistry)
			}
			if (getAutoRoutingState(sessionId).status !== "unresolved") return

			setAutoRoutingState(sessionId, { status: "attempting" })

			const requiresVision =
				options.requiresVision === true ||
				Boolean(event.images?.length) ||
				ctx.sessionManager
					.getBranch()
					.some(
						(entry) =>
							entry.type === "message" &&
							(entry.message.role === "user" || entry.message.role === "toolResult") &&
							Array.isArray(entry.message.content) &&
							entry.message.content.some((content) => content.type === "image"),
					)

			stageRoutingAttempt(sessionId, async ({ signal, headers }) => {
				const fail = (reason: AutoFailureReason): Extract<AutoRoutingState, { status: "failed" }> => {
					setAutoRoutingState(sessionId, { status: "unresolved" })
					return { status: "failed", reason }
				}

				const query = await prepareRouterQuery(event.prompt, { containsImages: requiresVision })
				if (!query.ok) return fail(query.reason)

				const resolution = await routeWithLaya(ctx, { query: query.query, requiresVision, signal, headers })
				if (!resolution.ok) return fail(resolution.reason)
				await logDecision(ctx, query.query, requiresVision, resolution)
				if (!(await syncAutoCapabilities(pi, layaModel, resolution.model))) {
					return fail("model_update_failed")
				}

				const state = {
					status: "resolved",
					model: resolution.model,
					requestedId: LAYA_MODEL_ID,
				} satisfies AutoRoutingState
				setAutoRoutingState(sessionId, state)
				pi.appendEntry(LAYA_RESOLUTION_ENTRY, resolvedEntry(resolution.model))
				return state
			})
		})

		pi.on("session_shutdown", (_event, ctx) => {
			const sessionId = ctx.sessionManager.getSessionId()
			fallbackNoticeShown.delete(sessionId)
			clearRoutingAttempt(sessionId)
			clearAutoRoutingState(sessionId)
		})
	}
}

const layaModelExtension = createLayaModelExtension()

export default layaModelExtension
