// agentdb/analysis/runs.js — analysis_runs bookkeeping (M5-1).
//
// ROADMAP M5-1: every analyze() invocation creates exactly one
// analysis_runs row. start() inserts a row with started_at + ended_at=NULL;
// end() updates ended_at + finding_count once the run finishes.
// finding_count is denormalized for the dashboard view; the actual
// findings live in analysis_findings (M5-2+).
//
// API:
//   start(db, opts={}) -> { ok, run_id, errors? }
//     opts: { model?, tokens_in?, tokens_out?, notes? }
//     run_id is the autoincremented id; needed for analysis_findings.run_id.
//   end(db, runId, opts={}) -> { ok, run, errors? }
//     opts: { finding_count, notes? } — sets ended_at, finding_count, notes.
//   get(db, runId) -> row | null
//   list(db, opts={}) -> [row]
//     opts: { limit?: number, since?: ISO8601 }
//   recordFinding(db, runId, finding) -> { ok, finding_id, errors? }
//     finding: { detector, severity, title, evidence? }
//     Convenience: callers in M5-2+ can use this to insert a finding
//     in one call (it records the finding AND bumps run.finding_count).
//
// RED-BLUE CONTRACT:
//   - start() never throws; bad inputs return ok:false with errors[].
//   - run_id is the autoincremented primary key; passing an invalid id
//     to end() returns ok:false (no silent no-op).
//   - finding_count on end() is REQUIRED (number >= 0); the caller must
//     pass the count of findings the run actually produced. This makes
//     the run row self-consistent with analysis_findings (which counts
//     via recordFinding() if used).
"use strict";

const SCHEMA_NOTE = `analysis_runs columns: id, started_at, ended_at, model,
tokens_in, tokens_out, finding_count, notes.`;

// isFinitePosInt(n) -> bool
function isFinitePosInt(n) {
	return Number.isInteger(n) && n >= 0;
}

// start(db, opts={}) -> { ok, run_id, errors? }
function start(db, opts = {}) {
	if (!db) return { ok: false, errors: ["start: db is required"] };
	const ts = (opts.now || (() => new Date().toISOString()))();
	const model = (typeof opts.model === "string" && opts.model.length > 0) ? opts.model : null;
	const tokensIn = isFinitePosInt(opts.tokens_in) ? opts.tokens_in : 0;
	const tokensOut = isFinitePosInt(opts.tokens_out) ? opts.tokens_out : 0;
	const notes = (typeof opts.notes === "string") ? opts.notes : null;

	try {
		const info = db.prepare(
			`INSERT INTO analysis_runs (started_at, ended_at, model, tokens_in, tokens_out, finding_count, notes)
			 VALUES (?, NULL, ?, ?, ?, 0, ?)`,
		).run(ts, model, tokensIn, tokensOut, notes);
		return { ok: true, run_id: info.lastInsertRowid };
	} catch (e) {
		return { ok: false, errors: [`start: INSERT failed (${e.message})`] };
	}
}

// end(db, runId, opts={}) -> { ok, run, errors? }
// Closes the run: sets ended_at, finding_count, and optionally updates notes.
function end(db, runId, opts = {}) {
	if (!db) return { ok: false, errors: ["end: db is required"] };
	if (!Number.isInteger(runId) || runId <= 0) {
		return { ok: false, errors: [`end: runId must be a positive integer (got ${JSON.stringify(runId)})`] };
	}
	if (!isFinitePosInt(opts.finding_count)) {
		return { ok: false, errors: ["end: opts.finding_count is required (integer >= 0)"] };
	}
	const ts = (opts.now || (() => new Date().toISOString()))();
	const notes = (typeof opts.notes === "string") ? opts.notes : null;

	try {
		// Atomic update: only if the run row exists. A missing id is
		// an error, not a silent no-op.
		const info = db.prepare(
			`UPDATE analysis_runs SET ended_at = ?, finding_count = ?, notes = COALESCE(?, notes)
			 WHERE id = ?`,
		).run(ts, opts.finding_count, notes, runId);
		if (info.changes === 0) {
			return { ok: false, errors: [`end: no analysis_runs row with id=${runId}`] };
		}
		const row = db.prepare("SELECT * FROM analysis_runs WHERE id = ?").get(runId);
		return { ok: true, run: row };
	} catch (e) {
		return { ok: false, errors: [`end: UPDATE failed (${e.message})`] };
	}
}

// get(db, runId) -> row | null
function get(db, runId) {
	if (!db) return null;
	if (!Number.isInteger(runId) || runId <= 0) return null;
	try {
		return db.prepare("SELECT * FROM analysis_runs WHERE id = ?").get(runId) || null;
	} catch (_) {
		return null;
	}
}

// list(db, opts={}) -> [row] — newest first.
function list(db, opts = {}) {
	if (!db) return [];
	const o = opts && typeof opts === "object" ? opts : {};
	let sql = "SELECT * FROM analysis_runs";
	const conds = [];
	const params = [];
	if (typeof o.since === "string" && o.since.length > 0) {
		conds.push("started_at >= ?");
		params.push(o.since);
	}
	if (conds.length > 0) sql += " WHERE " + conds.join(" AND ");
	sql += " ORDER BY started_at DESC, id DESC";
	if (Number.isInteger(o.limit) && o.limit > 0) {
		sql += " LIMIT " + o.limit;
	}
	try {
		return db.prepare(sql).all(...params);
	} catch (_) {
		return [];
	}
}

// recordFinding(db, runId, finding) -> { ok, finding_id, errors? }
// Convenience: insert into analysis_findings AND bump run.finding_count.
// Used by M5-2+ detectors to keep the run row in sync with the findings.
function recordFinding(db, runId, finding) {
	if (!db) return { ok: false, errors: ["recordFinding: db is required"] };
	if (!Number.isInteger(runId) || runId <= 0) {
		return { ok: false, errors: ["recordFinding: runId must be a positive integer"] };
	}
	if (!finding || typeof finding !== "object") {
		return { ok: false, errors: ["recordFinding: finding must be an object"] };
	}
	const detector = finding.detector;
	const severity = finding.severity;
	const title = finding.title;
	if (typeof detector !== "string" || detector.length === 0) {
		return { ok: false, errors: ["recordFinding: finding.detector (non-empty string) required"] };
	}
	if (!["info", "warn", "critical"].includes(severity)) {
		return { ok: false, errors: [`recordFinding: finding.severity must be info|warn|critical (got ${JSON.stringify(severity)})`] };
	}
	if (typeof title !== "string" || title.length === 0) {
		return { ok: false, errors: ["recordFinding: finding.title (non-empty string) required"] };
	}
	const evidence = (finding.evidence && typeof finding.evidence === "object")
		? JSON.stringify(finding.evidence)
		: "{}";

	try {
		const info = db.prepare(
			`INSERT INTO analysis_findings (run_id, detector, severity, title, evidence_json)
			 VALUES (?, ?, ?, ?, ?)`,
		).run(runId, detector, severity, title, evidence);
		// Bump the run's finding_count to match.
		db.prepare("UPDATE analysis_runs SET finding_count = finding_count + 1 WHERE id = ?").run(runId);
		return { ok: true, finding_id: info.lastInsertRowid };
	} catch (e) {
		return { ok: false, errors: [`recordFinding: INSERT failed (${e.message})`] };
	}
}

module.exports = {
	start,
	end,
	get,
	list,
	recordFinding,
	// Exported for tests.
	SETUP_DOC: SCHEMA_NOTE,
};