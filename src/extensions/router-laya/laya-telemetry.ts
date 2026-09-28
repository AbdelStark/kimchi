/**
 * Append-only JSONL decision log for the laya (System 1) router.
 *
 * Every routing decision made with laya selected is appended as one JSON
 * object per line to `<agentDir>/laya-routing/<sessionId>.jsonl`. The log
 * is the live-feed counterpart of the offline benchmark: it records what
 * was picked, with how much calibrated confidence, how fast, and whether
 * the answer came from laya or from the LLM-router fallback.
 *
 * Privacy: the prompt itself is never written — only its SHA-256 (of the
 * prepared router query) so decisions can be correlated with benchmark
 * cases without persisting user text.
 */

import { createHash } from "node:crypto"
import { appendFile, mkdir } from "node:fs/promises"
import { dirname, join } from "node:path"
import { getAgentDir } from "@earendil-works/pi-coding-agent"

/** Opt-out: set KIMCHI_LAYA_TELEMETRY=0 to disable decision logging. */
export const LAYA_TELEMETRY_ENV = "KIMCHI_LAYA_TELEMETRY"

export type LayaRoutingSource = "laya" | "llm-fallback"

export interface LayaRoutingDecision {
	readonly version: 1
	readonly timestamp: string
	readonly sessionId: string
	/** SHA-256 (hex) of the prepared router query — never the raw prompt. */
	readonly promptHash: string
	readonly pickedModel: { readonly provider: string; readonly id: string }
	/** Calibrated answer-confidence from laya; null when the LLM router answered. */
	readonly confidence: number | null
	/** Laya's per-option probability mass; null when the LLM router answered. */
	readonly probabilities: Readonly<Record<string, number>> | null
	/** Wall time of the /v1/systemone call; null when laya was never called. */
	readonly layaLatencyMs: number | null
	/** Wall time of the LLM-router call; null when it was never called. */
	readonly llmLatencyMs: number | null
	readonly source: LayaRoutingSource
	/** True when the prompt carried images and vision gating applied. */
	readonly visionGated: boolean
}

export function layaTelemetryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return env[LAYA_TELEMETRY_ENV] !== "0"
}

/** Log path for one session. Characters unsafe in a filename are replaced. */
export function layaTelemetryPath(agentDir: string, sessionId: string): string {
	const safe = sessionId.replace(/[^a-zA-Z0-9-_.]/g, "_")
	return join(agentDir, "laya-routing", `${safe}.jsonl`)
}

export function hashRoutingQuery(query: string): string {
	return createHash("sha256").update(query, "utf8").digest("hex")
}

export function createRoutingDecision(
	input: {
		sessionId: string
		query: string
		provider: string
		modelId: string
		confidence: number | null
		probabilities: Readonly<Record<string, number>> | null
		layaLatencyMs: number | null
		llmLatencyMs: number | null
		source: LayaRoutingSource
		visionGated: boolean
	},
	now: () => Date = () => new Date(),
): LayaRoutingDecision {
	return {
		version: 1,
		timestamp: now().toISOString(),
		sessionId: input.sessionId,
		promptHash: hashRoutingQuery(input.query),
		pickedModel: { provider: input.provider, id: input.modelId },
		confidence: input.confidence,
		probabilities: input.probabilities,
		layaLatencyMs: input.layaLatencyMs,
		llmLatencyMs: input.llmLatencyMs,
		source: input.source,
		visionGated: input.visionGated,
	}
}

export interface LayaTelemetryIO {
	mkdir: typeof mkdir
	appendFile: typeof appendFile
}

const defaultIO: LayaTelemetryIO = { mkdir, appendFile }

/** Append one decision line. I/O failures must never break routing — they return false. */
export async function appendRoutingDecision(
	path: string,
	decision: LayaRoutingDecision,
	io: LayaTelemetryIO = defaultIO,
): Promise<boolean> {
	try {
		await io.mkdir(dirname(path), { recursive: true })
		await io.appendFile(path, `${JSON.stringify(decision)}\n`, "utf8")
		return true
	} catch {
		return false
	}
}

/**
 * Record a routing decision honoring the opt-out flag.
 * Returns the written decision, or undefined when disabled or when the write failed.
 */
export async function recordRoutingDecision(
	decision: LayaRoutingDecision,
	options: { agentDir?: string; env?: NodeJS.ProcessEnv; io?: LayaTelemetryIO } = {},
): Promise<LayaRoutingDecision | undefined> {
	if (!layaTelemetryEnabled(options.env)) return undefined
	const agentDir = options.agentDir ?? getAgentDir()
	const path = layaTelemetryPath(agentDir, decision.sessionId)
	return (await appendRoutingDecision(path, decision, options.io)) ? decision : undefined
}
