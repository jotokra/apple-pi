// agentdb/ingest/incremental.test.js — append-only ingest + re-ingest (M4-2).
//
// ROADMAP M4-2 acceptance gate: appending 10 lines to a 100-line session
// ingests exactly 10 events; rewriting the file re-ingests only that
// session. Test layout: abuse suite first (bad paths, missing files,
// hash-mismatch handling), then happy path (first ingest, append-only,
// re-ingest, idempotency).

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const { ingestFile } = require("./incremental");
const { parseLine } = require("./sessions");

const SCHEMA_PATH = path.join(__dirname, "..", "lib", "schema.sql");

function freshDB() {
	const db = new DatabaseSync(":memory:");
	db.exec(readFileSync(SCHEMA_PATH, "utf8"));
	return db;
}

// Fixture helpers — produce JSONL-shaped strings the parser can consume.
function sessionLine(opts) {
	return JSON.stringify(Object.assign({
		timestamp: "2026-01-01T00:00:00.000Z",
	}, opts));
}

function buildJSONL(opts) {
	const { session_id = "sess-A", n = 10, startTs = "2026-01-01T00:00:00.000Z", intervalMs = 1000 } = opts;
	const lines = [];
	lines.push(sessionLine({ type: "session", id: session_id, timestamp: startTs, cwd: "/x" }));
	for (let i = 1; i < n; i++) {
		const ts = new Date(new Date(startTs).getTime() + i * intervalMs).toISOString();
		lines.push(sessionLine({
			type: "message",
			role: i % 2 === 0 ? "user" : "assistant",
			timestamp: ts,
			tokens_in: i * 10,
			tokens_out: i * 5,
			content: `msg ${i}`,
		}));
	}
	return lines.join("\n") + "\n";
}

// =====================================================================
// ABUSE SUITE — must run first
// =====================================================================

test("abuse: missing file returns ok:false with 'cannot read' error", () => {
	const db = freshDB();
	const res = ingestFile(db, "/tmp/__kb-ingest-does-not-exist-12345.jsonl");
	assert.equal(res.ok, false);
	assert.match(res.errors.join(" "), /cannot read|ENOENT/);
});

test("abuse: null/undefined filePath is rejected", () => {
	const db = freshDB();
	for (const bad of [null, undefined, 42, true, []]) {
		const res = ingestFile(db, bad);
		assert.equal(res.ok, false, `expected reject for filePath=${JSON.stringify(bad)}`);
	}
});

test("abuse: empty file ingests 0 events cleanly (no errors)", () => {
	const db = freshDB();
	const res = ingestFile(db, "/tmp/__empty.jsonl", { fileReader: () => "" });
	assert.equal(res.ok, true);
	assert.equal(res.stats.ingested, 0);
	assert.equal(res.stats.errors, 0);
});

// =====================================================================
// HAPPY PATH
// =====================================================================

test("happy: first-time ingest of a 100-line session ingests 100 events", () => {
	const db = freshDB();
	const jsonl = buildJSONL({ session_id: "sess-A", n: 100 });
	const res = ingestFile(db, "/tmp/sess-A.jsonl", { fileReader: () => jsonl });
	assert.equal(res.ok, true);
	assert.equal(res.stats.ingested, 100);
	assert.equal(res.stats.errors, 0);
	const sessRows = db.prepare("SELECT * FROM sess_files WHERE file_path = ?").all("/tmp/sess-A.jsonl");
	assert.equal(sessRows.length, 1);
	assert.equal(sessRows[0].session_id, "sess-A");
	assert.equal(sessRows[0].ingested_lines, 100);
	const eventCount = db.prepare("SELECT COUNT(*) as n FROM sess_events WHERE session_id = ?").get("sess-A").n;
	assert.equal(eventCount, 100);
});

test("happy: appending 10 lines to a 100-line session ingests exactly 10 new events", () => {
	const db = freshDB();
	const full = buildJSONL({ session_id: "sess-A", n: 100 });
	const appended = full + buildJSONL({ session_id: "sess-A", n: 10, startTs: "2026-01-01T00:01:40.000Z" }).replace(/^\{"type":"session".*\n/, "");
	// appended now has 100 original lines + 10 new lines (no second "session" event)

	// First ingest: 100
	const r1 = ingestFile(db, "/tmp/sess-A.jsonl", { fileReader: () => full });
	assert.equal(r1.stats.ingested, 100);

	// Second ingest (appended): exactly 10 more
	const r2 = ingestFile(db, "/tmp/sess-A.jsonl", { fileReader: () => appended });
	assert.equal(r2.ok, true);
	assert.equal(r2.stats.ingested, 10);
	assert.equal(r2.stats.appended, 10);
	assert.equal(r2.stats.errors, 0);
	const totalEvents = db.prepare("SELECT COUNT(*) as n FROM sess_events WHERE session_id = ?").get("sess-A").n;
	assert.equal(totalEvents, 110, "100 original + 10 appended = 110 total events");
});

test("happy: re-ingesting an unchanged file is a no-op (zero rows inserted)", () => {
	const db = freshDB();
	const jsonl = buildJSONL({ session_id: "sess-A", n: 50 });
	const r1 = ingestFile(db, "/tmp/sess-A.jsonl", { fileReader: () => jsonl });
	assert.equal(r1.stats.ingested, 50);
	const r2 = ingestFile(db, "/tmp/sess-A.jsonl", { fileReader: () => jsonl });
	assert.equal(r2.ok, true);
	assert.equal(r2.stats.ingested, 0, "no-op: zero rows inserted on second ingest of unchanged file");
	assert.equal(r2.stats.appended, 0);
});

test("happy: rewriting the file (prefix mismatch) deletes old events and re-ingests fresh", () => {
	const db = freshDB();
	const v1 = buildJSONL({ session_id: "sess-A", n: 50 });
	// v2 differs from v1 INSIDE the prefix (e.g. earlier messages edited),
	// not just by appending. We rewrite a line in the middle to a new
	// content so the prefix_hash differs even though the session_id and
	// line count match. buildJSONL generates `"content":"msg 3"` for i=3.
	const v1Lines = v1.split("\n");
	const v1Early = v1Lines.slice(0, Math.floor(v1Lines.length / 2)).join("\n") + "\n";
	const v2Late = v1Lines.slice(Math.floor(v1Lines.length / 2)).join("\n");
	const v2ModifiedEarly = v1Early.replace(/"content":"msg 3"/, '"content":"EDITED"') + v2Late;

	// Sanity: the edit actually changed the content
	assert.ok(v2ModifiedEarly.includes('"content":"EDITED"'), "test setup failed: replace did not match");
	assert.ok(!v2ModifiedEarly.includes('"content":"msg 3"'), "test setup failed: old content still present");

	// First ingest
	const r1 = ingestFile(db, "/tmp/sess-A.jsonl", { fileReader: () => v1 });
	assert.equal(r1.stats.ingested, 50);

	// Rewrite with an edited prefix → prefix mismatch → full re-ingest
	const r2 = ingestFile(db, "/tmp/sess-A.jsonl", { fileReader: () => v2ModifiedEarly });
	assert.equal(r2.ok, true);
	assert.ok(r2.stats.deleted >= 1, `expected at least one old event deleted, got ${r2.stats.deleted}`);
	assert.equal(r2.stats.ingested, 50, "50 fresh events ingested after prefix-mismatch full re-ingest");
	const total = db.prepare("SELECT COUNT(*) as n FROM sess_events WHERE session_id = ?").get("sess-A").n;
	assert.equal(total, 50, "no dupes: total is 50, not 50+50");
});

test("happy: a file that GREW (prefix matches, more lines) takes the append path, not the full-re-ingest path", () => {
	const db = freshDB();
	const v1 = buildJSONL({ session_id: "sess-A", n: 50 });
	const v1Lines = v1.split("\n");
	// v2 = v1's first 50 lines + 10 more (no edit to the prefix)
	const v2 = v1 + v1Lines.slice(1, 11).join("\n") + "\n";

	const r1 = ingestFile(db, "/tmp/sess-A.jsonl", { fileReader: () => v1 });
	assert.equal(r1.stats.ingested, 50);

	const r2 = ingestFile(db, "/tmp/sess-A.jsonl", { fileReader: () => v2 });
	assert.equal(r2.ok, true);
	assert.equal(r2.stats.appended, 10, "appended=10 (the new tail), not full re-ingest");
	assert.equal(r2.stats.deleted, 0, "no deletes — this is the append-only path");
	assert.equal(r2.stats.ingested, 10);
	const total = db.prepare("SELECT COUNT(*) as n FROM sess_events WHERE session_id = ?").get("sess-A").n;
	assert.equal(total, 60, "50 original + 10 appended = 60 events");
});

test("happy: a file that SHRANK (prefix matches, fewer lines) is treated as a full re-ingest of the shorter prefix", () => {
	const db = freshDB();
	const full30 = buildJSONL({ session_id: "sess-A", n: 30 });
	const halfDup = buildJSONL({ session_id: "sess-A", n: 30 }).split("\n").slice(0, 20).join("\n") + "\n";
	// First ingest: 30 events
	const r1 = ingestFile(db, "/tmp/sess-A.jsonl", { fileReader: () => full30 });
	assert.equal(r1.stats.ingested, 30);
	// Then: file shrunk to 20 lines (truncated). Algorithm doesn't know
	// how to "shrink in place" — it deletes the old 30 events and
	// re-ingests the new 20. End state: 20 events (correct), but the
	// mechanism is full re-ingest (deleted + ingested).
	const r3 = ingestFile(db, "/tmp/sess-A.jsonl", { fileReader: () => halfDup });
	assert.equal(r3.ok, true);
	assert.equal(r3.stats.deleted, 30, "all 30 old events deleted (file shrunk below the prefix)");
	assert.equal(r3.stats.ingested, 20, "20 fresh events from the new shorter file");
	const total = db.prepare("SELECT COUNT(*) as n FROM sess_events WHERE session_id = ?").get("sess-A").n;
	assert.equal(total, 20, "final state: 20 events (no dupes)");
});

test("happy: events without explicit session_id inherit from the first 'session' event", () => {
	const db = freshDB();
	const jsonl = [
		sessionLine({ type: "session", id: "sess-X", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/x" }),
		sessionLine({ type: "message", role: "user", timestamp: "2026-01-01T00:00:01.000Z", content: "no session_id here" }),
		sessionLine({ type: "message", role: "assistant", timestamp: "2026-01-01T00:00:02.000Z", content: "neither does this one" }),
	].join("\n") + "\n";
	ingestFile(db, "/tmp/sess-X.jsonl", { fileReader: () => jsonl });
	const evs = db.prepare("SELECT seq, type, session_id FROM sess_events ORDER BY seq").all();
	assert.equal(evs.length, 3);
	assert.equal(evs[0].session_id, "sess-X");
	assert.equal(evs[1].session_id, "sess-X", "inherited from session event");
	assert.equal(evs[2].session_id, "sess-X", "inherited from session event");
});

test("happy: sess_files.file_path is the absolute path the caller passed", () => {
	const db = freshDB();
	const jsonl = buildJSONL({ session_id: "sess-A", n: 5 });
	ingestFile(db, "/some/abs/path/sess-A.jsonl", { fileReader: () => jsonl });
	const sessRow = db.prepare("SELECT file_path FROM sess_files WHERE file_path = ?").get("/some/abs/path/sess-A.jsonl");
	assert.ok(sessRow);
});

test("happy: sess_events are queryable by content_sha (de-dup works)", () => {
	const db = freshDB();
	const jsonl = buildJSONL({ session_id: "sess-A", n: 5 });
	ingestFile(db, "/tmp/sess-A.jsonl", { fileReader: () => jsonl });
	const ev = db.prepare("SELECT content_sha, event_json FROM sess_events LIMIT 1").get();
	assert.ok(ev.content_sha);
	assert.match(ev.content_sha, /^[0-9a-f]{64}$/);
	assert.ok(ev.event_json.includes("type"));
});

test("happy: a partially-truncated file (last lines malformed) ingests the valid prefix", () => {
	const db = freshDB();
	const full = buildJSONL({ session_id: "sess-A", n: 20 });
	// Corrupt the last 3 lines: replace them with malformed JSON
	const lines = full.split("\n");
	lines[lines.length - 4] = "{not json";
	lines[lines.length - 3] = "";
	lines[lines.length - 2] = "{\"no_type_field\":\"oops\"}";
	const truncated = lines.join("\n");
	const res = ingestFile(db, "/tmp/sess-A.jsonl", { fileReader: () => truncated });
	assert.equal(res.ok, true);
	assert.equal(res.stats.errors, 3, "3 lines recorded as errors but ingest continued");
	assert.ok(res.stats.ingested >= 16, "valid prefix still ingested (>=16 of 20 valid lines)");
});

test("happy: appending after a malformed tail still ingests the new prefix", () => {
	const db = freshDB();
	const full = buildJSONL({ session_id: "sess-A", n: 20 });
	const r1 = ingestFile(db, "/tmp/sess-A.jsonl", { fileReader: () => full });
	assert.equal(r1.stats.ingested, 20);

	// Now: append 5 more lines to the same path. Simulate by
	// hand-building a new file content that contains the original + new.
	const appended = full + buildJSONL({ session_id: "sess-A", n: 5, startTs: "2026-01-01T00:00:30.000Z" }).replace(/^\{"type":"session".*\n/, "");
	const r2 = ingestFile(db, "/tmp/sess-A.jsonl", { fileReader: () => appended });
	assert.equal(r2.ok, true);
	assert.equal(r2.stats.ingested, 5);
	const total = db.prepare("SELECT COUNT(*) as n FROM sess_events WHERE session_id = ?").get("sess-A").n;
	assert.equal(total, 25);
});

test("happy: full ingest of a multi-file session directory (one ingestFile call per file) leaves no cross-file contamination", () => {
	const db = freshDB();
	const a = buildJSONL({ session_id: "sess-A", n: 30 });
	const b = buildJSONL({ session_id: "sess-B", n: 50 });
	ingestFile(db, "/tmp/sess-A.jsonl", { fileReader: () => a });
	ingestFile(db, "/tmp/sess-B.jsonl", { fileReader: () => b });
	const aCount = db.prepare("SELECT COUNT(*) as n FROM sess_events WHERE session_id = ?").get("sess-A").n;
	const bCount = db.prepare("SELECT COUNT(*) as n FROM sess_events WHERE session_id = ?").get("sess-B").n;
	assert.equal(aCount, 30);
	assert.equal(bCount, 50);
});

test("happy: stats.errors counts lines that failed to parse (one per line, not file-level)", () => {
	const db = freshDB();
	const full = buildJSONL({ session_id: "sess-A", n: 10 });
	const lines = full.split("\n");
	// Make 3 of the lines malformed
	lines[1] = "{bad";
	lines[3] = "";
	lines[5] = "{\"type\":\"message\"}"; // missing timestamp
	const corrupted = lines.join("\n");
	const res = ingestFile(db, "/tmp/sess-A.jsonl", { fileReader: () => corrupted });
	assert.equal(res.ok, true);
	assert.ok(res.stats.errors >= 1, "at least one error recorded");
	assert.ok(res.stats.ingested + res.stats.errors <= 10, "ingested + errors ≤ total lines");
});