// agentdb/kb/query.js — Tier-A filter queries over kb_cards (M3-1).
//
// ROADMAP M3-1: list({status,project,assignee,tag,priority,parent}) returning
// card rows. RED-BLUE CONTRACT (the load-bearing safety property for the
// whole query layer):
//
//   ALL filter values are bound via ? placeholders + db.prepare(...).bind(...).
//   NEVER string-concat user input into the SQL string. SQL injection is the
//   #1 attack surface on a query layer, and this kb is fed by Telegram + the
//   iOS bridge — untrusted input. Every value-type check below is defense in
//   depth: the bound-parameter layer is the primary defense; the type checks
//   exist to surface a loud error rather than silently misinterpret bad input.
//
// Filters:
//   status   : exact match (string; from STATUS_ENUM — non-enum rejected)
//   project  : exact match (string; any non-empty string)
//   assignee : exact match (string | null; null matches cards with assignee IS NULL)
//   tag      : ANY-of (matches cards whose tags_json contains any of the tags)
//              Accepts string (single tag) or array of strings.
//   priority : exact match (int 0-9) OR {min,max} range (both inclusive)
//   parent   : exact match (string)
//
// Unknown filter keys are SILENTLY IGNORED (forward-compat — a newer caller
// passing a key the older binary doesn't know about must not crash). Empty
// filter object = return everything.
//
// Default ordering: priority DESC NULLS LAST, then id ASC.
//
// Returns rows as plain JS objects: { id, title, status, priority, project,
// assignee, parent, tags (parsed array), file_path, updated_at }. The
// frontmatter_json / body / file_hash columns are intentionally NOT returned
// (callers that need them read the file directly — kb_cards is the index,
// .card.md is the truth).
//
// Best-effort, no-throw. A malformed filter (e.g. status not in enum) returns
// { ok: false, errors } rather than throwing — matches the rest of agentdb/kb.
// A successful empty result returns { ok: true, rows: [] }.
"use strict";

const { STATUS_ENUM } = require("./status");

// KNOWN_FILTERS — the closed set the query layer understands. Anything else
// is silently dropped (forward-compat). Keep this in sync with the docs.
const KNOWN_FILTERS = new Set(["status", "project", "assignee", "tag", "priority", "parent"]);

// COLUMN_WHITELIST — the columns a caller may ORDER BY. Hard cap; never let
// user input reach the ORDER BY clause unvalidated. `null` = use default order.
const ORDERABLE_COLUMNS = new Set(["priority", "id", "status", "updated_at", "title"]);

function isInt(n) { return typeof n === "number" && Number.isInteger(n); }

// list(db, filters={}, opts={}) -> { ok, rows, errors? }
//   db      : an open node:sqlite DatabaseSync (lib/db.js open()).
//   filters : { status?, project?, assignee?, tag?, priority?, parent? }
//   opts    : { limit?, orderBy?, orderDir? } — all optional
// Returns:
//   { ok: true, rows: [{id,title,status,priority,...}] } on success
//   { ok: false, errors: string[] } on validation failure (no SQL fired)
function list(db, filters = {}, opts = {}) {
	const errs = [];

	// --- Filter validation (loud-fail on bad input, before touching SQL) ---
	const f = filters && typeof filters === "object" && !Array.isArray(filters) ? filters : {};
	if (f !== filters) errs.push("query: filters must be a plain object");

	const validated = {};
	for (const key of Object.keys(f)) {
		if (!KNOWN_FILTERS.has(key)) continue; // unknown key → ignore
		const v = f[key];
		switch (key) {
			case "status":
				if (typeof v !== "string" || !STATUS_ENUM.includes(v)) {
					errs.push(`query: status must be one of {${STATUS_ENUM.join(",")}} (got ${typeof v === "string" ? v : typeof v})`);
				} else {
					validated.status = v;
				}
				break;
			case "project":
				if (typeof v !== "string" || v.length === 0) {
					errs.push("query: project must be a non-empty string");
				} else {
					validated.project = v;
				}
				break;
			case "assignee":
				// null is a valid filter — "cards with no assignee"
				if (v !== null && (typeof v !== "string" || v.length === 0)) {
					errs.push("query: assignee must be a non-empty string or null");
				} else {
					validated.assignee = v;
				}
				break;
			case "parent":
				if (typeof v !== "string" || v.length === 0) {
					errs.push("query: parent must be a non-empty string");
				} else {
					validated.parent = v;
				}
				break;
			case "tag": {
				// string -> [string] (non-empty); array of non-empty strings -> itself; anything else -> error
				let tags;
				if (typeof v === "string") {
					if (v.length === 0) { errs.push("query: tag must be a non-empty string or array of non-empty strings"); break; }
					tags = [v];
				} else if (Array.isArray(v) && v.length > 0 && v.every(t => typeof t === "string" && t.length > 0)) {
					tags = v;
				} else {
					errs.push("query: tag must be a non-empty string or non-empty array of non-empty strings");
					break;
				}
				validated.tag = tags;
				break;
			}
			case "priority":
				if (isInt(v) && v >= 0 && v <= 9) {
					validated.priority = { exact: v };
				} else if (v && typeof v === "object" && !Array.isArray(v)) {
					// {min,max} range — both inclusive; missing side = unbounded
					const { min, max } = v;
					if (min != null && !isInt(min)) { errs.push("query: priority.min must be an integer"); break; }
					if (max != null && !isInt(max)) { errs.push("query: priority.max must be an integer"); break; }
					if (min != null && (min < 0 || min > 9)) { errs.push("query: priority.min must be 0-9"); break; }
					if (max != null && (max < 0 || max > 9)) { errs.push("query: priority.max must be 0-9"); break; }
					if (min != null && max != null && min > max) { errs.push("query: priority.min > priority.max"); break; }
					validated.priority = { min: min ?? null, max: max ?? null };
				} else {
					errs.push("query: priority must be an integer 0-9 or {min,max} object");
				}
				break;
		}
	}
	if (errs.length > 0) return { ok: false, errors: errs };

	// --- Opts validation (limit / orderBy / orderDir) ---
	const o = opts && typeof opts === "object" && !Array.isArray(opts) ? opts : {};
	if (o !== opts) errs.push("query: opts must be a plain object");

	let limit = null;
	if (o.limit != null) {
		if (!isInt(o.limit) || o.limit <= 0) {
			errs.push("query: opts.limit must be a positive integer");
		} else {
			limit = o.limit;
		}
	}
	let orderBy = "priority";
	let orderDir = "DESC";
	if (o.orderBy != null) {
		if (typeof o.orderBy !== "string" || !ORDERABLE_COLUMNS.has(o.orderBy)) {
			errs.push(`query: opts.orderBy must be one of {${[...ORDERABLE_COLUMNS].join(",")}}`);
		} else {
			orderBy = o.orderBy;
		}
	}
	if (o.orderDir != null) {
		if (o.orderDir !== "ASC" && o.orderDir !== "DESC") {
			errs.push("query: opts.orderDir must be 'ASC' or 'DESC'");
		} else {
			orderDir = o.orderDir;
		}
	}
	if (errs.length > 0) return { ok: false, errors: errs };

	// --- Build parameterized SQL ---
	// Pattern: WHERE clauses accumulate with ? placeholders; values go into the
	// bound-array in the same order. NO string concatenation of user input.
	const wheres = [];
	const params = [];

	if (validated.status !== undefined) { wheres.push("status = ?"); params.push(validated.status); }
	if (validated.project !== undefined) { wheres.push("project = ?"); params.push(validated.project); }
	if (validated.parent !== undefined) { wheres.push("parent = ?"); params.push(validated.parent); }
	if (validated.assignee !== undefined) {
		if (validated.assignee === null) {
			wheres.push("assignee IS NULL");
		} else {
			wheres.push("assignee = ?"); params.push(validated.assignee);
		}
	}
	if (validated.priority) {
		if (validated.priority.exact !== undefined) {
			wheres.push("priority = ?"); params.push(validated.priority.exact);
		} else {
			if (validated.priority.min !== null) { wheres.push("priority >= ?"); params.push(validated.priority.min); }
			if (validated.priority.max !== null) { wheres.push("priority <= ?"); params.push(validated.priority.max); }
		}
	}
	// Tag is ANY-of: card matches if its tags_json contains ANY of the filter tags.
	// SQLite JSON parsing: json_each('["a","b"]') yields rows 'a','b'; LIKE check
	// is on the tags_json column directly (simple substring match). The substring
	// approach is good enough for tag matching because tags cannot contain '"'
	// (validated in schema-card via SLUG_RE-ish rules — see M0-1).
	if (validated.tag) {
		const tagClauses = validated.tag.map(() => "tags_json LIKE ?");
		wheres.push("(" + tagClauses.join(" OR ") + ")");
		for (const t of validated.tag) params.push(`%"${t}"%`);
	}

	// ORDER BY — orderBy/orderDir are validated against the whitelist above.
	// priority DESC NULLS LAST is the default — high-priority cards float up,
	// null-priority sinks to the bottom; id ASC as the tiebreaker for stability.
	const orderClause = orderBy === "priority" && orderDir === "DESC" && !o.orderBy
		? "ORDER BY priority DESC NULLS LAST, id ASC"
		: `ORDER BY ${orderBy} ${orderDir}, id ASC`;

	const whereClause = wheres.length > 0 ? "WHERE " + wheres.join(" AND ") : "";
	const limitClause = limit !== null ? `LIMIT ${limit}` : ""; // limit is validated int

	const sql = `SELECT id, title, status, priority, project, assignee, parent,
	                   tags_json, file_path, updated_at
	            FROM kb_cards
	            ${whereClause}
	            ${orderClause}
	            ${limitClause}`;

	let stmt;
	try {
		stmt = db.prepare(sql);
	} catch (e) {
		return { ok: false, errors: [`query: SQL prepare failed (${e.message})`] };
	}

	let rawRows;
	try {
		rawRows = stmt.all(...params);
	} catch (e) {
		return { ok: false, errors: [`query: SQL exec failed (${e.message})`] };
	}

	// --- Hydrate: parse tags_json (string -> array) on each row ---
	const rows = rawRows.map(r => {
		let tags = [];
		try { const parsed = JSON.parse(r.tags_json); if (Array.isArray(parsed)) tags = parsed; } catch (_) {}
		const { tags_json, ...rest } = r;
		return { ...rest, tags };
	});

	return { ok: true, rows };
}

module.exports = {
	list,
	// Exported for tests + future re-use; not part of the public API.
	KNOWN_FILTERS,
	ORDERABLE_COLUMNS,
};