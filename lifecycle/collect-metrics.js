#!/usr/bin/env node
// lifecycle/collect-metrics.js — DAILY metrics collector.
//
// Parses every session JSONL under $PI_DIR/sessions/, aggregates one day's
// worth of telemetry, and writes/refreshes a single row in the `runs` table
// (UNIQUE(run_date) → re-running today overwrites today, so a flaky cron
// self-heals). Pure local Node, no LLM, no network.
//
// Usage:
//   node --no-warnings lifecycle/collect-metrics.js            # collect today (default)
//   node --no-warnings lifecycle/collect-metrics.js --date 2026-06-27
//   node --no-warnings lifecycle/collect-metrics.js --all      # backfill every day present in sessions
//   node --no-warnings lifecycle/collect-metrics.js --dry      # parse + print, write nothing
//
// Session JSONL record schema (verified 2026-06-27 from a real ~/.pi/sessions file):
//   record.type ∈ {session, model_change, thinking_level_change, message, ...}
//   message record: { type:"message", message:{ role, content[], usage?, model?, toolName?, isError? } }
//     role:"assistant"  → has message.usage {input,output,cacheRead,cacheWrite,totalTokens,cost:{total}}
//                         and content blocks may include "toolCall" (the request side)
//     role:"toolResult" → has message.toolName (the authoritative per-call count) + message.isError
//     role:"user"       → user turns
//   record.timestamp   → ISO; used to bucket by day.

"use strict";
const { readdirSync, readFileSync, statSync } = require("node:fs");
const path = require("node:path");
const { open, todayLocal, isoNow, piDir } = require("./lib/db");

const SESSIONS_DIR = `${piDir()}/sessions`;

// REQ-CV-6 — credential-vault safety. The collector must NEVER read secret
// material, now or via future changes. This denylist + the guard in
// readSessionFile() enforce it: if any path resolved here matches a denied
// pattern, the read is refused with an error (and smoke/vault-tracefree.sh
// re-asserts no vault path appears in the collected DB). The vault itself lives
// at agent/credentials.vault; sessions/ is a different tree, so this is defense
// in depth against a future glob widening.
const DENYLIST_PATTERNS = [
	/credentials\.vault(\.|$)/i,   // the persistent credential vault
	/onboarding\.vault(\.|$)/i,    // the legacy transient onboarding vault
	/auth\.json$/i,                // Pi's own auth store (already excluded by scope, but explicit)
	/\.ssh\//i, /\.aws\//i, /\.kube\//i,  // standard secret dirs
];
function isDenied(p) {
	return DENYLIST_PATTERNS.some((re) => re.test(p));
}
// Guarded read: refuse denied paths. Used for ALL file reads in this collector.
function readSessionFile(fullPath) {
	if (isDenied(fullPath)) {
		throw new Error(`collect-metrics: refusing to read denied path (credential/secret material): ${fullPath}`);
	}
	return readFileSync(fullPath, "utf8");
}

function parseArgs(argv) {
	const out = { date: null, all: false, dry: false };
	for (let i = 2; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--all") out.all = true;
		else if (a === "--dry") out.dry = true;
		else if (a === "--date") out.date = argv[++i];
		else { console.error(`unknown arg: ${a}`); process.exit(2); }
	}
	return out;
}

// Scan sessions; return Map<YYYY-MM-DD, metrics> covering every day seen.
// (We always compute all days from raw sessions, then choose what to persist.)
function collectAllDays() {
	let files = [];
	try {
		files = readdirSync(SESSIONS_DIR).filter((f) => f.endsWith(".jsonl"));
	} catch {
		return new Map(); // no sessions dir yet — nothing to collect
	}
	const byDay = new Map(); // date → accum
	const emptyDay = () => ({
		sessionFiles: new Set(),
		turns: 0,
		tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0, cost: 0,
		compaction: 0, errors: 0,
		tools: {},    // toolName → count
		models: {},   // model → assistant-turn count
	});

	for (const f of files) {
		const full = path.join(SESSIONS_DIR, f);
		let lines;
		try { lines = readSessionFile(full).split("\n"); } catch { continue; }
		let touchedThisFile = false;
		for (const line of lines) {
			if (!line.trim()) continue;
			let o;
			try { o = JSON.parse(line); } catch { continue; }
			if (!o || typeof o !== "object") continue;
			// Bucket by the record's own timestamp (local date).
			const ts = o.timestamp || (o.message && o.message.timestamp);
			const date = ts ? new Date(ts) : null;
			const day = date ? todayLocal(date) : todayLocal();
			let d = byDay.get(day);
			if (!d) { d = emptyDay(); byDay.set(day, d); }

			if (o.type === "message") {
				const m = o.message || {};
				if (m.role === "user" || m.role === "assistant") d.turns += 1;
				if (m.role === "toolResult") {
					d.turns += 1;
					if (m.toolName) d.tools[m.toolName] = (d.tools[m.toolName] || 0) + 1;
					if (m.isError) d.errors += 1;
					touchedThisFile = true;
				}
				if (m.role === "assistant") {
					if (m.model) d.models[m.model] = (d.models[m.model] || 0) + 1;
					const u = m.usage || {};
					d.tokensIn += u.input || 0;
					d.tokensOut += u.output || 0;
					d.cacheRead += u.cacheRead || 0;
					d.cacheWrite += u.cacheWrite || 0;
					const c = u.cost || {};
					d.cost += c.total || 0;
				}
			}
			// Compaction: Pi emits records we can count; if absent, stays 0.
			// (Kept defensive: any type containing 'compact' counts.)
			if (typeof o.type === "string" && o.type.toLowerCase().includes("compact")) d.compaction += 1;
		}
		if (touchedThisFile) {
			// attribute the file to every day it touched (sessions span days);
			// but session_count below uses a simpler "files active this day" proxy.
		}
	}

	// session_count: how many session files had ANY record on a given day.
	// Re-scan cheaply mapping file→set of days.
	const fileDays = new Map();
	for (const f of files) {
		let lines;
		try { lines = readSessionFile(path.join(SESSIONS_DIR, f)).split("\n"); } catch { continue; }
		const days = new Set();
		for (const line of lines) {
			if (!line.trim()) continue;
			let o; try { o = JSON.parse(line); } catch { continue; }
			const ts = o && (o.timestamp || (o.message && o.message.timestamp));
			if (ts) days.add(todayLocal(new Date(ts)));
		}
		fileDays.set(f, days);
	}
	for (const [day, d] of byDay) {
		let n = 0;
		for (const days of fileDays.values()) if (days.has(day)) n += 1;
		d.sessionFilesCount = n;
	}
	return byDay;
}

function persistDay(db, day, d) {
	db.prepare(
		`INSERT INTO runs (run_date, collected_at, session_count, total_turns,
           tokens_in, tokens_out, cache_read, cache_write, cost,
           compaction_count, error_count, tool_calls_json, models_json)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(run_date) DO UPDATE SET
           collected_at=excluded.collected_at, session_count=excluded.session_count,
           total_turns=excluded.total_turns, tokens_in=excluded.tokens_in,
           tokens_out=excluded.tokens_out, cache_read=excluded.cache_read,
           cache_write=excluded.cache_write, cost=excluded.cost,
           compaction_count=excluded.compaction_count, error_count=excluded.error_count,
           tool_calls_json=excluded.tool_calls_json, models_json=excluded.models_json`,
	).run(
		day, isoNow(), d.sessionFilesCount || 0, d.turns,
		d.tokensIn, d.tokensOut, d.cacheRead, d.cacheWrite, d.cost,
		d.compaction, d.errors, JSON.stringify(d.tools), JSON.stringify(d.models),
	);
}

function summarize(day, d) {
	const tools = d.tools;
	const totalTools = Object.values(tools).reduce((a, b) => a + b, 0);
	const bashPct = totalTools ? Math.round((tools.bash || 0) * 100 / totalTools) : 0;
	const readPct = totalTools ? Math.round(((tools.read || 0) + (tools.grep || 0) + (tools.find || 0) + (tools.ls || 0)) * 100 / totalTools) : 0;
	return `${day}  sessions=${d.sessionFilesCount || 0}  turns=${d.turns}  tools=${totalTools} (bash ${bashPct}%/read ${readPct}%)  tok in/out=${d.tokensIn}/${d.tokensOut}  cache R/W=${d.cacheRead}/${d.cacheWrite}  $${d.cost.toFixed(4)}  errors=${d.errors}  models=${Object.entries(d.models).map(([k, v]) => `${k}:${v}`).join(",") || "—"}`;
}

function main() {
	const args = parseArgs(process.argv);
	const byDay = collectAllDays();
	if (byDay.size === 0) {
		console.log(`collect-metrics: no sessions found under ${SESSIONS_DIR}`);
		return;
	}

	let targets;
	if (args.all) targets = [...byDay.keys()].sort();
	else if (args.date) targets = [args.date];
	else targets = [todayLocal()];

	if (args.dry) {
		console.log(`collect-metrics --dry: ${byDay.size} day(s) seen, ${targets.length} target(s)`);
		for (const day of targets) {
			const d = byDay.get(day);
			if (d) console.log("  " + summarize(day, d));
			else console.log(`  ${day}: no session data`);
		}
		return;
	}

	const db = open("rw");
	let written = 0;
	for (const day of targets) {
		const d = byDay.get(day);
		if (!d) { console.log(`  ${day}: no session data, skipping`); continue; }
		persistDay(db, day, d);
		console.log("  " + summarize(day, d));
		written++;
	}
	db.close();
	console.log(`collect-metrics: wrote ${written} run row(s) to ${require("./lib/db").dbPath()}`);
}

// CLI entry — guarded so the module is require()-able for the REQ-CV-6 smoke
// test (which asserts isDenied() without triggering a real collection run
// against the live PI dir).
if (require.main === module) {
	main();
}

// Test-only exports (REQ-CV-6). Not part of the CLI surface; the smoke test
// requires this module to assert the denylist guard fires on credential paths.
module.exports = { isDenied, readSessionFile };
