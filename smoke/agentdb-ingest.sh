#!/bin/bash
# smoke/agentdb-ingest.sh — REQ-M10-3 (M10): ingest idempotency + append smoke.
#
# The reliability test for append-only resume ingest (M4-2). Two contracts:
#
#   (1) Idempotency — ingesting the SAME file twice must NOT create duplicate
#       events. The second ingest is a no-op (prefix_hash matches, line count
#       unchanged), so the event count stays byte-stable.
#   (2) Append-only — appending NEW lines to a file must ingest ONLY the new
#       lines (prefix_hash matches, line count grew). The pre-existing events
#       are never re-inserted or duplicated.
#
# The contract (one sentence): ingest is a stable function of the file — the
# same file always yields the same rows, and a grown file yields exactly its
# delta. This is what makes the daily collect idempotent + safe to retry.
#
# Drives the REAL `bin/apple-pi db ingest` path into a throwaway $AGENT_DB;
# the live ~/.pi/agent/agent.db is never referenced. Mirrors
# smoke/agentdb-tier-isolation.sh (same sandbox + buildJSONL + rowCount).
#
# Verify: bash smoke/agentdb-ingest.sh

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."
# shellcheck disable=SC1091
source ./smoke/_lib.sh

command -v node >/dev/null 2>&1 || { fail "node required"; exit 1; }
[[ -f agentdb/cli.js ]] || { fail "agentdb/cli.js missing"; exit 1; }
[[ -f agentdb/db/cli.js ]] || { fail "agentdb/db/cli.js missing"; exit 1; }

BIN="$SCRIPT_DIR/../bin/apple-pi"
DB=(node --no-warnings "$BIN" db)

# --- constants for the fixture -------------------------------------------

# N_INITIAL lines: 1 "session" event (line 0) + (N_INITIAL-1) messages.
N_INITIAL=6
# N_APPEND lines appended after the first two ingests (message events).
N_APPEND=3

# --- fixture builders ----------------------------------------------------

# buildJSONL SID N START_TS -> a session JSONL string. One session event on
# line 0 then N-1 messages; timestamps derived from START_TS. Matches the
# shape ingest/sessions.parseLine consumes (mirrors the tier-isolation smoke
# + bin/apple-pi.db.prune.test.js's builder).
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

# appendJSONL SID FROM_SEQ COUNT START_TS -> N_APPEND message lines as JSONL.
# seqs start at FROM_SEQ (so they never collide with already-ingested lines),
# and each line carries an explicit session_id so the parser routes them to
# the same session (appendIngest backfills it anyway, but being explicit
# keeps the fixture self-describing). Mirrors buildJSONL's message shape.
appendJSONL() {
	node -e '
		const sid = process.argv[1], fromSeq = Number(process.argv[2]), count = Number(process.argv[3]), start = process.argv[4];
		const t0 = new Date(start).getTime();
		const lines = [];
		for (let i = 0; i < count; i++) {
			const seq = fromSeq + i;
			const ts = new Date(t0 + i * 1000).toISOString();
			lines.push(JSON.stringify({ timestamp: ts, session_id: sid, type: "message", role: i % 2 === 0 ? "user" : "assistant", tokens_in: seq * 10, tokens_out: seq * 5, content: `appended msg ${seq}` }));
		}
		process.stdout.write(lines.join("\n") + "\n");
	' "$1" "$2" "$3" "$4"
}

# rowCount DB_FILE TABLE [WHERE] -> integer. Mirrors the tier-isolation smoke.
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

# fieldVal DB_FILE SQL -> the first column of the first row (as a string).
# Used to read sess_files.ingested_lines / total_lines to prove the
# append-only resume bookkeeping advanced correctly. Errors surface + exit 1.
fieldVal() {
	local dbFile="$1"; shift
	node --no-warnings -e '
		const { DatabaseSync } = require("node:sqlite");
		const db = new DatabaseSync(process.argv[1]);
		try {
			const row = db.prepare(process.argv[2]).get();
			const v = row ? Object.values(row)[0] : null;
			process.stdout.write(v === null ? "" : String(v));
		} finally { db.close(); }
	' "$dbFile" "$@"
}

# --- sandbox -------------------------------------------------------------

SBX="$(mktemp -d /tmp/agentdb-ingest.XXXXXX)"
trap 'rm -rf "$SBX" /tmp/agentdb-ingest.{o1,o2,o3}' EXIT
ROOT="$SBX/root"
DB_FILE="$SBX/agent.db"
export AGENT_DB="$DB_FILE"
mkdir -p "$ROOT/sessions"

SESS_JSONL="$ROOT/sessions/sess-1.jsonl"
buildJSONL "sess-1" "$N_INITIAL" "2026-06-01T00:00:00.000Z" > "$SESS_JSONL"

# ===========================================================================
# CONTRACT 1: ingesting the SAME file twice creates no duplicate events
# The second ingest must be a no-op (prefix_hash matches, line count equal),
# so the event/file counts are byte-stable.
# ===========================================================================
header "CONTRACT 1: ingest twice -> no duplicate events (no-op)"

# 1st ingest: full ingest of a new file.
OUT=$("${DB[@]}" ingest "$SESS_JSONL" 2>/tmp/agentdb-ingest.o1); RC=$?
[[ $RC -eq 0 ]] || { fail "1st ingest exited $RC"; cat /tmp/agentdb-ingest.o1; exit 1; }
[[ "$(rowCount "$DB_FILE" sess_files)" == "1" ]] \
	|| { fail "after 1st ingest: expected 1 sess_files row, got $(rowCount "$DB_FILE" sess_files)"; exit 1; }
[[ "$(rowCount "$DB_FILE" sess_events)" == "$N_INITIAL" ]] \
	|| { fail "after 1st ingest: expected $N_INITIAL sess_events, got $(rowCount "$DB_FILE" sess_events)"; exit 1; }
echo "$OUT" | grep -Eq "[[:space:]]$N_INITIAL[[:space:]]+inserted" \
	|| { fail "1st ingest should report $N_INITIAL inserted; got:"; echo "$OUT"; exit 1; }
EVENTS_AFTER_1=$(rowCount "$DB_FILE" sess_events)
INGESTED_LINES_AFTER_1=$(fieldVal "$DB_FILE" "SELECT ingested_lines FROM sess_files WHERE file_path = '$SESS_JSONL'")
[[ "$INGESTED_LINES_AFTER_1" == "$N_INITIAL" ]] \
	|| { fail "sess_files.ingested_lines should be $N_INITIAL after full ingest, got '$INGESTED_LINES_AFTER_1'"; exit 1; }
ok "1st ingest: $N_INITIAL events, 1 file, ingested_lines=$N_INITIAL"

# 2nd ingest: SAME file unchanged -> must be a no-op. No new events, no new
# file rows, and the CLI reports zero work done (0 inserted / 0 appended).
OUT=$("${DB[@]}" ingest "$SESS_JSONL" 2>/tmp/agentdb-ingest.o2); RC=$?
[[ $RC -eq 0 ]] || { fail "2nd ingest exited $RC"; cat /tmp/agentdb-ingest.o2; exit 1; }
[[ "$(rowCount "$DB_FILE" sess_files)" == "1" ]] \
	|| { fail "after 2nd ingest: expected still 1 sess_files row, got $(rowCount "$DB_FILE" sess_files)"; exit 1; }
EVENTS_AFTER_2=$(rowCount "$DB_FILE" sess_events)
[[ "$EVENTS_AFTER_2" == "$EVENTS_AFTER_1" ]] \
	|| { fail "2nd ingest created dupes: events went $EVENTS_AFTER_1 -> $EVENTS_AFTER_2"; exit 1; }
echo "$OUT" | grep -Eq "[[:space:]]0[[:space:]]+inserted" \
	|| { fail "2nd ingest (no-op) should report 0 inserted; got:"; echo "$OUT"; exit 1; }
echo "$OUT" | grep -Eq "[[:space:]]0[[:space:]]+appended" \
	|| { fail "2nd ingest (no-op) should report 0 appended; got:"; echo "$OUT"; exit 1; }
ok "2nd ingest (same file): no-op — events still $EVENTS_AFTER_2, 0 inserted / 0 appended"

# ===========================================================================
# CONTRACT 2: appending lines ingests ONLY the new events
# The prefix is byte-identical (append, not rewrite) so prefix_hash still
# matches; ingest resumes from line ingested_lines and inserts ONLY the tail.
# The pre-existing events are never re-inserted or duplicated.
# ===========================================================================
header "CONTRACT 2: append lines -> only the new events are ingested"

# Append N_APPEND new message lines to the SAME file (>> preserves the
# prefix byte-for-byte, which is what the prefix_hash resume relies on).
appendJSONL "sess-1" "$N_INITIAL" "$N_APPEND" "2026-07-01T00:00:00.000Z" >> "$SESS_JSONL"

OUT=$("${DB[@]}" ingest "$SESS_JSONL" 2>/tmp/agentdb-ingest.o3); RC=$?
[[ $RC -eq 0 ]] || { fail "3rd ingest (append) exited $RC"; cat /tmp/agentdb-ingest.o3; exit 1; }

EXPECTED=$((N_INITIAL + N_APPEND))
[[ "$(rowCount "$DB_FILE" sess_events)" == "$EXPECTED" ]] \
	|| { fail "after append: expected $EXPECTED sess_events ($N_INITIAL + $N_APPEND), got $(rowCount "$DB_FILE" sess_events)"; exit 1; }
[[ "$(rowCount "$DB_FILE" sess_files)" == "1" ]] \
	|| { fail "after append: expected still 1 sess_files row, got $(rowCount "$DB_FILE" sess_files)"; exit 1; }

# the CLI must report ONLY the appended delta as new work.
echo "$OUT" | grep -Eq "[[:space:]]$N_APPEND[[:space:]]+inserted" \
	|| { fail "append ingest should report $N_APPEND inserted; got:"; echo "$OUT"; exit 1; }
echo "$OUT" | grep -Eq "[[:space:]]$N_APPEND[[:space:]]+appended" \
	|| { fail "append ingest should report $N_APPEND appended; got:"; echo "$OUT"; exit 1; }

# the resume bookkeeping must have advanced: ingested_lines now covers the
# whole file, so a 4th ingest would again be a no-op (idempotent after append).
INGESTED_LINES_AFTER_3=$(fieldVal "$DB_FILE" "SELECT ingested_lines FROM sess_files WHERE file_path = '$SESS_JSONL'")
TOTAL_LINES_AFTER_3=$(fieldVal "$DB_FILE" "SELECT total_lines FROM sess_files WHERE file_path = '$SESS_JSONL'")
[[ "$INGESTED_LINES_AFTER_3" == "$EXPECTED" ]] \
	|| { fail "sess_files.ingested_lines should be $EXPECTED after append, got '$INGESTED_LINES_AFTER_3'"; exit 1; }
[[ "$TOTAL_LINES_AFTER_3" == "$EXPECTED" ]] \
	|| { fail "sess_files.total_lines should be $EXPECTED after append, got '$TOTAL_LINES_AFTER_3'"; exit 1; }
ok "append ingest: +$N_APPEND events (now $EXPECTED total), 0 dupes, resume bookkeeping advanced"

echo
ok "agentdb-ingest: idempotent + append-only resume (REQ-M10-3)"
