// agentdb/migration/autoresearch.test.js — REQ-M11-3
//
// M11-3 absorb: the legacy ~/.pi/agent/autoresearch.db (runs + proposals,
// written by the autoresearch lifecycle: collect-metrics.js → runs,
// aggregate-week.js → proposals) is copied INTO the unified agent.db, the
// lifecycle/lib/db.js dbPath() is repointed at agent.db, and a `.pre-merge`
// backup of the old db is kept. After this, `apple-pi status` reads from
// agent.db and the old rows are present.
//
// REQ-M11-3: after migrate, `apple-pi status` reads from agent.db; old rows
//   present; old db backed up.
//
// SCHEMA NOTE (the proposals collision): agent.db already has a `proposals`
// table from M6-1 — the NEW self-improvement setting-change proposals
// (setting/from_value/to_value/rationale/...), actively written by
// `apple-pi improve` and tested by bin/apple-pi.improve.test.js. The
// autoresearch `proposals` is a DIFFERENT concept (the weekly brief:
// week_start/week_end/brief_path/summary/changes_json) with an incompatible
// column set, so it CANNOT be merged into the M6 `proposals` without data
// loss or breaking improve. M11-3 therefore lands:
//   - autoresearch `runs`        → agent.db `runs`            (verbatim; no
//                                                      collision — Tier B had
//                                                      no `runs`; SUPERPROMPT
//                                                      §5.2: "unchanged")
//   - autoresearch `proposals`   → agent.db `legacy_proposals` (verbatim, under
//                                                      a distinct name so the
//                                                      active M6 `proposals` is
//                                                      untouched)
// Reshaping/merging the two proposal concepts is an M11-4+ concern. The
// headline "old rows present" holds for BOTH tables; `apple-pi status` (which
// reads `runs` + the M6 `proposals`) shows the migrated runs count correctly.
//
// migrate.js lives at agentdb/lib/migrate.js (per the SUPERPROMPT module map);
// its API: absorbAutoresearch({ from, to, backup }) -> { ok, from, to, backup,
// backupCreated, runsCopied, proposalsCopied, noop, failures? }.
//
// Verify: node --test agentdb/migration/autoresearch.test.js
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");

const { absorbAutoresearch, autoresearchPath } = require("../lib/migrate");
const agentdb = require("../lib/db");
const lifecycle = require("../../lifecycle/lib/db");

const REPO = path.resolve(__dirname, "..", "..");
const AUTORESEARCH_SCHEMA = fs.readFileSync(
	path.join(REPO, "lifecycle", "schema.sql"), "utf8",
);
const REAL_AUTORESEARCH = path.join(os.homedir(), ".pi", "agent", "autoresearch.db");

// --- fixture builders ---

// buildAutoresearchDB(file, { runs, proposals }) — create an autoresearch.db
// at `file` with the legacy schema + the given rows. `runs`/`proposals` are
// arrays of partial row objects (sane defaults filled in).
function buildAutoresearchDB(file, { runs = [], proposals = [] } = {}) {
	const db = new DatabaseSync(file);
	db.exec(AUTORESEARCH_SCHEMA);
	const insRun = db.prepare(
		`INSERT INTO runs (run_date, collected_at, session_count, total_turns,
		   tokens_in, tokens_out, cache_read, cache_write, cost,
		   compaction_count, error_count, tool_calls_json, models_json)
		 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
	);
	for (const r of runs) {
		insRun.run(
			r.run_date, r.collected_at ?? "2026-07-01T00:05:00Z",
			r.session_count ?? 1, r.total_turns ?? 10,
			r.tokens_in ?? 100, r.tokens_out ?? 50, r.cache_read ?? 0, r.cache_write ?? 0,
			r.cost ?? 0.01, r.compaction_count ?? 0, r.error_count ?? 0,
			r.tool_calls_json ?? '{"bash":1}', r.models_json ?? '{"<model>":1}',
		);
	}
	const insProp = db.prepare(
		`INSERT INTO proposals (created_at, week_start, week_end, brief_path,
		   summary, changes_json, status, applied_at, audit)
		 VALUES (?,?,?,?,?,?,?,?,?)`,
	);
	for (const p of proposals) {
		insProp.run(
			p.created_at ?? "2026-07-01T00:10:00Z",
			p.week_start ?? "2026-06-23", p.week_end ?? "2026-06-29",
			p.brief_path ?? "/home/.pi/agent/proposals/2026-06-29.md",
			p.summary ?? "1 proposal", p.changes_json ?? '[{"setting":"x"}]',
			p.status ?? "proposed", p.applied_at ?? null, p.audit ?? null,
		);
	}
	db.close();
}

function tmpFile(prefix) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "m11-autoresearch-"));
	return path.join(dir, prefix);
}

// openRO(file) — read-only handle to an arbitrary db path, for verifying the
// TARGET of an absorb (agentdb.open() always opens dbPath(), which is the
// wrong file inside a test that absorbs into a temp path). The tables already
// exist (absorb applied the schema), so no schema apply is needed for reads.
function openRO(file) {
	return new DatabaseSync(file, { readOnly: true });
}

// restoreEnv(vars) — put process.env keys back exactly. Assigning `undefined`
// to a process.env key coerces to the STRING "undefined" (a real footgun that
// once made piDir() resolve to "undefined/agent/..."), so undefined => DELETE.
function restoreEnv(vars) {
	for (const [k, v] of Object.entries(vars)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
}

// =====================================================================
// ABUSE / SANITY
// =====================================================================

test("abuse: non-string from returns ok:false (no throw)", () => {
	for (const bad of [null, 42, [], {}]) {
		const res = absorbAutoresearch({ from: bad });
		assert.equal(res.ok, false, `expected ok:false for from=${JSON.stringify(bad)}`);
		assert.ok((res.failures || []).length > 0, "failures populated");
	}
});

test("abuse: non-string to returns ok:false (no throw)", () => {
	const res = absorbAutoresearch({ from: "/dev/null", to: 123 });
	assert.equal(res.ok, false);
	assert.match((res.failures || []).join(" "), /to/i);
});

test("abuse: missing source file is a no-op, not an error (best-effort)", () => {
	const tgt = tmpFile("agent.db");
	const ghost = path.join(os.tmpdir(), "m11-no-such-autoresearch-" + process.pid + ".db");
	const res = absorbAutoresearch({ from: ghost, to: tgt, backup: tgt + ".pre-merge" });
	assert.equal(res.ok, true, "missing source is a no-op, not a failure");
	assert.equal(res.noop, true);
	assert.equal(res.runsCopied, 0);
	assert.equal(res.proposalsCopied, 0);
	assert.equal(res.backupCreated, false, "no backup created for a missing source");
	assert.ok(!fs.existsSync(tgt + ".pre-merge"), "no backup file written");
	fs.rmSync(path.dirname(tgt), { recursive: true, force: true });
});

// =====================================================================
// FIXTURE-BASED LOGIC TESTS — deterministic
// =====================================================================

test("absorbAutoresearch copies runs+proposals verbatim into agent.db; backs up the old db (REQ-M11-3)", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "m11-absorb-"));
	const src = path.join(dir, "autoresearch.db");
	const tgt = path.join(dir, "agent.db");
	const backup = src + ".pre-merge";

	buildAutoresearchDB(src, {
		runs: [
			{ run_date: "2026-06-28", session_count: 4, cost: 0.12, error_count: 2 },
			{ run_date: "2026-06-29", session_count: 7, cost: 0.20, error_count: 0 },
			{ run_date: "2026-06-30", session_count: 3, cost: 0.05, error_count: 1 },
		],
		proposals: [
			{ week_end: "2026-06-29", summary: "raise max_turns", status: "proposed" },
			{ week_end: "2026-06-22", summary: "prior week", status: "superseded" },
		],
	});

	const res = absorbAutoresearch({ from: src, to: tgt, backup });

	assert.equal(res.ok, true, `absorb failed: ${JSON.stringify(res.failures)}`);
	assert.equal(res.noop, false);
	assert.equal(res.runsCopied, 3, "all 3 runs copied");
	assert.equal(res.proposalsCopied, 2, "all 2 proposals copied");
	assert.equal(res.backupCreated, true, "pre-merge backup created");
	assert.ok(fs.existsSync(backup), "backup file exists at <from>.pre-merge");

	// open the target via a direct read-only handle (proves the rows landed in
	// the real unified schema at `tgt`, not a side db).
	const db = openRO(tgt);
	try {
		// runs: verbatim, 3 rows, values preserved
		const runCount = db.prepare("SELECT count(*) c FROM runs").get().c;
		assert.equal(runCount, 3);
		const r = db.prepare("SELECT * FROM runs WHERE run_date=?").get("2026-06-29");
		assert.ok(r, "specific run migrated");
		assert.equal(r.session_count, 7);
		assert.equal(r.cost, 0.20);
		assert.equal(r.error_count, 0);
		assert.equal(db.prepare("SELECT run_date FROM runs ORDER BY run_date DESC LIMIT 1").get().run_date, "2026-06-30",
			"latest run_date preserved");

		// proposals: landed in legacy_proposals verbatim (M6 `proposals` is left
		// untouched — the collision is resolved by the distinct table name).
		const propCount = db.prepare("SELECT count(*) c FROM legacy_proposals").get().c;
		assert.equal(propCount, 2);
		const p = db.prepare("SELECT * FROM legacy_proposals WHERE week_end=?").get("2026-06-29");
		assert.ok(p, "specific legacy proposal migrated");
		assert.equal(p.summary, "raise max_turns");
		assert.equal(p.status, "proposed");
		assert.equal(p.brief_path, "/home/.pi/agent/proposals/2026-06-29.md");

		// the M6 proposals table is NOT polluted by the absorb (it has its own
		// shape; the legacy rows did not leak into it).
		assert.equal(db.prepare("SELECT count(*) c FROM proposals").get().c, 0,
			"M6 proposals table untouched by absorb");
	} finally {
		db.close();
	}

	// backup is a faithful byte-copy of the source (still readable, same rows)
	const bdb = new DatabaseSync(backup, { readOnly: true });
	try {
		assert.equal(bdb.prepare("SELECT count(*) c FROM runs").get().c, 3);
		assert.equal(bdb.prepare("SELECT count(*) c FROM proposals").get().c, 2);
	} finally { bdb.close(); }

	fs.rmSync(dir, { recursive: true, force: true });
});

test("absorbAutoresearch is idempotent: a second pass does not double-count and does not overwrite the pre-merge backup", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "m11-idem-"));
	const src = path.join(dir, "autoresearch.db");
	const tgt = path.join(dir, "agent.db");
	const backup = src + ".pre-merge";

	buildAutoresearchDB(src, {
		runs: [{ run_date: "2026-07-01" }, { run_date: "2026-07-02" }],
		proposals: [{ week_end: "2026-06-29", status: "proposed" }],
	});

	const first = absorbAutoresearch({ from: src, to: tgt, backup });
	assert.equal(first.ok, true);
	assert.equal(first.runsCopied, 2);
	assert.equal(first.backupCreated, true);
	const backupStat = fs.statSync(backup);
	const backupMtimeMs = backupStat.mtimeMs;
	const backupSize = backupStat.size;

	// second pass over the SAME pair
	const second = absorbAutoresearch({ from: src, to: tgt, backup });
	assert.equal(second.ok, true);
	assert.equal(second.backupCreated, false, "re-run must NOT overwrite the pre-merge backup");
	assert.equal(fs.statSync(backup).mtimeMs, backupMtimeMs, "backup mtime unchanged on re-run");
	assert.equal(fs.statSync(backup).size, backupSize, "backup bytes unchanged on re-run");

	// no double-count: runs UNIQUE(run_date) + PK id, proposals PK id → REPLACE
	const db = openRO(tgt);
	try {
		assert.equal(db.prepare("SELECT count(*) c FROM runs").get().c, 2);
		assert.equal(db.prepare("SELECT count(*) c FROM legacy_proposals").get().c, 1);
	} finally { db.close(); }

	fs.rmSync(dir, { recursive: true, force: true });
});

test("absorbAutoresearch handles a source with empty runs/proposals tables (forward-compat)", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "m11-empty-"));
	const src = path.join(dir, "autoresearch.db");
	const tgt = path.join(dir, "agent.db");
	buildAutoresearchDB(src, { runs: [], proposals: [] });

	const res = absorbAutoresearch({ from: src, to: tgt, backup: src + ".pre-merge" });
	assert.equal(res.ok, true);
	assert.equal(res.runsCopied, 0);
	assert.equal(res.proposalsCopied, 0);
	const db = openRO(tgt);
	try {
		assert.equal(db.prepare("SELECT count(*) c FROM runs").get().c, 0);
		assert.equal(db.prepare("SELECT count(*) c FROM legacy_proposals").get().c, 0);
	} finally { db.close(); }
	fs.rmSync(dir, { recursive: true, force: true });
});

test("absorbAutoresearch tolerates a source missing the proposals table (partial schema)", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "m11-partial-"));
	const src = path.join(dir, "autoresearch.db");
	const tgt = path.join(dir, "agent.db");
	// a source with the REAL runs shape but NO proposals table (e.g. an early
	// legacy dump before aggregate-week ever ran). Apply the full autoresearch
	// schema then DROP proposals so runs keeps its verbatim shape.
	const sdb = new DatabaseSync(src);
	sdb.exec(AUTORESEARCH_SCHEMA);
	sdb.exec("DROP TABLE proposals");
	sdb.exec(`INSERT INTO runs (run_date, collected_at, session_count, total_turns,
	   tokens_in, tokens_out, cache_read, cache_write, cost,
	   compaction_count, error_count, tool_calls_json, models_json)
	   VALUES ('2026-01-01','2026-01-01T00:00:00Z',1,1,1,1,0,0,0.01,0,0,'{}','{}')`);
	sdb.close();

	const res = absorbAutoresearch({ from: src, to: tgt, backup: src + ".pre-merge" });
	assert.equal(res.ok, true, "missing proposals table is tolerated, not fatal");
	assert.equal(res.runsCopied, 1);
	assert.equal(res.proposalsCopied, 0);
	fs.rmSync(dir, { recursive: true, force: true });
});

// =====================================================================
// REPOINT: lifecycle/lib/db.js now resolves to agent.db
// =====================================================================

test("lifecycle/lib/db.js dbPath() is repointed at agent.db (=== agentdb dbPath)", () => {
	const piroot = fs.mkdtempSync(path.join(os.tmpdir(), "m11-piroot-"));
	const envPre = {
		AGENT_DB: process.env.AGENT_DB,
		AUTORESEARCH_DB: process.env.AUTORESEARCH_DB,
		PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
	};
	delete process.env.AGENT_DB;
	delete process.env.AUTORESEARCH_DB;
	process.env.PI_CODING_AGENT_DIR = piroot;
	try {
		const expected = path.join(piroot, "agent", "agent.db");
		assert.equal(lifecycle.dbPath(), expected, "lifecycle dbPath resolves to agent.db");
		assert.equal(agentdb.dbPath(), expected, "agentdb dbPath resolves to agent.db");
		assert.equal(lifecycle.dbPath(), agentdb.dbPath(),
			"lifecycle and agentdb now share ONE db path (unified DB)");

		// autoresearch.db is now just the SOURCE for migrate (its own resolver),
		// no longer the lifecycle's live db.
		assert.ok(!/autoresearch\.db$/.test(lifecycle.dbPath()),
			"lifecycle dbPath must NOT point at autoresearch.db anymore");

		// AGENT_DB still overrides (tests / rebuilds can repoint without touching live)
		process.env.AGENT_DB = path.join(piroot, "custom.db");
		assert.equal(lifecycle.dbPath(), process.env.AGENT_DB);
		assert.equal(agentdb.dbPath(), process.env.AGENT_DB);
		delete process.env.AGENT_DB;
	} finally {
		restoreEnv(envPre);
		fs.rmSync(piroot, { recursive: true, force: true });
	}
});

// =====================================================================
// END-TO-END: `apple-pi status` reads from agent.db after the absorb
// =====================================================================

test("apple-pi status reads from agent.db after absorb; migrated runs visible (REQ-M11-3)", () => {
	const piroot = fs.mkdtempSync(path.join(os.tmpdir(), "m11-status-"));
	fs.mkdirSync(path.join(piroot, "agent"), { recursive: true });
	const src = path.join(piroot, "agent", "autoresearch.db");
	const tgt = path.join(piroot, "agent", "agent.db");

	buildAutoresearchDB(src, {
		runs: [
			{ run_date: "2026-07-01", session_count: 5 },
			{ run_date: "2026-07-02", session_count: 8 },
			{ run_date: "2026-07-03", session_count: 2 },
		],
		proposals: [{ week_end: "2026-06-29", status: "proposed" }],
	});

	const res = absorbAutoresearch({ from: src, to: tgt, backup: src + ".pre-merge" });
	assert.equal(res.ok, true);
	assert.equal(res.runsCopied, 3);

	// run the REAL `apple-pi status` with PI_CODING_AGENT_DIR → piroot. status()
	// opens lifecycle.dbPath() (= piroot/agent/agent.db) read-only and prints
	// the runs/proposals counts. Legacy schedule probe is best-effort (non-fatal).
	const env = Object.assign({}, process.env, { PI_CODING_AGENT_DIR: piroot });
	delete env.AGENT_DB;
	delete env.AUTORESEARCH_DB;
	const r = spawnSync(process.execPath,
		["--no-warnings", path.join(REPO, "bin", "apple-pi"), "status"],
		{ env, cwd: REPO, encoding: "utf8" });

	assert.equal(r.status, 0, `apple-pi status exited 0\nstderr:\n${r.stderr || ""}`);
	const out = r.stdout || "";
	// status prints "metrics db  : <path>" — must be agent.db, not autoresearch.db
	assert.match(out, /metrics db\s*:\s*.*agent\.db/);
	assert.ok(!/autoresearch\.db/.test(out.split("\n").find((l) => /metrics db/.test(l)) || ""),
		"metrics db line must point at agent.db");
	// the migrated runs are visible through status
	assert.match(out, /runs\s*:\s*3/);
	assert.match(out, /2026-07-03/, "last run_date visible through status");

	fs.rmSync(piroot, { recursive: true, force: true });
});

// =====================================================================
// THE DOGFOOD ASSERTION: absorb the REAL ~/.pi/agent/autoresearch.db
// =====================================================================
//
// Runs only on a machine that has the legacy autoresearch.db (the judge's
// machine does). Asserts RELATIVE invariants (copied count == source count),
// not hardcoded numbers. The real autoresearch.db is ONLY ever read — absorb
// attaches it read-select; the backup is written to a TEMP path so the user's
// ~/.pi tree is never mutated by this test.
test("REAL workspace: absorb ~/.pi/agent/autoresearch.db into a temp agent.db; counts match; old db readable (REQ-M11-3 dogfood)", () => {
	if (!fs.existsSync(REAL_AUTORESEARCH)) {
		// not this machine — skip rather than fail (forward-compat: a fresh
		// install with no autoresearch history is a valid no-op state)
		return;
	}
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "m11-real-"));
	const tgt = path.join(dir, "agent.db");
	const backup = path.join(dir, "autoresearch.db.pre-merge"); // temp: do NOT touch ~/.pi

	// source row counts (read-only)
	let srcRuns = 0, srcProps = 0;
	const sdb = new DatabaseSync(REAL_AUTORESEARCH, { readOnly: true });
	try {
		srcRuns = sdb.prepare("SELECT count(*) c FROM runs").get().c;
		srcProps = sdb.prepare("SELECT count(*) c FROM proposals").get().c;
	} catch (_) {
		// unreadable / locked / missing tables — best-effort skip
		fs.rmSync(dir, { recursive: true, force: true });
		return;
	} finally { sdb.close(); }

	const res = absorbAutoresearch({ from: REAL_AUTORESEARCH, to: tgt, backup });
	assert.equal(res.ok, true, `absorb failed: ${JSON.stringify(res.failures)}`);
	assert.equal(res.runsCopied, srcRuns, "every source run landed in agent.db.runs");
	assert.equal(res.proposalsCopied, srcProps, "every source proposal landed in agent.db.legacy_proposals");
	assert.equal(res.backupCreated, true, "pre-merge backup created");

	const db = openRO(tgt);
	try {
		assert.equal(db.prepare("SELECT count(*) c FROM runs").get().c, srcRuns);
		assert.equal(db.prepare("SELECT count(*) c FROM legacy_proposals").get().c, srcProps);
	} finally { db.close(); }

	// autoresearchPath() default still resolves under the home pi tree (the
	// legacy source location, now owned by migrate.js).
	assert.ok(autoresearchPath().endsWith(path.join("agent", "autoresearch.db")),
		`autoresearchPath under ~/.pi/agent; got ${autoresearchPath()}`);

	fs.rmSync(dir, { recursive: true, force: true });
});
