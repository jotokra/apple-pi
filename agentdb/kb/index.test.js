// agentdb/kb/index.test.js — REQ-M2-2
//
// rebuild(db, root) DROPs the kb_* tables ONLY, recreates them, and rewrites
// them from every *.card.md under root (discover + parse + validate + INSERT).
//
// THE TIER-ISOLATION CONTRACT (SUPERPROMPT §2): a kanban rebuild must NEVER
// touch any non-kb_ table. kb_* is disposable (rebuildable from disk at any
// time); sess_*/analysis_*/runs/proposals (Tier B, later milestones) are
// durable and must survive a kanban rebuild byte-for-byte. This suite proves it
// by seeding a dummy non-kb table with a row, rebuilding kb over a fixture
// tree, and asserting the dummy table + row are byte-identical before/after.
//
// Verify: node --test agentdb/kb/index.test.js
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { DatabaseSync } = require("node:sqlite");
const { rebuild, KB_TABLES } = require("./index");

const SCHEMA_PATH = path.join(__dirname, "..", "lib", "schema.sql");

// CARD_HEAD(id, title, status, deps) -> a .card.md body. `deps` is the raw
// frontmatter token for depends_on ("[]" or "[a]"). One template builds clean,
// with-deps, and invalid cards (invalid via a bad `status`).
function CARD_HEAD(id, title, status, deps = "[]") {
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

// seededDB() — fresh in-memory DB with the kb_* schema applied PLUS a dummy
// non-kb table (`analysis_runs`, a plausible Tier-B name) seeded with one row.
// That table+row is the tier-isolation canary: it must survive a rebuild.
function seededDB() {
	const db = new DatabaseSync(":memory:");
	db.exec(fs.readFileSync(SCHEMA_PATH, "utf8"));
	db.exec("CREATE TABLE analysis_runs (id INTEGER PRIMARY KEY, note TEXT NOT NULL);");
	db.exec("INSERT INTO analysis_runs (id, note) VALUES (1, 'durable-tier-b-data');");
	return db;
}

// snapshot(db) — capture everything we assert survives a rebuild unchanged:
// the canary row, its DDL, and the full table+index list (to catch any table
// being added or dropped by the rebuild).
function snapshot(db) {
	return {
		row: db.prepare("SELECT id, note FROM analysis_runs ORDER BY id").all(),
		sql: db.prepare("SELECT sql FROM sqlite_master WHERE name='analysis_runs'").get().sql,
		tables: db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','index') ORDER BY name")
			.all().map(r => r.name),
	};
}

// --- the contract: tier isolation ------------------------------------------

test("rebuild DROPs only kb_* tables; a seeded non-kb table+row survive unchanged (REQ-M2-2 tier isolation)", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "kb-rebuild-"));
	makeTree(root, [
		{ path: "cards/a.card.md", content: CARD_HEAD("a", "Card A", "todo") },
		{ path: "cards/b.card.md", content: CARD_HEAD("b", "Card B", "in_progress", "[a]") },
		{ path: "cards/bad.card.md", content: CARD_HEAD("bad", "Bad", "wip") }, // status not in enum
	]);

	const db = seededDB();
	const before = snapshot(db);

	const r = rebuild(db, root);

	// (1) kb_* tier rebuilt correctly: 2 valid cards indexed, the invalid one
	//     skipped + reported.
	assert.equal(r.inserted, 2, `expected 2 inserted; skipped=${JSON.stringify(r.skipped)}`);
	assert.equal(r.skipped.length, 1, "the invalid 'bad' card should be skipped + reported");
	assert.equal(r.skipped[0].file, path.join(root, "cards/bad.card.md"));
	assert.equal(r.ok, false, "ok is false because one card failed validation");

	assert.deepEqual(
		db.prepare("SELECT id FROM kb_cards ORDER BY id").all().map(x => x.id),
		["a", "b"],
	);
	// b depends_on a -> exactly one forward edge. (Rows come back as null-prototype
	// objects from node:sqlite, so map to plain objects for the literal compare.)
	const deps = db.prepare("SELECT from_id, to_id FROM kb_deps ORDER BY from_id, to_id")
		.all().map(r => ({ from_id: r.from_id, to_id: r.to_id }));
	assert.deepEqual(deps, [{ from_id: "b", to_id: "a" }]);
	// FTS + meta: one row per VALID card
	assert.equal(db.prepare("SELECT count(*) c FROM kb_body_fts").get().c, 2);
	assert.equal(db.prepare("SELECT count(*) c FROM kb_meta").get().c, 2);

	// (2) THE CONTRACT: the non-kb table + its row are byte-identical before/after.
	const after = snapshot(db);
	assert.deepEqual(after.row, before.row, "non-kb row must survive rebuild unchanged");
	assert.equal(after.sql, before.sql, "non-kb table DDL must survive rebuild unchanged");
	assert.ok(after.tables.includes("analysis_runs"), "canary table still present after rebuild");
});

test("rebuild preserves MULTIPLE non-kb tables of differing shapes (tier isolation, multi-canary)", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "kb-rebuild-multi-"));
	makeTree(root, [{ path: "cards/a.card.md", content: CARD_HEAD("a", "A", "todo") }]);
	const db = seededDB();
	db.exec("CREATE TABLE sess_notes (k TEXT PRIMARY KEY, v TEXT);");
	db.exec(`INSERT INTO sess_notes VALUES ('x', 'y');`);
	const beforeA = db.prepare("SELECT * FROM analysis_runs").all();
	const beforeS = db.prepare("SELECT * FROM sess_notes").all();

	rebuild(db, root);

	assert.deepEqual(db.prepare("SELECT * FROM analysis_runs").all(), beforeA);
	assert.deepEqual(db.prepare("SELECT * FROM sess_notes").all(), beforeS);
	assert.equal(db.prepare("SELECT count(*) c FROM kb_cards").get().c, 1);
});

// --- determinism -----------------------------------------------------------

test("rebuild is deterministic: same root -> identical kb_* rows across two runs (REQ-M2-2)", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "kb-rebuild-det-"));
	makeTree(root, [
		{ path: "cards/a.card.md", content: CARD_HEAD("a", "Card A", "todo") },
		{ path: "cards/b.card.md", content: CARD_HEAD("b", "Card B", "review", "[a]") },
	]);
	const db = seededDB();

	rebuild(db, root);
	const cards1 = db.prepare(
		"SELECT id,title,status,file_path,frontmatter_json,body,file_hash FROM kb_cards ORDER BY id"
	).all();
	const deps1 = db.prepare("SELECT from_id,to_id FROM kb_deps ORDER BY from_id,to_id").all();
	const fts1 = db.prepare("SELECT title FROM kb_body_fts ORDER BY title").all();
	const meta1 = db.prepare("SELECT file_path,file_hash FROM kb_meta ORDER BY file_path").all();

	// second rebuild over the SAME root — every kb_* row must reproduce byte-for-byte
	const r2 = rebuild(db, root);
	assert.equal(r2.inserted, 2);

	assert.deepEqual(
		db.prepare("SELECT id,title,status,file_path,frontmatter_json,body,file_hash FROM kb_cards ORDER BY id").all(),
		cards1,
		"kb_cards rows differ between rebuild runs",
	);
	assert.deepEqual(
		db.prepare("SELECT from_id,to_id FROM kb_deps ORDER BY from_id,to_id").all(),
		deps1,
		"kb_deps rows differ between rebuild runs",
	);
	assert.deepEqual(
		db.prepare("SELECT title FROM kb_body_fts ORDER BY title").all(),
		fts1,
		"kb_body_fts rows differ between rebuild runs",
	);
	assert.deepEqual(
		db.prepare("SELECT file_path,file_hash FROM kb_meta ORDER BY file_path").all(),
		meta1,
		"kb_meta rows differ between rebuild runs",
	);
});

// --- edge cases ------------------------------------------------------------

test("rebuild over a tree with no cards leaves kb_* empty, ok=true, and preserves non-kb data (REQ-M2-2)", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "kb-rebuild-empty-"));
	makeTree(root, [{ path: "roadmap.md", content: "no cards here" }]);
	const db = seededDB();
	const before = snapshot(db);

	const r = rebuild(db, root);
	assert.equal(r.inserted, 0);
	assert.equal(r.ok, true, "vacuously ok when there are no cards");
	assert.equal(db.prepare("SELECT count(*) c FROM kb_cards").get().c, 0);
	assert.equal(db.prepare("SELECT count(*) c FROM kb_deps").get().c, 0);
	assert.equal(db.prepare("SELECT count(*) c FROM kb_body_fts").get().c, 0);
	assert.equal(db.prepare("SELECT count(*) c FROM kb_meta").get().c, 0);

	assert.deepEqual(snapshot(db).row, before.row);
});

test("rebuild stores frontmatter verbatim + body + a stable file_hash (REQ-M2-2 derived-mirror fidelity)", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "kb-rebuild-fidelity-"));
	makeTree(root, [{ path: "cards/a.card.md", content: CARD_HEAD("a", "Card A", "todo") }]);
	const db = seededDB();
	rebuild(db, root);
	const row = db.prepare("SELECT * FROM kb_cards WHERE id='a'").get();
	assert.equal(row.title, "Card A");
	assert.equal(row.status, "todo");
	assert.equal(row.project, "apple-pi");
	// frontmatter retained verbatim (nothing thrown away — §1 Principle A)
	const fm = JSON.parse(row.frontmatter_json);
	assert.equal(fm.id, "a");
	assert.deepEqual(fm.depends_on, []);
	// body carries the markdown past the closing fence
	assert.ok(row.body.includes("# Card A"), `body missing heading: ${JSON.stringify(row.body)}`);
	// file_hash is a stable function of the source bytes (rebuild -> same hash)
	const expectedHash = require("node:crypto")
		.createHash("sha256")
		.update(fs.readFileSync(path.join(root, "cards/a.card.md"), "utf8"), "utf8")
		.digest("hex");
	assert.equal(row.file_hash, expectedHash);
});

// --- module surface --------------------------------------------------------

test("KB_TABLES is exactly the 4 Tier-A tables rebuild may DROP", () => {
	assert.deepEqual(
		[...KB_TABLES].sort(),
		["kb_body_fts", "kb_cards", "kb_deps", "kb_meta"],
	);
});
