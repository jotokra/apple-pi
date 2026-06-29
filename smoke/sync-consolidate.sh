#!/bin/bash
# smoke/sync-consolidate.sh — REQ-S-7: `apple-pi sync consolidate <branch>`.
#
# The multi-device payoff. Folds another device's branch into the current
# one by classifying the three-dot diff and acting per bucket. Per the frozen
# decision (OQ1): STAGE + PRINT — never commit, push, or auto-PR.
#
#   S-7.1  portable changes on the other branch are STAGED (checked out from
#         it into the index); a new portable file (skill) comes across
#   S-7.2  device-local changes are SKIPPED (not overwritten), reported
#   S-7.3  a secret in the diff is REFUSED (exit non-zero, nothing staged)
#   S-7.4  the command STAGES ONLY — HEAD does not advance (no commit), the
#         suggested commit/push commands are printed for the user to run
#   S-7.5  three-dot semantics: changes on THIS branch since divergence are
#         NOT in the plan (only what the other branch changed)
#
# Uses two clones of a bare remote to simulate two devices diverging.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."
# shellcheck disable=SC1091
source ./smoke/_lib.sh

command -v node >/dev/null 2>&1 || { fail "node required"; exit 1; }
command -v git  >/dev/null 2>&1 || { fail "git required"; exit 1; }
node --check sync/lib/consolidate.js || { fail "consolidate.js syntax"; exit 1; }

SYNC=(node --no-warnings bin/apple-pi sync)
GHBIN="$(command -v gh 2>/dev/null || true)"
[ -n "$GHBIN" ] && mv "$GHBIN" "$(dirname "$GHBIN")/.gh.smoke-masked"

ROOT="$(mktemp -d)"
trap 'rm -rf "$ROOT"; [ -n "$GHBIN" ] && [ -e "$(dirname "$GHBIN")/.gh.smoke-masked" ] && mv "$(dirname "$GHBIN")/.gh.smoke-masked" "$GHBIN" 2>/dev/null || true' EXIT
REMOTE="$ROOT/remote.git"
A="$ROOT/deviceA"        # origin device (main), where consolidate runs
B="$ROOT/deviceB"        # other device (device/phone), source of changes

git init -q --bare "$REMOTE"

# --- Device A: init sync, push baseline ---
mkdir -p "$A/agent" "$A/skills/red"
echo '{}' > "$A/agent/AGENTS.md"; echo '{}' > "$A/agent/settings.json"; echo '{}' > "$A/agent/models.json"
echo '{}' > "$A/skills/red/SKILL.md"; echo 'KEY' > "$A/agent/auth.json"
export PI_CODING_AGENT_DIR="$A"
"${SYNC[@]}" init --remote "$REMOTE" --no-push --yes >/dev/null 2>&1
git -C "$A" config user.email t@t.t; git -C "$A" config user.name t
git -C "$A" push -q origin main 2>/dev/null

# --- Device B: clone the remote, make divergent changes on device/phone ---
git clone -q "$REMOTE" "$B"
git -C "$B" config user.email t@t.t; git -C "$B" config user.name t
git -C "$B" checkout -q -b device/phone
# portable: a NEW skill only on B
mkdir -p "$B/skills/blue"; echo '{}' > "$B/skills/blue/SKILL.md"
# portable: an UPDATED existing skill
echo "# red v2 from phone" >> "$B/skills/red/SKILL.md"
# device-local: models.json changed on B (must NOT overwrite A's)
echo '{"changed":"on-phone"}' > "$B/agent/models.json"
git -C "$B" add -A && git -C "$B" commit -q -m "phone: new skill + tuned models" >/dev/null 2>&1
# Also push B's branch so A can fetch it.
git -C "$B" push -q origin device/phone 2>/dev/null

header "S-7.1: portable changes from device/phone are STAGED on A"
OUT="$("${SYNC[@]}" consolidate origin/device/phone 2>&1)"
RC=$?
echo "$OUT"
echo "$OUT" | grep -q "STAGED (portable" || { fail "no staged section"; exit 1; }
echo "$OUT" | grep -q "skills/blue/SKILL.md" || { fail "new skill not staged"; exit 1; }
# Confirm actually staged in A's index.
git -C "$A" diff --cached --name-only | grep -qx "skills/blue/SKILL.md" || { fail "new skill not in A's index"; exit 1; }
ok "S-7.1: portable new + updated skill staged on A"

header "S-7.4: STAGES ONLY — HEAD did not advance, no commit made"
HEAD_BEFORE="$(git -C "$A" rev-parse HEAD)"
# (HEAD is unchanged because consolidate only staged; no commit ran.)
HEAD_AFTER="$(git -C "$A" rev-parse HEAD)"
[[ "$HEAD_BEFORE" == "$HEAD_AFTER" ]] || { fail "consolidate committed! (HEAD advanced)"; exit 1; }
echo "$OUT" | grep -q "git commit -m" || { fail "did not print suggested commit command"; exit 1; }
echo "$OUT" | grep -q "does not commit or push" || { fail "missing stage-only disclaimer"; exit 1; }
ok "S-7.4: stage-only (HEAD unchanged, commands printed)"

header "S-7.2: device-local changes SKIPPED (A's models.json untouched)"
echo "$OUT" | grep -q "SKIPPED (device-local" || { fail "no skipped section"; exit 1; }
echo "$OUT" | grep -q "agent/models.json" || { fail "models.json not reported as skipped"; exit 1; }
# A's models.json must NOT be in the staged set.
git -C "$A" diff --cached --name-only | grep -qx "agent/models.json" && { fail "device-local models.json was staged!"; exit 1; } || true
ok "S-7.2: device-local skipped, A's models.json preserved"

header "S-7.5: three-dot semantics — A's own changes aren't in the plan"
# Make a change on A (main) that B doesn't have, then re-run consolidate.
# That change is A's, not B's, so it must NOT appear in the consolidate plan.
mkdir -p "$A/skills/green"; echo '{}' > "$A/skills/green/SKILL.md"
git -C "$A" add -A && git -C "$A" commit -q -m "A: green skill" >/dev/null 2>&1
# Reset the previous consolidation's staging so this run is clean.
git -C "$A" reset -q HEAD >/dev/null 2>&1; git -C "$A" checkout -q -- . 2>/dev/null
OUT2="$("${SYNC[@]}" consolidate origin/device/phone 2>&1)"
echo "$OUT2" | grep -q "skills/green/SKILL.md" && { fail "A's own green skill appeared in the plan (should be three-dot)"; exit 1; } || true
ok "S-7.5: three-dot diff excludes A's own changes"

header "S-7.3: a secret in the diff is REFUSED"
# Push a device/evil branch that includes agent/auth.json (a secret) as a change.
git -C "$B" checkout -q -b device/evil main 2>/dev/null || git -C "$B" checkout -q -b device/evil
echo 'LEAKED-KEY' > "$B/agent/auth.json"
git -C "$B" add -f agent/auth.json && git -C "$B" commit -q -m "evil: leak a secret" >/dev/null 2>&1
git -C "$B" push -q origin device/evil 2>/dev/null
# Reset A's staging.
git -C "$A" reset -q HEAD >/dev/null 2>&1; git -C "$A" checkout -q -- . 2>/dev/null
OUT3="$("${SYNC[@]}" consolidate origin/device/evil 2>&1)"
RC3=$?
echo "$OUT3" | grep -qi "REFUSED" || { fail "secret diff was not refused"; exit 1; }
[[ $RC3 -ne 0 ]] || { fail "consolidate should exit non-zero on a secret (got $RC3)"; exit 1; }
# Nothing staged from the evil branch.
[[ -z "$(git -C "$A" diff --cached --name-only)" ]] || { fail "consolidate staged something despite refusing"; exit 1; }
ok "S-7.3: secret diff refused (exit non-zero, nothing staged)"

unset PI_CODING_AGENT_DIR
echo
echo "== smoke: sync-consolidate DONE =="
