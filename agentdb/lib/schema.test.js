// agentdb/lib/schema.test.js — REQ-M2-1
//
// Loads schema.sql into a TEMP in-memory SQLite DB and asserts:
//   - schema applies clean (no throw)
//   - all 4 Tier-A kb_* tables are present (sqlite_master)
//   - FTS5 is compiled in (PRAGMA compile_options) — kb_body_fts needs it
//
// Verify: node --test agentdb/lib/schema.test.js
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const SCHEMA_PATH = path.join(__dirname, "schema.sql");
const REQUIRED_TABLES = ["kb_cards", "kb_body_fts", "kb_deps", "kb_meta"];

// freshDB() — brand-new in-memory DB with schema.sql applied. ":memory:" is the
// canonical TEMP store for schema-only tests: no file, no cleanup, no env leak.
function freshDB() {
	const db = new DatabaseSync(":memory:");
	db.exec(readFileSync(SCHEMA_PATH, "utf8"));
	return db;
}

test("schema.sql applies cleanly to a fresh in-memory DB (REQ-M2-1)", () => {
	assert.doesNotThrow(freshDB, "loading schema.sql must not throw");
});

test("all 4 Tier-A kb_* tables are present", () => {
	const db = freshDB();
	const rows = db.prepare(
		"SELECT name FROM sqlite_master WHERE type IN ('table','view') ORDER BY name"
	).all();
	const names = new Set(rows.map(r => r.name));
	for (const t of REQUIRED_TABLES) {
		assert.ok(names.has(t), `missing table: ${t} (have: ${[...names].join(",")})`);
	}
});

test("FTS5 is compiled in (kb_body_fts requires it)", () => {
	const db = new DatabaseSync(":memory:");
	const opts = db.prepare("PRAGMA compile_options").all().map(r => r.compile_options);
	assert.ok(
		opts.includes("ENABLE_FTS5"),
		`FTS5 not enabled; compile_options were: ${opts.join(",")}`
	);
});

test("kb_body_fts is an FTS5 virtual table", () => {
	const db = freshDB();
	const row = db.prepare(
		"SELECT sql FROM sqlite_master WHERE type='table' AND name='kb_body_fts'"
	).get();
	assert.ok(row && /using\s+fts5/i.test(row.sql), `kb_body_fts is not FTS5: ${row && row.sql}`);
});

test("schema is idempotent (applying twice is a no-op)", () => {
	const db = new DatabaseSync(":memory:");
	const schema = readFileSync(SCHEMA_PATH, "utf8");
	assert.doesNotThrow(() => db.exec(schema), "first apply");
	assert.doesNotThrow(() => db.exec(schema), "second apply (every stmt is CREATE IF NOT EXISTS)");
});
