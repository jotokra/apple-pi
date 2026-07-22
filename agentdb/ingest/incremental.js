// agentdb/ingest/incremental.js — append-only incremental ingest (M4-2).
//
// ROADMAP M4-2: per-file resume via sess_files(ingested_lines, total_lines,
// prefix_hash). Algorithm:
//   1. Compute the file's full hash, prefix hash (lines [0..ingested_lines)
//      of what we last ingested), and current line count.
//   2. Look up sess_files.file_path.
//      - Absent                -> full ingest.
//      - prefix matches, total == ingested_lines -> no-op (file unchanged).
//      - prefix matches, total > ingested_lines -> APPEND from line ingested_lines.
//      - prefix differs       -> full re-ingest (file was rewritten; old events deleted).
//
// The KEY design decision: append detection uses prefix_hash (the hash of
// the lines we've already ingested), NOT full file_hash. A file that grew
// by 5 lines has a different full-file hash (the appended bytes change it)
// but the SAME prefix hash (the first 100 lines are byte-identical). Using
// full-file hash as the "same file?" check would mis-route every append
// into a full re-ingest — defeating the append-only optimization.
//
// RED-BLUE CONTRACT:
//   - ingestFile(db, filePath, opts) -> { ok, stats, errors? } never throws.
//   - All SQL is parameter-bound (? placeholders, never string concat).
//   - Idempotent: calling ingestFile on an already-ingested file is a no-op.
//     The de-dup is per-line via content_sha — a partial-append retry with
//     overlapping seqs skips already-ingested lines.
//   - session_id backfill: events without an explicit session_id inherit
//     from the preceding "session" event in the same file. This is the
//     indexer's job, not the parser's — keeping them split lets M4-1 stay
//     pure-functional.
//
// Public API:
//   ingestFile(db, filePath, opts={}) -> { ok, stats, errors? }
//     opts.lineParser : function(line, seq) -> {ok, row, errors?}
//                       defaults to ./sessions.parseLine
//     opts.now : () => ISO timestamp (overridable for tests)
//     opts.fileReader : function(path) -> string (test seam)
"use strict";

const crypto = require("node:crypto");
const { parseLine: defaultParseLine } = require("./sessions");

// sha256Hex(text) -> string — 64-char lowercased hex.
function sha256Hex(text) {
	return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

// countLines(text) -> number — number of NEWLINE-separated lines. A
// trailing newline does NOT add a line (matches what `wc -l` reports and
// matches what JS arrays report after split). The unit of count is the
// number of \n characters in the text; a file with content "a\nb\nc"
// reports 3 lines, "a\nb\nc\n" reports 3 lines (same).
function countLines(text) {
	if (text.length === 0) return 0;
	let n = 0;
	for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
	return n;
}

// splitLines(text) -> [line, ...] — split on \n, drop the trailing empty
// string that comes from a final newline (matches the line-count contract).
function splitLines(text) {
	const arr = text.split("\n");
	if (arr.length > 0 && arr[arr.length - 1] === "") arr.pop();
	return arr;
}

// ingestFile(db, filePath, opts={}) -> { ok, stats, errors? }
function ingestFile(db, filePath, opts = {}) {
	const parseLine = opts.lineParser || defaultParseLine;
	const now = opts.now || (() => new Date().toISOString());

	// --- 1. Read the file + compute full hash + line count ---
	let content;
	try {
		content = (opts.fileReader || ((p) => require("node:fs").readFileSync(p, "utf8")))(filePath);
	} catch (e) {
		return { ok: false, errors: [`ingest: cannot read '${filePath}' (${e.code || e.message})`] };
	}
	const file_hash = sha256Hex(content);
	const total_lines = countLines(content);
	const lines = splitLines(content);

	const stats = { ingested: 0, skipped: 0, appended: 0, errors: 0, deleted: 0 };

	// --- 2. Look up sess_files row ---
	let existing = null;
	try {
		const row = db.prepare(
			"SELECT file_path, session_id, file_hash, prefix_hash, total_lines, ingested_lines " +
			"FROM sess_files WHERE file_path = ?",
		).get(filePath);
		existing = row || null;
	} catch (e) {
		return { ok: false, errors: [`ingest: sess_files SELECT failed (${e.message})`] };
	}

	// --- 3. Branch on the existing-row state ---
	if (!existing) {
		// Full ingest of a new file.
		return fullIngest(db, filePath, lines, file_hash, total_lines, parseLine, now, stats);
	}

	// Compute the prefix hash of what we'd have ingested last time:
	// lines [0..existing.ingested_lines) joined by \n.
	const prefixText = lines.slice(0, existing.ingested_lines).join("\n") + (existing.ingested_lines > 0 ? "\n" : "");
	const currentPrefixHash = existing.ingested_lines > 0 ? sha256Hex(prefixText) : "";

	if (currentPrefixHash === existing.prefix_hash && existing.ingested_lines === total_lines) {
		// No-op: the prefix matches what we ingested and the file hasn't grown.
		return { ok: true, stats };
	}

	if (currentPrefixHash === existing.prefix_hash && existing.ingested_lines < total_lines) {
		// Append-only: the prefix matches, file grew, parse new tail.
		return appendIngest(db, filePath, lines, existing.ingested_lines, existing.session_id, file_hash, total_lines, parseLine, now, stats);
	}

	// Prefix differs -> file was rewritten (a different write of the same
	// session, or a totally different session with the same file_path).
	// Delete the old session's events + do a full re-ingest.
	stats.deleted = deleteSessionEvents(db, existing.session_id);
	return fullIngest(db, filePath, lines, file_hash, total_lines, parseLine, now, stats);
}

// fullIngest(db, filePath, lines, file_hash, total_lines, parseLine, now, stats)
// First-time ingest (or full re-ingest after prefix mismatch): INSERT a
// sess_files row + INSERT every parsed event into sess_events.
function fullIngest(db, filePath, lines, file_hash, total_lines, parseLine, now, stats) {
	const ingested_at = now();

	// First pass: parse all lines, gathering parsed events + detecting session_id.
	let sessionId = "";
	let lastTs = null;
	const events = [];
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const res = parseLine(line, i);
		if (!res.ok) {
			stats.errors++;
			continue;
		}
		const e = res.row;
		events.push(e);
		// session_id inference: the first "session" event's id is canonical;
		// model_change/thinking/etc. events without session_id inherit it.
		if (e.type === "session" && e.session_id) sessionId = e.session_id;
		else if (!sessionId && e.session_id) sessionId = e.session_id;
		if (e.ts) lastTs = e.ts;
	}

	// Backfill session_id on events that lack it (parser leaves it "" if
	// the JSON had neither .id nor .session_id).
	for (const e of events) {
		if (!e.session_id && sessionId) e.session_id = sessionId;
	}

	// The "prefix" of a full ingest IS the full file content (modulo the
	// trailing newline that joins the lines we kept).
	const prefixText = lines.join("\n") + (lines.length > 0 ? "\n" : "");
	const prefix_hash = sha256Hex(prefixText);

	try { db.exec("BEGIN"); } catch (e) {
		return { ok: false, errors: [`ingest: BEGIN failed (${e.message})`] };
	}

	try {
		const insertFile = db.prepare(
			`INSERT OR REPLACE INTO sess_files
			 (file_path, session_id, file_hash, prefix_hash, total_lines, ingested_lines, ingested_at, last_event_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		);
		insertFile.run(filePath, sessionId || "unknown", file_hash, prefix_hash, total_lines, lines.length, ingested_at, lastTs);

		const insertEvent = db.prepare(
			`INSERT OR IGNORE INTO sess_events
			 (session_id, seq, type, ts, role, tool, tokens_in, tokens_out, is_error, content_sha, event_json)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		);
		for (const e of events) {
			const r = insertEvent.run(e.session_id, e.seq, e.type, e.ts, e.role, e.tool,
				e.tokens_in, e.tokens_out, e.is_error, e.content_sha, e.event_json);
			if (r.changes > 0) stats.ingested++;
			else stats.skipped++; // content_sha de-dup caught a re-ingest
		}
	} catch (e) {
		try { db.exec("ROLLBACK"); } catch (_) {}
		return { ok: false, errors: [`ingest: INSERT failed (${e.message})`] };
	}

	try { db.exec("COMMIT"); } catch (e) {
		try { db.exec("ROLLBACK"); } catch (_) {}
		return { ok: false, errors: [`ingest: COMMIT failed (${e.message})`] };
	}
	return { ok: true, stats };
}

// appendIngest(db, filePath, lines, fromSeq, sessionId, file_hash, total_lines, parseLine, now, stats)
// Incremental path: file grew but the prefix matches. Parse lines [fromSeq..end]
// and INSERT them. Backfill session_id from the passed-in sessionId.
function appendIngest(db, filePath, lines, fromSeq, sessionId, file_hash, total_lines, parseLine, now, stats) {
	const newEvents = [];
	for (let i = fromSeq; i < lines.length; i++) {
		const res = parseLine(lines[i], i);
		if (!res.ok) { stats.errors++; continue; }
		const e = res.row;
		if (!e.session_id && sessionId) e.session_id = sessionId;
		newEvents.push(e);
	}
	stats.appended = newEvents.length;

	const ingested_at = now();
	const lastTs = newEvents.length > 0 ? newEvents[newEvents.length - 1].ts : null;

	// After appending, the new "prefix" includes all lines (we now know all of them).
	const prefixText = lines.join("\n") + (lines.length > 0 ? "\n" : "");
	const prefix_hash = sha256Hex(prefixText);

	try { db.exec("BEGIN"); } catch (e) {
		return { ok: false, errors: [`ingest: BEGIN failed (${e.message})`] };
	}
	try {
		db.prepare(
			`UPDATE sess_files
			 SET file_hash = ?, prefix_hash = ?, total_lines = ?, ingested_lines = ?, ingested_at = ?, last_event_at = ?
			 WHERE file_path = ?`,
		).run(file_hash, prefix_hash, total_lines, lines.length, ingested_at, lastTs, filePath);

		const insertEvent = db.prepare(
			`INSERT OR IGNORE INTO sess_events
			 (session_id, seq, type, ts, role, tool, tokens_in, tokens_out, is_error, content_sha, event_json)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		);
		for (const e of newEvents) {
			const r = insertEvent.run(e.session_id, e.seq, e.type, e.ts, e.role, e.tool,
				e.tokens_in, e.tokens_out, e.is_error, e.content_sha, e.event_json);
			if (r.changes > 0) stats.ingested++;
			else stats.skipped++;
		}
	} catch (e) {
		try { db.exec("ROLLBACK"); } catch (_) {}
		return { ok: false, errors: [`ingest: INSERT failed (${e.message})`] };
	}
	try { db.exec("COMMIT"); } catch (e) {
		try { db.exec("ROLLBACK"); } catch (_) {}
		return { ok: false, errors: [`ingest: COMMIT failed (${e.message})`] };
	}
	return { ok: true, stats };
}

// deleteSessionEvents(db, sessionId) -> number of rows deleted.
// Used on prefix mismatch: blow away the old events before the re-ingest.
function deleteSessionEvents(db, sessionId) {
	try {
		const r = db.prepare("DELETE FROM sess_events WHERE session_id = ?").run(sessionId);
		return r.changes;
	} catch (_) {
		return 0;
	}
}

module.exports = {
	ingestFile,
	// Exported for tests + future re-use.
	countLines,
	splitLines,
	deleteSessionEvents,
};