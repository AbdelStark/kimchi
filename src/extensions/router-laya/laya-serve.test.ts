import { EventEmitter } from "node:events"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
	DEFAULT_LAYA_BASE_URL,
	ensureLayaServer,
	getLayaServerStatus,
	type LayaManagedChild,
	type LayaSpawnImpl,
	resolveLayaApiKey,
	resolveLayaBaseUrl,
	stopLayaServer,
} from "./laya-serve.js"

const noSleep = vi.fn(async () => {})

function fakeChild(pid = 9001) {
	const emitter = new EventEmitter()
	const kill = vi.fn(() => true)
	const child = {
		pid,
		kill,
		on: (event: string, listener: (...args: unknown[]) => void) => emitter.on(event, listener),
		once: (event: string, listener: (...args: unknown[]) => void) => emitter.once(event, listener),
		stderr: { on: (event: string, listener: (chunk: unknown) => void) => emitter.on(`stderr:${event}`, listener) },
	} satisfies LayaManagedChild
	return {
		child,
		kill,
		/** laya-serve answers the probe: subsequent fetches resolve. */
		emitListening: () => emitter.emit("listening"),
		emitSpawnError: (code: string, message = "spawn failure") =>
			emitter.emit("error", Object.assign(new Error(message), { code })),
		emitExit: (exitCode: number, stderr = "") => {
			if (stderr) emitter.emit("stderr:data", stderr)
			emitter.emit("exit", exitCode)
		},
	}
}

/** fetch stub: resolves when "listening" was emitted, otherwise throws a connection error. */
function fetchUntilListening() {
	let listening = false
	const impl = vi.fn<typeof fetch>(async () => {
		if (!listening) throw new Error("connect ECONNREFUSED")
		return { status: 200 } as Response
	})
	return {
		fetchImpl: impl,
		listen: () => {
			listening = true
		},
	}
}

function spawnRecorder(children: Array<ReturnType<typeof fakeChild>>) {
	const calls: Array<{ command: string; args: readonly string[]; env: NodeJS.ProcessEnv | undefined }> = []
	const spawnImpl: LayaSpawnImpl = (command, args, options) => {
		calls.push({ command, args, env: options.env })
		return children[Math.min(calls.length - 1, children.length - 1)].child
	}
	return { calls, spawnImpl }
}

afterEach(async () => {
	await stopLayaServer({ sleepImpl: noSleep })
	vi.restoreAllMocks()
})

describe("ensureLayaServer", () => {
	it("reuses an already-running instance without spawning", async () => {
		const fetchImpl = vi.fn<typeof fetch>(async () => ({ status: 404 }) as Response)
		const { calls, spawnImpl } = spawnRecorder([])

		await expect(ensureLayaServer({ env: {}, fetchImpl, spawnImpl, sleepImpl: noSleep })).resolves.toEqual({
			ok: true,
			baseUrl: DEFAULT_LAYA_BASE_URL,
			reused: true,
			managed: false,
			pid: undefined,
		})
		expect(calls).toHaveLength(0)
		expect(fetchImpl).toHaveBeenCalledWith(
			new URL("http://127.0.0.1:8000/health"),
			expect.objectContaining({ headers: {} }),
		)
	})

	it("sends the configured bearer token on probes", async () => {
		const fetchImpl = vi.fn<typeof fetch>(async () => ({ status: 200 }) as Response)

		await ensureLayaServer({ env: { KIMCHI_LAYA_API_KEY: "k-secret" }, fetchImpl, sleepImpl: noSleep })

		expect(fetchImpl).toHaveBeenCalledWith(
			new URL("http://127.0.0.1:8000/health"),
			expect.objectContaining({ headers: { Authorization: "Bearer k-secret" } }),
		)
	})

	it("falls back to LAYA_API_KEY when KIMCHI_LAYA_API_KEY is unset", () => {
		expect(resolveLayaApiKey({})).toBeUndefined()
		expect(resolveLayaApiKey({ LAYA_API_KEY: "a" })).toBe("a")
		expect(resolveLayaApiKey({ LAYA_API_KEY: "a", KIMCHI_LAYA_API_KEY: "b" })).toBe("b")
	})

	it("reports disabled when autostart is off and nothing answers", async () => {
		const fetchImpl = vi.fn<typeof fetch>(async () => {
			throw new Error("connect ECONNREFUSED")
		})
		const { calls, spawnImpl } = spawnRecorder([])

		const result = await ensureLayaServer({
			env: { KIMCHI_LAYA_AUTOSTART: "0" },
			fetchImpl,
			spawnImpl,
			sleepImpl: noSleep,
		})

		expect(result).toEqual({
			ok: false,
			reason: "disabled",
			detail: expect.stringContaining("pip install 'laya[serve]'"),
		})
		expect(calls).toHaveLength(0)
	})

	it("refuses to auto-start against a remote endpoint", async () => {
		const fetchImpl = vi.fn<typeof fetch>(async () => {
			throw new Error("connect ECONNREFUSED")
		})
		const { calls, spawnImpl } = spawnRecorder([])

		const result = await ensureLayaServer({
			env: { KIMCHI_LAYA_ENDPOINT: "http://192.168.1.10:8000" },
			fetchImpl,
			spawnImpl,
			sleepImpl: noSleep,
		})

		expect(result).toEqual({
			ok: false,
			reason: "not_ready",
			detail: expect.stringContaining("only auto-starts laya-serve on loopback"),
		})
		expect(calls).toHaveLength(0)
	})

	it("spawns laya-serve with LAYA_PRELOAD and waits for readiness", async () => {
		const fake = fetchUntilListening()
		const rec = fakeChild(4242)
		const { calls, spawnImpl } = spawnRecorder([rec])

		const pending = ensureLayaServer({
			env: {},
			fetchImpl: fake.fetchImpl,
			spawnImpl,
			sleepImpl: noSleep,
			probeIntervalMs: 10,
		})
		fake.listen()
		await expect(pending).resolves.toEqual({
			ok: true,
			baseUrl: DEFAULT_LAYA_BASE_URL,
			reused: false,
			managed: true,
			pid: 4242,
		})
		expect(calls).toHaveLength(1)
		expect(calls[0].command).toBe("laya-serve")
		expect(calls[0].args).toEqual([])
		expect(calls[0].env?.LAYA_PRELOAD).toBe("1")
		expect(calls[0].env?.LAYA_HOST).toBe("127.0.0.1")
		expect(calls[0].env?.LAYA_PORT).toBe("8000")
		expect(getLayaServerStatus()).toEqual({ managed: true, pid: 4242 })
	})

	it("passes the endpoint's custom port to LAYA_PORT when spawning", async () => {
		const fake = fetchUntilListening()
		const rec = fakeChild(7777)
		const { calls, spawnImpl } = spawnRecorder([rec])

		const pending = ensureLayaServer({
			env: { KIMCHI_LAYA_ENDPOINT: "http://127.0.0.1:9377/" },
			fetchImpl: fake.fetchImpl,
			spawnImpl,
			sleepImpl: noSleep,
			probeIntervalMs: 10,
		})
		fake.listen()
		const result = await pending

		expect(result.ok).toBe(true)
		expect(result).toMatchObject({ baseUrl: "http://127.0.0.1:9377" })
		expect(calls[0].env?.LAYA_PORT).toBe("9377")
	})

	it("preserves user-set LAYA_* env when spawning", async () => {
		const fake = fetchUntilListening()
		const rec = fakeChild(4243)
		const { calls, spawnImpl } = spawnRecorder([rec])

		const pending = ensureLayaServer({
			env: { LAYA_PRELOAD: "0", LAYA_DEVICE: "mps", KIMCHI_LAYA_SERVE_CMD: "/opt/venv/bin/laya-serve" },
			fetchImpl: fake.fetchImpl,
			spawnImpl,
			sleepImpl: noSleep,
			probeIntervalMs: 10,
		})
		fake.listen()
		await pending

		expect(calls[0].command).toBe("/opt/venv/bin/laya-serve")
		expect(calls[0].env?.LAYA_PRELOAD).toBe("0")
		expect(calls[0].env?.LAYA_DEVICE).toBe("mps")
	})

	it("classifies a synchronous ENOENT spawn failure as missing_binary", async () => {
		const fetchImpl = vi.fn<typeof fetch>(async () => {
			throw new Error("connect ECONNREFUSED")
		})
		const spawnImpl: LayaSpawnImpl = () => {
			throw Object.assign(new Error("spawn laya-serve ENOENT"), { code: "ENOENT" })
		}

		const result = await ensureLayaServer({ env: {}, fetchImpl, spawnImpl, sleepImpl: noSleep })

		expect(result.ok).toBe(false)
		expect(result).toMatchObject({ ok: false, reason: "missing_binary" })
	})

	it("classifies an async ENOENT spawn error as missing_binary", async () => {
		const fetchImpl = vi.fn<typeof fetch>(async () => {
			throw new Error("connect ECONNREFUSED")
		})
		const rec = fakeChild()
		// Emit after spawnManaged has attached its listeners but before the poll loop probes again.
		const spawnImpl: LayaSpawnImpl = () => {
			queueMicrotask(() => rec.emitSpawnError("ENOENT", "spawn laya-serve ENOENT"))
			return rec.child
		}

		const result = await ensureLayaServer({ env: {}, fetchImpl, spawnImpl, sleepImpl: noSleep, probeIntervalMs: 10 })

		expect(result).toMatchObject({ ok: false, reason: "missing_binary" })
		expect(result).toMatchObject({ detail: expect.stringContaining("ENOENT") })
	})

	it("reports boot_failed with the stderr tail when laya-serve exits early", async () => {
		const fetchImpl = vi.fn<typeof fetch>(async () => {
			throw new Error("connect ECONNREFUSED")
		})
		const rec = fakeChild()
		// Emit after spawnManaged has attached its listeners but before the poll loop probes again.
		const spawnImpl: LayaSpawnImpl = () => {
			queueMicrotask(() => rec.emitExit(1, "Traceback: ModuleNotFoundError: No module named 'torch'"))
			return rec.child
		}

		const result = await ensureLayaServer({ env: {}, fetchImpl, spawnImpl, sleepImpl: noSleep, probeIntervalMs: 10 })

		expect(result.ok).toBe(false)
		expect(result).toMatchObject({
			ok: false,
			reason: "boot_failed",
			detail: expect.stringContaining("exited with code 1"),
		})
		expect(result).toMatchObject({ detail: expect.stringContaining("Traceback") })
		expect(getLayaServerStatus()).toEqual({ managed: false })
	})

	it("kills the child and reports not_ready when readiness times out", async () => {
		const fetchImpl = vi.fn<typeof fetch>(async () => {
			throw new Error("connect ECONNREFUSED")
		})
		const rec = fakeChild()
		const { spawnImpl } = spawnRecorder([rec])

		const result = await ensureLayaServer({
			env: {},
			fetchImpl,
			spawnImpl,
			sleepImpl: noSleep,
			readinessTimeoutMs: 40,
			probeIntervalMs: 10,
		})

		expect(result).toEqual({
			ok: false,
			reason: "not_ready",
			detail: "laya-serve did not become ready within 40ms",
		})
		expect(rec.kill).toHaveBeenCalledTimes(1)
		expect(getLayaServerStatus()).toEqual({ managed: false })
	})

	it("reuses a managed running server on the next ensure call", async () => {
		const fake = fetchUntilListening()
		const rec = fakeChild(4242)
		const { calls, spawnImpl } = spawnRecorder([rec])

		const first = ensureLayaServer({
			env: {},
			fetchImpl: fake.fetchImpl,
			spawnImpl,
			sleepImpl: noSleep,
			probeIntervalMs: 10,
		})
		fake.listen()
		await first
		const second = await ensureLayaServer({ env: {}, fetchImpl: fake.fetchImpl, spawnImpl, sleepImpl: noSleep })

		expect(second).toEqual({ ok: true, baseUrl: DEFAULT_LAYA_BASE_URL, reused: true, managed: true, pid: 4242 })
		expect(calls).toHaveLength(1)
	})

	it("stopLayaServer kills a spawned server and clears status", async () => {
		const fake = fetchUntilListening()
		const rec = fakeChild(5555)
		const { spawnImpl } = spawnRecorder([rec])

		const pending = ensureLayaServer({
			env: {},
			fetchImpl: fake.fetchImpl,
			spawnImpl,
			sleepImpl: noSleep,
			probeIntervalMs: 10,
		})
		fake.listen()
		await pending
		expect(getLayaServerStatus()).toEqual({ managed: true, pid: 5555 })

		const stopping = stopLayaServer({ sleepImpl: noSleep })
		rec.emitExit(0)
		await stopping

		expect(rec.kill).toHaveBeenCalledTimes(1)
		expect(getLayaServerStatus()).toEqual({ managed: false })
	})

	it("stopLayaServer is a no-op when nothing was spawned", async () => {
		const fetchImpl = vi.fn<typeof fetch>(async () => ({ status: 200 }) as Response)

		await ensureLayaServer({ env: {}, fetchImpl, sleepImpl: noSleep })
		await expect(stopLayaServer({ sleepImpl: noSleep })).resolves.toBeUndefined()
		expect(getLayaServerStatus()).toEqual({ managed: false })
	})
})

describe("resolveLayaBaseUrl", () => {
	it("defaults to the loopback endpoint", () => {
		expect(resolveLayaBaseUrl({})).toBe(DEFAULT_LAYA_BASE_URL)
	})

	it("honors KIMCHI_LAYA_ENDPOINT and strips trailing slashes", () => {
		expect(resolveLayaBaseUrl({ KIMCHI_LAYA_ENDPOINT: " http://127.0.0.1:9000/ " })).toBe("http://127.0.0.1:9000")
	})
})
