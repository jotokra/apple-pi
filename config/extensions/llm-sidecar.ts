/**
 * llm-sidecar.ts — apple-pi tool for a second-opinion LLM cross-check.
 *
 * Tools:
 *   llm_cross_check  → POST a single-turn prompt to an Anthropic-compatible
 *                      sidecar endpoint, get a reply back. (canonical name)
 *   llm_call_minimax → DEPRECATED alias for llm_cross_check. Same tool,
 *                      same params, same execute. Kept so existing skills,
 *                      prompts, and contracts that reference the old name
 *                      keep working; new callers should use llm_cross_check.
 *
 * Use this when the primary model is uncertain and you want a second
 * opinion from a DIFFERENT model. It is never the primary path.
 *
 * Configuration (env vars — NO defaults baked in; or device-local
 *   agent/env.local KEY=VALUE, see _lib/envlocal.ts):
 *   LLM_SIDECAR_URL   — e.g. https://llm.example.com/anthropic
 *                        (an auth-injecting proxy you control, or a direct
 *                        Anthropic-compatible endpoint). The tool POSTs to
 *                        ${LLM_SIDECAR_URL}/v1/messages.
 *   LLM_SIDECAR_MODEL — model id (default "cross-check")
 *   LLM_SIDECAR_KEY   — optional API key sent as x-api-key (omitted if
 *                        unset; an auth-injecting proxy typically strips it)
 *
 * Enabled on demand.
 *
 * Why an alias and not a rename: the workspace contract (agent AGENTS.md,
 * skills, prompts) may hardcode llm_call_minimax. pi's ToolDefinition has
 * no native aliases field (name is singular; defineTool is identity), so
 * the alias is a second defineTool sharing the same parameters + execute.
 * See `.docs/decisions/2026-06-29-env-injection.md` §"llm-sidecar alias".
 */

import "./_lib/envlocal"; // device-local env overrides (agent/env.local)
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const SIDECAR_BASE = (process.env as Record<string, string | undefined>)["LLM_SIDECAR_URL"] ?? "";
const SIDECAR_MODEL = (process.env as Record<string, string | undefined>)["LLM_SIDECAR_MODEL"] ?? "cross-check";
const SIDECAR_KEY = (process.env as Record<string, string | undefined>)["LLM_SIDECAR_KEY"] ?? "";

// Shared parameters + execute so the canonical tool and its alias cannot drift.
const parameters = Type.Object({
	prompt: Type.String({ description: "User message text" }),
	model: Type.Optional(Type.String({ description: `Model id (default '${SIDECAR_MODEL}')` })),
	max_tokens: Type.Optional(Type.Number({ description: "Max tokens to generate (default 1024)" })),
	system: Type.Optional(Type.String({ description: "Optional system prompt override" })),
});

async function execute(_id: string, p: { prompt: string; model?: string; max_tokens?: number; system?: string }) {
	if (!SIDECAR_BASE) {
		return { content: [{ type: "text", text: "llm-sidecar not configured. Set LLM_SIDECAR_URL in your environment." }], details: { ok: false } };
	}
	const body = {
		model: p.model ?? SIDECAR_MODEL,
		max_tokens: p.max_tokens ?? 1024,
		messages: [{ role: "user", content: p.prompt }],
		...(p.system ? { system: p.system } : {}),
	};
	const headers: Record<string, string> = {
		"content-type": "application/json",
		"anthropic-version": "2023-06-01",
	};
	if (SIDECAR_KEY) headers["x-api-key"] = SIDECAR_KEY;
	const res = await fetch(`${SIDECAR_BASE}/v1/messages`, {
		method: "POST",
		headers,
		body: JSON.stringify(body),
	});
	const text = await res.text();
	if (!res.ok) {
		return { content: [{ type: "text", text: `sidecar error ${res.status}: ${text.slice(0, 400)}` }], details: { status: res.status } };
	}
	let parsed: any;
	try {
		parsed = JSON.parse(text);
	} catch {
		return { content: [{ type: "text", text }], details: { raw: true } };
	}
	const reply = (parsed?.content ?? []).map((b: any) => b?.text ?? "").join("\n");
	return { content: [{ type: "text", text: reply }], details: { model_in_response: parsed?.model, usage: parsed?.usage } };
}

const crossCheck = defineTool({
	name: "llm_cross_check",
	label: "LLM Cross-Check (second opinion)",
	description: "Send a single-turn prompt to a configured Anthropic-compatible sidecar for a second opinion from a different model. Not the primary path. Requires LLM_SIDECAR_URL.",
	parameters,
	async execute(id, p) {
		return execute(id, p);
	},
});

// Backward-compat alias (deprecated). Identical params + execute; the
// description steers the model to the canonical name.
const callMinimax = defineTool({
	name: "llm_call_minimax",
	label: "LLM Call MiniMax (alias → llm_cross_check)",
	description: "DEPRECATED alias for llm_cross_check (kept for backward compat with skills/prompts that reference this name). Prefer llm_cross_check. Sends a single-turn prompt to the configured Anthropic-compatible sidecar.",
	parameters,
	async execute(id, p) {
		return execute(id, p);
	},
});

export default function (pi: ExtensionAPI) {
	pi.registerTool(crossCheck);
	pi.registerTool(callMinimax);
}
