#!/usr/bin/env bash
# smoke/autobuild-sessions.sh — deterministic test of session capture (no LLM,
# no real ~/.pi/sessions). Verifies: DB init at start, worker+subagent sessions
# diff-captured, full event ingest, session_id + tool extraction, resumability of
# the snapshot diff, and the disk-budget HALT (via AUTOBUILD_DISK_BUDGET_BYTES).
set -uo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE="${NODE:-$(command -v node)}"
W1="$(mktemp -d)"; W2="$(mktemp -d)"
trap 'rm -rf "$W1" "$W2"' EXIT
fail() { echo "FAIL autobuild-sessions: $*" >&2; exit 1; }

# --- test 1: capture worker + subagent, full ingest, id/tool extraction ---
mkdir -p "$W1/sessions"
AUTOBUILD_DB="$W1/agent.db" AUTOBUILD_SESSIONS_DIR="$W1/sessions" TESTREPO="$REPO" \
"$NODE" - <<'NODE' || fail "capture driver failed"
const S = require(process.env.TESTREPO + "/autobuild/sessions");
const assert = require("node:assert");
const fs = require("node:fs");
const tmp = process.env.AUTOBUILD_SESSIONS_DIR;
const before = S.snapshotSessions();
assert.equal(before.size, 0, "sessions dir starts empty");
// simulate a worker spawn that produced a worker session + a subagent session
fs.writeFileSync(tmp + "/2026-07-02T00-00-00Z_worker-aaaa.jsonl",
  '{"type":"session","version":1,"id":"aaaa-1111","timestamp":"2026-07-02T22:00:00Z","cwd":"/x"}\n' +
  '{"type":"message","message":{"role":"assistant","content":[{"type":"tool_use","name":"read","id":"1"}]},"timestamp":"2026-07-02T22:00:01Z"}\n' +
  '{"type":"message","message":{"role":"user"},"timestamp":"2026-07-02T22:00:02Z"}\n');
fs.writeFileSync(tmp + "/2026-07-02T00-00-00Z_sub-bbbb.jsonl",
  '{"type":"session","version":1,"id":"bbbb-2222","timestamp":"2026-07-02T22:00:00Z","cwd":"/x"}\n' +
  '{"type":"message","message":{"role":"assistant","content":[{"type":"tool_use","name":"bash","id":"1"}]},"timestamp":"2026-07-02T22:00:03Z"}\n');
const db = S.initDb();
const run = S.startRun(db, { cwd: "/x", tasks_file: "t.json", orchestrator_session: null });
const wid = S.recordWorker(db, run.id, { task_id: "T1", attempt: 1, worker_cmd: "pi" });
const cap = S.captureNewSessions(db, run.id, wid, before);
assert.equal(cap.length, 2, "captured worker + subagent");
assert.equal(db.prepare("SELECT count(*) c FROM ab_captured_sessions WHERE run_id=?").get(run.id).c, 2);
assert.equal(db.prepare("SELECT count(*) c FROM ab_session_events").get().c, 5, "3 worker + 2 subagent events ingested");
assert.deepEqual(db.prepare("SELECT session_id FROM ab_captured_sessions ORDER BY session_id").all().map(r => r.session_id), ["aaaa-1111", "bbbb-2222"], "session ids extracted from session-type entry");
assert.equal(db.prepare("SELECT count(*) c FROM ab_session_events WHERE tool='bash'").get().c, 1, "tool name extracted from tool_use");
assert.equal(db.prepare("SELECT count(*) c FROM ab_captured_sessions WHERE worker_session_id=?").get(wid).c, 2, "both linked to the worker session");
S.endRun(db, run.id);
assert.ok(db.prepare("SELECT ended_at FROM ab_runs WHERE id=?").get(run.id).ended_at, "run ended_at recorded");
NODE

# --- test 2: disk-budget HALT (forced tiny budget) ---
mkdir -p "$W2/sessions"
printf '{"type":"session","id":"cccc-3333","timestamp":"2026-07-02T22:00:00Z"}\n' > "$W2/sessions/one.jsonl"
AUTOBUILD_DB="$W2/agent.db" AUTOBUILD_SESSIONS_DIR="$W2/sessions" AUTOBUILD_DISK_BUDGET_BYTES=10 TESTREPO="$REPO" \
"$NODE" - <<'NODE' || fail "budget HALT did not fire"
const S = require(process.env.TESTREPO + "/autobuild/sessions");
const db = S.initDb();
const run = S.startRun(db, { cwd: "/x", tasks_file: "t.json", orchestrator_session: null });
const wid = S.recordWorker(db, run.id, { task_id: "T1", attempt: 1, worker_cmd: "pi" });
let code = null;
try { S.captureNewSessions(db, run.id, wid, new Set()); }
catch (e) { code = e.code; }
if (code !== "BUDGET") { console.error("expected BUDGET throw, got code=" + code); process.exit(1); }
NODE

echo "OK autobuild-sessions (capture worker+subagent, full ingest, id/tool extraction, budget HALT — no LLM)"
