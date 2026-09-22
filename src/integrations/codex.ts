import { mkdirSync, readFileSync } from "node:fs"
import { dirname } from "node:path"
import { log } from "@clack/prompts"
import { parse, stringify, TomlDate, type TomlTable } from "smol-toml"
import { writeFileAtomic, writeJson } from "../config/json.js"
import type { ConfigScope } from "../config/scope.js"
import { resolveScopePath } from "../config/scope.js"
import type { ModelMetadata } from "../models.js"
import { confirm } from "../setup-wizard/prompt.js"
import { backupToolConfig } from "./config-backup.js"
import { BASE_URL, PROVIDER_NAME } from "./constants.js"
import { detectBinaryFactory } from "./detect.js"
import { resolveModelRole } from "./models.js"
import { register } from "./registry.js"

const CODEX_CONFIG_PATH = "~/.codex/config.toml"
const CODEX_CATALOG_PATH = "~/.codex/model_catalog.json"

/** Escape a string for inclusion inside a TOML basic double-quoted string. */
function tomlEscape(value: string): string {
	return value
		.replace(/\\/g, "\\\\")
		.replace(/"/g, '\\"')
		.replace(/\n/g, "\\n")
		.replace(/\r/g, "\\r")
		.replace(/\t/g, "\\t")
}

/**
 * Build the Codex config.toml body pointing at the kimchi proxy. The API
 * key is embedded directly as a static `Authorization` header so that
 * Codex works when launched directly (`codex`) — not just via `kimchi codex`.
 *
 * @param apiKey     - Kimchi API key, written as a Bearer token in http_headers.
 * @param modelSlug  - Slug of the resolved "main" model, written to the top-level `model` key.
 * @param catalogPath - Resolved absolute path to the model catalog JSON file.
 */
export function buildCodexToml(apiKey: string, modelSlug: string, catalogPath: string): string {
	const escapedSlug = tomlEscape(modelSlug)
	const escapedCatalogPath = tomlEscape(catalogPath)
	const escapedKey = tomlEscape(apiKey)
	return `model_provider = "${PROVIDER_NAME}"
model = "${escapedSlug}"
model_catalog_json = "${escapedCatalogPath}"

[model_providers.${PROVIDER_NAME}]
name = "Kimchi Gateway"
base_url = "${tomlEscape(BASE_URL)}"
http_headers = { Authorization = "Bearer ${escapedKey}" }
wire_api = "responses"
`
}

interface CodexReasoningLevel {
	effort: "low" | "medium" | "high"
	description: string
}

interface CodexModelEntry {
	slug: string
	display_name: string
	name: string
	model: string
	provider: string
	context_window: number
	truncation_policy: { mode: "tokens"; limit: number }
	shell_type: "shell_command"
	visibility: "list"
	supported_in_api: boolean
	priority: number
	base_instructions: string
	supports_tools: boolean
	supports_parallel_tool_calls: boolean
	experimental_supported_tools: string[]
	supports_reasoning_summaries: boolean
	support_verbosity: boolean
	supported_reasoning_levels: CodexReasoningLevel[]
}

export interface CodexModelCatalog {
	models: CodexModelEntry[]
}

/**
 * Build the Codex model catalog (`~/.codex/model_catalog.json`). Mirrors
 * the structure Codex expects from a user-provided catalog: per-model
 * reasoning levels, truncation policy, and capability flags. Priority
 * is assigned by index so the first model wins any picker ordering.
 *
 * Pure so the snapshot is testable without touching the filesystem.
 */
export function buildModelCatalog(models: readonly ModelMetadata[]): CodexModelCatalog {
	const REASONING_LEVELS: CodexReasoningLevel[] = [
		{ effort: "low", description: "Low reasoning effort" },
		{ effort: "medium", description: "Medium reasoning effort" },
		{ effort: "high", description: "High reasoning effort" },
	]

	const entries: CodexModelEntry[] = models.map((m, index) => ({
		slug: m.slug,
		display_name: m.display_name,
		name: m.slug,
		model: m.slug,
		provider: PROVIDER_NAME,
		context_window: m.limits.context_window,
		truncation_policy: { mode: "tokens", limit: m.limits.context_window },
		shell_type: "shell_command",
		visibility: "list",
		supported_in_api: true,
		priority: (index + 1) * 10,
		base_instructions: "You are a helpful coding assistant.",
		supports_tools: true,
		supports_parallel_tool_calls: true,
		experimental_supported_tools: [],
		supports_reasoning_summaries: m.reasoning,
		support_verbosity: m.reasoning,
		supported_reasoning_levels: m.reasoning ? REASONING_LEVELS : [],
	}))

	return { models: entries }
}

/** Get the provider table without accepting a scalar/array that setup would destroy. */
function providersTable(config: TomlTable): TomlTable {
	const providers = config.model_providers ?? {}
	if (typeof providers !== "object" || Array.isArray(providers) || providers instanceof TomlDate) {
		throw new Error("Codex model_providers must be a TOML table. No changes written.")
	}
	return providers
}

/**
 * Replace only the selected model, catalog and Kimchi provider. Parsing keeps
 * user settings in their original tables, including quoted keys and multiline
 * values. Serialization normalizes formatting; the backup retains comments.
 */
export function mergeCodexToml(existingText: string, freshToml: string): string {
	let existing: TomlTable
	let fresh: TomlTable
	try {
		existing = parse(existingText, { integersAsBigInt: true })
		fresh = parse(freshToml, { integersAsBigInt: true })
	} catch {
		// Parser errors include source excerpts, which may contain API keys.
		throw new Error("Codex config is invalid TOML. No changes written.")
	}
	const merged = {
		...existing,
		...fresh,
		model_providers: { ...providersTable(existing), ...providersTable(fresh) },
	}
	return stringify(merged, { numbersAsFloat: true })
}

async function writeCodex(
	scope: ConfigScope,
	apiKey: string,
	models: readonly ModelMetadata[],
	_options?: { telemetryEnabled?: boolean },
): Promise<void> {
	if (!apiKey) {
		throw new Error("API key not configured")
	}
	if (!models || models.length === 0) {
		throw new Error("No models available — is the API key valid?")
	}

	const configPath = resolveScopePath(scope, CODEX_CONFIG_PATH)
	const catalogPath = resolveScopePath(scope, CODEX_CATALOG_PATH)

	mkdirSync(dirname(configPath), { recursive: true })

	let existingText = ""
	try {
		existingText = readFileSync(configPath, "utf-8")
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err
	}

	const main = resolveModelRole(models, "main")
	const mainSlug = main?.slug ?? models[0].slug

	const freshToml = buildCodexToml(apiKey, mainSlug, catalogPath)
	const merged = mergeCodexToml(existingText, freshToml)

	log.warn(
		`This switches Codex's default model and provider to Kimchi in ${configPath}, ` +
			"including when you launch codex directly. Existing settings are preserved, but TOML comments and formatting are rewritten. " +
			`The model catalog at ${catalogPath} will be replaced. Existing files will be backed up before writing.`,
	)
	if (process.stdin.isTTY) {
		const answer = await confirm({
			message: "Apply these changes to Codex configuration?",
			initialValue: false,
			backable: false,
		})
		if (answer.kind !== "next") throw new Error("User cancelled the settings update.")
		if (!answer.value) throw new Error("User declined the settings update.")
	}

	// Back up both files before changing either, so a backup failure is harmless.
	backupToolConfig(configPath)
	backupToolConfig(catalogPath)
	writeJson(catalogPath, buildModelCatalog(models))
	writeFileAtomic(configPath, merged)
}

register({
	id: "codex",
	name: "Codex",
	description: "OpenAI Codex CLI",
	configPath: CODEX_CONFIG_PATH,
	binaryName: "codex",
	isInstalled: detectBinaryFactory("codex"),
	write: writeCodex,
	interactiveWrite: true,
})
