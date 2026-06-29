#!/bin/bash
# smoke/sync-doctor.sh — REQ-S-5: `apple-pi sync doctor` health + history scan.
#
#   S-5.1  doctor on a healthy repo: all checks pass (repo, remote, hook,
#         no drift, no history findings)
#   S-5.2  doctor WARNS when the hook is disabled (hooksPath unset)
#   S-5.3  doctor FAILS + reports when a real key shape is in git history
#         (the deep check the pre-commit hook structurally can't do — it
#         only fires on NEW commits, so a secret committed before the hook
#         existed, or force-pushed around it, must be caught here)
#   S-5.4  scanHistory is pure: clean history → zero findings
#
# Uses a synthetic pi dir; no network, no gh. History leak is simulated by
# committing a key-shaped string, then rewriting it out of the working tree
# (so it's only in history, exactly the real-world failure mode).

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."
# shellcheck disable=SC1091
source ./smoke/_lib.sh

command -v node >/dev/null 2>&1 || { fail "node required"; exit 1; }
command -v git  >/dev/null 2>&1 || { fail "git required"; exit 1; }
node --check sync/cli.js || { fail "cli.js syntax"; exit 1; }
node --check sync/lib/hookrun.js || { fail "hookrun.js syntax"; exit 1; }

SYNC=(node --no-warnings bin/apple-pi sync)
GHBIN="$(command -v gh 2>/dev/null || true)"
[ -n "$GHBIN" ] && mv "$GHBIN" "$(dirname "$GHBIN")/.gh.smoke-masked"

ROOT="$(mktemp -d)"
trap 'rm -rf "$ROOT"; [ -n "$GHBIN" ] && [ -e "$(dirname "$GHBIN")/.gh.smoke-masked" ] && mv "$(dirname "$GHBIN")/.gh.smoke-masked" "$GHBIN" 2>/dev/null || true' EXIT
PI="$ROOT/pi"
REMOTE="$ROOT/remote.git"

mkdir -p "$PI/agent" "$PI/skills/red" "$PI/sessions"
echo '{}' > "$PI/agent/AGENTS.md"
echo '{}' > "$PI/agent/settings.json"
echo '{}' > "$PI/agent/models.json"
echo '{}' > "$PI/skills/red/SKILL.md"
echo 'KEY' > "$PI/agent/auth.json"          # secret (gitignored)
echo 'x'   > "$PI/sessions/a.jsonl"

export PI_CODING_AGENT_DIR="$PI"
git init -q --bare "$REMOTE"
"${SYNC[@]}" init --remote "$REMOTE" --no-push --yes >/dev/null 2>&1
git -C "$PI" config user.email t@t.t; git -C "$PI" config user.name t

header "S-5.4: scanHistory on clean history → zero findings"
FIND="$(node --no-warnings -e "console.log(require('./sync/lib/hookrun').scanHistory('$PI').length)")"
[[ "$FIND" == "0" ]] || { fail "scanHistory found $FIND in a clean repo"; exit 1; }
ok "S-5.4: clean history → 0 findings"

header "S-5.1: doctor on a healthy repo → all pass"
# Reinstall hook to be sure it's active.
node --no-warnings -e "require('./sync/lib/repo').ensureHook('$PI')" >/dev/null 2>&1
OUT="$("${SYNC[@]}" doctor 2>&1)"
RC=$?
echo "$OUT" | grep -qi "FAIL" && { fail "healthy doctor reported FAIL"; echo "$OUT"; exit 1; } || true
echo "$OUT" | grep -q "no provider key shapes in git history" || { fail "missing history-scan OK line"; exit 1; }
ok "S-5.1: healthy doctor passes (exit $RC)"

header "S-5.2: doctor WARNS when hook disabled"
git -C "$PI" config --unset core.hooksPath
OUT="$("${SYNC[@]}" doctor 2>&1)"
echo "$OUT" | grep -qi "hook NOT active" || { fail "doctor did not warn on disabled hook"; echo "$OUT"; exit 1; }
# restore hook for the next check
node --no-warnings -e "require('./sync/lib/repo').ensureHook('$PI')" >/dev/null 2>&1
ok "S-5.2: doctor warns on disabled hook"

header "S-5.3: doctor FAILS when a key shape is in git history"
# Commit a key-shaped string into a PORTABLE file, then overwrite it in the
# working tree + commit again — so the key lives ONLY in history (the real
# failure mode: committed before the hook existed, or force-pushed around it).
# We commit the leak with the hook BYPASSED (-c core.hooksPath=) because that's
# exactly the scenario: the hook can't stop a commit it wasn't present for.
KEYFILE="$PI/skills/red/SKILL.md"
printf -- '---\nname: red\ndescription: x\n---\n# red\n\nKEY = sk-ant-api03-%s\n' "$(printf 'b%.0s' {1..40})" > "$KEYFILE"
git -C "$PI" add skills/red/SKILL.md
git -C "$PI" -c core.hooksPath=/dev/null commit -q -m "accidentally commit a key"
# Now overwrite + recommit (hook active), so the key is only in the parent blob.
echo "---" > "$KEYFILE"; echo "name: red" >> "$KEYFILE"
git -C "$PI" add skills/red/SKILL.md && git -C "$PI" commit -q -m "rewrite the key out"
OUT="$("${SYNC[@]}" doctor 2>&1)"
RC=$?
echo "$OUT" | grep -qi "potential key-shape finding" || { fail "doctor did NOT find the history leak"; echo "$OUT"; exit 1; }
[[ $RC -ne 0 ]] || { fail "doctor should exit non-zero on a history leak (got $RC)"; exit 1; }
ok "S-5.3: doctor caught the history-only key leak (exit non-zero)"

unset PI_CODING_AGENT_DIR
echo
echo "== smoke: sync-doctor DONE =="
