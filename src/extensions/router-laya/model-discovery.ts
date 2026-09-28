import type { Model } from "@earendil-works/pi-ai"
import { ModelRuntime } from "@earendil-works/pi-coding-agent"
import { isExperimentalFeaturesEnabled } from "../experimental.js"
import { isLayaModel } from "./constants.js"

let installed = false

function filterLaya<T extends Model<string>>(models: readonly T[]): T[] {
	return isExperimentalFeaturesEnabled() ? [...models] : models.filter((model) => !isLayaModel(model))
}

/**
 * Keep kimchi-dev/laya in Pi's full catalogue so saved sessions and defaults
 * can restore it, while removing it from discovery surfaces unless the launch
 * explicitly enables experimental features. Unlike Auto, laya has no @cast.ai
 * entitlement path: it is strictly opt-in experimental.
 */
export function installLayaModelDiscoveryAdapter(): void {
	if (installed) return
	installed = true

	const getAvailable = ModelRuntime.prototype.getAvailable
	ModelRuntime.prototype.getAvailable = async function (...args) {
		return filterLaya(await getAvailable.apply(this, args))
	}

	const getAvailableSnapshot = ModelRuntime.prototype.getAvailableSnapshot
	ModelRuntime.prototype.getAvailableSnapshot = function () {
		return filterLaya(getAvailableSnapshot.call(this))
	}
}
