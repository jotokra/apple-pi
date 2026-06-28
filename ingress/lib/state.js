// ingress/lib/state.js — poller state store (REQ-B-1-2).
//
// Records per-poller seen item IDs (RSS/JSON) or a last-content hash (webdiff)
// so re-runs don't re-inject the same items. SQLite via node:sqlite (same dep
// as the autoresearch DB). One table, keyed by (poller, item_id).
//
// Also exposes an in-memory fake (memStore) for unit tests + the poller smoke.

"use strict";
let DatabaseSync;
try { ({ DatabaseSync } = require("node:sqlite")); } catch { DatabaseSync = null; }
const { dirname, join } = require("node:path");
const { mkdirSync } = require("node:fs");
const { homedir } = require("node:os");

function dbPath() {
	const piDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi");
	return process.env.INGRESS_DB || join(piDir, "agent", "ingress.db");
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS seen (
	poller TEXT NOT NULL,
	item_id TEXT NOT NULL,
	seen_at TEXT NOT NULL,
	PRIMARY KEY (poller, item_id)
);
CREATE TABLE IF NOT EXISTS hash (
	poller TEXT NOT NULL PRIMARY KEY,
	hash TEXT NOT NULL,
	updated_at TEXT NOT NULL
);
`;

class SqliteStore {
	constructor(path) {
		if (!DatabaseSync) throw new Error("node:sqlite unavailable (need Node 22+)");
		mkdirSync(dirname(path || dbPath()), { recursive: true });
		this.db = new DatabaseSync(path || dbPath(), {});
		this.db.exec(SCHEMA);
	}
	hasSeen(poller, id) {
		const r = this.db.prepare("SELECT 1 FROM seen WHERE poller=? AND item_id=?").get(poller, id);
		return !!r;
	}
	markSeen(poller, id) {
		this.db.prepare("INSERT OR IGNORE INTO seen(poller,item_id,seen_at) VALUES(?,?,?)")
			.run(poller, id, new Date().toISOString());
	}
	getSeen(poller) {              // webdiff hash
		const r = this.db.prepare("SELECT hash FROM hash WHERE poller=?").get(poller);
		return r ? r.hash : null;
	}
	setSeen(poller, hash) {
		this.db.prepare("INSERT OR REPLACE INTO hash(poller,hash,updated_at) VALUES(?,?,?)")
			.run(poller, hash, new Date().toISOString());
	}
	close() { try { this.db.close(); } catch { /* */ } }
}

// in-memory fake for tests
function memStore() {
	const seen = new Map();   // "poller\x00id" → true
	const hash = new Map();   // poller → hash
	return {
		hasSeen: (p, id) => seen.has(p + "\x00" + id),
		markSeen: (p, id) => seen.set(p + "\x00" + id, true),
		getSeen: (p) => hash.get(p) || null,
		setSeen: (p, h) => hash.set(p, h),
	};
}

module.exports = { SqliteStore, memStore, dbPath };
