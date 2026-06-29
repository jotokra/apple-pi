/**
 * n8n-bridge.ts — apple-pi tools for an n8n instance.
 *
 * Tools:
 *   n8n_list_workflows        → array of {id, name, active, updatedAt}
 *   n8n_get_workflow          → full workflow object by id
 *   n8n_create_workflow_json  → POST/PUT a workflow JSON (create or update)
 *   n8n_healthz               → GET /healthz
 *
 * Configuration (env vars — NO defaults baked in; or device-local
 *   agent/env.local KEY=VALUE, see _lib/envlocal.ts):
 *   N8N_BASE_URL  — your n8n root, e.g. https://n8n.example.com
 *   N8N_API_KEY   — an n8n API key (Settings → API)
 *
 * Enabled on demand (the n8n workflow offer in onboarding, or by hand).
 * If the env vars are unset, the tools refuse with a clear message rather
 * than guessing an endpoint.
 */

import "./_lib/envlocal"; // device-local env overrides (agent/env.local)
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const N8N_BASE = (process.env as Record<string, string | undefined>)["N8N_BASE_URL"] ?? "";
const N8N_API_KEY = (process.env as Record<string, string | undefined>)["N8N_API_KEY"] ?? "";

function configError(): string {
	return "n8n-bridge not configured. Set N8N_BASE_URL and N8N_API_KEY in your environment (e.g. ~/.pi/agent/env).";
}

async function n8nFetch(path: string, init: RequestInit = {}): Promise<{ ok: boolean; status: number; body: string }> {
	if (!N8N_BASE || !N8N_API_KEY) {
		throw new Error(configError());
	}
	const res = await fetch(`${N8N_BASE}${path}`, {
		...init,
		headers: {
			"X-N8N-API-KEY": N8N_API_KEY,
			"content-type": "application/json",
			accept: "application/json",
			...(init.headers ?? {}),
		},
	});
	return { ok: res.ok, status: res.status, body: await res.text() };
}

const listTool = defineTool({
	name: "n8n_list_workflows",
	label: "n8n List Workflows",
	description: "List all workflows in the configured n8n instance. Returns id, name, active, updatedAt. Requires N8N_BASE_URL + N8N_API_KEY.",
	parameters: Type.Object({}),
	async execute() {
		const r = await n8nFetch("/api/v1/workflows?limit=100");
		if (!r.ok) {
			return { content: [{ type: "text", text: `n8n error: ${r.status} ${r.body.slice(0, 400)}` }], details: { status: r.status } };
		}
		const parsed = JSON.parse(r.body);
		const workflows = (parsed?.data ?? []).map((w: any) => ({
			id: w.id, name: w.name, active: w.active, updatedAt: w.updatedAt,
		}));
		return { content: [{ type: "text", text: JSON.stringify(workflows, null, 2) }], details: { count: workflows.length } };
	},
});

const getTool = defineTool({
	name: "n8n_get_workflow",
	label: "n8n Get Workflow",
	description: "Fetch the full JSON of a single n8n workflow by id.",
	parameters: Type.Object({
		id: Type.String({ description: "n8n workflow id (numeric, as a string)" }),
	}),
	async execute(_id, p) {
		const r = await n8nFetch(`/api/v1/workflows/${encodeURIComponent(p.id)}`);
		if (!r.ok) {
			return { content: [{ type: "text", text: `n8n error: ${r.status} ${r.body.slice(0, 400)}` }], details: { status: r.status } };
		}
		const wf = JSON.parse(r.body);
		return { content: [{ type: "text", text: JSON.stringify(wf, null, 2) }], details: { id: wf.id, name: wf.name } };
	},
});

const createTool = defineTool({
	name: "n8n_create_workflow_json",
	label: "n8n Create/Update Workflow",
	description: "Create or update a workflow in n8n from a JSON body. The body must be an n8n workflow object (nodes, connections, settings). Use n8n_get_workflow to fetch an existing workflow as a template.",
	parameters: Type.Object({
		workflow: Type.Any({ description: "Full n8n workflow object: { name, nodes, connections, settings, ... }" }),
		activate: Type.Optional(Type.Boolean({ description: "Set workflow.active=true after create/update. Default false." })),
	}),
	async execute(_id, p) {
		const body = JSON.stringify({
			...(p.workflow as any),
			active: p.activate ?? (p.workflow as any).active ?? false,
		});
		const createRes = await n8nFetch("/api/v1/workflows", { method: "POST", body });
		if (createRes.ok) {
			const created = JSON.parse(createRes.body);
			return { content: [{ type: "text", text: `Created workflow id=${created.id} name="${created.name}"` }], details: { id: created.id, action: "created" } };
		}
		const existingId = (p.workflow as any)?.id;
		if (existingId && (createRes.status === 409 || createRes.status === 400)) {
			const upd = await n8nFetch(`/api/v1/workflows/${existingId}`, { method: "PUT", body });
			if (!upd.ok) {
				return { content: [{ type: "text", text: `n8n create failed (${createRes.status}) and update failed (${upd.status}): ${upd.body.slice(0, 400)}` }], details: { createStatus: createRes.status, updateStatus: upd.status } };
			}
			const updated = JSON.parse(upd.body);
			return { content: [{ type: "text", text: `Updated workflow id=${updated.id} name="${updated.name}"` }], details: { id: updated.id, action: "updated" } };
		}
		return { content: [{ type: "text", text: `n8n create failed: ${createRes.status} ${createRes.body.slice(0, 400)}` }], details: { status: createRes.status } };
	},
});

const healthTool = defineTool({
	name: "n8n_healthz",
	label: "n8n Health",
	description: "GET /healthz on the configured n8n instance. Returns {status: ok} when up.",
	parameters: Type.Object({}),
	async execute() {
		if (!N8N_BASE) {
			return { content: [{ type: "text", text: configError() }], details: { ok: false } };
		}
		try {
			const res = await fetch(`${N8N_BASE}/healthz`);
			const body = await res.text();
			return { content: [{ type: "text", text: `${res.status} ${body.slice(0, 200)}` }], details: { status: res.status } };
		} catch (e: any) {
			return { content: [{ type: "text", text: `n8n unreachable: ${e?.message ?? String(e)}` }], details: { ok: false } };
		}
	},
});

export default function (pi: ExtensionAPI) {
	pi.registerTool(listTool);
	pi.registerTool(getTool);
	pi.registerTool(createTool);
	pi.registerTool(healthTool);
}
