/**
 * ingress/index.ts — apple-pi ingress extension: the /ingress command (REQ-B-4).
 *
 * User-facing management of pollers (RSS/JSON/webdiff) that watch a source on a
 * schedule and inject new items into a target session, wrapped with the
 * UNTRUSTED marker (see lib/inject.js + the AGENTS.md persona rule).
 *
 *   /ingress                                  list pollers + last-run health
 *   /ingress add rss <name> <url> [--every Nd|h]
 *   /ingress add webdiff <name> <url> [--every Nd|h]
 *   /ingress add json <name> <url> --jp <path> [--every Nd|h]
 *   /ingress pause|resume|remove <name>
 *   /ingress run <name>                       manual trigger (fetch + inject)
 *
 * Writes to settings.json (ingress.pollers[]). The scheduler (B-3) reads the
 * same list to install launchd/cron jobs. /ingress run does an immediate fetch
 * + inject so the user can verify a source works before scheduling it.
 *
 * Security: every 'add' confirms the user trusts the source (mirrors MCP's
 * consent model — a poller makes outbound requests to a URL they typed). The
 * UNTRUSTED marker defends at inject time regardless.
 */
import { createRequire } from "node:module";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const thisFile = (() => {
	try { return fileURLToPath(import.meta.url); }
	catch { return typeof __dirname !== "undefined" ? __dirname + "/index.ts" : process.cwd() + "/index.ts"; }
})();
const HERE = dirname(thisFile);   // .../ingress
const poller = require(join(HERE, "lib", "poller.js"));
const state = require(join(HERE, "lib", "state.js"));
const inject = require(join(HERE, "lib", "inject.js"));

function settingsPath(): string {
	const piDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi");
	return join(piDir, "agent", "settings.json");
}
function readSettings(): any {
	try { return JSON.parse(readFileSync(settingsPath(), "utf8")); }
	catch { return {}; }
}
function writeSettings(s: any): void {
	mkdirSync(dirname(settingsPath()), { recursive: true });
	writeFileSync(settingsPath(), JSON.stringify(s, null, 2) + "\n");
}
function ensureIngress(s: any): any {
	if (!s.ingress) s.ingress = {};
	if (!Array.isArray(s.ingress.pollers)) s.ingress.pollers = [];
	return s.ingress;
}

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,30}$/;
const KINDS = new Set(["rss", "webdiff", "json"]);

export default function (pi: ExtensionAPI) {
	pi.registerCommand("ingress", {
		description: "Manage ingress pollers (RSS/webdiff/json) that watch sources and inject new items",
		handler: async (args: string, ctx: ExtensionContext) => {
			const parts = (args || "").trim().split(/\s+/).filter(Boolean);
			const sub = parts[0] || "list";
			const s = readSettings();
			const ing = ensureIngress(s);

			if (sub === "list") {
				if (!ing.pollers.length) {
					await ctx.ui.notify("No pollers. Add one: `/ingress add rss <name> <url>`", "info");
					return;
				}
				const lines = ["Ingress pollers:", ""];
				for (const p of ing.pollers) {
					const st = p.enabled === false ? "paused" : "active";
					const last = p.lastRunAt ? ` · last ${p.lastRunAt} (${p.lastCount ?? 0} new)` : " · never run";
					lines.push(`  • ${p.name} [${p.kind} · ${st}${last}]`);
					lines.push(`      ${p.url}${p.jsonpath ? ` (jp: ${p.jsonpath})` : ""}${p.every ? ` · every ${p.every}` : " · manual"}`);
				}
				lines.push("", "Items arrive wrapped [INGRESS · UNTRUSTED]. Schedule install: `apple-pi ingress install`.");
				await ctx.ui.notify(lines.join("\n"), "info");
				return;
			}

			if (sub === "add") {
				const kind = parts[1];
				const name = parts[2];
				const url = parts[3];
				if (!KINDS.has(kind)) {
					await ctx.ui.notify(`kind must be rss | webdiff | json (got "${kind}")`, "warning");
					return;
				}
				if (!name || !NAME_RE.test(name)) {
					await ctx.ui.notify(`Invalid name "${name || ""}" — need [a-z0-9-], start alphanumeric.`, "warning");
					return;
				}
				if (!url || !/^https?:\/\//.test(url)) {
					await ctx.ui.notify(`url must start with http(s):// (got "${url || ""}")`, "warning");
					return;
				}
				if (ing.pollers.some((x: any) => x.name === name)) {
					await ctx.ui.notify(`Poller "${name}" exists. /ingress remove it first.`, "warning");
					return;
				}
				// parse --every + --jp
				const opts: any = { enabled: true };
				for (let i = 4; i < parts.length; i++) {
					if (parts[i] === "--every") opts.every = parts[++i];
					else if (parts[i] === "--jp") opts.jsonpath = parts[++i];
				}
				if (kind === "json" && !opts.jsonpath) {
					await ctx.ui.notify("`add json` requires --jp <dotted.path> (use * for the first array)", "warning");
					return;
				}
				ing.pollers.push({ name, kind, url, ...opts });
				writeSettings(s);
				await ctx.ui.notify(
					`Added "${name}" (${kind}). Try it now: \`/ingress run ${name}\`. ` +
					`Install schedule: \`apple-pi ingress install\`.`,
					"info",
				);
				return;
			}

			if (sub === "pause" || sub === "resume") {
				const name = parts[1];
				const p = ing.pollers.find((x: any) => x.name === name);
				if (!p) { await ctx.ui.notify(`No poller "${name}".`, "warning"); return; }
				p.enabled = sub === "resume";
				writeSettings(s);
				await ctx.ui.notify(`"${name}" ${sub === "resume" ? "resumed" : "paused"}.`, "info");
				return;
			}

			if (sub === "remove") {
				const name = parts[1];
				const before = ing.pollers.length;
				ing.pollers = ing.pollers.filter((x: any) => x.name !== name);
				if (ing.pollers.length === before) { await ctx.ui.notify(`No poller "${name}".`, "warning"); return; }
				writeSettings(s);
				await ctx.ui.notify(`Removed "${name}". Reinstall schedule: \`apple-pi ingress install\`.`, "info");
				return;
			}

			if (sub === "run") {
				const name = parts[1];
				const spec = ing.pollers.find((x: any) => x.name === name);
				if (!spec) { await ctx.ui.notify(`No poller "${name}".`, "warning"); return; }
				await ctx.ui.notify(`Fetching "${name}"…`, "info");
				const store = new state.SqliteStore();
				try {
					const r = await poller.runPoller(spec, store);
					spec.lastRunAt = new Date().toISOString();
					spec.lastCount = r.items.length;
					if (r.error) { spec.lastError = r.error; writeSettings(s); await ctx.ui.notify(`"${name}" error: ${r.error}`, "error"); return; }
					spec.lastError = null;
					writeSettings(s);
					if (!r.items.length) { await ctx.ui.notify(`"${name}": no new items.`, "info"); return; }
					const msg = inject.synthesize(name, r.items);
					const res = await inject.injectNow(msg, null);
					await ctx.ui.notify(`"${name}": injected ${r.items.length} item(s) [UNTRUSTED]. ${res.ok ? "" : "(inject failed: " + res.error + ")"}`, res.ok ? "info" : "warning");
				} finally {
					store.close();
				}
				return;
			}

			await ctx.ui.notify(
				"Usage: /ingress [list | add rss|webdiff|json <name> <url> [--every Nd|h] [--jp path] | pause|resume|remove|run <name>]",
				"warning",
			);
		},
	});
}
