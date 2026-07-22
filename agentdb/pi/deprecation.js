// agentdb/pi/deprecation.js — M9-6 deprecated read-only alias shim.
//
// ROADMAP M9-6 (SUPERPROMPT §6 module map): kanban-bridge.ts (the OLD pi
// extension: kanban_list_cards / kanban_get_card / kanban_create_card) is
// deprecated in favor of the M9-1/2 tools (kanban_list / kanban_get /
// kanban_create). For ONE release the OLD tool names are kept as a READ-ONLY
// alias that:
//   - logs a deprecation notice on every call (notice() below), and
//   - delegates the READ side to the new tools so existing callers keep
//     working while they migrate.
//
// READ-ONLY: the writer (kanban_create_card) is intentionally NOT delegated.
// It answers with a { ok:false, deprecated:true } refusal pointing at
// kanban_create (M9-2) instead of performing the write. The whole shim is
// removed in the next release — it exists only to give callers one release
// to migrate off the old names.
//
// The pi extension (config/extensions/kanban-bridge.ts) is a thin binding
// over these: each old tool name maps to the function of the same name here.
//
// This is the testable JS core. notice() is the reusable seam; the three
// kanban_*_card functions are the deprecated aliases. The logger is
// injectable via options.logger (default console.warn) so callers/tests can
// capture the notice without scraping stderr — mirroring the options.db
// injectability convention used across the agentdb/pi tools.
//
// Best-effort, no-throw: a failing logger NEVER breaks the alias (notice
// swallows logger exceptions). Delegation inherits the no-throw contract of
// kanban_list / kanban_get ({ ok:false, ... } on bad input, never raises).
//
// RED-BLUE: this layer adds NO SQL of its own and NO path logic — it only
// forwards to the M9-1 tools, so its injection surface is exactly theirs.

"use strict";

const { kanban_list, kanban_get } = require("./list");

// Scheduled removal window for the whole shim. Neutral string (no version
// baked in) — the point is "this is temporary, migrate now."
const REMOVAL = "the next release";

// resolveLogger(logger?) -> function
//   defaults to console.warn; tolerates a non-function (falls back to warn).
function resolveLogger(logger) {
	return typeof logger === "function" ? logger : console.warn;
}

// notice(name, replacementName, { logger, removal }?) -> void
//   Emits exactly one deprecation line. NEVER throws — a failing logger is
//   swallowed so a logging-side outage cannot break a deprecated caller.
function notice(name, replacementName, { logger, removal = REMOVAL } = {}) {
	const log = resolveLogger(logger);
	try {
		log(`[kanban] ${name} is deprecated; use ${replacementName} instead. (removed in ${removal})`);
	} catch (_) {
		/* logging must never break the alias */
	}
}

// kanban_list_cards(options?) — DEPRECATED read alias -> kanban_list (M9-1).
//   Adapts the OLD kanban-bridge params ({status, limit}) to the new
//   {filters, opts} shape, then delegates. options.logger injects the sink.
function kanban_list_cards(options = {}) {
	const { logger, status, limit, db, root } = options;
	notice("kanban_list_cards", "kanban_list", { logger });
	const filters = status ? { status } : {};
	const opts = limit ? { limit } : {};
	return kanban_list({ db, root, filters, opts });
}

// kanban_get_card(id, options?) — DEPRECATED read alias -> kanban_get (M9-1).
//   Same (id, options) signature as the new tool — pure delegation.
function kanban_get_card(id, options = {}) {
	const { logger, db, root } = options;
	notice("kanban_get_card", "kanban_get", { logger });
	return kanban_get(id, { db, root });
}

// kanban_create_card(options?) — DEPRECATED, READ-ONLY.
//   The OLD writer. NOT delegated in this release: it answers with a
//   { ok:false, deprecated:true } refusal pointing at kanban_create (M9-2)
//   and performs NO write. Callers must migrate to kanban_create.
function kanban_create_card(_options = {}) {
	const { logger } = _options;
	notice("kanban_create_card", "kanban_create", { logger });
	return {
		ok: false,
		deprecated: true,
		error: "kanban_create_card is deprecated and was removed in this read-only alias release; use kanban_create (M9-2) to write cards.",
	};
}

module.exports = {
	notice,
	kanban_list_cards,
	kanban_get_card,
	kanban_create_card,
	REMOVAL,
};
