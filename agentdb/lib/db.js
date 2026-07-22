// agentdb/lib/db.js — shared SQLite helpers for the unified agent DB.
// SUPERPROMPT §2 + §6: ONE unified `~/.pi/agent/agent.db`, two durability tiers
// (kb_* disposable; sess_*/analysis_*/runs/proposals durable). Uses node:sqlite
// (Node 22, same dep as the autoresearch lifecycle). Callers should run via
// `node --no-warnings` to suppress the ExperimentalWarning.
//
// Scope (M2-1): open()/dbPath()/piDir() + idempotent schema apply. The schema
// file currently defines **Tier A only** (kb_* kanban mirror); Tier B is added
// into the SAME schema.sql by later milestones and applied by the SAME open() —
// one connection, one backup, one apply pass. Mirrors lifecycle/lib/db.js.
"use strict";

const { readFileSync } = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const SCHEMA_PATH = path.join(__dirname, "schema.sql");

// piDir() — root of the agent config tree ($PI_CODING_AGENT_DIR-aware; default ~/.pi).
function piDir() {
	return process.env.PI_CODING_AGENT_DIR || `${process.env.HOME}/.pi`;
}

// dbPath() — the unified agent DB. Default ~/.pi/agent/agent.db (SUPERPROMPT §6);
// overridable via $AGENT_DB so tests / rebuilds can point at a temp file without
// touching the live DB.
function dbPath() {
	return process.env.AGENT_DB || `${piDir()}/agent/agent.db`;
}

// open(mode) — open the DB and ensure the full schema is present. Idempotent:
// every schema statement is CREATE ... IF NOT EXISTS, so open() is safe to call
// on every connection. mode: 'rw' (default) | 'ro'.
function open(mode = "rw") {
	const file = dbPath();
	const opts = mode === "ro" ? { readOnly: true } : {};
	const db = new DatabaseSync(file, opts);
	db.exec(readFileSync(SCHEMA_PATH, "utf8"));
	return db;
}

module.exports = { open, dbPath, piDir };
