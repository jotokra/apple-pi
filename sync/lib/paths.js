// sync/lib/paths.js — THE classification authority for config sync.
//
// Everything else in sync/ (gitignore generator, secret hook, doctor,
// consolidate) reads its path classes from here. This is the single place
// that knows what is portable / device-local / secret / device-only —
// derived from pi's ACTUAL layout (settings.json for sessionDir, the known
// file locations pi writes) rather than a static list that would rot.
//
// Pure: reads files, never writes. Safe to call from anywhere.
//
// Buckets (relative to the pi dir, forward-slash globs):
//   portable    — methodology layer; syncs; merges cleanly across devices
//   deviceLocal — committed, but per-device (reconcile, don't overwrite)
//   secret      — NEVER tracked (auth, vault, sessions, browser profile)
//   deviceOnly  — per-machine trust/pointer state; not portable
//
// Card S-1. See .docs/decisions/2026-06-28-config-sync-feature.md.

"use strict";
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

/** Resolve the pi dir: PI_CODING_AGENT_DIR wins, else ~/.pi. */
function piDir() {
	return process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi");
}

/** The real settings.json location (agent/settings.json in current pi; fall
 *  back to the top-level if a layout ever puts it there). */
function settingsPath(dir) {
	const candidates = [path.join(dir, "agent", "settings.json"), path.join(dir, "settings.json")];
	for (const c of candidates) if (fs.existsSync(c)) return c;
	return candidates[0]; // default for read errors / fresh installs
}

/** Read + parse settings.json; {} on any error (never throws). */
function readSettings(dir) {
	try {
		return JSON.parse(fs.readFileSync(settingsPath(dir), "utf8"));
	} catch {
		return {};
	}
}

/** Normalize an absolute or relative path to a glob relative to dir, or null
 *  if it escapes dir (we only classify paths inside the pi dir). */
function relGlob(dir, absOrRel) {
	if (!absOrRel || typeof absOrRel !== "string") return null;
	const abs = path.isAbsolute(absOrRel) ? absOrRel : path.resolve(dir, absOrRel);
	const rel = path.relative(dir, abs);
	if (!rel || rel === ".." || rel.startsWith(".." + path.sep)) return null; // escapes dir
	return rel.split(path.sep).join("/") + "/**";
}

/**
 * Classify every path under dir into one of four buckets.
 * @param {string} [dir] — pi dir (defaults to piDir())
 * @returns {{portable:string[], deviceLocal:string[], secret:string[],
 *            deviceOnly:string[], sessionDirRel:string|null,
 *            browserProfileRel:string|null, dir:string, settings:string}}
 */
function classify(dir) {
	dir = dir || piDir();
	const s = readSettings(dir);

	// sessionDir (from settings) — if it points inside dir, it's secret.
	const sessionDirRel = relGlob(dir, s.sessionDir);

	// Browser profile: web extension uses <dir>/browser-profile by default.
	// (Configurable via the web ext; if a custom path inside dir is set, we
	// pick it up. For v1 the default covers the common case.)
	const browserProfileRel = "browser-profile/**";

	const portable = [
		"skills/**",
		"agent/skills/**",
		"agent/extensions/**",
		"extensions/*.ts",
		"extensions/mcp-bridge/**",
		"extensions/web/**",
		"prompts/**",
		"agent/AGENTS.md",
		"agent/self-assessment-*.md",
		// S-6: settings.json is split. The PORTABLE extract is tracked here;
		// the device-specific original (agent/settings.json) is gitignored
		// (deviceOnly below) so paths/model never leave the device.
		"agent/settings.portable.json",
		"voice/**",
	];

	const deviceLocal = [
		"agent/models.json",
	];

	const secret = [
		"auth.json",
		"agent/auth.json",
		"agent/credentials.vault",
		"agent/env.local",
		"sessions/**",
		"agent/sessions/**",
		browserProfileRel,
	];
	if (sessionDirRel && !secret.includes(sessionDirRel)) secret.push(sessionDirRel);

	const deviceOnly = [
		"caddy-root.crt",
		"agent/trust.json",
		".apple-pi-source",
		"agent/settings.json",
	];

	return {
		dir,
		settings: settingsPath(dir),
		portable, deviceLocal, secret, deviceOnly,
		sessionDirRel, browserProfileRel,
	};
}

/** True if a relative path (or glob fragment) matches any pattern in a list.
 *  Used by the hook to refuse secret paths. Supports `*` and `**`. */
function matchesAny(relPath, patterns) {
	relPath = relPath.split(path.sep).join("/");
	for (const p of patterns) {
		if (globMatch(p, relPath)) return true;
	}
	return false;
}

// Minimal glob: supports `**` (any depth incl. zero), `*` (one segment, no /),
// and literal chars. Sufficient for the path patterns this module emits.
function globMatch(pattern, target) {
	// Convert pattern to a regex.
	let re = "";
	let i = 0;
	while (i < pattern.length) {
		const c = pattern[i];
		if (c === "*" && pattern[i + 1] === "*") {
			re += ".*"; // ** matches across separators
			i += 2;
			if (pattern[i] === "/") i++; // eat the trailing slash of **/
		} else if (c === "*") {
			re += "[^/]*"; // * matches within a segment
			i++;
		} else if (c === "." || c === "+") {
			re += "\\" + c;
			i++;
		} else {
			re += c;
			i++;
		}
	}
	return new RegExp("^" + re + "$").test(target);
}

/** Classify a single relative path into its bucket name, or "unknown".
 *  Unknown paths are NOT tracked (default-deny gitignore handles them). */
function bucketOf(relPath, c) {
	if (matchesAny(relPath, c.secret)) return "secret";
	if (matchesAny(relPath, c.deviceOnly)) return "deviceOnly";
	if (matchesAny(relPath, c.deviceLocal)) return "deviceLocal";
	if (matchesAny(relPath, c.portable)) return "portable";
	return "unknown";
}

module.exports = { piDir, settingsPath, readSettings, classify, matchesAny, globMatch, bucketOf };
