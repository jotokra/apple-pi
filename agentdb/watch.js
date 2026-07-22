// agentdb/watch.js — chokidar file watcher: truth-disk → derived mirror (M7-1).
//
// SUPERPROMPT §6 (module map) + §7 (data flow) + D4/D10:
//   - Watches the two TRUTH roots and routes each change to the right primitive:
//       ~/Projects/*/.kanban/  -> kb incremental reindex (kb/index.js index())
//       ~/.pi/sessions/        -> session append-only ingest (ingest/incremental.js)
//   - Debounces 150 ms so a burst of edits (a save that fires add+change, or a
//     few cards touched at once) coalesces into ONE reindex pass. The latency
//     budget is ~300 ms (150 ms debounce + fsevents delivery) — REQ-M7-1.
//   - macOS fsevents: chokidar v5 uses fsevents automatically on darwin when
//     usePolling is false (the default). No option is set that would disable it.
//
// DEPENDENCY POLICY (D10): chokidar is the ONE approved new runtime dep for
// agentdb (the rest is hand-rolled, zero-dep). The dep-budget smoke (M10-4)
// asserts deps ≤ chokidar (+ gray-matter only as a D3 fallback).
//
// TIER ISOLATION: this module only ever CALLS the kb/ingest primitives; it owns
// no SQL. kb_* is disposable (index() reconciles it), sess_* is durable
// (ingestFile is append-only + idempotent). A flush never crosses tiers.
//
// SCOPE (M7-1): watch the roots that exist at start() time, debounce, route.
// Single-instance + partial-write resilience is M7-2; the launchd daemon +
// lazy-reconcile guarantee is M7-3. M7-1 keeps the surface minimal + testable:
// every external (db, roots, primitives, timing) is injectable so the
// integration test drives real fsevents on temp dirs without touching ~/.
//
// Public API:
//   start(opts) -> { watcher, ready, flushNow, close }
//     opts.db          : open DatabaseSync (caller owns its lifecycle)
//     opts.projectsDir : dir of project subdirs (default ~/Projects); each
//                        <projectsDir>/<proj>/.kanban that exists is watched
//     opts.sessionsDir : pi sessions dir (default <piDir>/sessions)
//     opts.debounceMs  : idle window before a flush (default 150)
//     opts.indexFn     : (db, kbRoot) -> reindex result (default kb/index.index)
//     opts.ingestFn    : (db, file)   -> ingest result  (default ingest/incremental.ingestFile)
//     opts.onFlush     : ({kbRoots, sessions}) -> void  (observability/test seam)
//     opts.onEvent     : (event, path) -> void            (observability/test seam)
//     opts.onError     : (Error) -> void                  (default no-op; M7-2 logs)
//   discoverKbRoots(projectsDir) -> string[]   (exported for tests/reuse)
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const chokidar = require("chokidar");
const { index } = require("./kb/index");
const { ingestFile } = require("./ingest/incremental");
const { piDir } = require("./lib/db");

// discoverKbRoots(projectsDir) -> string[] — the <projectsDir>/<proj>/.kanban
// dirs that currently exist (the SUPERPROMPT §5.1 layout). A missing/unreadable
// projectsDir yields [] (best-effort, like kb/discover). This is the set M7-1
// watches; a brand-new project appearing at runtime is an M7-2 concern.
function discoverKbRoots(projectsDir) {
	const out = [];
	let entries;
	try {
		entries = fs.readdirSync(projectsDir, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const ent of entries) {
		if (!ent.isDirectory()) continue;
		const kanban = path.join(projectsDir, ent.name, ".kanban");
		try {
			if (fs.statSync(kanban).isDirectory()) out.push(kanban);
		} catch { /* project without a .kanban — nothing to watch */ }
	}
	return out;
}

// kbRootFor(p, kbRoots) -> string|null — which watched .kanban root owns path p.
// A card lives at <kbRoot>/cards/<id>.card.md, so p is either the root itself
// or a descendant of it.
function kbRootFor(p, kbRoots) {
	for (const r of kbRoots) {
		if (p === r || p.startsWith(r + path.sep)) return r;
	}
	return null;
}

// start(opts) -> { watcher, flushNow, close } — see module header.
function start(opts = {}) {
	const db = opts.db;
	const projectsDir = opts.projectsDir || path.join(os.homedir(), "Projects");
	const sessionsDir = opts.sessionsDir || path.join(piDir(), "sessions");
	const debounceMs = opts.debounceMs ?? 150;
	const indexFn = opts.indexFn || ((d, root) => index(d, root));
	const ingestFn = opts.ingestFn || ((d, file) => ingestFile(d, file));
	const onFlush = opts.onFlush || (() => {});
	const onEvent = opts.onEvent || (() => {});
	const onError = opts.onError || (() => {});

	const kbRoots = discoverKbRoots(projectsDir);
	const sessionsExists = (() => { try { return fs.statSync(sessionsDir).isDirectory(); } catch { return false; } })();

	// Build the watch list: each kb root + (if present) the sessions dir.
	// chokidar v5 watch() returns the FSWatcher synchronously.
	const watchPaths = [...kbRoots];
	if (sessionsExists) watchPaths.push(sessionsDir);

	// Pending work, debounced. A single timer coalesces kb + session edits that
	// land inside the same window into one flush — the standard debounce pattern
	// and what makes "a save firing add+change" cost one reindex, not two.
	const pendingKb = new Set();
	const pendingSessions = new Set();
	let timer = null;

	function flush() {
		timer = null;
		const kb = [...pendingKb];
		const sessions = [...pendingSessions];
		pendingKb.clear();
		pendingSessions.clear();
		// Each primitive never throws (they return {ok, errors}); the try/catch
		// is belt-and-suspenders so a surprise error never kills the watcher.
		// (Full partial-write resilience lands in M7-2.)
		for (const root of kb) {
			try { indexFn(db, root); } catch (e) { onError(e); }
		}
		for (const f of sessions) {
			try { ingestFn(db, f); } catch (e) { onError(e); }
		}
		try { onFlush({ kbRoots: kb, sessions }); } catch { /* observability must never break a flush */ }
	}

	function schedule() {
		if (timer) clearTimeout(timer);
		timer = setTimeout(flush, debounceMs);
	}

	const watcher = chokidar.watch(watchPaths, {
		ignoreInitial: true, // the seed (rebuild/ingestFile) already indexed existing files
		// macOS fsevents is chokidar v5's default on darwin (usePolling:false).
	});

	// Route each event. Only the two truth file shapes are interesting:
	//   *.card.md under a watched .kanban -> kb reindex of that root
	//   *.jsonl   under the sessions dir  -> session ingest of that file
	// Everything else (roadmap.md, topics/, non-jsonl) is ignored.
	watcher.on("all", (event, p) => {
		onEvent(event, p);
		if (typeof p !== "string") return;
		if (p.endsWith(".card.md")) {
			const root = kbRootFor(p, kbRoots);
			if (root) { pendingKb.add(root); schedule(); }
		} else if (p.endsWith(".jsonl") && (p === sessionsDir || p.startsWith(sessionsDir + path.sep))) {
			pendingSessions.add(p);
			schedule();
		}
	});
	watcher.on("error", onError);

	// ready — resolves once chokidar has subscribed its fsevents watchers (the
	// 'ready' event). A caller MUST await this before assuming edits will be
	// seen: events fired before 'ready' are NOT delivered. chokidar never emits
	// 'ready' for an empty watch list, so resolve immediately in that case
	// (and on 'error', so a failed arm doesn't hang the caller).
	const ready = new Promise((resolve) => {
		if (watchPaths.length === 0) { resolve(); return; }
		watcher.once("ready", () => resolve());
		watcher.once("error", () => resolve());
	});

	return {
		watcher,
		ready,
		// flushNow() — drain pending work immediately (skipping the debounce).
		// Useful for a clean shutdown / a deterministic test; not on the hot path.
		flushNow() {
			if (timer) { clearTimeout(timer); }
			flush();
		},
		// close() — stop watching + cancel any pending flush. Returns the
		// chokidar close() promise (await it so fsevents handles release before
		// the process exits / the test tears down).
		async close() {
			if (timer) { clearTimeout(timer); timer = null; }
			await watcher.close();
		},
	};
}

module.exports = { start, discoverKbRoots, kbRootFor };
