// agentdb/pi/query.js — pi agent tool db_query (M9-4).
//
// ROADMAP M9-4 (SUPERPROMPT §6 module map): the testable JS core of the pi
// agent tool that surfaces the durable Tier-B tables (sess_*/analysis_*) as a
// read-only query. It is the agent-side twin of the `apple-pi db query` CLI
// (M8-4) — the same parameterized, AND-composed filter, surfaced as a tool so
// an agent can ask "my last N errors" or "sessions that touched card X"
// without leaving the loop.
//
//   db_query({ table, filters, opts, db }) -> { ok, rows } | { ok:false, error|errors }
//     table   : "events" | "sessions" | "findings" | "runs"  (the Tier-B views)
//     filters : table-specific filter object (see QUERY_DEFS below). Unknown
//               keys are SILENTLY IGNORED (forward-compat — mirrors kb/query.js).
//     opts    : { limit } — default 1000 (0 = unlimited). Caps a runaway query.
//     db      : inject an open DatabaseSync (skips open/close — tests +
//               composition; the caller owns the connection).
//
// REQ-M9-4 contract, made concrete:
//   - PARAMETERIZED: every caller-supplied value is bound via ? — NEVER string-
//     concatenated into the WHERE. The SQL shape is fixed per table (QUERY_DEFS),
//     so a caller can only steer the value bound to a placeholder, never the SQL.
//     The table name + ORDER BY are from a closed whitelist, not caller input.
//   - NO MUTATION: the tool fires SELECTs only — it never writes. sess_*/
//     analysis_* are updated by `db ingest` / `analyze`, NOT by this tool.
//   - RETURNS JSON: the result is a plain { ok, rows } object that round-trips
//     through JSON.stringify (the pi harness ships it verbatim as tool result
//     text). Rows are the useful-metadata projection (the verbatim event_json
//     blob is deliberately omitted — matches `apple-pi db query events`).
//
// TWO MODES (mirrors pi/list.js + pi/next.js):
//   (a) injected `db` — tests + composition; the caller owns the connection, so
//       NO open/close runs.
//   (b) no injected db — the real "pi harness" path: open() the unified agent.db
//       and close in a finally. NO ensureCurrent reconcile runs here, unlike the
//       kb_* tools: Tier B is authoritative in the DB itself (ingested by
//       `db ingest`, not mirrored from files), so there is nothing to reconcile.
//
// Best-effort, no-throw (mirrors kb/query.js + pi/list.js): an unknown table, a
// bad filter value, or a bad limit returns { ok:false, error|errors } rather
// than throwing. A successful empty result returns { ok: true, rows: [] }.
//
// RED-BLUE: the injection surface is the bound-parameter layer — exactly
// kb/query.js's surface. The table name + ORDER BY are read from the closed
// QUERY_DEFS map (not caller input), so a caller cannot steer the SQL shape;
// only the value bound to each placeholder is caller-controlled, and a bound
// value is inert data. Payloads like `'; DROP TABLE sess_events;--` or
// `$(rm -rf /)` match nothing and change nothing.

"use strict";

const { open } = require("../lib/db");

// QUERY_DEFS — the closed set of tables the tool exposes + their per-table
// column projection, default ORDER BY, and filter axes. Mirrors the
// QUERY_DEFS in agentdb/db/cli.js (M8-4) so the tool + the CLI agree on the
// row shape and ordering. The table name + ORDER BY reaching the engine are
// ALWAYS read from here, never from caller input.
const QUERY_DEFS = {
	events: {
		// the events projection omits the verbatim event_json blob (the useful
		// metadata only — matches `apple-pi db query events`).
		table: "sess_events",
		columns: "session_id, seq, type, ts, role, tool, tokens_in, tokens_out, is_error",
		order: "session_id, seq",
		// filter builders: (value) -> { clause, param } — clause uses a bound ?
		filters: {
			session: (v) => ({ clause: "session_id = ?", param: v }),
			type: (v) => ({ clause: "type = ?", param: v }),
			tool: (v) => ({ clause: "tool = ?", param: v }),
			role: (v) => ({ clause: "role = ?", param: v }),
		},
		// boolean filters: presence-only (a flag). The ONLY bool filter; value
		// MUST be strictly true (false is ignored, not a "non-errors" filter).
		bools: { errors: "is_error = 1" },
	},
	sessions: {
		table: "sess_sessions",
		columns: "session_id, started_at, ended_at, last_event_at, message_count, " +
			"tool_call_count, error_count, tokens_in, tokens_out, cost, model, cwd",
		order: "started_at DESC NULLS LAST, session_id",
		filters: {
			model: (v) => ({ clause: "model = ?", param: v }),
			// cwd is a SUBSTRING (LIKE) match — powers "sessions that touched
			// card X": filter by the project-root substring of a card's path.
			// The substring is a literal bound value (the LIKE pattern is built
			// around the bound param, never concatenated raw).
			cwd: (v) => ({ clause: "cwd LIKE ?", param: `%${v}%` }),
		},
		bools: {},
	},
	findings: {
		table: "analysis_findings",
		columns: "id, run_id, detector, severity, title, detected_at",
		order: "detected_at DESC, id DESC",
		filters: {
			severity: (v) => ({ clause: "severity = ?", param: v }),
			detector: (v) => ({ clause: "detector = ?", param: v }),
			run: (v) => ({ clause: "run_id = ?", param: v }),
		},
		bools: {},
	},
	runs: {
		table: "analysis_runs",
		columns: "id, started_at, ended_at, model, tokens_in, tokens_out, finding_count",
		order: "started_at DESC, id DESC",
		filters: {},
		bools: {},
	},
};

// isInt(n) — strict integer check (mirrors kb/query.js).
function isInt(n) { return typeof n === "number" && Number.isInteger(n); }

// isNonEmptyStr(v) — a non-empty string.
function isNonEmptyStr(v) { return typeof v === "string" && v.length > 0; }

// runQuery(db, def, filters, opts) -> { ok, rows } | { ok:false, errors }
// Builds + executes the parameterized SELECT on an open db. Best-effort: a
// prepare/exec failure returns { ok:false, errors } rather than throwing.
function runQuery(db, def, filters, opts) {
	const errs = [];

	// --- filter validation (loud-fail on bad input, BEFORE touching SQL) ---
	const f = filters && typeof filters === "object" && !Array.isArray(filters) ? filters : {};
	const where = [];
	const params = [];

	// value filters: each value is a non-empty string OR an integer (run_id is
	// numeric). Unknown keys are silently ignored (forward-compat).
	for (const key of Object.keys(f)) {
		const builder = def.filters[key];
		if (!builder) continue; // unknown key -> ignore
		const v = f[key];
		if (!isNonEmptyStr(v) && !isInt(v)) {
			errs.push(`db_query: filter '${key}' must be a non-empty string or integer (got ${typeof v})`);
			continue;
		}
		const { clause, param } = builder(v);
		where.push(clause);
		params.push(param);
	}
	// boolean filters (errors is the only one): strictly true narrows; strictly
	// false is ignored (NOT a "non-errors" filter); a NON-boolean value is a bad
	// input -> rejected loudly (e.g. errors:"yes" is almost certainly a mistake).
	for (const key of Object.keys(def.bools)) {
		const v = f[key];
		if (v === true) { where.push(def.bools[key]); continue; }
		if (v === false || v === undefined || v === null) continue; // ignored
		errs.push(`db_query: bool filter '${key}' must be true or false (got ${typeof v})`);
	}
	if (errs.length > 0) return { ok: false, errors: errs };

	// --- opts validation (limit only) ---
	const o = opts && typeof opts === "object" && !Array.isArray(opts) ? opts : {};
	let limit = 1000; // bounded default — matches `apple-pi db query`
	if (o.limit != null) {
		if (!isInt(o.limit) || o.limit < 0) {
			return { ok: false, errors: ["db_query: opts.limit must be a non-negative integer"] };
		}
		limit = o.limit; // 0 = unlimited
	}

	// --- build the parameterized SQL (table + ORDER BY from the closed def) ---
	let sql = `SELECT ${def.columns} FROM ${def.table}`;
	if (where.length > 0) sql += " WHERE " + where.join(" AND ");
	sql += ` ORDER BY ${def.order}`;
	if (limit > 0) { sql += " LIMIT ?"; params.push(limit); }

	let rows;
	try {
		rows = db.prepare(sql).all(...params);
	} catch (e) {
		return { ok: false, errors: [`db_query: SQL exec failed (${e.message})`] };
	}
	return { ok: true, rows };
}

// db_query({ table, filters, opts, db }) -> { ok, rows } | { ok:false, error|errors }
//   table   : "events" | "sessions" | "findings" | "runs"
//   filters : table-specific object; unknown keys ignored; all values bound via ?
//   opts    : { limit } — default 1000; 0 = unlimited
//   db      : inject an open DatabaseSync (skips open/close)
function db_query({ table, filters, opts, db: injectedDb } = {}) {
	const def = isNonEmptyStr(table) ? QUERY_DEFS[table] : undefined;
	if (!def) {
		const got = typeof table === "string" ? table : typeof table;
		return {
			ok: false,
			error: `db_query: unknown table '${isNonEmptyStr(table) ? table : ""}' (try one of: ${Object.keys(QUERY_DEFS).join(", ")}) [got ${got}]`,
		};
	}

	if (injectedDb) return runQuery(injectedDb, def, filters || {}, opts || {});
	const db = open();
	try {
		// NO ensureCurrent: Tier B is authoritative in the DB (ingested, not
		// mirrored). The tool is read-only — it only ever fires SELECTs.
		return runQuery(db, def, filters || {}, opts || {});
	} finally {
		db.close();
	}
}

module.exports = { db_query, QUERY_DEFS };
