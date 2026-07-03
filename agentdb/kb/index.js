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

module.exports = { rebuild, KB_TABLES, sha256hex };
