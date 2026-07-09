// agentdb/pi/write.js — pi agent tools kanban_create / kanban_move (M9-2).
//
// ROADMAP M9-2 (SUPERPROMPT §6 module map): the testable JS core of the pi
// agent tools that replace kanban-bridge.ts — the WRITE side. These two are
// thin wrappers over the M2-5 truth writer (kb/write.js) that ADD one thing
// the raw writer does not: after a successful .card.md write, they REINDEX
// the kb_* mirror so the next kanban_list / kanban_get sees the change with
// NO manual rebuild.
//
//   kanban_create({ root, dir, card, db? }) -> { ok, errors, file, reindexed }
//     delegates to M2-5 createCard (full path-safety + §5.1 validation
//     inherited via delegation — this layer adds NO path logic of its own),
//     then runs kb/index.index(db, root) to upsert the new card into the mirror.
//
//   kanban_move({ root, file, to, db? }) -> { ok, errors, file, reindexed }
//     delegates to M2-5 moveStatus (same path-safety + the M0-2 transition
//     map), then reindexes so the new status is reflected immediately.
//
// PATH-SAFETY CONTRACT (REQ-M9-2: "same path-safety as M2-5"): every reject
// that M2-5 enforces — parent traversal, absolute paths, out-of-tree targets,
// non-.card.md extensions, symlink escapes, illegal transitions, immutable
// fields, clobber-on-create — is inherited verbatim because this layer only
// calls createCard/moveStatus and forwards their { ok, errors }. On any reject
// NO reindex runs (no spurious mirror churn; reindexed:false on the result).
//
// REINDEX CHOICE: this layer calls kb/index.index(db, root) DIRECTLY (not
// ensureCurrent). index() is the AUTHORITATIVE incremental reindex — it detects
// changes by mtime AND hash, so a write that lands inside the same mtime tick
// as the previous index is still picked up (hash differs → upsert).
// ensureCurrent's mtime-only gate could miss a same-tick moveStatus; index()
// cannot. After open()/freshDB() the kb_meta table always exists (schema is
// applied on open), so index() never hits a missing-table state here.
//
// BOTH tools run in two modes (mirrors pi/list.js):
//   (a) injected `db` (options.db) — used by tests + composition; the caller
//       owns the connection + freshness, so NO open/close runs. The reindex
//       writes into the injected db directly.
//   (b) no injected db — the real "pi harness" path: open() the unified
//       agent.db, reindex, close in a finally. (No pre-write ensureCurrent:
//       createCard/moveStatus only touch the filesystem, not the db; the
//       post-write index() reconciles everything in one pass.)
//
// Best-effort, no-throw (mirrors kb/write.js + pi/list.js): a rejected write
// returns { ok:false, errors } rather than throwing. A successful write whose
// reindex somehow fails still returns ok:true (the .card.md TRUTH was written;
// the mirror self-heals on the next read's ensureCurrent) with reindexed:false
// + a reindexError string.
//
// RED-BLUE: this layer adds NO SQL of its own and NO path logic. The injection
// surface is exactly M2-5's surface (bound parameters under kb/query) + M2-2's
// index() (fixed statements, no user concatenation). String card fields like
// title/project are written literally to the .card.md and indexed as bound
// values — payloads like `'; DROP TABLE--` or `$(rm -rf /)` are inert data.

"use strict";

const { createCard, moveStatus } = require("../kb/write");
const { index } = require("../kb");
const { open } = require("../lib/db");

// reindex(root, injectedDb?) -> { ok, ...indexFields } | { ok:false, error }
// Runs the authoritative incremental reindex over `root` into `db`. Uses the
// injected db if provided (tests / composition); otherwise opens the unified
// agent.db, reindexes, and closes in a finally. Best-effort: a reindex failure
// is caught + reported, never thrown (the truth write already succeeded).
function reindex(root, injectedDb) {
	const run = (db) => {
		try {
			return { ok: true, ...index(db, root) };
		} catch (e) {
			return { ok: false, error: `reindex: ${e.code || e.message}` };
		}
	};
	if (injectedDb) return run(injectedDb);
	const db = open();
	try {
		return run(db);
	} finally {
		db.close();
	}
}

// kanban_create({ root, dir, card, db? }) -> { ok, errors, file, reindexed }
//   root       : project root for the path-safety containment check
//   dir        : subdir under root (default ".") where <id>.card.md is created
//   card       : frontmatter seed ({ id, title, status, project, ... }); id is
//                the §5.1 slug + the filename; created_at/updated_at stamped here
//   options.db : inject an open DatabaseSync (skips open/close; reindex writes
//                into this connection)
//
// On success: { ok:true, errors:[], file:<abs path>, reindexed:true }.
// On reject : { ok:false, errors:[...], reindexed:false } — NO file written,
//             NO reindex run (createCard's path-safety gate fired first).
function kanban_create({ root, dir, card, db: injectedDb } = {}) {
	const w = createCard({ root, dir, card });
	if (!w.ok) {
		return { ok: false, errors: w.errors, reindexed: false };
	}
	const r = reindex(root, injectedDb);
	const out = { ok: true, errors: [], file: w.file, reindexed: r.ok };
	if (!r.ok) out.reindexError = r.error;
	return out;
}

// kanban_move({ root, file, to, db? }) -> { ok, errors, file, reindexed }
//   root       : project root for the path-safety containment check
//   file       : relative-to-root path to an existing .card.md (the truth)
//   to         : target status (must be in STATUS_ENUM + a legal M0-2 transition)
//   options.db : inject an open DatabaseSync (skips open/close; reindex writes
//                into this connection)
//
// On success: { ok:true, errors:[], file:<abs path>, reindexed:true }. The
// disk diff is EXACTLY the M2-5 contract (status + updated_at lines).
// On reject : { ok:false, errors:[...], reindexed:false } — NO file written,
//             NO reindex run.
function kanban_move({ root, file, to, db: injectedDb } = {}) {
	const w = moveStatus({ root, file, to });
	if (!w.ok) {
		return { ok: false, errors: w.errors, reindexed: false };
	}
	const r = reindex(root, injectedDb);
	const out = { ok: true, errors: [], file: w.file, reindexed: r.ok };
	if (!r.ok) out.reindexError = r.error;
	return out;
}

module.exports = { kanban_create, kanban_move };
