// lifecycle/lib/db.js — shared SQLite helpers for the autoresearch lifecycle.
// Uses node:sqlite (Node 22, same dep as the kanban-bridge extension).
// Callers should run via `node --no-warnings` to suppress the ExperimentalWarning.
//
// M11-3 repoint: the lifecycle now reads+writes the UNIFIED ~/.pi/agent/agent.db
// (same file as agentdb/lib/db.js), NOT the legacy autoresearch.db. dbPath()
// therefore mirrors agentdb.dbPath() (AGENT_DB || piDir/agent/agent.db). The
// legacy ~/.pi/agent/autoresearch.db survives only as the one-shot SOURCE for
// agentdb/lib/migrate.js (absorbAutoresearch); its resolver lives there now.
//
// open() applies the UNIFIED agentdb/lib/schema.sql (the single schema source
// for agent.db) so the lifecycle can never create a stale/wrong-shape table on
// a fresh agent.db. lifecycle/schema.sql is retained as the verbatim shape
// reference for the legacy tables + the migrate source-fixture builder in tests.

"use strict";
const { readFileSync } = require("node:fs");
const { DatabaseSync } = require("node:sqlite");
const path = require("node:path");

// UNIFIED schema: same file agentdb/lib/db.js applies. Keeping one schema
// source for agent.db prevents the two libraries from diverging on table shape.
const SCHEMA_PATH = path.join(__dirname, "..", "..", "agentdb", "lib", "schema.sql");

function piDir() {
	return process.env.PI_CODING_AGENT_DIR || `${process.env.HOME}/.pi`;
}
// dbPath() — the unified agent DB (M11-3: was autoresearch.db, now agent.db).
// Mirrors agentdb/lib/db.js so the lifecycle and the kanban/ingest/analysis
// layers share ONE file. $AGENT_DB override for tests / rebuilds.
function dbPath() {
	return process.env.AGENT_DB || `${piDir()}/agent/agent.db`;
}

// open() — open + ensure the unified schema. mode: 'rw' (default) | 'ro'.
function open(mode = "rw") {
	const file = dbPath();
	const opts = mode === "ro" ? { readOnly: true } : {};
	const db = new DatabaseSync(file, opts);
	db.exec(readFileSync(SCHEMA_PATH, "utf8"));
	return db;
}

// todayLocal() — YYYY-MM-DD in the user's local timezone (not UTC), so the
// weekly grouping matches the user's notion of "a day."
function todayLocal(d = new Date()) {
	const off = d.getTimezoneOffset();             // minutes ahead/behind UTC
	const local = new Date(d.getTime() - off * 60000);
	return local.toISOString().slice(0, 10);
}

// isoNow() — full ISO timestamp for "collected_at" / "created_at".
function isoNow() {
	return new Date().toISOString();
}

module.exports = { open, dbPath, piDir, todayLocal, isoNow };
