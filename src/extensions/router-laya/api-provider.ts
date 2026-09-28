import { registerRoutedApiProvider } from "../router/routed-model-shared.js"
import { LAYA_MODEL_API, LAYA_MODEL_NAME } from "./constants.js"

const SOURCE_ID = "kimchi-laya-model"

export function registerLayaApiProvider(): void {
	registerRoutedApiProvider({ api: LAYA_MODEL_API, sourceId: SOURCE_ID, displayName: LAYA_MODEL_NAME })
}
