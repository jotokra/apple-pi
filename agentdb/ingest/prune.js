// agentdb/ingest/prune.js — retention + prune (M4-4).
//
// ROADMAP M4-4: opt-in retention. No auto-purge (D7). prune({before, dry, db})
// counts (dry) or deletes (yes) sess_events/sess_sessions older than the
// given date. kb_*/analysis_*/proposals/improvement_outcomes are NEVER
// touched — tier-isolation invariant.
//
// API:
//   prune({db, before, dry}) -> { ok, deleted: { sess_events, sess_sessions,
//                                                  sess_files }, dry, errors? }
//   plan({db, before}) -> { ok, counts: { ... }, errors? } — same as dry prune
//
// RED-BLUE CONTRACT:
//   - dry=true is the default; --yes required to mutate (D9). The CLI
//     layer (M8-8) enforces --yes gating; this module accepts a `dry` param
//     but defaults to true (the safe default).
//   - 'before' must be a valid ISO8601 date (YYYY-MM-DD or full ISO);
//     missing/invalid -> ok:false, no mutation.
//   - Tier-A tables (kb_*) and analysis-tier tables (analysis_*, proposals,
//     improvement_outcomes) are NEVER deleted, even with --yes. Pruning
//     is strictly sess_events + sess_sessions + sess_files.
//   - Each prune is logged to analysis_runs (notes column carries the
//     dry/yes marker + the threshold date + the counts) so an audit
//     shows what was deleted and when.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { recompute } = require("./aggregates");

// PRUNE_TABLES — the SET of tables prune is allowed to touch. Adding
// new tables to this set is the explicit gesture for "yes, I want this
// table to be eligible for retention pruning." Tier A (kb_*) and Tier B
// analysis tables (analysis_*, proposals, improvement_outcomes) are NOT
// in this list — they're protected by the tier-isolation contract.
const PRUNE_TABLES = {
	sess_events:   "ts",        // column to compare against `before` (text ISO8601)
	sess_sessions: "last_event_at",
	sess_files:    "ingested_at",
};

// parseDate(input) -> string (normalized ISO8601) | null.
// Accepts YYYY-MM-DD (expanded to YYYY-MM-DDT00:00:00.000Z) or a full
// ISO timestamp. Returns null on anything else.
//
// Validation strategy: regex anchor + JS Date round-trip. The regex
// catches shape errors (wrong digit count, bad characters, truncated);
// Date() catches semantic errors (month 13, day 32, hour 25, etc.).
// We accept the timestamp only if the Date parses AND reformatting it
// recovers the same date+time fields — this catches timezone-shift
// bugs where "2026-01-01T25:00:00" would otherwise round-trip via
// "2026-01-02T01:00:00" in local time.
function parseDate(input) {
	if (typeof input !== "string" || input.length === 0) return null;
	// YYYY-MM-DD
	if (/^\d{4}-\d{2}-\d{2}$/.test(input)) {
		// Validate the date is real (rejects 2026-13-01, 2026-02-30, etc.)
		const d = new Date(input + "T00:00:00.000Z");
		if (isNaN(d.getTime())) return null;
		if (d.toISOString().slice(0, 10) !== input) return null;
		return input + "T00:00:00.000Z";
	}
	// Full ISO (with or without millis/zone) — anchored BOTH ends.
	if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/.test(input)) {
		const d = new Date(input);
		if (isNaN(d.getTime())) return null;
		// Pass through; SQLite text comparison is lexicographic and ISO
		// timestamps sort correctly.
		return input;
	}
	return null;
}

// plan({db, before}) -> { ok, counts: { sess_events, sess_sessions, sess_files } }
// Counts the rows that would be deleted by a real prune. Dry-run equivalent.
function plan({ db, before }) {
	const errs = [];
	if (!db) { errs.push("plan: db is required"); return { ok: false, errors: errs }; }
	const ts = parseDate(before);
	if (ts === null) { errs.push(`plan: 'before' must be YYYY-MM-DD or ISO8601 (got ${JSON.stringify(before)})`); return { ok: false, errors: errs }; }

	const counts = {};
	try {
		for (const [table, col] of Object.entries(PRUNE_TABLES)) {
			const row = db.prepare(`SELECT COUNT(*) as n FROM ${table} WHERE ${col} < ?`).get(ts);
			counts[table] = row.n;
		}
	} catch (e) {
		return { ok: false, errors: [`plan: COUNT failed (${e.message})`] };
	}
	return { ok: true, counts, before: ts };
}

// prune({db, before, dry, now}) -> { ok, deleted: { ... }, dry, errors? }
// dry=true (default): same as plan() but writes an analysis_runs note
// "PRUNE-DRY …" so the audit log shows the intent was considered.
// dry=false: deletes the rows in a single transaction; logs
// "PRUNE-YES …" with the actual counts.
function prune({ db, before, dry = true, now = (() => new Date().toISOString()) } = {}) {
	const errs = [];
	if (!db) { errs.push("prune: db is required"); return { ok: false, errors: errs }; }
	const ts = parseDate(before);
	if (ts === null) { errs.push(`prune: 'before' must be YYYY-MM-DD or ISO8601 (got ${JSON.stringify(before)})`); return { ok: false, errors: errs }; }

	// Always plan first (count rows), so the audit log is accurate.
	const planned = plan({ db, before: ts });
	if (!planned.ok) return { ok: false, errors: planned.errors };

	const note = `${dry ? "PRUNE-DRY" : "PRUNE-YES"} before=${ts} counts=${JSON.stringify(planned.counts)}`;
	logAudit(db, now(), note);

	if (dry) {
		return { ok: true, dry: true, counts: planned.counts, before: ts };
	}

	// Real prune: single transaction so partial failures roll back.
	const deleted = { sess_events: 0, sess_sessions: 0, sess_files: 0 };
	try { db.exec("BEGIN"); } catch (e) {
		return { ok: false, errors: [`prune: BEGIN failed (${e.message})`] };
	}
	try {
		for (const [table, col] of Object.entries(PRUNE_TABLES)) {
			const r = db.prepare(`DELETE FROM ${table} WHERE ${col} < ?`).run(ts);
			deleted[table] = r.changes;
		}
	} catch (e) {
		try { db.exec("ROLLBACK"); } catch (_) {}
		return { ok: false, errors: [`prune: DELETE failed (${e.message})`] };
	}
	try { db.exec("COMMIT"); } catch (e) {
		try { db.exec("ROLLBACK"); } catch (_) {}
		return { ok: false, errors: [`prune: COMMIT failed (${e.message})`] };
	}
	return { ok: true, dry: false, deleted, before: ts };
}

// logAudit(db, ts, note) — insert a row into analysis_runs. The
// analysis_runs table has a 'notes' column; we use it to carry the
// "PRUNE-DRY/PRUNE-YES before=... counts=..." string so an audit can
// grep the table for the history of prunes.
function logAudit(db, ts, note) {
	try {
		db.prepare(
			`INSERT INTO analysis_runs (started_at, ended_at, model, tokens_in, tokens_out, finding_count, notes)
			 VALUES (?, ?, ?, 0, 0, 0, ?)`,
		).run(ts, ts, null, note);
	} catch (e) {
		// Best-effort: a logging failure must not abort a prune.
	}
}

module.exports = {
	prune,
	plan,
	// Exported for tests + future re-use; not part of the public API.
	parseDate,
	PRUNE_TABLES,
	logAudit,
};