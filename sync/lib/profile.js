// sync/lib/profile.js — settings.json portable/device split (S-6).
//
// The structural fix for clean multi-device consolidation. settings.json mixes:
//   - PORTABLE tuning (compaction, treeFilterMode, enabled extensions, theme,
//     thinking level) — should converge across devices.
//   - DEVICE-SPECIFIC (sessionDir absolute path, shellPath, defaultModel,
//     defaultProvider, _models) — must differ per machine.
//
// Split (spec frozen decision: sync-time transform, not a pi-core change):
//   - ~/.pi/agent/settings.json         → gitignored (deviceOnly). Each device
//                                         has its own; never tracked.
//   - ~/.pi/agent/settings.portable.json → tracked (portable). The extract.
//   push: extractPortable(local settings.json) → write settings.portable.json.
//   pull: mergePortable(local settings.json, remote settings.portable.json)
//         → local settings.json, device fields preserved byte-for-byte.
//
// The device-field allowlist is the contract (R2): get it wrong and pull
// corrupts a device's config. Add a field here ONLY if it's genuinely
// per-machine (absolute path, chosen model, provider selection).

"use strict";
const fs = require("node:fs");
const path = require("node:path");

/** Top-level keys that are device-specific (never portable). Exact names. */
const DEVICE_FIELDS = new Set([
	"sessionDir",       // absolute path — differs per machine
	"shellPath",        // absolute path — differs per machine
	"defaultModel",     // this device's chosen model
	"defaultProvider",  // this device's chosen provider
	"_models",          // model catalog state (provider keys live in auth.json,
	                    // but this holds provider/model selection metadata)
]);

/** The settings.json path (agent/settings.json in current pi). */
function settingsPath(dir) {
	return path.join(dir, "agent", "settings.json");
}
/** The portable-extract path. */
function portablePath(dir) {
	return path.join(dir, "agent", "settings.portable.json");
}

/** Read + parse settings.json; {} on any error (never throws). */
function readSettings(dir) {
	try {
		return JSON.parse(fs.readFileSync(settingsPath(dir), "utf8"));
	} catch {
		return {};
	}
}

/** Write settings.json with stable 2-space formatting (preserves key order
 *  because we write the parsed object back as-is). */
function writeSettings(dir, obj) {
	fs.mkdirSync(path.dirname(settingsPath(dir)), { recursive: true });
	fs.writeFileSync(settingsPath(dir), JSON.stringify(obj, null, 2) + "\n");
}

/** Extract the portable subset: a deep copy of settings with device-specific
 *  top-level keys removed. Returns a plain object. */
function extractPortable(settings) {
	const out = {};
	for (const [k, v] of Object.entries(settings)) {
		if (DEVICE_FIELDS.has(k)) continue;
		out[k] = v; // primitives, arrays, objects all copy by value here (JSON-ish)
	}
	return out;
}

/** Merge a remote portable extract INTO a local settings object, preserving
 *  every device-specific field byte-for-byte. Portable keys are overwritten
 *  from `portable` (that's the point — converge the tuning); device keys are
 *  kept from `local`. Returns a new object (does not mutate inputs). */
function mergePortable(local, portable) {
	const out = {};
	// 1. copy local's device fields (preserve exactly).
	for (const [k, v] of Object.entries(local)) {
		if (DEVICE_FIELDS.has(k)) out[k] = v;
	}
	// 2. overlay portable fields (the convergence).
	for (const [k, v] of Object.entries(portable || {})) {
		if (!DEVICE_FIELDS.has(k)) out[k] = v;
	}
	return out;
}

/** One-shot: read local settings.json, extract portable, write settings.portable.json.
 *  Returns true if the file was written/changed. */
function writePortableExtract(dir) {
	const local = readSettings(dir);
	const portable = extractPortable(local);
	const pp = portablePath(dir);
	let prev = null;
	try { prev = fs.readFileSync(pp, "utf8"); } catch {}
	const next = JSON.stringify(portable, null, 2) + "\n";
	if (prev !== next) {
		fs.mkdirSync(path.dirname(pp), { recursive: true });
		fs.writeFileSync(pp, next);
		return true;
	}
	return false;
}

/** One-shot: read remote portable extract (settings.portable.json, which pull
 *  has just updated in the working tree) + local settings.json, merge, write
 *  local settings.json. Returns the merged object. Device fields preserved. */
function applyPortableMerge(dir) {
	const local = readSettings(dir);
	let portable = {};
	try {
		portable = JSON.parse(fs.readFileSync(portablePath(dir), "utf8"));
	} catch { /* no portable file yet — nothing to merge */ }
	const merged = mergePortable(local, portable);
	writeSettings(dir, merged);
	return { merged, changed: JSON.stringify(merged) !== JSON.stringify(local) };
}

module.exports = {
	DEVICE_FIELDS,
	settingsPath, portablePath,
	readSettings, writeSettings,
	extractPortable, mergePortable,
	writePortableExtract, applyPortableMerge,
};
