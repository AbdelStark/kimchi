import { AUTO_MODEL_API, AUTO_MODEL_NAME } from "./constants.js"
import {
	clearRoutingAttempt,
	consumeRoutingAttempt,
	type RoutedModelAttempt,
	type RoutedModelRequestOptions,
	registerRoutedApiProvider,
	stageRoutingAttempt,
} from "./routed-model-shared.js"
import type { AutoRoutingState } from "./state.js"

const SOURCE_ID = "kimchi-auto-model"

export type AutoRoutingAttemptResult = Extract<AutoRoutingState, { status: "resolved" | "failed" }>
export type AutoRoutingRequestOptions = RoutedModelRequestOptions
export type AutoRoutingAttempt = RoutedModelAttempt

/** Stage the one routing attempt that the Auto provider will run with Pi's model-request signal. */
export function stageAutoRoutingAttempt(sessionId: string, attempt: AutoRoutingAttempt): void {
	stageRoutingAttempt(sessionId, attempt)
}

/** Drop a staged attempt when its session ends or is reinitialized. */
export function clearAutoRoutingAttempt(sessionId: string): void {
	clearRoutingAttempt(sessionId)
}

/** Claim a staged attempt before running it so concurrent provider calls cannot route twice. */
export async function consumeAutoRoutingAttempt(
	sessionId: string,
	options: AutoRoutingRequestOptions = {},
): Promise<AutoRoutingAttemptResult | undefined> {
	return consumeRoutingAttempt(sessionId, options)
}

export function registerAutoApiProvider(): void {
	registerRoutedApiProvider({ api: AUTO_MODEL_API, sourceId: SOURCE_ID, displayName: AUTO_MODEL_NAME })
}
