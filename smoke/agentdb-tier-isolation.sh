#!/bin/bash
# smoke/agentdb-tier-isolation.sh — REQ-M10-2 (M10): the tier-isolation smoke.
#
# The HEADLINE reliability test for the unified agent DB. Both tiers are
# seeded in ONE DB, then each is disposed independently to prove the
# tier-isolation invariant from SUPERPROMPT §2 / M2-2:
#
#   Tier A (kb_*)              — disposable: `kanban index --rebuild` DROPs
#                                and recreates it from the .card.md truth
#   Tier B (sess_*/analysis_*) — durable: `db prune --yes` deletes old sess_*
#                                rows + logs an audit row to analysis_runs
#
# The contract (one sentence): each tier is disposable independently.
#   (1) `kanban index --rebuild` leaves Tier B byte-identical (row-hash match)
#   (2) `db prune --yes`        leaves Tier A byte-identical (row-hash match)
#
# Both disposals do REAL work (the assertions are not vacuous): the rebuild
# recreates kb_* from 3 cards; the prune deletes all 8 seeded sess_events.
# The "other tier" staying byte-identical is what's being proved.
#
# Seeds via the REAL bin/apple-pi paths (kanban index, db ingest) plus direct
# SQL for the analysis-tier canaries — mirroring bin/apple-pi.db.prune.test.js.
# Drives a throwaway cwd + $AGENT_DB; the live ~/.pi/agent/agent.db is never
# referenced. Mirrors smoke/kanban-index.sh + the db prune suite.
#
# Verify: bash smoke/agentdb-tier-isolation.sh

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."
# shellcheck disable=SC1091
source ./smoke/_lib.sh

command -v node >/dev/null 2>&1 || { fail "node required"; exit 1; }
[[ -f agentdb/cli.js ]] || { fail "agentdb/cli.js missing"; exit 1; }
[[ -f agentdb/db/cli.js ]] || { fail "agentdb/db/cli.js missing"; exit 1; }

BIN="$SCRIPT_DIR/../bin/apple-pi"
KANBAN=(node --no-warnings "$BIN" kanban)
DB=(node --no-warnings "$BIN" db)

# --- fixture builders ------------------------------------------------------

# card(id, status, deps) -> a .card.md body (same template smoke/kanban-*.sh
# and the kb/ suites use).
card() {
	cat <<EOF
---
id: $1
title: Card $1
status: $2
project: apple-pi
parent: root
depends_on: $3
created_at: 2026-07-02T22:00:00Z
updated_at: 2026-07-02T22:00:00Z
---

# Card $1
Body for $1.
EOF
}

# buildJSONL SID N START_TS -> a session JSONL string. One session event on
# line 0 then N-1 messages, timestamps derived from START_TS so a "2025-12"
# start yields 2025-12 sess_events.ts rows (old relative to the 2026-01-01
# prune threshold). Matches the shape ingest/sessions.parseLine consumes
# (mirrors bin/apple-pi.db.prune.test.js's builder).
buildJSONL() {
	node -e '
		const sid = process.argv[1], n = Number(process.argv[2]), start = process.argv[3];
		const t0 = new Date(start).getTime();
		const line = (o) => JSON.stringify(Object.assign({ timestamp: start }, o));
		const lines = [line({ type: "session", id: sid, cwd: "/work" })];
		for (let i = 1; i < n; i++) {
			const ts = new Date(t0 + i * 1000).toISOString();
			lines.push(line({ type: "message", role: i % 2 === 0 ? "user" : "assistant", tokens_in: i * 10, tokens_out: i * 5, content: `msg ${i}` }));
		}
		process.stdout.write(lines.join("\n") + "\n");
	' "$1" "$2" "$3"
}

# tierHash DB_FILE TABLE... -> sha256 hex over every row of every named table.
# Rows are dumped in a canonical order (ORDER BY all columns; falls back to
# natural order if a table refuses the ORDER BY) and serialized as
# `table|col=val|col=val|...` with column names sorted — so the digest is a
# stable function of the table contents alone. A single byte change in any
# row of any named table flips it. Works for both regular tables and FTS5
# virtual tables (PRAGMA table_info returns columns for both).
tierHash() {
	local dbFile="$1"; shift
	node --no-warnings -e '
		const crypto = require("node:crypto");
		const { DatabaseSync } = require("node:sqlite");
		const db = new DatabaseSync(process.argv[1]);
		const tables = process.argv.slice(2);
		const parts = [];
		for (const t of tables) {
			const cols = db.prepare(`PRAGMA table_info(${t})`).all()
				.sort((a, b) => a.cid - b.cid).map(r => r.name);
			const order = cols.map(c => `"${c}"`).join(", ");
			let rows;
			try { rows = db.prepare(`SELECT * FROM "${t}" ORDER BY ${order}`).all(); }
			catch (_) { rows = db.prepare(`SELECT * FROM "${t}"`).all(); }
			for (const row of rows) {
				const seg = Object.keys(row).sort()
					.map(k => `${k}=${row[k] === null ? "NULL" : String(row[k])}`)
					.join("|");
				parts.push(`${t}|${seg}`);
			}
		}
		db.close();
		process.stdout.write(crypto.createHash("sha256").update(parts.join("\n"), "utf8").digest("hex"));
	' "$dbFile" "$@"
}

# sqlExec DB_FILE SQL... — fire DDL/DML statements (used to seed the
# analysis-tier canaries + back-date sess_files.ingested_at). A statement
# error surfaces to stderr and exits 1.
sqlExec() {
	local dbFile="$1"; shift
	node --no-warnings -e '
		const { DatabaseSync } = require("node:sqlite");
		const db = new DatabaseSync(process.argv[1]);
		try { for (let i = 2; i < process.argv.length; i++) db.exec(process.argv[i]); }
		finally { db.close(); }
	' "$dbFile" "$@"
}

# rowCount DB_FILE TABLE [WHERE] -> integer. Used to prove the disposals did
# real work (rebuild -> 3 cards back; prune -> 0 events left) so the
# "other tier unchanged" assertions are not vacuous.
rowCount() {
	local dbFile="$1" table="$2" where="${3:-}"
	node --no-warnings -e '
		const { DatabaseSync } = require("node:sqlite");
		const db = new DatabaseSync(process.argv[1]);
		try {
			const sql = `SELECT COUNT(*) c FROM ${process.argv[2]}` + (process.argv[3] ? ` WHERE ${process.argv[3]}` : "");
			process.stdout.write(String(db.prepare(sql).get().c));
		} finally { db.close(); }
	' "$dbFile" "$table" "$where"
}

# --- the tiers (table lists) ----------------------------------------------

# Tier A: the disposable kanban mirror (kb_*). A rebuild DROPs+recreates these.
TIER_A=(kb_cards kb_body_fts kb_deps kb_meta)
# Tier B: the durable memory. sess_* (ingest) + analysis_*/proposals (analysis).
# A prune deletes sess_* rows + APPENDS an analysis_runs audit row.
TIER_B=(sess_files sess_sessions sess_events analysis_runs analysis_findings proposals)

SBX="$(mktemp -d /tmp/tier-iso.XXXXXX)"
trap 'rm -rf "$SBX" /tmp/tier-iso.{k1,k2,i1,p1}' EXIT
ROOT="$SBX/root"
DB_FILE="$SBX/agent.db"
export AGENT_DB="$DB_FILE"
mkdir -p "$ROOT/cards" "$ROOT/sessions"

# ── seed Tier A (kb_*) via the REAL kanban index path ─────────────────
card a todo "[]"      > "$ROOT/cards/a.card.md"
card b review "[a]"   > "$ROOT/cards/b.card.md"
card c done "[]"      > "$ROOT/cards/c.card.md"
"${KANBAN[@]}" index --rebuild --root "$ROOT" >/tmp/tier-iso.k1 2>&1 \
	|| { fail "kanban index --rebuild (seed Tier A) failed"; cat /tmp/tier-iso.k1; exit 1; }
[[ "$(rowCount "$DB_FILE" kb_cards)" == "3" ]] \
	|| { fail "Tier A seed: expected 3 kb_cards, got $(rowCount "$DB_FILE" kb_cards)"; exit 1; }
ok "seeded Tier A (kb_*): 3 cards via kanban index --rebuild"

# ── seed Tier B (sess_* + analysis_* + proposals) ─────────────────────
# sess_* via the REAL db ingest path. Events dated 2025-12 so a 2026-01-01
# prune threshold actually deletes them (a vacuous prune would not prove
# the isolation contract — the "Tier A unchanged" assertion must come after
# a prune that genuinely mutated Tier B).
OLD_JSONL="$ROOT/sessions/sess-old.jsonl"
buildJSONL "sess-old" 8 "2025-12-15T00:00:00.000Z" > "$OLD_JSONL"
"${DB[@]}" ingest "$OLD_JSONL" >/tmp/tier-iso.i1 2>&1 \
	|| { fail "db ingest (seed sess_*) failed"; cat /tmp/tier-iso.i1; exit 1; }
# sess_files.ingested_at is ingest-time (today); back-date so all three prune
# columns (sess_events.ts / sess_sessions.last_event_at / sess_files.ingested_at)
# agree this session is "old" relative to --before (mirrors the db prune suite).
sqlExec "$DB_FILE" "UPDATE sess_files SET ingested_at = '2025-12-15T00:01:00.000Z' WHERE session_id = 'sess-old'"
[[ "$(rowCount "$DB_FILE" sess_events)" == "8" ]] \
	|| { fail "Tier B seed: expected 8 sess_events, got $(rowCount "$DB_FILE" sess_events)"; exit 1; }

# analysis_* + proposals via direct SQL (canaries the isolation invariant
# must protect — mirrors the seedTierRows helper in bin/apple-pi.db.prune.test.js).
sqlExec "$DB_FILE" \
	"INSERT INTO analysis_runs (started_at, ended_at, model, finding_count, notes) VALUES ('2025-12-10T00:00:00.000Z', '2025-12-10T00:00:00.000Z', '<model>', 1, 'pre-existing analysis run')" \
	"INSERT INTO analysis_findings (run_id, detector, severity, title, detected_at) VALUES (1, 'error_pattern', 'warn', 'tool X failed 3x', '2025-12-10T00:00:00.000Z')" \
	"INSERT INTO proposals (status, setting, from_value, to_value, rationale, proposed_at) VALUES ('proposed', 'agent.max_turns', '40', '60', 'reduce stalls', '2025-12-11T00:00:00.000Z')"
[[ "$(rowCount "$DB_FILE" analysis_runs)" == "1" ]] || { fail "analysis_runs seed (1 expected)"; exit 1; }
[[ "$(rowCount "$DB_FILE" analysis_findings)" == "1" ]] || { fail "analysis_findings seed (1 expected)"; exit 1; }
[[ "$(rowCount "$DB_FILE" proposals)" == "1" ]] || { fail "proposals seed (1 expected)"; exit 1; }
ok "seeded Tier B (sess_* + analysis_* + proposals): 8 events, 1 run, 1 finding, 1 proposal"

# ===========================================================================
# CONTRACT 1: kanban index --rebuild leaves Tier B byte-identical
# A rebuild DROPs+recreates kb_* ONLY (Tier A); Tier B must survive untouched.
# ===========================================================================
header "CONTRACT 1: kanban index --rebuild leaves Tier B byte-identical"
TIER_B_BEFORE=$(tierHash "$DB_FILE" "${TIER_B[@]}")

OUT=$("${KANBAN[@]}" index --rebuild --root "$ROOT" 2>/tmp/tier-iso.k2); RC=$?
[[ $RC -eq 0 ]] || { fail "kanban index --rebuild exited $RC"; cat /tmp/tier-iso.k2; exit 1; }
# the rebuild did REAL work on Tier A: kb_* recreated, 3 cards back.
echo "$OUT" | grep -Eq "cards[[:space:]]*:[[:space:]]*3" \
	|| { fail "rebuild should report 3 cards; got:"; echo "$OUT"; exit 1; }
[[ "$(rowCount "$DB_FILE" kb_cards)" == "3" ]] \
	|| { fail "post-rebuild kb_cards should be 3; got $(rowCount "$DB_FILE" kb_cards)"; exit 1; }

TIER_B_AFTER=$(tierHash "$DB_FILE" "${TIER_B[@]}")
if [[ "$TIER_B_BEFORE" != "$TIER_B_AFTER" ]]; then
	fail "Tier B row-hash CHANGED across kanban index --rebuild (rebuild touched a non-kb table)"
	info "  before: $TIER_B_BEFORE"
	info "  after : $TIER_B_AFTER"
	exit 1
fi
ok "Tier B byte-identical across kanban index --rebuild (row-hash match)"

# ===========================================================================
# CONTRACT 2: db prune --yes leaves Tier A (kb_*) byte-identical
# A prune deletes sess_* + appends an analysis_runs audit row (Tier B); Tier A
# must survive untouched.
# ===========================================================================
header "CONTRACT 2: db prune --yes leaves Tier A (kb_*) byte-identical"
TIER_A_BEFORE=$(tierHash "$DB_FILE" "${TIER_A[@]}")

OUT=$("${DB[@]}" prune --before 2026-01-01 --yes 2>/tmp/tier-iso.p1); RC=$?
[[ $RC -eq 0 ]] || { fail "db prune --yes exited $RC"; cat /tmp/tier-iso.p1; exit 1; }
# the prune did REAL work on Tier B: the OLD session is gone (so the
# "Tier A unchanged" assertion is not vacuous — prune mutated Tier B, not A).
[[ "$(rowCount "$DB_FILE" sess_events)" == "0" ]] \
	|| { fail "prune should have deleted all sess_events; got $(rowCount "$DB_FILE" sess_events)"; exit 1; }
echo "$OUT" | grep -Eq "events[[:space:]]*:[[:space:]]*8" \
	|| { fail "prune stdout should report 8 deleted events; got:"; echo "$OUT"; exit 1; }

TIER_A_AFTER=$(tierHash "$DB_FILE" "${TIER_A[@]}")
if [[ "$TIER_A_BEFORE" != "$TIER_A_AFTER" ]]; then
	fail "Tier A row-hash CHANGED across db prune --yes (prune touched a kb_* table)"
	info "  before: $TIER_A_BEFORE"
	info "  after : $TIER_A_AFTER"
	exit 1
fi
ok "Tier A (kb_*) byte-identical across db prune --yes (row-hash match)"

echo
ok "agentdb-tier-isolation: each tier disposable independently (REQ-M10-2)"
