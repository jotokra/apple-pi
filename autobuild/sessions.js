// autobuild/sessions.js — capture every agent + subagent session produced by an
// autonomous autobuild run into a durable SQLite store, initialized at the START
// of the process. This is the seed of apple-pi's unified agent DB (Tier-B
// session memory in the kanban SUPERPROMPT): the autobuild workflow is the first
// PRODUCER of agent-session data, which the self-improvement loop later analyzes
// to improve the builder itself.
//
// Design:
//   - initDb() at orchestrator startup (creates ~/.pi/agent/agent.db if absent).
//   - snapshot the pi sessions dir BEFORE each worker spawn; AFTER, every NEW
//     session file = the worker + any subagents it spawned. Each is INGESTED in
//     full (one row per event, original payload retained) — long retention.
//   - a disk-budget guard (30% of available disk by default) HALTS (never
//     auto-prunes) if the metadata store would exceed it.
//   - all capture is NON-FATAL: a capture error is logged, never breaks the build.
//
// Config (env): AUTOBUILD_DB (default ~/.pi/agent/agent.db),
//   AUTOBUILD_SESSIONS_DIR (default ~/.pi/sessions), AUTOBUILD_DISK_BUDGET_PCT
//   (default 30).
"use strict";
const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const DB_PATH = process.env.AUTOBUILD_DB || path.join(process.env.HOME || os.homedir(), ".pi", "agent", "agent.db");
const SESS_DIR = process.env.AUTOBUILD_SESSIONS_DIR || path.join(process.env.HOME || os.homedir(), ".pi", "sessions");
const BUDGET_PCT = parseInt(process.env.AUTOBUILD_DISK_BUDGET_PCT || "30", 10);

function availBytes(p) {
	try { const s = fs.statfsSync(p); return Number(s.bavail) * Number(s.bsize); } catch { return 0; }
}
function diskBudget() {
	const abs = parseInt(process.env.AUTOBUILD_DISK_BUDGET_BYTES || "0", 10);
	if (abs > 0) return abs; // absolute override (also lets tests force a tiny budget)
	return Math.floor((BUDGET_PCT / 100) * availBytes(os.homedir()));
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS ab_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, started_at TEXT NOT NULL, ended_at TEXT,
  cwd TEXT, tasks_file TEXT, orchestrator_session TEXT, pid INTEGER,
  disk_avail_bytes INTEGER, disk_budget_bytes INTEGER);
CREATE TABLE IF NOT EXISTS ab_worker_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER NOT NULL REFERENCES ab_runs(id),
  task_id TEXT, attempt INTEGER, worker_cmd TEXT, started_at TEXT, ended_at TEXT,
  duration_ms INTEGER, verify_cmd TEXT, verify_exit INTEGER, status TEXT, committed_sha TEXT);
CREATE TABLE IF NOT EXISTS ab_captured_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER NOT NULL REFERENCES ab_runs(id),
  worker_session_id INTEGER REFERENCES ab_worker_sessions(id),
  session_file TEXT, session_id TEXT, entry_count INTEGER, bytes INTEGER, ingested_at TEXT);
CREATE TABLE IF NOT EXISTS ab_session_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, captured_session_id INTEGER NOT NULL REFERENCES ab_captured_sessions(id),
  seq INTEGER, type TEXT, ts TEXT, role TEXT, tool TEXT, event_json TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_ab_ws_run ON ab_worker_sessions(run_id);
CREATE INDEX IF NOT EXISTS idx_ab_cs_run ON ab_captured_sessions(run_id);
CREATE INDEX IF NOT EXISTS idx_ab_ev_cs ON ab_session_events(captured_session_id);
`;

function initDb() {
	fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
	const db = new DatabaseSync(DB_PATH);
	db.exec(SCHEMA);
	db.exec("PRAGMA journal_mode=WAL;");
	return db;
}
function isoNow() { return new Date().toISOString(); }

function startRun(db, { cwd, tasks_file, orchestrator_session }) {
	const avail = availBytes(os.homedir()), budget = diskBudget();
	const r = db.prepare(`INSERT INTO ab_runs (started_at, cwd, tasks_file, orchestrator_session, pid, disk_avail_bytes, disk_budget_bytes)
		VALUES (?, ?, ?, ?, ?, ?, ?)`).run(isoNow(), cwd, tasks_file, orchestrator_session || null, process.pid, avail, budget);
	return { id: Number(r.lastInsertRowid), budget, avail };
}
function endRun(db, runId) { db.prepare("UPDATE ab_runs SET ended_at = ? WHERE id = ?").run(isoNow(), runId); }

function snapshotSessions() {
	const set = new Set();
	try { for (const f of fs.readdirSync(SESS_DIR)) if (f.endsWith(".jsonl")) set.add(path.join(SESS_DIR, f)); } catch {}
	return set;
}

function recordWorker(db, runId, w) {
	const r = db.prepare(`INSERT INTO ab_worker_sessions (run_id, task_id, attempt, worker_cmd, started_at)
		VALUES (?, ?, ?, ?, ?)`).run(runId, w.task_id, w.attempt, w.worker_cmd, isoNow());
	return Number(r.lastInsertRowid);
}
function finalizeWorker(db, workerId, f) {
	db.prepare(`UPDATE ab_worker_sessions SET ended_at=?, duration_ms=?, verify_cmd=?, verify_exit=?, status=?, committed_sha=? WHERE id=?`)
		.run(isoNow(), f.duration_ms ?? null, f.verify_cmd ?? null, f.verify_exit, f.status, f.committed_sha ?? null, workerId);
}

// metadata footprint so far (sum of ingested session bytes) vs the budget
function metadataBytes(db) {
	const r = db.prepare("SELECT COALESCE(SUM(bytes),0) AS b FROM ab_captured_sessions").get();
	return Number(r && r.b) || 0;
}

function normalizeEvent(line, seq) {
	let o; try { o = JSON.parse(line); } catch { return null; }
	const type = o.type || o.role || "unknown";
	const ts = o.timestamp || null;
	let role = null, tool = null;
	if (o.message && typeof o.message === "object") {
		role = o.message.role || null;
		const c = o.message.content;
		if (Array.isArray(c)) { const tu = c.find(b => b && b.type === "tool_use"); if (tu) tool = tu.name || null; }
	} else if (o.role) role = o.role;
	return { seq, type, ts, role, tool, json: line };
}
function sessionIdFrom(file, events) {
	const sess = events.find(e => e && e.type === "session");
	if (sess) { try { const o = JSON.parse(sess.json); if (o.id) return o.id; } catch {} }
	const m = path.basename(file).match(/_([0-9a-f-]{8,})\.jsonl$/i);
	return m ? m[1] : path.basename(file);
}

// Ingest every NEW session file (worker + subagents) produced during a worker run.
// Throws on budget exceeded so the orchestrator can HALT cleanly (no auto-prune).
function captureNewSessions(db, runId, workerId, beforeSet) {
	const before = beforeSet instanceof Set ? beforeSet : new Set(beforeSet);
	const now = new Set(snapshotSessions());
	const newFiles = [...now].filter(f => !before.has(f));
	const insCs = db.prepare(`INSERT INTO ab_captured_sessions (run_id, worker_session_id, session_file, session_id, entry_count, bytes, ingested_at)
		VALUES (?, ?, ?, ?, ?, ?, ?)`);
	const insEv = db.prepare(`INSERT INTO ab_session_events (captured_session_id, seq, type, ts, role, tool, event_json) VALUES (?, ?, ?, ?, ?, ?, ?)`);
	const budget = diskBudget();
	const captured = [];
	for (const file of newFiles) {
		let lines; try { lines = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(l => l.trim()); } catch { continue; }
		const events = lines.map((l, i) => normalizeEvent(l, i)).filter(Boolean);
		const bytes = fs.statSync(file).size;
		const projected = metadataBytes(db) + bytes;
		if (budget && projected > budget) {
			const e = new Error(`AUTOBUILD session budget exceeded: ${projected} > ${budget} bytes (30% of disk). HALT — not pruning (long retention). Clear old data or raise AUTOBUILD_DISK_BUDGET_PCT.`);
			e.code = "BUDGET"; throw e;
		}
		const sid = sessionIdFrom(file, events);
		db.exec("BEGIN");
		try {
			const r = insCs.run(runId, workerId, file, sid, events.length, bytes, isoNow());
			const csId = Number(r.lastInsertRowid);
			for (const ev of events) insEv.run(csId, ev.seq, ev.type, ev.ts, ev.role, ev.tool, ev.json);
			db.exec("COMMIT");
		} catch (err) { db.exec("ROLLBACK"); throw err; }
		captured.push({ session_file: file, session_id: sid, events: events.length, bytes });
	}
	return captured;
}

module.exports = { DB_PATH, SESS_DIR, diskBudget, availBytes, initDb, startRun, endRun, snapshotSessions, recordWorker, finalizeWorker, captureNewSessions, metadataBytes };
