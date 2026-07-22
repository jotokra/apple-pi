// agentdb/migration/ingest-sessions.js — M11-2 dogfood parity (one-shot ingest).
//
// SUPERPROMPT §5.2 + ROADMAP M11-2: the REAL ~/.pi/sessions/*.jsonl are the
// durable truth this agent DB ingests. They are already valid pi JSONL, so a
// straight `apple-pi db ingest` works on them — no normalization needed
// (unlike M11-1's card import, which had to drop `blocks` + non-§5.1 fields).
//
// This module is the BATCH driver: discover every *.jsonl under a dir,
// ingestFile each (M4-2 append-only resume via prefix_hash), then recompute
// (M4-3) the sess_sessions rollup for every session touched. Reusing
// ingestFile means the import inherits the SAME tested parse + insert +
// resume path — no SQL duplication, no second parser. This is the session
// tier's mirror of import-cards.js (M11-1), which reuses rebuild() for the
// kanban tier the same way.
//
// REQ-M11-2: every *.jsonl file on disk ingested (one sess_files row per
// file); sess_events count plausible vs JSONL line totals (events <=
// total_lines; events + parse_errors == total_lines — no line lost, no line
// double-counted).
//
// Best-effort + no-throw posture (matches ingestFile, reconcileNow, and the
// rest of agentdb): a file that can't be read or ingested is reported in
// errors[], not fatal. `ok` is false only when a file-level failure occurred
// (a parse error on a single line is recorded in stats.errors, NOT a failure
// of the file itself — matches ingestFile's contract).
//
// API: ingestSessions({ db, dir }) -> { ok, discovered, ingested, noop,
//                                        appended, skipped, deleted, errors,
//                                        failures?, totalLines, events,
//                                        sessions }
//   db          : open DatabaseSync (caller owns it; ingest owns only sess_*)
//   dir         : directory holding *.jsonl files (default ~/.pi/sessions)
//   discovered  : # of *.jsonl files found in dir
//   ingested    : # of NEW sess_events rows inserted (full-ingest + append
//                 paths both bump this — matches ingestFile's stats.ingested)
//   appended    : # of sess_events rows from appended tails (resume path;
//                 appendIngest sets stats.appended = newEvents.length)
//   skipped     : # of sess_events rows de-duped (content_sha retry)
//   deleted     : # of old events removed on a prefix-mismatch re-ingest
//   noop        : # of files unchanged since last ingest (resume no-op)
//   errors      : # of per-line PARSE errors across all files (the count the
//                 events-vs-totals invariant needs: events + errors == total_lines)
//   failures    : (array of strings, only when non-empty) file-level +
//                 input-validation failures. ok is false iff this is non-empty.
//   totalLines  : sum of every file's line count (the JSONL line total —
//                 the plausibility baseline: events <= total_lines)
//   events      : # rows in sess_events for the ingested sessions (queried
//                 after the batch so it reflects the on-disk truth)
//   sessions    : # distinct session_ids whose rollup was refreshed
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { ingestFile } = require("../ingest/incremental"); // M4-2
const { recompute } = require("../ingest/aggregates");   // M4-3

// discoverJsonl(dir) -> string[] — every *.jsonl file (top-level only, sorted).
// Matches db/cli.js resolveIngestFiles' directory contract: a flat dir of
// session files, NOT a recursive walk (the sessions dir is flat by pi's
// convention; nested layouts would be a different feature). Missing or
// unreadable dir -> [] (best-effort: caller decides whether [] is an error).
function discoverJsonl(dir) {
	let entries;
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	return entries
		.filter((d) => d.isFile() && d.name.endsWith(".jsonl"))
		.map((d) => path.join(dir, d.name))
		.sort();
}

// ingestSessions({ db, dir }) -> see file header.
function ingestSessions(opts = {}) {
	const { db } = opts;
	if (!db) {
		return { ok: false, errors: 0, failures: ["ingestSessions: db is required"] };
	}
	const dir = opts.dir;
	if (typeof dir !== "string" || dir.length === 0) {
		return { ok: false, errors: 0, failures: ["ingestSessions: dir is required (string)"] };
	}
	const target = path.resolve(dir);

	const totals = {
		discovered: 0,
		ingested: 0,
		appended: 0,
		skipped: 0,
		deleted: 0,
		noop: 0,
		errors: 0,
		totalLines: 0,
	};
	const failures = [];
	const touched = new Set(); // session_ids whose rollup needs a refresh

	const files = discoverJsonl(target);
	for (const file of files) {
		totals.discovered++;
		let res;
		try {
			res = ingestFile(db, file);
		} catch (e) {
			// ingestFile is no-throw by contract; this is purely defensive.
			failures.push(`${file}: ${e && e.message ? e.message : String(e)}`);
			continue;
		}
		if (!res.ok) {
			// file-level failure (unreadable, sess_files write failed, …).
			// ingestFile's own per-line parse errors are in res.stats.errors,
			// NOT here — those are recorded below via the stats path.
			for (const e of (res.errors || [])) failures.push(`${file}: ${e}`);
			continue;
		}
		const s = res.stats || {};
		totals.ingested += s.ingested || 0;
		totals.appended += s.appended || 0;
		totals.skipped += s.skipped || 0;
		totals.deleted += s.deleted || 0;
		totals.errors += s.errors || 0;

		// pull the file's recorded line count + session_id from the row ingestFile
		// just wrote (sess_files.total_lines is the authoritative JSONL line count
		// for this file — exactly the plausibility baseline we sum into totalLines).
		let row = null;
		try {
			row = db.prepare("SELECT total_lines, session_id FROM sess_files WHERE file_path = ?").get(file);
		} catch (_) { /* best-effort: a missing read leaves totalLines undercounted, not fatal */ }
		if (row) {
			totals.totalLines += row.total_lines || 0;
			if (row.session_id) touched.add(row.session_id);
		}

		const changed = (s.ingested || 0) + (s.appended || 0) + (s.deleted || 0) > 0;
		if (!changed) totals.noop++;
	}

	// refresh the sess_sessions rollup for every session we touched. Idempotent
	// (INSERT OR REPLACE); recompute never throws (returns { ok, errors? }).
	for (const sid of touched) {
		try { recompute(db, sid); } catch (_) { /* best-effort: rollup refresh is a nicety */ }
	}

	// events: the on-disk truth after the batch. Queried (not summed from
	// stats) so a re-ingest of an already-present session still reports the
	// real row count rather than a possibly-stale delta.
	let events = 0;
	try {
		events = db.prepare("SELECT count(*) c FROM sess_events").get().c;
	} catch (_) { /* a DB without sess_events reports 0 — caller sees events=0 */ }

	const out = Object.assign({}, totals, {
		events,
		sessions: touched.size,
	});
	// `ok` follows ingestFile's contract: a file-level failure (failures) is
	// a hard fail; per-line parse errors are recorded in totals.errors but do
	// NOT flip ok (a session with one malformed line still ingests the rest).
	out.ok = failures.length === 0;
	if (failures.length > 0) out.failures = failures;
	return out;
}

module.exports = { ingestSessions, discoverJsonl };
