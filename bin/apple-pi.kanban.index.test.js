// bin/apple-pi.kanban.index.test.js — REQ-M8-1
//
// `apple-pi kanban index [--rebuild]` — the CLI surface over the kb_* mirror.
//   --rebuild : DROP kb_* first, then reindex from disk (full rebuild)
//   (default) : ensureCurrent — lazy reconcile (rebuild / incremental / noop)
//
// ACCEPTANCE (REQ-M8-1): exit 0 + a row count; --rebuild drops kb_* first.
// This suite drives the REAL bin/apple-pi wrapper as a subprocess (the path a
// user hits), points AGENT_DB + cwd at throwaway paths, and asserts:
//   - exit code 0
//   - stdout reports the kb_cards row count
//   - the DB actually holds the indexed cards
//   - a second call over a current mirror is a no-op (ensureCurrent converged)
//   - --rebuild drops kb_* ONLY: a seeded non-kb (Tier-B) table+row survives
//     byte-identical (the tier-isolation contract from M2-2, via the CLI)
//
// Verify: node --test bin/apple-pi.kanban.index.test.js
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");

const BIN = path.join(__dirname, "apple-pi");
const SCHEMA_PATH = path.join(__dirname, "..", "agentdb", "lib", "schema.sql");

// CARD(id, title, status, deps) -> a .card.md body. Same template the kb/
// suites use so the CLI tests stay consistent with the library tests.
function CARD(id, title, status, deps = "[]") {
	return [
		"---",
		`id: ${id}`,
		`title: ${title}`,
		`status: ${status}`,
		"project: apple-pi",
		"parent: root",
		`depends_on: ${deps}`,
		"created_at: 2026-07-02T22:00:00Z",
		"updated_at: 2026-07-02T22:00:00Z",
		"---",
		"",
		`# ${title}`,
		"",
		"Body text.",
		"",
	].join("\n");
}

function makeTree(root, layout) {
	for (const e of layout) {
		const p = path.join(root, e.path);
		fs.mkdirSync(path.dirname(p), { recursive: true });
		fs.writeFileSync(p, e.content ?? "", "utf8");
	}
}

// runIndex(args, { cwd, env }) — spawn the real bin/apple-pi kanban index.
// node --no-warnings suppresses the node:sqlite ExperimentalWarning so stderr
// stays clean. Returns { status, stdout, stderr }.
function runIndex(args, { cwd, env }) {
	const r = spawnSync(process.execPath, ["--no-warnings", BIN, "kanban", "index", ...args], {
		cwd,
		env,
		encoding: "utf8",
	});
	return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

// ===========================================================================
// REQ-M8-1: `apple-pi kanban index` exits 0, reports a row count, indexes
// ===========================================================================

test("apple-pi kanban index exits 0, reports a row count, and indexes the cards (REQ-M8-1)", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "kb-cli-index-"));
	const dbFile = path.join(root, "agent.db");
	makeTree(root, [
		{ path: "cards/a.card.md", content: CARD("a", "Card A", "todo") },
		{ path: "cards/b.card.md", content: CARD("b", "Card B", "in_progress", "[a]") },
	]);

	const r = runIndex([], { cwd: root, env: { ...process.env, AGENT_DB: dbFile } });

	assert.equal(r.status, 0, `expected exit 0; stderr=\n${r.stderr}`);
	// ACCEPTANCE: stdout reports the kb_cards row count
	assert.match(r.stdout, /cards\s*:\s*2/, `stdout should report the row count; got:\n${r.stdout}`);

	// the DB actually holds both indexed cards (a kb query sees them)
	const db = new DatabaseSync(dbFile);
	try {
		assert.deepEqual(
			db.prepare("SELECT id FROM kb_cards ORDER BY id").all().map(x => x.id),
			["a", "b"],
		);
	} finally { db.close(); }
});

test("apple-pi kanban index is idempotent: a second call is exit 0 + no-op (REQ-M8-1)", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "kb-cli-idem-"));
	const dbFile = path.join(root, "agent.db");
	makeTree(root, [{ path: "cards/a.card.md", content: CARD("a", "Card A", "todo") }]);
	const env = { ...process.env, AGENT_DB: dbFile };

	const r1 = runIndex([], { cwd: root, env });
	assert.equal(r1.status, 0, `first call exit 0; stderr=\n${r1.stderr}`);

	const r2 = runIndex([], { cwd: root, env });
	assert.equal(r2.status, 0, `second call exit 0; stderr=\n${r2.stderr}`);
	// ensureCurrent converged over a current mirror -> no-op
	assert.match(r2.stdout, /noop/, `second call should report noop; got:\n${r2.stdout}`);
});

// ===========================================================================
// REQ-M8-1: --rebuild drops kb_* first; Tier-B data survives (tier isolation)
// ===========================================================================

test("apple-pi kanban index --rebuild drops kb_* first; a non-kb table+row survive (REQ-M8-1 tier isolation)", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "kb-cli-rebuild-"));
	const dbFile = path.join(root, "agent.db");
	makeTree(root, [
		{ path: "cards/a.card.md", content: CARD("a", "Card A", "todo") },
		{ path: "cards/b.card.md", content: CARD("b", "Card B", "review", "[a]") },
	]);

	// pre-seed the DB: apply schema, index nothing, then create a Tier-B canary
	// table + row that MUST survive a kb rebuild byte-for-byte, AND seed a STALE
	// kb_cards row so we can prove --rebuild wiped + rewrote kb_* from disk.
	const seed = new DatabaseSync(dbFile);
	try {
		seed.exec(fs.readFileSync(SCHEMA_PATH, "utf8"));
		seed.exec("CREATE TABLE tier_b_canary (id INTEGER PRIMARY KEY, note TEXT NOT NULL);");
		seed.exec("INSERT INTO tier_b_canary (id, note) VALUES (1, 'durable-tier-b-data');");
		seed.exec(
			"INSERT INTO kb_cards (id,title,status,file_path,frontmatter_json,body,file_hash) " +
			"VALUES ('stale','Stale','todo','/nope','{}','x','hash');",
		);
	} finally { seed.close(); }

	const r = runIndex(["--rebuild"], { cwd: root, env: { ...process.env, AGENT_DB: dbFile } });

	assert.equal(r.status, 0, `expected exit 0; stderr=\n${r.stderr}`);
	assert.match(r.stdout, /cards\s*:\s*2/, `stdout should report 2 cards after rebuild; got:\n${r.stdout}`);

	const db = new DatabaseSync(dbFile);
	try {
		// the stale row was DROPPED (kb_* rebuilt from disk); only a + b remain
		assert.deepEqual(
			db.prepare("SELECT id FROM kb_cards ORDER BY id").all().map(x => x.id),
			["a", "b"],
			"--rebuild must drop kb_* and reindex from disk (stale row gone)",
		);
		// THE CONTRACT: the non-kb canary table + row survive byte-identical.
		// (node:sqlite rows have a null prototype — map to plain objects for the
		// strict-deepEqual compare, mirroring agentdb/kb/index.test.js.)
		assert.deepEqual(
			db.prepare("SELECT id, note FROM tier_b_canary ORDER BY id").all()
				.map(r => ({ id: r.id, note: r.note })),
			[{ id: 1, note: "durable-tier-b-data" }],
			"non-kb (Tier-B) data must survive a kb rebuild",
		);
	} finally { db.close(); }
});
