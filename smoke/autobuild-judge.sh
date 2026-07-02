#!/usr/bin/env bash
# smoke/autobuild-judge.sh — deterministic test of the autobuild JUDGE.
# No LLM: a fake worker stands in for the agent. Verifies, with zero model
# dependency, that the orchestrator correctly:
#   - selects the next dep-satisfied task
#   - judges by re-running `verify` (not by trusting the worker)
#   - commits on green, regression-clean
#   - retries red, then marks blocked and HALTS (exit != 0)
#   - is resumable (a re-run does not redo done tasks or retry blocked ones)
set -uo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE="${NODE:-$(command -v node)}"

WORK="$(mktemp -d)"; STATE="$(mktemp -d)"
trap 'rm -rf "$WORK" "$STATE"' EXIT
fail() { echo "FAIL autobuild-judge: $*" >&2; exit 1; }

# --- a scratch git project ---
git -C "$WORK" init -q
git -C "$WORK" config user.email autobuild@test
git -C "$WORK" config user.name autobuild-test

# --- fake worker: creates the artifact for GREEN-* tasks; no-op for RED-* ---
cat > "$WORK/worker.sh" <<'W'
case "$AUTOBUILD_TASK_ID" in
	*GREEN*) mkdir -p out && touch "out/$AUTOBUILD_TASK_ID" ;;   # makes verify pass
esac
# RED-* intentionally does nothing -> verify fails -> retry -> blocked
W

# --- task queue: a green path then a red path ---
cat > "$WORK/autobuild.tasks.json" <<'J'
{ "tasks": [
  { "id": "GREEN-T", "module": "t", "title": "green path", "spec": "s", "req": "r",
    "verify": "test -f out/GREEN-T", "commit": "feat(t): green (GREEN-T)",
    "depends_on": [], "needs_review": false },
  { "id": "RED-T", "module": "t", "title": "red path", "spec": "s", "req": "r",
    "verify": "test -f out/RED-T", "commit": "feat(t): red (RED-T)",
    "depends_on": ["GREEN-T"], "needs_review": false }
] }
J

run_orch() {
	( cd "$WORK" && AUTOBUILD_TASKS="$WORK/autobuild.tasks.json" \
		AUTOBUILD_STATE="$STATE" AUTOBUILD_DB="$STATE/db.sqlite" AUTOBUILD_WORKER="bash $WORK/worker.sh" \
		AUTOBUILD_REGRESSION="" AUTOBUILD_RETRY_CAP=2 \
		"$NODE" "$REPO/autobuild/orchestrator.js" )
}

# --- run 1: GREEN-T should commit + go done; RED-T should block + HALT ---
run_orch > "$STATE/run1.log" 2>&1; RC=$?
[[ $RC -ne 0 ]] || fail "run 1 should HALT (non-zero) on the blocked RED-T, got exit $RC"
git -C "$WORK" log --oneline | grep -q "GREEN-T" || fail "GREEN-T was not committed"
git -C "$WORK" log --oneline | grep -q "RED-T" && fail "RED-T must NOT be committed (it never went green)"
"$NODE" -e 'const p=require(process.argv[1]); if(!(p["GREEN-T"].status==="done"&&p["RED-T"].status==="blocked")) process.exit(1)' "$STATE/progress.json" \
	|| fail "progress wrong (want GREEN-T=done, RED-T=blocked)"
grep -qi "blocked" "$STATE/BUILD.md" || fail "BUILD.md should list RED-T as blocked"

# --- run 2: resumability — must not redo GREEN-T or retry RED-T; clean exit ---
BEFORE="$(git -C "$WORK" rev-parse HEAD)"
run_orch > "$STATE/run2.log" 2>&1; RC2=$?
AFTER="$(git -C "$WORK" rev-parse HEAD)"
[[ "$BEFORE" = "$AFTER" ]] || fail "run 2 must not create new commits (resumable) — HEAD moved"
[[ $RC2 -eq 0 ]] || fail "run 2 should exit 0 (nothing pending), got $RC2"
"$NODE" -e 'const p=require(process.argv[1]); if(p["GREEN-T"].attempts!==1) process.exit(1)' "$STATE/progress.json" \
	|| fail "resumability broken: GREEN-T attempts should stay 1, not increment"

echo "OK autobuild-judge (green-commit + red-block-halt + resumable, no LLM)"
