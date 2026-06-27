// lifecycle/lib/db.js — shared SQLite helpers for the autoresearch lifecycle.
// Uses node:sqlite (Node 22, same dep as the kanban-bridge extension).
// Callers should run via `node --no-warnings` to suppress the ExperimentalWarning.

"use strict";
const { readFileSync } = require("node:fs");
const { DatabaseSync } = require("node:sqlite");

const SCHEMA_PATH = require("path").join(__dirname, "..", "schema.sql");

function piDir() {
	return process.env.PI_CODING_AGENT_DIR || `${process.env.HOME}/.pi`;
}
function dbPath() {
	return process.env.AUTORESEARCH_DB || `${piDir()}/agent/autoresearch.db`;
}

// open() — open + ensure schema. mode: 'rw' (default) | 'ro'.
function open(mode = "rw") {
	const path = dbPath();
	const opts = mode === "ro" ? { readOnly: true } : {};
	const db = new DatabaseSync(path, opts);
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
