// agentdb/pi/self_improve.test.js — pi agent tool self_improve (M9-5).
//
// ROADMAP M9-5 acceptance gate (REQ-M9-5): "harness runs analyze, returns
// findings, applies nothing." This is the testable JS core of the pi tool;
// the pi extension (.ts harness binding) is a thin wrapper over this module
// (M9-6).
//
// What "runs analyze, returns findings, applies nothing" means, concretely:
//   - self_improve is the agent-callable, IN-SESSION entry to the
//     self-improvement loop (SUPERPROMPT §8). It runs the autonomous `analyze`
//     pass (M5-4 cli.js factored as a callable): start a run → run all
//     detectors → record each finding → end the run, and RETURN the findings
//     to the agent so it can reason about them mid-session.
//   - It MAY also run `propose` (M6-1) when asked (opts.propose=true): turns
//     the freshly-recorded findings into 'proposed' proposal rows. Still no
//     apply.
//   - NEVER APPLIES. `apply` (M6-3) is CLI-gated only (decision D9 — the human
//     apply gate). self_improve has NO code path that calls apply, NO yes/
//     apply option, and the result always carries applied:false. The headline
//     red-blue below proves this: a pre-existing 'proposed' proposal is left
//     byte-identical and no improvement_outcomes row is ever created.
//
// Best-effort, no-throw (mirrors pi/list.js / pi/query.js): a bad db or an
// empty corpus returns { ok:true, findings:[] } (an empty analyze is a
// success, not an error). The tool runs in TWO modes (mirrors every pi/*
// tool): (a) an injected db (tests + composition — caller owns the
// connection, no open/close), and (b) opening its OWN connection via
// lib/db.open() (the real "pi harness" path). NO ensureCurrent reconcile
// runs: Tier B (sess_*/analysis_*/proposals) is authoritative in the DB
// itself, not mirrored from files.
//
// Test shape mirrors pi/query.test.js (injected-db happy + opens-own-db +
// red-blue no-mutation) + analysis/apply.test.js (the byte-identical
// "applies nothing" snapshot pattern).

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const { self_improve } = require("./self_improve");

const SCHEMA_PATH = path.join(__dirname, "..", "lib", "schema.sql");

// --- shared helpers (mirror pi/query.test.js + detectors.test.js) ---

// freshDB() — in-memory DB with the canonical schema applied (all tiers).
function freshDB() {
	const db = new DatabaseSync(":memory:");
	db.exec(fs.readFileSync(SCHEMA_PATH, "utf8"));
	return db;
}

// insertErrorEvent(db, opts) — INSERT one errored sess_events row. Enough to
// trip error_pattern (>= 5 errors for the same tool across sessions).
function insertErrorEvent(db, opts) {
	db.prepare(
		`INSERT INTO sess_events (session_id, seq, type, ts, role, tool,
		   tokens_in, tokens_out, is_error, content_sha, event_json)
		 VALUES (?, ?, 'message', ?, ?, ?, ?, ?, 1, ?, '{}')`,
	).run(
		opts.session_id, opts.seq,
		opts.ts ?? "2026-01-01T00:00:00.000Z",
		opts.role ?? "user",
		opts.tool ?? "search_files",
		opts.tokens_in ?? 0, opts.tokens_out ?? 0,
		opts.content_sha ?? `sha-${opts.session_id}-${opts.seq}`,
	);
}

// seedFiveErrors(db, tool) — the canonical error_pattern trigger: 5 errors for
// the same tool across 5 sessions. Returns the expected finding count (1).
function seedFiveErrors(db, tool = "search_files") {
	for (let i = 0; i < 5; i++) {
		insertErrorEvent(db, { session_id: `s-${i}`, seq: 0, tool });
	}
}

// insertProposedProposal(db) — INSERT one 'proposed' proposal row (the state
// apply would target). Used by the red-blue "applies nothing" suite.
function insertProposedProposal(db, setting = "agent.tools.search_files.error_budget") {
	const info = db.prepare(
		`INSERT INTO proposals (status, setting, from_value, to_value, rationale,
		   expected_delta_json, source_finding_ids_json, outcome_id,
		   proposed_at, applied_at, audit)
		 VALUES ('proposed', ?, NULL, 5, 'seeded for red-blue', '{}', '[]', NULL, ?, NULL, NULL)`,
	).run(setting, "2026-01-01T00:00:00.000Z");
	return db.prepare("SELECT * FROM proposals WHERE id = ?").get(info.lastInsertRowid);
}

// =====================================================================
// REQ-M9-5 part 1 — RUNS ANALYZE + RETURNS FINDINGS
// =====================================================================

test("REQ-M9-5: runs analyze, records findings, returns them (injected db)", () => {
	const db = freshDB();
	try {
		seedFiveErrors(db); // trips error_pattern -> 1 warn finding
		assert.equal(
			db.prepare("SELECT COUNT(*) c FROM analysis_runs").get().c, 0,
			"no run before",
		);

		const res = self_improve({ db });

		// ok + the analyze artifacts
		assert.equal(res.ok, true, `expected ok, got: ${JSON.stringify(res.errors || [])}`);
		assert.equal(typeof res.run_id, "number", "run_id returned");
		assert.ok(res.run_id > 0);
		assert.equal(res.detectorCount, 6, "ran all six detectors");

		// the findings are returned to the agent
		assert.ok(Array.isArray(res.findings), "findings is an array");
		assert.equal(res.findings.length, 1, "exactly the error_pattern finding");
		const f = res.findings[0];
		assert.equal(f.detector, "error_pattern");
		assert.equal(f.severity, "warn");
		assert.match(f.title, /search_files/);
		assert.equal(f.run_id, res.run_id, "finding carries the run_id");
		assert.equal(typeof f.id, "number", "finding carries its persisted id");
		assert.equal(f.evidence.tool, "search_files", "evidence parsed (evidence_json dropped)");
		assert.equal(f.evidence.error_count, 5);

		// persisted: one run row + one finding row, self-consistent
		assert.equal(
			db.prepare("SELECT COUNT(*) c FROM analysis_runs").get().c, 1,
			"exactly one analysis_runs row created",
		);
		const run = db.prepare("SELECT * FROM analysis_runs WHERE id = ?").get(res.run_id);
		assert.equal(run.finding_count, 1, "run.finding_count self-consistent");
		assert.notEqual(run.ended_at, null, "run was ended (not left running)");
		assert.equal(
			db.prepare("SELECT COUNT(*) c FROM analysis_findings WHERE run_id = ?").get(res.run_id).c, 1,
			"finding persisted to analysis_findings",
		);
	} finally {
		db.close();
	}
});

test("REQ-M9-5: result always carries applied:false (the headline invariant)", () => {
	const db = freshDB();
	try {
		seedFiveErrors(db);
		const res = self_improve({ db });
		assert.equal(res.ok, true);
		assert.equal(res.applied, false, "applied is explicitly false");
	} finally {
		db.close();
	}
});

test("REQ-M9-5: empty corpus -> ok with no findings (no-op, no throw)", () => {
	const db = freshDB();
	try {
		const res = self_improve({ db });
		assert.equal(res.ok, true, "an empty analyze is a success");
		assert.deepEqual(res.findings, []);
		assert.equal(res.findingCount ?? res.findings.length, 0);
		assert.equal(res.applied, false);
		assert.equal(
			db.prepare("SELECT COUNT(*) c FROM analysis_runs").get().c, 1,
			"still records a run (even with zero findings)",
		);
	} finally {
		db.close();
	}
});

test("REQ-M9-5: result is JSON-serializable (the pi harness round-trips it)", () => {
	const db = freshDB();
	try {
		seedFiveErrors(db);
		const res = self_improve({ db });
		const json = JSON.stringify(res);
		const back = JSON.parse(json);
		assert.equal(back.ok, true);
		assert.equal(back.applied, false);
		assert.equal(back.findings.length, 1);
		assert.equal(back.findings[0].detector, "error_pattern");
	} finally {
		db.close();
	}
});

// =====================================================================
// REQ-M9-5 part 2 — APPLIES NOTHING (the headline red-blue)
// =====================================================================

test("REQ-M9-5 red-blue: a pre-existing 'proposed' proposal is NEVER applied", () => {
	const db = freshDB();
	try {
		seedFiveErrors(db); // so analyze produces a finding (would-be propose/apply fuel)
		const beforeProposal = insertProposedProposal(db); // the apply target
		const beforeOutcomes = db.prepare("SELECT COUNT(*) c FROM improvement_outcomes").get().c;
		const beforeRuns = db.prepare("SELECT COUNT(*) c FROM analysis_runs").get().c;
		const beforeFindings = db.prepare("SELECT COUNT(*) c FROM analysis_findings").get().c;

		const res = self_improve({ db });
		assert.equal(res.ok, true);

		// the pre-existing proposal row is byte-identical — apply never ran.
		const afterProposal = db.prepare("SELECT * FROM proposals WHERE id = ?").get(beforeProposal.id);
		assert.deepEqual(afterProposal, beforeProposal, "proposal row must not change");
		assert.equal(afterProposal.status, "proposed", "status must stay 'proposed'");
		assert.equal(afterProposal.applied_at, null, "applied_at must stay NULL");
		assert.equal(afterProposal.audit, null, "audit must stay NULL");
		assert.equal(afterProposal.outcome_id, null, "outcome_id must stay NULL");

		// no outcome row created — the apply artifact never appeared.
		assert.equal(
			db.prepare("SELECT COUNT(*) c FROM improvement_outcomes").get().c, beforeOutcomes,
			"no improvement_outcomes row may be created (apply never ran)",
		);

		// analyze DID run: one new run + one new finding (the only writes allowed).
		assert.equal(
			db.prepare("SELECT COUNT(*) c FROM analysis_runs").get().c, beforeRuns + 1,
			"analyze added exactly one run",
		);
		assert.equal(
			db.prepare("SELECT COUNT(*) c FROM analysis_findings").get().c, beforeFindings + 1,
			"analyze added exactly one finding",
		);
	} finally {
		db.close();
	}
});

test("REQ-M9-5 red-blue: NO proposals are created by default (propose opt-in only)", () => {
	const db = freshDB();
	try {
		seedFiveErrors(db);
		const beforeProposals = db.prepare("SELECT COUNT(*) c FROM proposals").get().c;

		self_improve({ db });

		assert.equal(
			db.prepare("SELECT COUNT(*) c FROM proposals").get().c, beforeProposals,
			"default self_improve creates NO proposals (propose is opt-in)",
		);
	} finally {
		db.close();
	}
});

test("REQ-M9-5 red-blue: a stray yes:true option does NOT apply (no apply path exists)", () => {
	const db = freshDB();
	try {
		seedFiveErrors(db);
		const beforeProposal = insertProposedProposal(db);
		const beforeOutcomes = db.prepare("SELECT COUNT(*) c FROM improvement_outcomes").get().c;

		// An agent (or a confused caller) passing yes:true must still apply
		// nothing — self_improve has no apply code path at all.
		const res = self_improve({ db, yes: true, apply: true, latest: true });
		assert.equal(res.ok, true);
		assert.equal(res.applied, false, "no option can flip applied to true");

		const afterProposal = db.prepare("SELECT * FROM proposals WHERE id = ?").get(beforeProposal.id);
		assert.deepEqual(afterProposal, beforeProposal, "proposal untouched even with yes:true");
		assert.equal(
			db.prepare("SELECT COUNT(*) c FROM improvement_outcomes").get().c, beforeOutcomes,
			"no outcome created even with yes:true",
		);
	} finally {
		db.close();
	}
});

// =====================================================================
// REQ-M9-5 part 3 — OPTIONAL propose: STILL never applies
// =====================================================================

test("REQ-M9-5 propose: propose=true turns findings into 'proposed' rows, applies nothing", () => {
	const db = freshDB();
	try {
		seedFiveErrors(db);
		const beforeProposal = insertProposedProposal(db); // would-be apply target
		const beforeOutcomes = db.prepare("SELECT COUNT(*) c FROM improvement_outcomes").get().c;

		const res = self_improve({ db, propose: true });
		assert.equal(res.ok, true);
		assert.equal(res.applied, false, "propose does not apply");
		assert.ok((res.proposedCount || 0) >= 1, "propose ran + reported a count");

		// new proposal rows exist, ALL 'proposed', NONE 'applied'.
		const rows = db.prepare("SELECT status FROM proposals").all();
		assert.ok(rows.length >= 2, "pre-existing + at least one new proposal");
		assert.deepEqual(
			rows.map(r => r.status),
			rows.map(() => "proposed"),
			"every proposal is 'proposed' — none applied",
		);
		// the pre-existing target is untouched
		assert.deepEqual(
			db.prepare("SELECT * FROM proposals WHERE id = ?").get(beforeProposal.id),
			beforeProposal,
		);
		// still no outcome
		assert.equal(
			db.prepare("SELECT COUNT(*) c FROM improvement_outcomes").get().c, beforeOutcomes,
			"propose creates no improvement_outcomes",
		);
	} finally {
		db.close();
	}
});

test("REQ-M9-5 propose: the new proposals cite THIS run's findings (source_finding_ids)", () => {
	// self_improve always re-analyzes (a fresh run + fresh findings each call),
	// so it is intentionally NOT idempotent across calls — that is propose's own
	// contract (M6-1: a finding already linked to a proposal is skipped). What
	// matters for self_improve is that propose links exactly the findings this
	// run produced.
	const db = freshDB();
	try {
		seedFiveErrors(db);
		const res = self_improve({ db, propose: true });
		assert.equal(res.ok, true);
		assert.ok(res.findings.length >= 1);
		const findingIds = res.findings.map(f => f.id);

		// every proposal created this call cites one of this run's finding ids.
		// (fresh DB, only this run ran, so all proposals belong to it.)
		const rows = db.prepare("SELECT source_finding_ids_json FROM proposals").all();
		assert.ok(rows.length >= 1, "propose created at least one proposal");
		for (const r of rows) {
			const cited = JSON.parse(r.source_finding_ids_json);
			assert.ok(
				cited.every(id => findingIds.includes(id)),
				`proposal cites a finding from this run: ${JSON.stringify(cited)} vs ${JSON.stringify(findingIds)}`,
			);
		}
	} finally {
		db.close();
	}
});

// =====================================================================
// REQ-M9-5 part 4 — opens-OWN-db path (the real "pi harness" path)
// =====================================================================

test("REQ-M9-5: with NO injected db opens AGENT_DB, runs analyze, applies nothing", () => {
	const tmpDb = path.join(os.tmpdir(), `pi-self-improve-db-${process.pid}-${Date.now()}.sqlite`);
	process.env.AGENT_DB = tmpDb;
	try {
		// seed the on-disk DB the open() path will hit
		{
			const seed = new DatabaseSync(tmpDb);
			seed.exec(fs.readFileSync(SCHEMA_PATH, "utf8"));
			seedFiveErrors(seed);
			insertProposedProposal(seed);
			seed.close();
		}

		const res = self_improve();
		assert.equal(res.ok, true, `expected ok, got: ${JSON.stringify(res.errors || [])}`);
		assert.equal(res.findings.length, 1);
		assert.equal(res.findings[0].detector, "error_pattern");
		assert.equal(res.applied, false);

		// persisted to the on-disk DB
		const check = new DatabaseSync(tmpDb);
		try {
			assert.equal(check.prepare("SELECT COUNT(*) c FROM analysis_runs").get().c, 1);
			assert.equal(check.prepare("SELECT COUNT(*) c FROM analysis_findings").get().c, 1);
			// the pre-existing proposal is still 'proposed' — apply never ran
			assert.equal(
				check.prepare("SELECT status FROM proposals ORDER BY id DESC LIMIT 1").get().status,
				"proposed",
			);
			assert.equal(check.prepare("SELECT COUNT(*) c FROM improvement_outcomes").get().c, 0);
		} finally {
			check.close();
		}
	} finally {
		delete process.env.AGENT_DB;
		try { fs.unlinkSync(tmpDb); } catch (_) {}
	}
});

// =====================================================================
// abuse — best-effort, no-throw
// =====================================================================

test("abuse: missing db (no injected db, no AGENT_DB) is handled, no throw", () => {
	// Point AGENT_DB at a path that cannot be opened (a directory) so open()
	// fails. self_improve must surface ok:false, not throw. We use a fresh
	// empty dir under tmpdir as an unopenable DB target.
	const badPath = fs.mkdtempSync(path.join(os.tmpdir(), "pi-self-improve-bad-"));
	process.env.AGENT_DB = path.join(badPath, "sub"); // parent missing? -> use dir itself
	process.env.AGENT_DB = badPath; // a directory is not a valid sqlite file
	try {
		const res = self_improve();
		assert.equal(res.ok, false, "an unopenable DB must surface ok:false");
		assert.ok(Array.isArray(res.errors) && res.errors.length > 0, "errors[] populated");
	} finally {
		delete process.env.AGENT_DB;
		fs.rmSync(badPath, { recursive: true, force: true });
	}
});
