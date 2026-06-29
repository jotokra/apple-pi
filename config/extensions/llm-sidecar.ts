/**
 * llm-sidecar.ts — apple-pi tool for a second-opinion LLM cross-check.
 *
 * Tool:
 *   llm_cross_check → POST a single-turn prompt to an Anthropic-compatible
 *                     sidecar endpoint, get a reply back.
 *
 * Use this when the primary model is uncertain and you want a second
 * opinion from a DIFFERENT model. It is never the primary path.
 *
 * Configuration (env vars — NO defaults baked in; or device-local
 *   agent/env.local KEY=VALUE, see _lib/envlocal.ts):
 *   LLM_SIDECAR_URL   — e.g. https://llm.example.com/anthropic
 *                        (an auth-injecting proxy you control, or a direct
 *                        Anthropic-compatible endpoint)
 *   LLM_SIDECAR_MODEL — model id (default "cross-check")
 *   LLM_SIDECAR_KEY   — optional API key sent as x-api-key (the proxy may
 *                        strip/replace it)
 *
 * Enabled on demand.
 */

import "./_lib/envlocal"; // device-local env overrides (agent/env.local)
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const SIDECAR_BASE = (process.env as Record<string, string | undefined>)["LLM_SIDECAR_URL"] ?? "";
const SIDECAR_MODEL = (process.env as Record<string, string | undefined>)["LLM_SIDECAR_MODEL"] ?? "cross-check";
const SIDECAR_KEY = (process.env as Record<string, string | undefined>)["LLM_SIDECAR_KEY"] ?? "";

const crossCheck = defineTool({
	name: "llm_cross_check",
	label: "LLM Cross-Check (second opinion)",
	description: "Send a single-turn prompt to a configured Anthropic-compatible sidecar for a second opinion from a different model. Not the primary path. Requires LLM_SIDECAR_URL.",
	parameters: Type.Object({
		prompt: Type.String({ description: "User message text" }),
		model: Type.Optional(Type.String({ description: `Model id (default '${SIDECAR_MODEL}')` })),
		max_tokens: Type.Optional(Type.Number({ description: "Max tokens to generate (default 1024)" })),
		system: Type.Optional(Type.String({ description: "Optional system prompt override" })),
	}),
	async execute(_id, p) {
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
	},
});

export default function (pi: ExtensionAPI) {
	pi.registerTool(crossCheck);
}
