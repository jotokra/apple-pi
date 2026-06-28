/**
 * mcp-bridge/sources.ts — the `/sources` command (REQ-A-5).
 *
 * User-facing management of MCP servers (Phase A slice of the broader
 * "datasource registry" from VISION.md P3):
 *
 *   /sources                     list servers + live health
 *   /sources add mcp <name> <cmd> [args...]   register a new server
 *   /sources remove <name>       delete a server entry
 *   /sources pause <name>        set enabled:false (kept, not spawned)
 *   /sources resume <name>       set enabled:true
 *   /sources trust <name>        add to mcp.trustedServers (A-6 consent)
 *   /sources untrust <name>      remove from trusted (must re-trust to spawn)
 *
 * Writes go to the user's real settings.json (mcp.servers / mcp.trustedServers).
 * Read actions take a live snapshot. Never touches the vault.
 *
 * Note: changes require a /reload (or new session) to take effect — the bridge
 * reads settings in session_start. The command says so.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

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

function ensureMcp(s: any): any {
	if (!s.mcp) s.mcp = {};
	if (!Array.isArray(s.mcp.servers)) s.mcp.servers = [];
	if (!Array.isArray(s.mcp.trustedServers)) s.mcp.trustedServers = [];
	return s.mcp;
}

// tiny markdown-ish formatter for the list view
function fmtList(servers: any[], trusted: Set<string>): string {
	if (!servers.length) return "No MCP servers configured. Add one: `/sources add mcp <name> <command> [args...]`";
	const lines = ["MCP servers:", ""];
	for (const srv of servers) {
		const trust = trusted.has(srv.name) ? "trusted" : "UNTRUSTED";
		const state = srv.enabled === false ? "paused" : "active";
		const flag = srv.enabled === false ? " (paused)" : (trusted.has(srv.name) ? "" : " (not trusted — /sources trust)");
		lines.push(`  • ${srv.name}  [${state} · ${trust}]${flag}`);
		lines.push(`      ${srv.command}${srv.args ? " " + srv.args.join(" ") : ""}`);
	}
	lines.push("", "Changes need a `/reload` (or new session) to take effect.");
	return lines.join("\n");
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("sources", {
		description: "Manage MCP data sources: list / add mcp / remove / pause / resume / trust / untrust",
		handler: async (args: string, ctx: ExtensionContext) => {
			const parts = (args || "").trim().split(/\s+/).filter(Boolean);
			const sub = parts[0] || "list";
			const s = readSettings();
			const mcp = ensureMcp(s);

			if (sub === "list") {
				await ctx.ui.notify(fmtList(mcp.servers, new Set(mcp.trustedServers)), "info");
				return;
			}

			if (sub === "add") {
				// /sources add mcp <name> <command> [args...]
				const kind = parts[1];
				if (kind !== "mcp") {
					await ctx.ui.notify("`/sources add` currently supports only `mcp` (Phase A). Usage: /sources add mcp <name> <command> [args...]", "warning");
					return;
				}
				const name = parts[2];
				const command = parts[3];
				const cmdArgs = parts.slice(4);
				if (!name || !command) {
					await ctx.ui.notify("Usage: /sources add mcp <name> <command> [args...]", "warning");
					return;
				}
				if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(name)) {
					await ctx.ui.notify(`Invalid name "${name}" — need [a-z0-9-], start alphanumeric.`, "warning");
					return;
				}
				if (mcp.servers.some((x: any) => x.name === name)) {
					await ctx.ui.notify(`Server "${name}" already exists. /sources remove it first.`, "warning");
					return;
				}
				mcp.servers.push({ name, command, args: cmdArgs.length ? cmdArgs : undefined, enabled: true });
				writeSettings(s);
				await ctx.ui.notify(
					`Added "${name}". NOT trusted yet — run \`/sources trust ${name}\`, then \`/reload\`.`,
					"info",
				);
				return;
			}

			if (sub === "remove") {
				const name = parts[1];
				const before = mcp.servers.length;
				mcp.servers = mcp.servers.filter((x: any) => x.name !== name);
				mcp.trustedServers = mcp.trustedServers.filter((t: string) => t !== name);
				if (mcp.servers.length === before) {
					await ctx.ui.notify(`No server named "${name}".`, "warning");
					return;
				}
				writeSettings(s);
				await ctx.ui.notify(`Removed "${name}". Run \`/reload\` to stop it.`, "info");
				return;
			}

			if (sub === "pause" || sub === "resume") {
				const name = parts[1];
				const srv = mcp.servers.find((x: any) => x.name === name);
				if (!srv) { await ctx.ui.notify(`No server named "${name}".`, "warning"); return; }
				srv.enabled = sub === "resume";
				writeSettings(s);
				await ctx.ui.notify(`"${name}" ${sub === "resume" ? "resumed" : "paused"}. Run \`/reload\`.`, "info");
				return;
			}

			if (sub === "trust" || sub === "untrust") {
				const name = parts[1];
				if (!mcp.servers.some((x: any) => x.name === name)) {
					await ctx.ui.notify(`No server named "${name}". Add it first: /sources add mcp ${name} ...`, "warning");
					return;
				}
				if (sub === "trust") {
					if (!mcp.trustedServers.includes(name)) mcp.trustedServers.push(name);
				} else {
					mcp.trustedServers = mcp.trustedServers.filter((t: string) => t !== name);
				}
				writeSettings(s);
				await ctx.ui.notify(`"${name}" ${sub === "trust" ? "trusted" : "UNtrusted"}. Run \`/reload\`.`, "info");
				return;
			}

			await ctx.ui.notify(
				"Usage: /sources [list|add mcp <name> <cmd> [args...]|remove <name>|pause <name>|resume <name>|trust <name>|untrust <name>]",
				"warning",
			);
		},
	});
}
