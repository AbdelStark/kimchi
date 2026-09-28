import type { Model } from "@earendil-works/pi-ai"

export const LAYA_MODEL_PROVIDER = "kimchi-dev"
export const LAYA_MODEL_ID = "laya"
export const LAYA_MODEL_REF = `${LAYA_MODEL_PROVIDER}/${LAYA_MODEL_ID}`
export const LAYA_MODEL_API = "kimchi-laya"

/** Display name for the experimental System 1 router. */
export const LAYA_MODEL_NAME = "Laya"

/**
 * What Laya does, in one line.
 *
 * Mirrors AUTO_MODEL_DESCRIPTION: ACP sends it as
 * `SessionConfigSelectOption.description`, and the Pi model registration
 * appends it to the name because Pi's `Model` has no description field.
 */
export const LAYA_MODEL_DESCRIPTION =
	"Picks the best model per prompt with the local laya System 1 decision model (experimental)."

/**
 * The Pi-registered model name: the two constants joined, for surfaces without
 * a description slot. Use this wherever Laya's registered `Model.name` is
 * produced or asserted, so tests cannot drift from what production builds.
 */
export const LAYA_MODEL_PI_NAME = `${LAYA_MODEL_NAME} — ${LAYA_MODEL_DESCRIPTION}`

export function isLayaModel<T extends Pick<Model<string>, "provider" | "id">>(
	model: T | undefined,
): model is T & { provider: typeof LAYA_MODEL_PROVIDER; id: typeof LAYA_MODEL_ID } {
	return model?.provider === LAYA_MODEL_PROVIDER && model.id === LAYA_MODEL_ID
}
