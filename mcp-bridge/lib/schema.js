// mcp-bridge/lib/schema.js — validate the `mcp` settings block (REQ-A-1).
//
// The `mcp.servers` array in settings.json is the bridge's source of truth.
// This module normalizes + validates it so the bridge can trust what it reads
// and the /sources command can give clear errors. Pure (no fs, no pi) so it
// unit-tests trivially.
//
// Shape (one server entry):
//   {
//     name:        "github",                 // [a-z0-9-]+, unique
//     transport:   "stdio",                  // optional; only "stdio" in Phase A
//     command:     "npx",                    // non-empty
//     args:        ["-y","@mcp/github"],     // optional string[]
//     env:         { GH_HOST: "..." },       // optional, non-secret
//     envFrom:     { GH_TOKEN: "vault:github" },  // optional; vault refs (bridge resolves)
//     enabled:     true,                     // optional (default true); false = paused
//     _error?:     "..."                     // set by validate() on a bad entry
//   }
//
// Validate is permissive on unknown fields (forward-compat) and strict on the
// load-bearing ones (name + command). Returns { servers: [...clean], errors: [...] }.

"use strict";

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,30}$/;

function validateServers(raw) {
	const errors = [];
	const servers = [];
	const list = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.servers) ? raw.servers : []);
	const seen = new Set();
	list.forEach((entry, i) => {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
			errors.push(`server #${i}: not an object`);
			return;
		}
		const name = String(entry.name || "").trim();
		if (!NAME_RE.test(name)) {
			errors.push(`server #${i}: name "${name}" invalid (need ${NAME_RE})`);
			return;
		}
		if (seen.has(name)) {
			errors.push(`server "${name}": duplicate name`);
			return;
		}
		seen.add(name);
		const command = entry.command;
		if (typeof command !== "string" || !command.trim()) {
			errors.push(`server "${name}": command missing/empty`);
			return;
		}
		if (entry.transport !== undefined && entry.transport !== "stdio") {
			errors.push(`server "${name}": transport "${entry.transport}" unsupported (Phase A: stdio only)`);
			return;
		}
		if (entry.args !== undefined && !Array.isArray(entry.args)) {
			errors.push(`server "${name}": args must be an array`);
			return;
		}
		// envFrom values must look like "vault:<id>"
		if (entry.envFrom && typeof entry.envFrom === "object") {
			for (const [k, v] of Object.entries(entry.envFrom)) {
				if (typeof v !== "string" || !/^vault:[a-z0-9_-]+$/i.test(v)) {
					errors.push(`server "${name}": envFrom.${k} must be "vault:<id>" (got "${v}")`);
				}
			}
		}
		servers.push({
			name,
			transport: "stdio",
			command: command.trim(),
			args: Array.isArray(entry.args) ? entry.args : undefined,
			env: entry.env && typeof entry.env === "object" ? entry.env : undefined,
			envFrom: entry.envFrom && typeof entry.envFrom === "object" ? entry.envFrom : undefined,
			enabled: entry.enabled === false ? false : true,
		});
	});
	return { servers, errors };
}

module.exports = { validateServers, NAME_RE };
