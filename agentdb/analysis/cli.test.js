// agentdb/analysis/cli.test.js — `apple-pi analyze` CLI (M5-4).
//
// ROADMAP M5-4 acceptance gate (REQ-M5-4): `apple-pi analyze` runs all
// detectors, prints a findings summary, and writes analysis_runs +
// analysis_findings. Read-only on the world: the only tables it mutates
// are analysis_* (sess_*/kb_* are read inputs, never written).
//
// This suite drives agentdb/analysis/cli.js's run() in-process against a
// throwaway $AGENT_DB file (mirrors runs.test.js / detectors.test.js).
// The bin/apple-pi subprocess path is exercised by the integration smokes.

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { DatabaseSync } = require("node:sqlite");

const cli = require("./cli");

const SCHEMA_PATH = path.join(__dirname, "..", "lib", "schema.sql");

// freshFileDB() — a temp DB file with the schema applied. The CLI opens
// $AGENT_DB via lib/db.js, so we point AGENT_DB at this file. Returns the
// file path; caller owns cleanup of the temp dir.
function freshFileDB() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "analyze-cli-"));
	const file = path.join(dir, "agent.db");
	const db = new DatabaseSync(file);
	db.exec(readFileSync(SCHEMA_PATH, "utf8"));
	db.close();
	return { dir, file };
}

// insertEvent(db, opts) — INSERT one sess_events row directly.
function insertEvent(db, opts) {
	db.prepare(
		`INSERT INTO sess_events (session_id, seq, type, ts, role, tool, tokens_in, tokens_out, is_error, content_sha, event_json)
		 VALUES (?, ?, 'message', ?, ?, ?, ?, ?, ?, ?, '{}')`,
	).run(
		opts.session_id,
		opts.seq,
		opts.ts,
		opts.role ?? "user",
		opts.tool ?? null,
		opts.tokens_in ?? 0,
		opts.tokens_out ?? 0,
		opts.is_error ?? 0,
		opts.content_sha ?? `sha-${opts.session_id}-${opts.seq}`,
	);
}

// captureStdout(fn) — run fn with console.log patched; return its exit code
// plus the captured stdout text. console.error is left untouched so test
// failures still surface real diagnostics.
function captureStdout(fn) {
	const orig = console.log;
	const lines = [];
	console.log = (...a) => { lines.push(a.join(" ")); };
	try {
		const code = fn();
		return { code, stdout: lines.join("\n") };
	} finally {
		console.log = orig;
	}
}

// withEnv(key, value, fn) — set env var for the duration of fn, restore after.
function withEnv(key, value, fn) {
	const prev = process.env[key];
	process.env[key] = value;
	try { return fn(); } finally { process.env[key] = prev; }
}

// =====================================================================
// ABUSE SUITE — must run first
// =====================================================================

test("abuse: -h/--help prints help and exits 0 without touching the DB", () => {
	const { dir, file } = freshFileDB();
	try {
		const { code, stdout } = withEnv("AGENT_DB", file, () => captureStdout(() => cli.run(["--help"])));
		assert.equal(code, 0);
		assert.match(stdout, /analyze/i, "help text mentions analyze");
		// No run row should have been created by a help call.
		const db = new DatabaseSync(file);
		try {
			assert.equal(db.prepare("SELECT COUNT(*) n FROM analysis_runs").get().n, 0);
		} finally { db.close(); }
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

// =====================================================================
// REQ-M5-4 — happy path
// =====================================================================

test("REQ-M5-4: apple-pi analyze exits 0, prints N findings, rows exist", () => {
	const { dir, file } = freshFileDB();
	try {
		// Seed: 5 error events for one tool → error_pattern fires (>= minErrors).
		const seed = new DatabaseSync(file);
		for (let i = 0; i < 5; i++) {
			insertEvent(seed, { session_id: "s-x", seq: i, ts: "2026-01-01T00:00:00.000Z", tool: "search_files", is_error: 1 });
		}
		seed.close();

		const { code, stdout } = withEnv("AGENT_DB", file, () => captureStdout(() => cli.run([])));
		assert.equal(code, 0, `expected exit 0; stdout=\n${stdout}`);
		// "prints N findings" — the summary reports a count.
		assert.match(stdout, /finding/i, `stdout should mention findings; got:\n${stdout}`);

		// "rows exist": exactly one analysis_runs row (the run we just did),
		// ended, with finding_count >= 1, and matching analysis_findings rows.
		const db = new DatabaseSync(file);
		try {
			const runs = db.prepare("SELECT * FROM analysis_runs ORDER BY id").all();
			assert.equal(runs.length, 1, "exactly one analysis_runs row per analyze call");
			assert.ok(runs[0].finding_count >= 1, `finding_count >= 1; got ${runs[0].finding_count}`);
			assert.notEqual(runs[0].ended_at, null, "run was closed (ended_at set)");

			const findings = db.prepare("SELECT * FROM analysis_findings WHERE run_id = ?").all(runs[0].id);
			assert.ok(findings.length >= 1, "at least one analysis_findings row linked to the run");
			assert.equal(findings.length, runs[0].finding_count, "run.finding_count == rows in analysis_findings");
			// error_pattern is the detector the seed was built to fire.
			assert.ok(findings.some(f => f.detector === "error_pattern"), "an error_pattern finding landed");
		} finally {
			db.close();
		}
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("REQ-M5-4: empty corpus → 0 findings, but a run row still exists", () => {
	const { dir, file } = freshFileDB();
	try {
		const { code, stdout } = withEnv("AGENT_DB", file, () => captureStdout(() => cli.run([])));
		assert.equal(code, 0, `expected exit 0 even with no data; stdout=\n${stdout}`);
		// A 0-finding run is a success, not an error — the run still lands.
		assert.match(stdout, /0\s+findings?/i, `summary should report 0 findings; got:\n${stdout}`);

		const db = new DatabaseSync(file);
		try {
			assert.equal(db.prepare("SELECT COUNT(*) n FROM analysis_runs").get().n, 1, "one run row even with 0 findings");
			assert.equal(db.prepare("SELECT COUNT(*) n FROM analysis_findings").get().n, 0, "no findings rows");
			const run = db.prepare("SELECT * FROM analysis_runs").get();
			assert.equal(run.finding_count, 0);
			assert.notEqual(run.ended_at, null, "0-finding run is still closed");
		} finally {
			db.close();
		}
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("REQ-M5-4: read-only on the world — sess_*/kb_* rows survive unchanged", () => {
	const { dir, file } = freshFileDB();
	try {
		// Seed both a sess_events cluster (fires error_pattern) and a
		// kb_cards stall row (fires card_stall) so multiple tables are
		// read. Capture the exact pre-state, then verify it is byte-identical
		// post-analyze (the read-only-on-the-world contract).
		const seed = new DatabaseSync(file);
		for (let i = 0; i < 6; i++) {
			insertEvent(seed, { session_id: "s-x", seq: i, ts: "2026-01-01T00:00:00.000Z", tool: "search_files", is_error: 1 });
		}
		seed.prepare(
			`INSERT INTO sess_sessions (session_id, started_at, ended_at, last_event_at, message_count, tool_call_count, error_count, tokens_in, tokens_out, cost, model, cwd, tool_calls_json, file_path)
			 VALUES ('s-x', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 1, 0, 6, 0, 0, 0, 'MiniMax-M3', '/x', '{}', NULL)`,
		).run();
		seed.prepare(
			`INSERT INTO kb_cards (id, title, status, project, updated_at, file_path, frontmatter_json, file_hash)
			 VALUES ('stalled', 'Stalled', 'in_progress', 'p', '2026-01-01T00:00:00.000Z', '/x/stalled.card.md', '{}', 'sha-stalled')`,
		).run();
		seed.close();

		// Snapshot the read-side tables (everything the detectors read).
		const snap = (db) => ({
			sess_events: db.prepare("SELECT * FROM sess_events ORDER BY session_id, seq").all(),
			sess_sessions: db.prepare("SELECT * FROM sess_sessions ORDER BY session_id").all(),
			kb_cards: db.prepare("SELECT * FROM kb_cards ORDER BY id").all(),
			kb_deps: db.prepare("SELECT * FROM kb_deps ORDER BY 1").all(),
			kb_meta: db.prepare("SELECT * FROM kb_meta ORDER BY 1").all(),
		});
		let before;
		{
			const db = new DatabaseSync(file);
			try { before = snap(db); } finally { db.close(); }
		}

		const { code, stdout } = withEnv("AGENT_DB", file, () => captureStdout(() => cli.run([])));
		assert.equal(code, 0, `expected exit 0; stdout=\n${stdout}`);
		assert.match(stdout, /finding/i);

		// After analyze, the read-side tables must be byte-identical to before;
		// the only writes are to analysis_*.
		const db = new DatabaseSync(file);
		try {
			for (const tbl of Object.keys(before)) {
				assert.deepEqual(snap(db)[tbl], before[tbl], `read-only contract violated: ${tbl} changed`);
			}
			assert.ok(db.prepare("SELECT COUNT(*) n FROM analysis_runs").get().n >= 1, "analysis_runs written");
			assert.ok(db.prepare("SELECT COUNT(*) n FROM analysis_findings").get().n >= 1, "analysis_findings written");
		} finally {
			db.close();
		}
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
