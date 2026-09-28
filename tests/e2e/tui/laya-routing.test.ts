import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { Socket } from "node:net"
import { expect, test } from "@microsoft/tui-test"
import {
	INPUT_TIMEOUT_MS,
	STREAM_TIMEOUT_MS,
	viewText,
	waitForText,
	waitForTurnToSettle,
} from "./support/assertions.js"
import { PROMPT_READY, runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

const MODELS = [
	{
		slug: "override",
		displayName: "Fake Override",
		contextWindow: 128_000,
		maxTokens: 8_192,
		input: ["text"] as const,
		provider: "ai-enabler",
	},
	{
		slug: "routed",
		displayName: "Fake Routed",
		contextWindow: 128_000,
		maxTokens: 8_192,
		input: ["text"] as const,
		provider: "ai-enabler",
	},
]

const ROUTED_ROUTER_RESPONSE = { best_model: "routed", probabilities: { routed: 1 } }

interface LayaStubRequest {
	method: string
	url: string
	body: unknown
}

interface LayaStubServer {
	baseUrl: string
	requests: LayaStubRequest[]
	stop(): Promise<void>
}

/**
 * In-process laya-serve stub: answers the /health probe and one static
 * /v1/systemone decision so the e2e drives the real HTTP contract without a
 * Python install.
 */
async function startFakeLayaServe(decisionModelId: string): Promise<LayaStubServer> {
	const requests: LayaStubRequest[] = []
	const sockets = new Set<Socket>()
	const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
		const chunks: Buffer[] = []
		req.on("data", (chunk: Buffer) => chunks.push(chunk))
		req.on("end", () => {
			const raw = Buffer.concat(chunks).toString("utf-8")
			let body: unknown
			try {
				body = raw ? JSON.parse(raw) : undefined
			} catch {
				body = raw
			}
			requests.push({ method: req.method ?? "GET", url: req.url ?? "/", body })
			if (req.method === "GET" && req.url?.startsWith("/health")) {
				res.writeHead(200, { "Content-Type": "application/json" })
				res.end("{}")
				return
			}
			if (req.method === "POST" && req.url?.startsWith("/v1/systemone")) {
				res.writeHead(200, { "Content-Type": "application/json" })
				res.end(
					JSON.stringify({
						answers: {
							"best-model": {
								choice: decisionModelId,
								probabilities: { [decisionModelId]: 0.9 },
								confidence: 0.8,
								answer_confidence: 0.9,
							},
						},
						usage: { input_tokens: 12, output_tokens: 1 },
						routing: { model: "english", repo: "convaiinnovations/laya", reason: "auto" },
					}),
				)
				return
			}
			res.writeHead(404, { "Content-Type": "application/json" })
			res.end(JSON.stringify({ error: `unhandled ${req.method} ${req.url}` }))
		})
	})
	server.on("connection", (socket) => {
		sockets.add(socket)
		socket.on("close", () => sockets.delete(socket))
	})
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject)
		server.listen(0, "127.0.0.1", () => {
			server.off("error", resolve)
			resolve()
		})
	})
	const address = server.address()
	if (!address || typeof address === "string") throw new Error("laya stub did not bind")
	return {
		baseUrl: `http://127.0.0.1:${address.port}`,
		requests,
		stop: async () => {
			for (const socket of sockets) socket.destroy()
			await new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()))
			})
		},
	}
}

function chatRequests(fixture: { fake: { requests: { url: string }[] } }) {
	return fixture.fake.requests.filter((request) => request.url.startsWith("/openai/v1/chat/completions"))
}

function routerRequests(fixture: { fake: { requests: { url: string }[] } }) {
	return fixture.fake.requests.filter((request) => request.url.startsWith("/v1/route"))
}

function requestModel(body: unknown): string | undefined {
	return body && typeof body === "object" && "model" in body && typeof body.model === "string" ? body.model : undefined
}

test("Laya rows up in the picker and routes the prompt through the local sidecar", async ({ terminal }) => {
	const laya = await startFakeLayaServe("routed")
	try {
		await runKimchiSession(
			terminal,
			{
				artifactName: "laya-routing-local-pick",
				providerId: "kimchi-dev",
				initialModel: "routed",
				models: MODELS,
				extraArgs: ["--enable-experimental-features"],
				// Point the sidecar lifecycle at the stub: the health probe reuses a
				// running instance, so no laya-serve process is spawned.
				env: { KIMCHI_LAYA_ENDPOINT: laya.baseUrl },
				responses: [{ stream: ["Laya-routed reply."] }],
			},
			async (fixture, trace) => {
				terminal.write("/model")
				await waitForText(terminal, "/model", { timeoutMs: INPUT_TIMEOUT_MS, full: false })
				terminal.submit("")
				await waitForText(terminal, "Only showing models from configured providers", {
					timeoutMs: INPUT_TIMEOUT_MS,
					full: false,
				})
				trace.step("model picker open")

				terminal.write("laya")
				await waitForText(terminal, "Picks the best model per prompt with the local laya System 1 decision model", {
					timeoutMs: INPUT_TIMEOUT_MS,
					full: false,
				})
				expect(viewText(terminal)).toMatch(/→\s+laya \[kimchi-dev\]/)
				trace.step("Laya row highlighted")

				terminal.submit("")
				await waitForText(terminal, "Default model: kimchi-dev/laya", { timeoutMs: INPUT_TIMEOUT_MS, full: false })
				await waitForText(terminal, "laya → ctrl+p", { timeoutMs: INPUT_TIMEOUT_MS, full: false })
				trace.step("Laya selected")

				terminal.submit("Route with the local decision model")
				await waitForText(terminal, "Laya-routed reply.", { timeoutMs: STREAM_TIMEOUT_MS })
				await waitForText(terminal, "Laya picked routed.", { timeoutMs: STREAM_TIMEOUT_MS, full: false })
				await waitForTurnToSettle(fixture.fake.requests)
				trace.step("prompt routed and pick announced")

				const systemoneCalls = laya.requests.filter((request) => request.url.startsWith("/v1/systemone"))
				expect(systemoneCalls).toHaveLength(1)
				expect(routerRequests(fixture)).toHaveLength(0)
				const chat = chatRequests(fixture)
				expect(chat).toHaveLength(1)
				expect(requestModel(chat[0]?.body)).toBe("routed")
			},
		)
	} finally {
		await laya.stop().catch(() => {})
	}
})

test("Laya falls back to the LLM router with a notice when no sidecar can start", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "laya-routing-fallback",
			providerId: "kimchi-dev",
			initialModel: "laya",
			models: MODELS,
			extraArgs: ["--enable-experimental-features"],
			env: {
				// A definitely-closed loopback endpoint: nothing probes up, so the
				// lifecycle tries to spawn…
				KIMCHI_LAYA_ENDPOINT: "http://127.0.0.1:1",
				// …a binary guaranteed not to exist, deterministically landing on the
				// missing-binary fallback regardless of what the test host has on PATH.
				KIMCHI_LAYA_SERVE_CMD: "laya-serve-not-a-real-binary-for-tui-e2e",
			},
			routerResponses: [ROUTED_ROUTER_RESPONSE],
			responses: [{ stream: ["Fallback routed reply."] }],
		},
		async (fixture, trace) => {
			await waitForText(terminal, "laya → ctrl+p", { timeoutMs: INPUT_TIMEOUT_MS, full: false })
			terminal.submit("Route without a sidecar")
			await waitForText(terminal, "Laya routing unavailable", { timeoutMs: STREAM_TIMEOUT_MS })
			// The notice is one printed line that wraps in the terminal; assert the unwrapped prefix.
			await waitForText(terminal, "Falling back to the LLM", { timeoutMs: STREAM_TIMEOUT_MS, full: false })
			trace.step("fallback notice shown")

			await waitForText(terminal, "Fallback routed reply.", { timeoutMs: STREAM_TIMEOUT_MS })
			await waitForText(terminal, "Laya picked routed.", { timeoutMs: STREAM_TIMEOUT_MS, full: false })
			await waitForTurnToSettle(fixture.fake.requests)
			trace.step("LLM router served the pick")

			expect(routerRequests(fixture)).toHaveLength(1)
			const chat = chatRequests(fixture)
			expect(chat).toHaveLength(1)
			expect(requestModel(chat[0]?.body)).toBe("routed")
		},
	)
})
