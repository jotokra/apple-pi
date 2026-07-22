// agentdb/kb/index.js — Tier-A kanban mirror: full rebuild (M2-2).
//
// SUPERPROMPT §5.2 + §1 (Principle A: .card.md is truth; kb_* is a one-way
// derived mirror). Composes the three primitives the earlier milestones shipped:
//   discover (M0-3 local walker / M1-2 workspace) — which *.card.md files exist
//   parse    (M1-1)                               — frontmatter + body from a file
//   validate (M0-1 schema, wrapped by M1-3)        — does the frontmatter pass?
// and writes the derived rows into the four Tier-A tables.
//
// TIER ISOLATION (the hard contract, §2): a rebuild DROPs the kb_* tables ONLY
// and NEVER touches any other table. kb_* is disposable (rebuildable from disk
// at any time); sess_*/analysis_*/runs/proposals (Tier B, later milestones) are
// durable and must survive a kanban rebuild byte-for-byte. KB_TABLES below is
// the EXHAUSTIVE list of what a rebuild may DROP — anything not in it is
// untouchable, and the re-create step re-applies schema.sql (CREATE IF NOT
// EXISTS) which only ever creates, never drops, anything else. Hand-rolled,
// zero deps (D3) — mirrors the rest of agentdb/kb.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { findCards } = require("./discover");      // discover (M0-3 / M1-2)
const { parseCardFile } = require("./parse");      // parse    (M1-1)
const { validateCard } = require("./schema-card"); // validate (M0-1; M1-3 wraps it)

// schema.sql is the single source of truth for the kb_* DDL — lib/db.js applies
// it on open(). rebuild DROPs the kb_* tables and re-applies this SAME file to
// recreate them, never a hand-maintained duplicate of the DDL (which would
// drift). Mirrors the path db.js uses.
const SCHEMA_PATH = path.join(__dirname, "..", "lib", "schema.sql");

// The exhaustive set of Tier-A tables a rebuild may DROP. This list IS the
// tier-isolation contract: rebuild never emits DROP for anything outside it.
// Indexes are not listed — SQLite drops a table's indexes automatically.
const KB_TABLES = ["kb_cards", "kb_body_fts", "kb_deps", "kb_meta"];

// sha256hex(content) -> hex digest. file_hash for kb_cards/kb_meta — the
// incremental-reindex key (M2-3); for a full rebuild it only has to be a stable
// function of the source bytes (REQ-M2-2 determinism).
function sha256hex(content) {
	return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

// dropKbTables(db) — DROP IF EXISTS every kb_* table (and only those). Order is
// irrelevant: the four tables have no cross-references (FTS is standalone, deps
// + meta are flat).
function dropKbTables(db) {
	for (const t of KB_TABLES) db.exec(`DROP TABLE IF EXISTS ${t};`);
}

// rebuild(db, root) -> { ok, inserted, skipped }
//   db   : an open node:sqlite DatabaseSync (lib/db.js open() is the canonical
//          source, but any connection works — rebuild owns only the kb_* tier
//          on it). Default root is process.cwd().
//   root : directory walked for *.card.md via discover's findCards.
//
// Steps: (1) DROP kb_* ONLY, (2) re-apply schema.sql to recreate them, (3) walk
// every discovered card, parse + validate, and INSERT the valid ones into
// kb_cards / kb_body_fts / kb_deps / kb_meta. Invalid cards (or any card that
// fails to read/parse) are skipped + reported rather than crashing the rebuild
// — best-effort, like the rest of agentdb/kb. Returns:
//   ok       : true iff every discovered card validated + was indexed
//   inserted : number of cards written to kb_cards (== valid card count)
//   skipped  : [{ file, errors: string[] }] for cards not indexed
function rebuild(db, root = process.cwd()) {
	// (1) drop the disposable tier, (2) recreate it from the canonical DDL.
	dropKbTables(db);
	db.exec(fs.readFileSync(SCHEMA_PATH, "utf8"));

	const insCard = db.prepare(
		`INSERT OR REPLACE INTO kb_cards
		   (id, title, status, priority, project, assignee, parent, tags_json,
		    file_path, frontmatter_json, body, updated_at, file_hash)
		 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
	);
	const insFts = db.prepare(`INSERT INTO kb_body_fts (title, body) VALUES (?,?)`);
	const insDep = db.prepare(`INSERT OR IGNORE INTO kb_deps (from_id, to_id) VALUES (?,?)`);
	const insMeta = db.prepare(`INSERT OR REPLACE INTO kb_meta (file_path, mtime, file_hash) VALUES (?,?,?)`);

	const skipped = [];
	let inserted = 0;

	for (const file of findCards(root)) {
		try {
			const parsed = parseCardFile(file);
			const vr = validateCard(parsed.frontmatter);
			if (!vr.ok) {
				skipped.push({ file, errors: vr.errors.map(e => `${file}: ${e}`) });
				continue;
			}
			const fm = parsed.frontmatter;
			const content = fs.readFileSync(file, "utf8");
			const file_hash = sha256hex(content);
			const mtime = fs.statSync(file).mtimeMs;

			insCard.run(
				fm.id, fm.title, fm.status,
				fm.priority ?? null, fm.project ?? null, fm.assignee ?? null, fm.parent ?? null,
				JSON.stringify(fm.tags ?? []),
				file,
				JSON.stringify(fm),
				parsed.body,
				fm.updated_at ?? null,
				file_hash,
			);
			insFts.run(fm.title, parsed.body);
			if (Array.isArray(fm.depends_on)) {
				for (const dep of fm.depends_on) insDep.run(fm.id, dep);
			}
			insMeta.run(file, mtime, file_hash);
			inserted++;
		} catch (e) {
			// a transiently unreadable / unparseable card is reported, not fatal —
			// the rebuild still indexes everything else and stays deterministic.
			skipped.push({ file, errors: [`${file}: could not index (${e.message})`] });
		}
	}

	return { ok: skipped.length === 0, inserted, skipped };
}

// index(db, root) -> { ok, upserted, removed, skipped } — INCREMENTAL reindex
// (M2-3). Unlike rebuild (which DROPs + recreates the whole kb_* tier), index
// touches ONLY changed/new cards and deletes rows for removed files, leaving
// every untouched row byte-for-byte in place. This is what makes a reindex
// O(changed files), not O(all files).
//
// Change detection (per file, from kb_meta — the M2-3 key table):
//   - stored mtime == current mtime AND stored hash == current hash -> UNCHANGED
//     (the mtime fast-path: one stat, no read/hash/parse, zero writes). mtime is
//     the quick gate; this is the standard incremental-indexer trade-off and is
//     safe because a real edit always moves mtime, and rebuild() reconciles
//     anything mtime missed at any time.
//   - hash identical but mtime differs (e.g. an editor that touched the file
//     without changing it) -> mtime drift: refresh kb_meta.mtime ONLY, do NOT
//     rewrite the card row (its rowid stays stable).
//   - hash differs (or file is new) -> CHANGED: re-parse + re-validate, upsert
//     kb_cards, refresh that card's forward edges from depends_on, swap its FTS
//     row, refresh kb_meta.
//   - a file present in kb_meta but no longer on disk -> REMOVED: delete its
//     kb_cards row, its forward kb_deps edges, its kb_meta row, and its FTS entry.
//
// Order: removals are applied BEFORE upserts so a rename (old path removed, new
// path added, same id) reconciles to a single upserted row rather than a delete
// racing an insert.
//
// FTS linkage limitation: kb_body_fts has no card-id column (the schema ships it
// standalone by design — M2-2), so a changed/removed card's old FTS row is
// matched by its OLD (title, body) read from kb_cards just before the upsert.
// Two cards sharing an identical title+body would therefore over-delete; that
// does not arise for a single-user kanban, and rebuild() is always the
// authoritative reconciliation. Mirrors rebuild's best-effort posture: an
// unreadable/unparseable/invalid card is skipped + reported, not fatal.
//
// Returns:
//   ok       : true iff no card was skipped
//   upserted : # of card rows written (changed + new)
//   removed  : # of card rows deleted (files gone)
//   skipped  : [{ file, errors: string[] }] for cards not indexed
function index(db, root = process.cwd()) {
	const selMeta = db.prepare("SELECT mtime, file_hash FROM kb_meta WHERE file_path = ?");
	const selCardByPath = db.prepare("SELECT id, title, body FROM kb_cards WHERE file_path = ?");
	const delCardById = db.prepare("DELETE FROM kb_cards WHERE id = ?");
	const delDepsByFrom = db.prepare("DELETE FROM kb_deps WHERE from_id = ?");
	const delFtsByContent = db.prepare("DELETE FROM kb_body_fts WHERE title = ? AND body = ?");
	const delMetaByPath = db.prepare("DELETE FROM kb_meta WHERE file_path = ?");

	const insCard = db.prepare(
		`INSERT OR REPLACE INTO kb_cards
		   (id, title, status, priority, project, assignee, parent, tags_json,
		    file_path, frontmatter_json, body, updated_at, file_hash)
		 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
	);
	const insFts = db.prepare(`INSERT INTO kb_body_fts (title, body) VALUES (?,?)`);
	const insDep = db.prepare(`INSERT OR IGNORE INTO kb_deps (from_id, to_id) VALUES (?,?)`);
	const insMeta = db.prepare(`INSERT OR REPLACE INTO kb_meta (file_path, mtime, file_hash) VALUES (?,?,?)`);

	const currentFiles = findCards(root);
	const currentSet = new Set(currentFiles);
	const existingPaths = new Set(
		db.prepare("SELECT file_path FROM kb_meta").all().map(r => r.file_path),
	);

	const skipped = [];
	let upserted = 0;
	let removed = 0;

	// (1) REMOVALS — meta paths no longer on disk. Done first so a rename
	//     reconciles with the upsert below.
	for (const fp of existingPaths) {
		if (currentSet.has(fp)) continue;
		const old = selCardByPath.get(fp); // {id,title,body} | undefined
		if (old) {
			delCardById.run(old.id);
			delDepsByFrom.run(old.id);
			delFtsByContent.run(old.title, old.body);
		}
		delMetaByPath.run(fp);
		removed++;
	}

	// (2) UPSERTS — per current file: unchanged (skip) | mtime-drift (meta only) |
	//     changed/new (full upsert) | invalid (drop + report).
	for (const file of currentFiles) {
		let stat, content, hash, mtime;
		try {
			stat = fs.statSync(file);
			content = fs.readFileSync(file, "utf8");
			hash = sha256hex(content);
			mtime = stat.mtimeMs;
		} catch (e) {
			skipped.push({ file, errors: [`${file}: could not read (${e.message})`] });
			continue;
		}

		const meta = selMeta.get(file);
		if (meta && meta.mtime === mtime && meta.file_hash === hash) continue; // UNCHANGED
		if (meta && meta.file_hash === hash) { insMeta.run(file, mtime, hash); continue; } // mtime drift

		// CHANGED or NEW — re-parse + re-validate.
		let parsed, vr;
		try {
			parsed = parseCardFile(file);
			vr = validateCard(parsed.frontmatter);
		} catch (e) {
			skipped.push({ file, errors: [`${file}: could not parse (${e.message})`] });
			continue;
		}
		if (!vr.ok) {
			// card no longer validates: drop any stale mirror rows for it (mirrors
			// rebuild, which would not have indexed it), then report.
			const old = selCardByPath.get(file);
			if (old) {
				delCardById.run(old.id);
				delDepsByFrom.run(old.id);
				delFtsByContent.run(old.title, old.body);
			}
			delMetaByPath.run(file);
			skipped.push({ file, errors: vr.errors.map(e => `${file}: ${e}`) });
			continue;
		}

		const fm = parsed.frontmatter;
		// swap the card's OLD FTS row (content linkage) before the upsert overwrites it
		const old = selCardByPath.get(file);
		if (old) delFtsByContent.run(old.title, old.body);

		insCard.run(
			fm.id, fm.title, fm.status,
			fm.priority ?? null, fm.project ?? null, fm.assignee ?? null, fm.parent ?? null,
			JSON.stringify(fm.tags ?? []),
			file,
			JSON.stringify(fm),
			parsed.body,
			fm.updated_at ?? null,
			hash,
		);
		// refresh this card's forward edges: wipe + reinsert from depends_on
		delDepsByFrom.run(fm.id);
		if (Array.isArray(fm.depends_on)) {
			for (const dep of fm.depends_on) insDep.run(fm.id, dep);
		}
		insFts.run(fm.title, parsed.body);
		insMeta.run(file, mtime, hash);
		upserted++;
	}

	return { ok: skipped.length === 0, upserted, removed, skipped };
}

// ensureCurrent(db, root) -> { action, ... } — LAZY reconcile gate (M2-4).
// SUPERPROMPT §5.2: the query path calls this before touching the mirror so the
// kb_* tier is always correct with NO manual rebuild/incremental bookkeeping on
// the caller. It only DECIDES which primitive to run (rebuild / index / none);
// the primitive is the source of truth for the actual work. Decision tree:
//
//   - kb_meta table MISSING          -> full rebuild (no meta to diff against;
//                                       the "rm agent.db" extreme where schema
//                                       was never applied / tier was dropped)
//   - kb_meta EMPTY + cards on disk  -> full rebuild (mirror was never built;
//                                       the realistic open()-after-delete path:
//                                       open() reapplies schema CREATE IF NOT
//                                       EXISTS, so kb_* reappear EMPTY)
//   - kb_meta EMPTY + no cards       -> no-op          (vacuously current)
//   - count(meta) != count(files)    -> incremental index (adds / removes)
//   - any card newer than its kb_meta -> incremental index (content drift)
//   - otherwise                       -> no-op          (already current)
//
// The incremental triggers deliberately OVER-trigger then delegate: the mtime
// gate is the lazy "is anything possibly stale?" check (matches index()'s
// mtime fast-path); index() is the AUTHORITATIVE reindex (mtime+hash, removals,
// upserts). rebuild() remains the always-available authoritative reset.
//
// Returns:
//   action : "rebuild" | "incremental" | "noop"
//   plus the primitive's own fields (rebuild: ok/inserted/skipped;
//   incremental: ok/upserted/removed/skipped; noop: none).
function ensureCurrent(db, root = process.cwd()) {
	const files = findCards(root);

	// (1) kb_meta table missing -> cannot diff -> full rebuild (recreates the
	//     whole kb_* tier from the canonical schema + indexes every card).
	const metaTableMissing = !db.prepare(
		"SELECT name FROM sqlite_master WHERE type='table' AND name='kb_meta'",
	).get();
	if (metaTableMissing) return { action: "rebuild", ...rebuild(db, root) };

	// (2) kb_meta EMPTY: mirror was either never built or fully drained.
	const metaCount = db.prepare("SELECT count(*) c FROM kb_meta").get().c;
	if (metaCount === 0) {
		// no cards on disk either -> already current (vacuously); avoid a needless
		// DROP+recreate over an empty tree.
		if (files.length === 0) return { action: "noop" };
		return { action: "rebuild", ...rebuild(db, root) };
	}

	// (3) count mismatch (meta rows vs files on disk) -> incremental.
	if (metaCount !== files.length) return { action: "incremental", ...index(db, root) };

	// (4) any card newer than its kb_meta.mtime (or a new file with no meta row)
	//     -> incremental. mtime is the lazy gate; index() is authoritative.
	if (hasNewerCard(db, files)) return { action: "incremental", ...index(db, root) };

	// (5) current -> no-op.
	return { action: "noop" };
}

// hasNewerCard(db, files) -> bool — does any current card file look stale vs its
// kb_meta row? A file is "newer" if it has NO kb_meta row (never indexed / new)
// OR its current mtime is greater than the stored kb_meta.mtime. A transient
// stat error on one file is skipped (best-effort, like the rest of kb); index()
// is the authoritative reconciler and would report it.
function hasNewerCard(db, files) {
	const selMeta = db.prepare("SELECT mtime FROM kb_meta WHERE file_path = ?");
	for (const f of files) {
		let stat;
		try {
			stat = fs.statSync(f);
		} catch {
			continue;
		}
		const meta = selMeta.get(f);
		if (!meta) return true; // new file: never indexed
		if (stat.mtimeMs > meta.mtime) return true; // content-drift: mtime moved
	}
	return false;
}

module.exports = { rebuild, index, ensureCurrent, KB_TABLES, sha256hex };
