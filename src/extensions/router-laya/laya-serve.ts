import { spawn } from "node:child_process"

export const DEFAULT_LAYA_BASE_URL = "http://127.0.0.1:8000"
export const LAYA_SERVE_COMMAND = "laya-serve"

const DEFAULT_READINESS_TIMEOUT_MS = 120_000
const DEFAULT_PROBE_INTERVAL_MS = 500
const DEFAULT_PROBE_TIMEOUT_MS = 2_000
const DEFAULT_STOP_TIMEOUT_MS = 3_000
const STOP_POLL_INTERVAL_MS = 50
const STDERR_TAIL_LIMIT = 2_000

/**
 * The slice of a spawned laya-serve child process this manager depends on.
 * Structural so tests can fabricate children without real processes.
 */
export interface LayaManagedChild {
	pid?: number
	kill(signal?: NodeJS.Signals | number): boolean
	on(event: string, listener: (...args: unknown[]) => void): unknown
	once(event: string, listener: (...args: unknown[]) => void): unknown
	stderr?: { on(event: string, listener: (chunk: unknown) => void): unknown } | null
}

export interface LayaSpawnOptions {
	env?: NodeJS.ProcessEnv
	stdio?: unknown
}

export type LayaSpawnImpl = (command: string, args: readonly string[], options: LayaSpawnOptions) => LayaManagedChild

const defaultSpawnImpl: LayaSpawnImpl = (command, args, options) =>
	spawn(command, [...args], options as Parameters<typeof spawn>[2])

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** Endpoint Kimchi talks to: explicit argument > KIMCHI_LAYA_ENDPOINT > loopback default. */
export function resolveLayaBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
	const raw = env.KIMCHI_LAYA_ENDPOINT?.trim()
	return raw ? raw.replace(/\/+$/, "") : DEFAULT_LAYA_BASE_URL
}

/** Bearer token for laya-serve when LAYA_API_KEY auth is enabled on the server. */
export function resolveLayaApiKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
	return env.KIMCHI_LAYA_API_KEY?.trim() || env.LAYA_API_KEY?.trim() || undefined
}

export interface LayaProbeOptions {
	fetchImpl?: typeof fetch
	apiKey?: string
	timeoutMs?: number
	signal?: AbortSignal
}

/**
 * Reachability probe: GET /health. Any HTTP response — even 404 from older
 * laya-serve builds that predate /health — means a live server is answering;
 * only a network failure means "down".
 */
export async function probeLayaServer(baseUrl: string, options: LayaProbeOptions = {}): Promise<boolean> {
	const fetchImpl = options.fetchImpl ?? fetch
	const controller = new AbortController()
	const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS)
	const onExternalAbort = () => controller.abort()
	options.signal?.addEventListener("abort", onExternalAbort, { once: true })
	try {
		const headers: Record<string, string> = {}
		if (options.apiKey) headers.Authorization = `Bearer ${options.apiKey}`
		await fetchImpl(new URL("/health", baseUrl), { signal: controller.signal, headers })
		return true
	} catch {
		return false
	} finally {
		clearTimeout(timeout)
		options.signal?.removeEventListener("abort", onExternalAbort)
	}
}

export type LayaServerResult =
	| { ok: true; baseUrl: string; reused: boolean; managed: boolean; pid?: number }
	| { ok: false; reason: "disabled" | "missing_binary" | "boot_failed" | "not_ready"; detail: string }

export interface EnsureLayaServerOptions {
	baseUrl?: string
	env?: NodeJS.ProcessEnv
	fetchImpl?: typeof fetch
	spawnImpl?: LayaSpawnImpl
	sleepImpl?: (ms: number) => Promise<void>
	autostart?: boolean
	readinessTimeoutMs?: number
	probeIntervalMs?: number
	probeTimeoutMs?: number
}

interface ManagedServer {
	child: LayaManagedChild
	exited: number | null
	spawnError: Error | undefined
	stderrTail: string
}

let managed: ManagedServer | undefined
let exitHookRegistered = false

function isLoopback(baseUrl: string): boolean {
	try {
		const host = new URL(baseUrl).hostname
		return host === "127.0.0.1" || host === "localhost" || host === "[::1]" || host === "::1"
	} catch {
		return false
	}
}

function isEnoent(error: unknown): boolean {
	return typeof error === "object" && error !== null && (error as { code?: string }).code === "ENOENT"
}

function registerExitHook(): void {
	if (exitHookRegistered) return
	exitHookRegistered = true
	process.once("exit", () => {
		try {
			managed?.child.kill()
		} catch {
			// best-effort cleanup on the way out
		}
	})
}

function clearManaged(): void {
	managed = undefined
	exitHookRegistered = false
}

function killManaged(): void {
	const target = managed
	clearManaged()
	if (target && target.exited === null) {
		try {
			target.child.kill()
		} catch {
			// best-effort: the process may already be gone
		}
	}
}

type SpawnOutcome = { ok: true } | { ok: false; reason: "missing_binary" | "boot_failed"; detail: string }

/**
 * Spawn `laya-serve` from PATH (KIMCHI_LAYA_SERVE_CMD overrides), binding the
 * loopback host/port of the endpoint Kimchi will probe. LAYA_* env from the
 * user's environment always wins, so device/threads/models stay user-controlled.
 */
function spawnManaged(baseUrl: string, env: NodeJS.ProcessEnv, spawnImpl: LayaSpawnImpl): SpawnOutcome {
	const url = new URL(baseUrl)
	const childEnv: NodeJS.ProcessEnv = {
		...env,
		LAYA_PRELOAD: env.LAYA_PRELOAD ?? "1",
		LAYA_HOST: env.LAYA_HOST ?? url.hostname.replace(/^\[|\]$/g, ""),
		LAYA_PORT: env.LAYA_PORT ?? (url.port || "8000"),
	}
	const command = env.KIMCHI_LAYA_SERVE_CMD?.trim() || LAYA_SERVE_COMMAND
	let child: LayaManagedChild
	try {
		child = spawnImpl(command, [], { env: childEnv, stdio: ["ignore", "ignore", "pipe"] })
	} catch (error) {
		return {
			ok: false,
			reason: isEnoent(error) ? "missing_binary" : "boot_failed",
			detail: `could not spawn ${command}: ${(error as Error).message}`,
		}
	}
	const tracked: ManagedServer = { child, exited: null, spawnError: undefined, stderrTail: "" }
	child.once("error", (error: unknown) => {
		tracked.spawnError = error instanceof Error ? error : new Error(String(error))
	})
	child.once("exit", (code: unknown) => {
		tracked.exited = typeof code === "number" ? code : -1
	})
	child.stderr?.on("data", (chunk: unknown) => {
		tracked.stderrTail = (tracked.stderrTail + String(chunk)).slice(-STDERR_TAIL_LIMIT)
	})
	managed = tracked
	registerExitHook()
	return { ok: true }
}

/**
 * Make sure a laya-serve is answering at the configured endpoint. Reuses a
 * healthy running instance; otherwise spawns one on loopback (unless
 * KIMCHI_LAYA_AUTOSTART=0) and waits for readiness. Never throws.
 */
export async function ensureLayaServer(options: EnsureLayaServerOptions = {}): Promise<LayaServerResult> {
	const env = options.env ?? process.env
	const fetchImpl = options.fetchImpl ?? fetch
	const sleep = options.sleepImpl ?? realSleep
	const baseUrl = (options.baseUrl ?? resolveLayaBaseUrl(env)).replace(/\/+$/, "")
	const apiKey = resolveLayaApiKey(env)
	const probe = () => probeLayaServer(baseUrl, { fetchImpl, apiKey, timeoutMs: options.probeTimeoutMs })

	if (await probe()) {
		return {
			ok: true,
			baseUrl,
			reused: true,
			managed: managed !== undefined && managed.exited === null,
			pid: managed?.child.pid,
		}
	}
	if (!isLoopback(baseUrl)) {
		return {
			ok: false,
			reason: "not_ready",
			detail: `no laya-serve answers at ${baseUrl}; Kimchi only auto-starts laya-serve on loopback — start it yourself or point KIMCHI_LAYA_ENDPOINT at a running instance`,
		}
	}
	const autostart = options.autostart ?? env.KIMCHI_LAYA_AUTOSTART !== "0"
	if (!autostart) {
		return {
			ok: false,
			reason: "disabled",
			detail:
				"no laya-serve is running and KIMCHI_LAYA_AUTOSTART=0 — install with `pip install 'laya[serve]'` and start `laya-serve`, or unset the flag",
		}
	}

	if (managed && managed.exited !== null) clearManaged()
	if (!managed) {
		const spawned = spawnManaged(baseUrl, env, options.spawnImpl ?? defaultSpawnImpl)
		if (!spawned.ok) return spawned
	}

	const timeoutMs = options.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS
	const intervalMs = options.probeIntervalMs ?? DEFAULT_PROBE_INTERVAL_MS
	const attempts = Math.max(1, Math.ceil(timeoutMs / intervalMs))
	for (let attempt = 0; attempt < attempts; attempt++) {
		const tracked = managed
		if (!tracked) {
			return { ok: false, reason: "missing_binary", detail: "the laya-serve process handle was lost" }
		}
		if (tracked.spawnError) {
			const reason = isEnoent(tracked.spawnError) ? "missing_binary" : "boot_failed"
			clearManaged()
			return {
				ok: false,
				reason,
				detail: `could not start laya-serve: ${tracked.spawnError.message}`,
			}
		}
		if (tracked.exited !== null) {
			const tail = tracked.stderrTail ? `: ${tracked.stderrTail}` : ""
			clearManaged()
			return {
				ok: false,
				reason: "boot_failed",
				detail: `laya-serve exited with code ${tracked.exited} before becoming ready${tail}`,
			}
		}
		if (await probe()) {
			return { ok: true, baseUrl, reused: false, managed: true, pid: managed?.child.pid }
		}
		await sleep(intervalMs)
	}
	killManaged()
	return { ok: false, reason: "not_ready", detail: `laya-serve did not become ready within ${timeoutMs}ms` }
}

/** Stop a laya-serve this module spawned; a no-op for instances we only probed. */
export async function stopLayaServer(
	options: { timeoutMs?: number; sleepImpl?: (ms: number) => Promise<void> } = {},
): Promise<void> {
	const target = managed
	if (!target || target.exited !== null) {
		clearManaged()
		return
	}
	try {
		target.child.kill()
	} catch {
		clearManaged()
		return
	}
	const sleep = options.sleepImpl ?? realSleep
	const attempts = Math.max(1, Math.ceil((options.timeoutMs ?? DEFAULT_STOP_TIMEOUT_MS) / STOP_POLL_INTERVAL_MS))
	for (let i = 0; i < attempts && target.exited === null; i++) await sleep(STOP_POLL_INTERVAL_MS)
	clearManaged()
}

export function getLayaServerStatus(): { managed: boolean; pid?: number } {
	if (!managed || managed.exited !== null) return { managed: false }
	return { managed: true, pid: managed.child.pid }
}
