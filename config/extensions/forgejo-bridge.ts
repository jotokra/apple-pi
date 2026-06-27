/**
 * forgejo-bridge.ts — apple-pi tools for a Forgejo (or Gitea-compatible) forge.
 *
 * Tools:
 *   forgejo_list_repos  → GET /api/v1/repos/search (or /users/{owner}/repos)
 *   forgejo_get_repo    → GET /api/v1/repos/{owner}/{name}
 *   forgejo_create_pr   → POST /api/v1/repos/{owner}/{name}/pulls
 *
 * Configuration (env vars — NO defaults baked in):
 *   FORGEJO_BASE_URL  — e.g. https://git.example.com
 *   FORGEJO_TOKEN     — an access token with repo + PR scopes
 *
 * Enabled on demand. Works against any Forgejo/Gitea API; for GitHub or
 * GitLab, add a separate extension or use the `gh`/`glab` CLI via bash.
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const FORGEJO_BASE = (process.env as Record<string, string | undefined>)["FORGEJO_BASE_URL"] ?? "";
const FORGEJO_TOKEN = (process.env as Record<string, string | undefined>)["FORGEJO_TOKEN"] ?? "";

function configError(): string {
	return "forgejo-bridge not configured. Set FORGEJO_BASE_URL and FORGEJO_TOKEN in your environment.";
}

async function forgejoFetch(path: string, init: RequestInit = {}): Promise<{ ok: boolean; status: number; body: string }> {
	if (!FORGEJO_BASE || !FORGEJO_TOKEN) {
		throw new Error(configError());
	}
	const res = await fetch(`${FORGEJO_BASE}${path}`, {
		...init,
		headers: {
			authorization: `token ${FORGEJO_TOKEN}`,
			"content-type": "application/json",
			accept: "application/json",
			...(init.headers ?? {}),
		},
	});
	return { ok: res.ok, status: res.status, body: await res.text() };
}

const listRepos = defineTool({
	name: "forgejo_list_repos",
	label: "Forgejo List Repos",
	description: "List forgejo repos visible to the token. Default limit 50. Omit owner to list across owners.",
	parameters: Type.Object({
		limit: Type.Optional(Type.Number({ description: "Max repos to return (default 50)" })),
		owner: Type.Optional(Type.String({ description: "Filter by owner. Omit to list across owners." })),
	}),
	async execute(_id, p) {
		const limit = p.limit ?? 50;
		const path = p.owner
			? `/api/v1/users/${encodeURIComponent(p.owner)}/repos?limit=${limit}`
			: `/api/v1/repos/search?limit=${limit}`;
		const r = await forgejoFetch(path);
		if (!r.ok) {
			return { content: [{ type: "text", text: `forgejo error: ${r.status} ${r.body.slice(0, 400)}` }], details: { status: r.status } };
		}
		const data = JSON.parse(r.body);
		const items = (data?.data ?? data ?? []).slice(0, limit).map((repo: any) => ({
			full_name: repo.full_name, name: repo.name, owner: repo.owner?.login, private: repo.private, updated_at: repo.updated_at,
		}));
		return { content: [{ type: "text", text: JSON.stringify(items, null, 2) }], details: { count: items.length } };
	},
});

const getRepo = defineTool({
	name: "forgejo_get_repo",
	label: "Forgejo Get Repo",
	description: "Get metadata for a single forgejo repo.",
	parameters: Type.Object({
		owner: Type.String({ description: "Owner" }),
		name: Type.String({ description: "Repo name" }),
	}),
	async execute(_id, p) {
		const r = await forgejoFetch(`/api/v1/repos/${encodeURIComponent(p.owner)}/${encodeURIComponent(p.name)}`);
		if (!r.ok) {
			return { content: [{ type: "text", text: `forgejo error: ${r.status} ${r.body.slice(0, 400)}` }], details: { status: r.status } };
		}
		return { content: [{ type: "text", text: r.body }], details: { name: p.name, owner: p.owner } };
	},
});

const createPR = defineTool({
	name: "forgejo_create_pr",
	label: "Forgejo Create PR",
	description: "Open a pull request in forgejo. head + base are branch names within the same repo.",
	parameters: Type.Object({
		owner: Type.String({ description: "Owner" }),
		name: Type.String({ description: "Repo name" }),
		title: Type.String({ description: "PR title" }),
		body: Type.String({ description: "PR body (markdown)" }),
		head: Type.String({ description: "Source branch (e.g. 'feat/x')" }),
		base: Type.String({ description: "Target branch (default 'main')" }),
	}),
	async execute(_id, p) {
		const r = await forgejoFetch(`/api/v1/repos/${encodeURIComponent(p.owner)}/${encodeURIComponent(p.name)}/pulls`, {
			method: "POST",
			body: JSON.stringify({ title: p.title, body: p.body, head: p.head, base: p.base || "main" }),
		});
		if (!r.ok) {
			return { content: [{ type: "text", text: `forgejo error: ${r.status} ${r.body.slice(0, 400)}` }], details: { status: r.status } };
		}
		const pr = JSON.parse(r.body);
		return { content: [{ type: "text", text: `Opened PR #${pr.number}: ${pr.html_url}` }], details: { number: pr.number, url: pr.html_url } };
	},
});

export default function (pi: ExtensionAPI) {
	pi.registerTool(listRepos);
	pi.registerTool(getRepo);
	pi.registerTool(createPR);
}
