// agentdb/kb/ensure.test.js — REQ-M2-4
//
// ensureCurrent(db, root) is the LAZY reconcile gate: a query path calls it
// before touching the mirror so the kb_* tier is always correct with no manual
// rebuild/incremental bookkeeping on the caller. The decision tree:
//
//   - kb_meta table MISSING            -> full rebuild (no meta to diff against)
//   - kb_meta EMPTY + cards on disk    -> full rebuild (mirror never built)
//   - kb_meta EMPTY + no cards         -> no-op          (vacuously current)
//   - count(meta) != count(files)      -> incremental index
//   - any card newer than its kb_meta  -> incremental index
//   - otherwise                        -> no-op          (already current)
//
// THE CONTRACT under test (ACCEPTANCE: "missing kb -> rebuild transparently;
// fresh -> no-op"):
//   - a DB whose kb_* tier is gone (tables dropped, or a raw fresh DB) is
//     rebuilt transparently by ensureCurrent and a kb query then succeeds with
//     the right cards (the ROADMAP verify: "delete db, run a kb query, assert
//     correct + db exists").
//   - an already-current tier is a no-op: no rebuild, no incremental, rows
//     byte-identical before/after.
//   - a drifted tier (count mismatch, or a card newer than its kb_meta) is
//     reconciled by the incremental indexer, not a full rebuild.
//
// Verify: node --test agentdb/kb/ensure.test.js
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { DatabaseSync } = require("node:sqlite");
const { rebuild, ensureCurrent } = require("./index");

const SCHEMA_PATH = path.join(__dirname, "..", "lib", "schema.sql");

// CARD_HEAD(id, title, status, deps) -> a .card.md body. Same template the
// rebuild + incremental suites use so the three stay consistent.
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

// freshDB(schema?) — in-memory DB. schema=true (default) applies the canonical
// kb_* schema (the real open() always does, so tables EXIST possibly EMPTY);
// schema=false yields a raw DB with NO tables (the "kb missing" extreme).
function freshDB(schema = true) {
	const db = new DatabaseSync(":memory:");
	if (schema) db.exec(fs.readFileSync(SCHEMA_PATH, "utf8"));
	return db;
}

// snapshotKb(db) — every kb_* row, ordered. The no-op canary: a no-op pass must
// leave the tier byte-identical.
function snapshotKb(db) {
	return {
		cards: db.prepare("SELECT id,title,status FROM kb_cards ORDER BY id").all(),
		deps: db.prepare("SELECT from_id,to_id FROM kb_deps ORDER BY from_id,to_id")
			.all().map(r => ({ from_id: r.from_id, to_id: r.to_id })),
		fts: db.prepare("SELECT title FROM kb_body_fts ORDER BY title").all(),
		meta: db.prepare("SELECT file_path,file_hash FROM kb_meta ORDER BY file_path")
			.all().map(r => ({ file_path: r.file_path, file_hash: r.file_hash })),
	};
}

// bumpMtime(file, offsetSec) — set a file's mtime to now+offset so the "newer
// than kb_meta" gate deterministically sees drift.
function bumpMtime(file, offsetSec = 30) {
	const t = (Date.now() / 1000) + offsetSec;
	fs.utimesSync(file, t, t);
}

// ===========================================================================
// MISSING kb_* tier -> rebuild transparently; a kb query then succeeds
// (the ROADMAP verify: "rm agent.db -> query -> kb rebuilt transparently")
// ===========================================================================

test("a raw DB with NO kb_* tables is rebuilt transparently, then a kb query succeeds (REQ-M2-4)", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "kb-ensure-missing-"));
	makeTree(root, [
		{ path: "cards/a.card.md", content: CARD_HEAD("a", "Card A", "todo") },
		{ path: "cards/b.card.md", content: CARD_HEAD("b", "Card B", "in_progress", "[a]") },
	]);

	// raw DB: schema never applied -> no kb_* tables at all (the "missing" extreme)
	const db = freshDB(false);

	const r = ensureCurrent(db, root);
	assert.equal(r.action, "rebuild", "missing kb_* tier must trigger a full rebuild");
	assert.equal(r.inserted, 2, "both valid cards indexed by the transparent rebuild");

	// after ensureCurrent, the kb_* tier EXISTS and a query returns the right cards
	assert.ok(
		db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='kb_cards'").get(),
		"kb_cards table must exist after ensureCurrent",
	);
	assert.deepEqual(
		db.prepare("SELECT id FROM kb_cards ORDER BY id").all().map(x => x.id),
		["a", "b"],
		"a kb query after the transparent rebuild returns the correct cards",
	);
	// b depends_on a -> the dep edge is present too
	assert.deepEqual(
		db.prepare("SELECT from_id,to_id FROM kb_deps ORDER BY from_id,to_id")
			.all().map(x => ({ from_id: x.from_id, to_id: x.to_id })),
		[{ from_id: "b", to_id: "a" }],
	);
});

test("kb_* tables dropped mid-life (DROP IF EXISTS) are rebuilt transparently (REQ-M2-4)", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "kb-ensure-dropped-"));
	makeTree(root, [{ path: "cards/a.card.md", content: CARD_HEAD("a", "Card A", "todo") }]);
	const db = freshDB();
	// simulate "someone dropped the disposable tier" (the realistic 'missing'
	// case next to the raw-DB case above)
	for (const t of ["kb_cards", "kb_body_fts", "kb_deps", "kb_meta"]) {
		db.exec(`DROP TABLE IF EXISTS ${t};`);
	}

	const r = ensureCurrent(db, root);
	assert.equal(r.action, "rebuild");
	assert.equal(
		db.prepare("SELECT count(*) c FROM kb_cards").get().c,
		1,
		"kb_cards repopulated after the dropped-tier rebuild",
	);
});

// ===========================================================================
// EMPTY kb_meta + cards on disk -> rebuild (mirror was never built); the real
// "rm agent.db then open()" path (open() reapplies schema -> tables EXIST EMPTY)
// ===========================================================================

test("empty kb_meta with cards on disk triggers a full rebuild (REQ-M2-4: the open()-after-delete path)", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "kb-ensure-empty-"));
	makeTree(root, [
		{ path: "cards/a.card.md", content: CARD_HEAD("a", "Card A", "todo") },
		{ path: "cards/c.card.md", content: CARD_HEAD("c", "Card C", "review") },
	]);
	// freshDB applies the schema but indexes nothing -> kb_* tables EXIST, EMPTY.
	// (this is exactly what happens after `rm agent.db` + open(): schema CREATE
	// IF NOT EXISTS runs, kb_* reappear empty, cards are on disk.)
	const db = freshDB();
	assert.equal(db.prepare("SELECT count(*) c FROM kb_meta").get().c, 0, "precondition: mirror empty");

	const r = ensureCurrent(db, root);
	assert.equal(r.action, "rebuild", "empty mirror + cards on disk -> full rebuild");
	assert.equal(r.inserted, 2);
	assert.deepEqual(
		db.prepare("SELECT id FROM kb_cards ORDER BY id").all().map(x => x.id),
		["a", "c"],
	);
});

test("empty kb_meta with NO cards on disk is a no-op (REQ-M2-4: vacuously current)", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "kb-ensure-empty-nofiles-"));
	makeTree(root, [{ path: "roadmap.md", content: "no cards here" }]);
	const db = freshDB();

	const r = ensureCurrent(db, root);
	assert.equal(r.action, "noop", "no cards + empty mirror is already current");
	assert.equal(db.prepare("SELECT count(*) c FROM kb_cards").get().c, 0);
});

// ===========================================================================
// FRESH / already-current tier -> no-op (rows byte-identical before/after)
// ===========================================================================

test("an already-current tier is a no-op: nothing rebuilt/incremented (REQ-M2-4: fresh -> no-op)", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "kb-ensure-current-"));
	makeTree(root, [
		{ path: "cards/a.card.md", content: CARD_HEAD("a", "Card A", "todo") },
		{ path: "cards/b.card.md", content: CARD_HEAD("b", "Card B", "review", "[a]") },
	]);
	const db = freshDB();
	rebuild(db, root); // make the mirror current
	const before = snapshotKb(db);

	const r = ensureCurrent(db, root);
	assert.equal(r.action, "noop", "a current tier must not be rebuilt or incremented");

	// no-op means byte-identical rows (no DROP+recreate, no upsert)
	assert.deepEqual(snapshotKb(db), before, "no-op pass must leave every kb_* row unchanged");
});

test("ensureCurrent is idempotent: calling it twice on a current tier is no-op both times (REQ-M2-4)", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "kb-ensure-idempotent-"));
	makeTree(root, [{ path: "cards/a.card.md", content: CARD_HEAD("a", "Card A", "todo") }]);
	const db = freshDB();

	assert.equal(ensureCurrent(db, root).action, "rebuild", "first call builds the mirror");
	assert.equal(ensureCurrent(db, root).action, "noop", "second call over a current tier is no-op");
	assert.equal(ensureCurrent(db, root).action, "noop", "third call still no-op");
});

// ===========================================================================
// DRIFTED tier -> incremental (NOT a full rebuild)
// ===========================================================================

test("count mismatch from an ADDED card file -> incremental (REQ-M2-4)", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "kb-ensure-count-add-"));
	makeTree(root, [
		{ path: "cards/a.card.md", content: CARD_HEAD("a", "Card A", "todo") },
		{ path: "cards/b.card.md", content: CARD_HEAD("b", "Card B", "todo") },
	]);
	const db = freshDB();
	rebuild(db, root);

	// add a card file WITHOUT reindexing -> meta count (2) != files (3)
	fs.writeFileSync(path.join(root, "cards/c.card.md"), CARD_HEAD("c", "Card C", "review", "[b]"), "utf8");

	const r = ensureCurrent(db, root);
	assert.equal(r.action, "incremental", "count mismatch must reconcile via the incremental indexer");
	assert.equal(r.upserted, 1);
	// the new card is now indexed (a kb query would see it)
	assert.deepEqual(
		db.prepare("SELECT id FROM kb_cards ORDER BY id").all().map(x => x.id),
		["a", "b", "c"],
	);
	// a follow-up ensureCurrent over the now-current tier is a no-op (converged)
	assert.equal(ensureCurrent(db, root).action, "noop");
});

test("count mismatch from a REMOVED card file -> incremental (REQ-M2-4)", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "kb-ensure-count-rm-"));
	makeTree(root, [
		{ path: "cards/a.card.md", content: CARD_HEAD("a", "Card A", "todo") },
		{ path: "cards/b.card.md", content: CARD_HEAD("b", "Card B", "todo", "[a]") },
	]);
	const db = freshDB();
	rebuild(db, root);

	// remove a card file WITHOUT reindexing -> meta count (2) != files (1)
	fs.unlinkSync(path.join(root, "cards/b.card.md"));

	const r = ensureCurrent(db, root);
	assert.equal(r.action, "incremental");
	assert.equal(r.removed, 1);
	assert.deepEqual(
		db.prepare("SELECT id FROM kb_cards ORDER BY id").all().map(x => x.id),
		["a"],
	);
});

test("a card NEWER than its kb_meta.mtime -> incremental, even with equal counts (REQ-M2-4)", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "kb-ensure-newer-"));
	makeTree(root, [
		{ path: "cards/a.card.md", content: CARD_HEAD("a", "Card A", "todo") },
		{ path: "cards/b.card.md", content: CARD_HEAD("b", "Card B", "todo") },
	]);
	const db = freshDB();
	rebuild(db, root);

	// rewrite B's CONTENT + bump its mtime. Counts still match (2 == 2), so only
	// the "newer than kb_meta" gate can catch it.
	const bFile = path.join(root, "cards/b.card.md");
	fs.writeFileSync(bFile, CARD_HEAD("b", "Card B EDITED", "in_progress"), "utf8");
	bumpMtime(bFile);

	const r = ensureCurrent(db, root);
	assert.equal(
		r.action,
		"incremental",
		"a card newer than its kb_meta must trigger incremental even when counts match",
	);
	assert.equal(r.upserted, 1);
	assert.equal(
		db.prepare("SELECT title FROM kb_cards WHERE id='b'").get().title,
		"Card B EDITED",
		"the stale card was reconciled",
	);
	// converged: a second pass is a no-op
	assert.equal(ensureCurrent(db, root).action, "noop");
});

test("a NEW card file with no kb_meta row is detected (newer-than-meta gate) even at equal counts via swap (REQ-M2-4)", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "kb-ensure-swap-"));
	makeTree(root, [{ path: "cards/a.card.md", content: CARD_HEAD("a", "Card A", "todo") }]);
	const db = freshDB();
	rebuild(db, root);

	// swap: remove a.card.md, add z.card.md. Counts match (1 == 1) and the only
	// signal is that z has no kb_meta row (the "newer/never-indexed" gate).
	fs.unlinkSync(path.join(root, "cards/a.card.md"));
	fs.writeFileSync(path.join(root, "cards/z.card.md"), CARD_HEAD("z", "Card Z", "todo"), "utf8");

	const r = ensureCurrent(db, root);
	assert.equal(r.action, "incremental", "a never-indexed card must trigger incremental");
	assert.equal(r.upserted, 1);
	assert.equal(r.removed, 1);
	assert.deepEqual(
		db.prepare("SELECT id FROM kb_cards ORDER BY id").all().map(x => x.id),
		["z"],
	);
});
