// bin/apple-pi.improve.test.js — REQ-M8-6
//
// `apple-pi improve [--apply] [--yes]` — the CLI wrapper around propose
// (M6-1) + apply (M6-3). The default run proposes only: it scans
// analysis_findings for unlinked rows and writes proposals (status
// 'proposed'). --apply also runs apply; apply NEVER writes without --yes
// (the D9 gate). This is the one-verb "find improvements AND optionally
// apply the latest" path.
//
// ACCEPTANCE (REQ-M8-6): propose writes proposals; no apply without --yes.
//
// This suite drives the REAL bin/apple-pi wrapper as a subprocess (the path a
// user hits), points AGENT_DB at a throwaway file, seeds analysis_findings
// directly, and asserts:
//   - improve (default):      propose writes proposals (status 'proposed') +
//                             back-fills analysis_findings.proposal_id; exit 0
//   - improve (default):      does NOT apply (nothing flips to 'applied', no
//                             improvement_outcomes row)
//   - improve (idempotent):   re-run finds nothing new (no dupes)
//   - improve --apply:        NO apply without --yes — proposal stays
//                             'proposed', no outcome row; exit 0 (gated, not
//                             an error); stdout flags --yes
//   - improve --apply --yes:  applies the latest proposal — status 'applied' +
//                             one improvement_outcomes row; exit 0
//   - improve --apply --yes:  with nothing pending is a no-op; exit 0
//
// Verify: node --test bin/apple-pi.improve.test.js
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");

const BIN = path.join(__dirname, "apple-pi");
const SCHEMA_PATH = path.join(__dirname, "..", "agentdb", "lib", "schema.sql");

// freshDB() -> { dir, dbFile, env } — a tmpdir + schema'd DB + env with
// AGENT_DB pointed at it. Each test gets its own.
function freshDB() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "improve-cli-"));
	const dbFile = path.join(dir, "agent.db");
	const db = new DatabaseSync(dbFile);
	db.exec(readFileSync(SCHEMA_PATH, "utf8"));
	db.close();
	return { dir, dbFile, env: { ...process.env, AGENT_DB: dbFile } };
}

// seedFindings(dbFile, n) -> ids — insert n analysis_findings rows (each on
// its own run, proposal_id NULL so propose() picks them up). Mirrors the
// error_pattern evidence shape detectors.js emits. Returns the finding ids.
function seedFindings(dbFile, n = 1) {
	const db = new DatabaseSync(dbFile);
	try {
		const ids = [];
		for (let i = 0; i < n; i++) {
			const run = db.prepare(
				`INSERT INTO analysis_runs (started_at, ended_at, finding_count) VALUES (?, ?, ?)`,
			).run("2026-07-01T00:00:00.000Z", "2026-07-01T00:00:01.000Z", 1);
			const errors = 5 + i;
			const ev = JSON.stringify({ tool: "bash", error_count: errors, threshold: 5 });
			const f = db.prepare(
				`INSERT INTO analysis_findings (run_id, detector, severity, title, evidence_json)
				 VALUES (?, 'error_pattern', 'warn', ?, ?)`,
			).run(run.lastInsertRowid, `tool bash errored ${errors} times`, ev);
			ids.push(Number(f.lastInsertRowid));
		}
		return ids;
	} finally { db.close(); }
}

// runImprove(args, env) — spawn the real bin/apple-pi improve <args>.
// node --no-warnings suppresses the node:sqlite ExperimentalWarning.
function runImprove(args, env) {
	const r = spawnSync(process.execPath, ["--no-warnings", BIN, "improve", ...args], {
		cwd: __dirname, env, encoding: "utf8",
	});
	return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

// count(dbFile, table, where=[]) -> number — convenience for DB assertions.
function count(dbFile, table, where = []) {
	const db = new DatabaseSync(dbFile);
	try {
		const sql = `SELECT COUNT(*) c FROM ${table}` + (where.length ? ` WHERE ${where.join(" AND ")}` : "");
		return db.prepare(sql).get().c;
	} finally { db.close(); }
}

// ===========================================================================
// REQ-M8-6: `apple-pi improve` (default) — propose writes proposals
// ===========================================================================

test("apple-pi improve (default) writes proposals from unlinked findings (REQ-M8-6)", () => {
	const { dbFile, env } = freshDB();
	seedFindings(dbFile, 2);

	const r = runImprove([], env);
	assert.equal(r.status, 0, `exit 0; stderr=\n${r.stderr}`);

	// propose wrote 2 proposals, both status 'proposed'
	assert.equal(count(dbFile, "proposals"), 2, "2 proposals written");
	assert.equal(count(dbFile, "proposals", ["status='proposed'"]), 2, "all 'proposed'");
	// back-fill: findings now linked to a proposal
	assert.equal(count(dbFile, "analysis_findings", ["proposal_id IS NOT NULL"]), 2, "findings back-filled");
	// stdout reports the propose step
	assert.match(r.stdout, /propos/i, `stdout should report proposals; got:\n${r.stdout}`);
});

test("apple-pi improve (default) does NOT apply: nothing flips to 'applied' (REQ-M8-6)", () => {
	const { dbFile, env } = freshDB();
	seedFindings(dbFile, 1);

	const r = runImprove([], env);
	assert.equal(r.status, 0, `exit 0; stderr=\n${r.stderr}`);
	// default never calls apply — no applied rows, no outcomes
	assert.equal(count(dbFile, "proposals", ["status='applied'"]), 0, "default must not apply");
	assert.equal(count(dbFile, "improvement_outcomes"), 0, "default must not write outcomes");
});

test("apple-pi improve is idempotent: re-run finds nothing new (REQ-M8-6)", () => {
	const { dbFile, env } = freshDB();
	seedFindings(dbFile, 1);

	const r1 = runImprove([], env); // 1 proposal
	assert.equal(r1.status, 0);
	assert.equal(count(dbFile, "proposals"), 1);

	const r2 = runImprove([], env); // no new unlinked findings -> no dupes
	assert.equal(r2.status, 0);
	assert.equal(count(dbFile, "proposals"), 1, "idempotent: no dupes");
});

// ===========================================================================
// REQ-M8-6: `apple-pi improve --apply` WITHOUT --yes — NO apply (the gate)
// ===========================================================================

test("apple-pi improve --apply WITHOUT --yes applies NOTHING (REQ-M8-6 gate)", () => {
	const { dbFile, env } = freshDB();
	seedFindings(dbFile, 1);

	const r = runImprove(["--apply"], env);
	assert.equal(r.status, 0, `gated apply exits 0 (not an error); stderr=\n${r.stderr}`);

	// propose still ran (1 proposal written), but apply was gated by --yes
	assert.equal(count(dbFile, "proposals"), 1, "propose ran");
	assert.equal(count(dbFile, "proposals", ["status='proposed'"]), 1, "still 'proposed'");
	assert.equal(count(dbFile, "proposals", ["status='applied'"]), 0, "NOT applied (no --yes)");
	assert.equal(count(dbFile, "improvement_outcomes"), 0, "no outcome written (no --yes)");
	// human output flags the --yes gate
	assert.match(r.stdout, /--yes/i, `stdout should mention --yes gate; got:\n${r.stdout}`);
});

// ===========================================================================
// REQ-M8-6: `apple-pi improve --apply --yes` — applies the latest proposal
// ===========================================================================

test("apple-pi improve --apply --yes applies the latest proposal (REQ-M8-6)", () => {
	const { dbFile, env } = freshDB();
	seedFindings(dbFile, 1);

	const r = runImprove(["--apply", "--yes"], env);
	assert.equal(r.status, 0, `exit 0; stderr=\n${r.stderr}`);

	// the proposal flipped to 'applied' + exactly one outcome row written
	assert.equal(count(dbFile, "proposals", ["status='applied'"]), 1, "applied");
	assert.equal(count(dbFile, "improvement_outcomes"), 1, "one outcome written");
	// stdout reports the apply
	assert.match(r.stdout, /appl/i, `stdout should report apply; got:\n${r.stdout}`);
});

// ===========================================================================
// REQ-M8-6: --apply --yes with nothing pending — no-op, exit 0
// ===========================================================================

test("apple-pi improve --apply --yes with nothing pending is a no-op (REQ-M8-6)", () => {
	const { dbFile, env } = freshDB();
	// no findings -> propose writes nothing -> apply has nothing to apply
	const r = runImprove(["--apply", "--yes"], env);
	assert.equal(r.status, 0, `exit 0; stderr=\n${r.stderr}`);
	assert.equal(count(dbFile, "proposals"), 0, "no proposals");
	assert.equal(count(dbFile, "improvement_outcomes"), 0, "no outcomes");
});
