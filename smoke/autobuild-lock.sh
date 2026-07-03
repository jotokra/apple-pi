#!/usr/bin/env bash
# smoke/autobuild-lock.sh — deterministic test of the single-instance lock.
# No timing races: (A) a LIVE holder PID -> second run must exit 2; (B) a DEAD
# (stale) holder PID -> lock is stolen and the run succeeds. Proves the atomic
# O_EXCL acquire + stale-PID detection (the fix for the existsSync->write race
# that let overlapping fires double-run).
set -uo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE="${NODE:-$(command -v node)}"
W="$(mktemp -d)"; mkdir -p "$W/.ab"
trap 'rm -rf "$W"' EXIT
fail() { echo "FAIL autobuild-lock: $*" >&2; exit 1; }
echo '{"tasks":[{"id":"T1","title":"t","spec":"s","verify":"true","commit":"c","depends_on":[],"needs_review":false}]}' > "$W/tasks.json"
run() { ( cd "$W" && AUTOBUILD_TASKS="$W/tasks.json" AUTOBUILD_STATE="$W/.ab" AUTOBUILD_DB="$W/db.sqlite" AUTOBUILD_REGRESSION="" "$NODE" "$REPO/autobuild/orchestrator.js" --dry-run >/dev/null 2>&1 ); }

# (A) lock held by a LIVE pid (this shell) -> run must refuse with exit 2
echo "$$" > "$W/.ab/.lock"
run; rc=$?; [[ $rc -eq 2 ]] || fail "live-holder: expected exit 2, got $rc"
rm -f "$W/.ab/.lock"

# (B) lock held by a DEAD pid (stale, e.g. after a SIGKILL) -> stolen, run exit 0
echo "999999" > "$W/.ab/.lock"
run; rc=$?; [[ $rc -eq 0 ]] || fail "stale-holder: expected exit 0 (steal), got $rc"
[[ ! -e "$W/.ab/.lock" ]] || fail "stale lock should have been acquired then released"

echo "OK autobuild-lock (atomic O_EXCL: live->exit2, stale->steal)"
