import type { ModelRegistry, SessionEntry } from "@earendil-works/pi-coding-agent"
import {
	type AutoRoutingState,
	hydrateRoutingResolution,
	isPersistedAutoResolution,
	resolvedEntry,
	sessionSelectsRoutedVirtualModel,
} from "../router/state.js"
import { isLayaModel, LAYA_MODEL_ID } from "./constants.js"

/**
 * Custom entry type that persists the laya System 1 routing pick. Mirrors
 * AUTO_RESOLUTION_ENTRY with a distinct type so Auto and Laya sessions keep
 * separate pick notices and hydration paths.
 */
export const LAYA_RESOLUTION_ENTRY = "kimchi_laya_resolution"

/** Persisted laya resolutions share Auto's entry shape (version/status/provider/modelId). */
export const isPersistedLayaResolution = isPersistedAutoResolution

/** Rendered when the laya router picks a concrete model — mirrors Auto's pick notice. */
export function formatLayaPickNotice(modelId: string): string {
	return `Laya picked ${modelId}.`
}

/** Whether a session's entry history selects the laya System 1 router. */
export function sessionSelectsLaya(entries: readonly SessionEntry[]): boolean {
	return sessionSelectsRoutedVirtualModel(entries, LAYA_RESOLUTION_ENTRY, isLayaModel)
}

/**
 * Hydrate laya routing state from a session's persisted laya resolution entry.
 * The resolved state is stamped with `requestedId: LAYA_MODEL_ID` so
 * `resolveEffectiveModel` only resolves while the session's selected model is
 * the laya virtual model — an Auto selection in the same session stays
 * untouched.
 */
export function hydrateLayaRoutingState(
	sessionId: string,
	entries: readonly SessionEntry[],
	modelRegistry: Pick<ModelRegistry, "find" | "getAvailable">,
): AutoRoutingState {
	return hydrateRoutingResolution(sessionId, entries, modelRegistry, LAYA_RESOLUTION_ENTRY, LAYA_MODEL_ID)
}

export { resolvedEntry }
