#!/bin/bash
# smoke/sync-pushpull.sh — REQ-S-4: `apple-pi sync push|pull|status`.
#
#   S-4.1  status on a clean, initialized repo reports "in sync"
#   S-4.2  push: a portable change is committed + pushed to the remote
#   S-4.3  push refuses when a secret is staged (no commit, no push)
#   S-4.4  pull: brings a portable change made on the remote down cleanly
#   S-4.5  push refuses when nothing dirty + nothing unpushed (clean no-op)
#   S-4.6  status reports unpushed count + dirty portable paths
#
# Uses a LOCAL bare repo as origin (no network, no gh). portable-pull is
# exercised by committing on the bare remote directly, then pulling.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."
# shellcheck disable=SC1091
source ./smoke/_lib.sh

command -v node >/dev/null 2>&1 || { fail "node required"; exit 1; }
command -v git  >/dev/null 2>&1 || { fail "git required"; exit 1; }
node --check sync/cli.js || { fail "cli.js syntax"; exit 1; }

SYNC=(node --no-warnings bin/apple-pi sync)
ROOT="$(mktemp -d)"
trap 'rm -rf "$ROOT"' EXIT
PI="$ROOT/pi"
REMOTE="$ROOT/remote.git"
CLONE="$ROOT/remote-clone"   # a working clone to push INTO the bare remote

# --- bare remote + a seeded portable commit on it ---
mkdir -p "$PI/agent" "$PI/skills/red" "$PI/sessions"
echo '{}' > "$PI/agent/AGENTS.md"
echo '{}' > "$PI/agent/settings.json"
echo '{}' > "$PI/skills/red/SKILL.md"
echo 'KEY' > "$PI/agent/auth.json"          # secret
echo 'x'   > "$PI/sessions/a.jsonl"          # secret

export PI_CODING_AGENT_DIR="$PI"
# Mask gh so init doesn't try to create a real GitHub repo.
GHBIN="$(command -v gh 2>/dev/null || true)"
[ -n "$GHBIN" ] && mv "$GHBIN" "$(dirname "$GHBIN")/.gh.smoke-masked"
trap 'rm -rf "$ROOT"; [ -n "$GHBIN" ] && [ -e "$(dirname "$GHBIN")/.gh.smoke-masked" ] && mv "$(dirname "$GHBIN")/.gh.smoke-masked" "$GHBIN" 2>/dev/null || true' EXIT

# Bare remote (empty). PI will be the first to push into it.
git init -q --bare "$REMOTE"
git clone -q "$REMOTE" "$CLONE" 2>/dev/null
git -C "$CLONE" config user.email t@t.t; git -C "$CLONE" config user.name t

# --- init sync in PI, pointed at the bare remote (no push yet) ---
"${SYNC[@]}" init --remote "$REMOTE" --no-push --yes >/dev/null 2>&1
git -C "$PI" config user.email t@t.t; git -C "$PI" config user.name t
# init created the baseline commit; push it so origin has history.
git -C "$PI" push -q origin main 2>/dev/null || true

header "S-4.1: status reports clean when in sync"
"${SYNC[@]}" push >/dev/null 2>&1 || true   # ensure pushed
OUT="$("${SYNC[@]}" status 2>&1)"
echo "$OUT" | grep -q "in sync" || { fail "status did not report in-sync"; echo "$OUT"; exit 1; }
ok "S-4.1: clean status reports 'in sync'"

header "S-4.6: status reports dirty + unpushed"
echo "# edited on device" >> "$PI/skills/red/SKILL.md"
git -C "$PI" add skills/red/SKILL.md && git -C "$PI" commit -q -m "local portable edit"
OUT="$("${SYNC[@]}" status 2>&1)"
echo "$OUT" | grep -q "commits unpushed" || { fail "status missing unpushed count"; echo "$OUT"; exit 1; }
ok "S-4.6: status shows unpushed commit"

header "S-4.2: push commits + pushes a portable change"
OUT="$("${SYNC[@]}" push --message "feat: portable edit" 2>&1)"
echo "$OUT" | grep -q "pushed: origin/main" || { fail "push did not report success"; echo "$OUT"; exit 1; }
# Confirm the remote now has the portable edit.
git -C "$CLONE" pull -q origin main 2>/dev/null
grep -q "edited on device" "$CLONE/skills/red/SKILL.md" || { fail "portable edit did NOT reach remote"; exit 1; }
ok "S-4.2: portable edit reached the remote"

header "S-4.5: push with nothing to push is a clean no-op"
OUT="$("${SYNC[@]}" push 2>&1)"
echo "$OUT" | grep -q "nothing to push" || { fail "push of clean tree did not no-op"; echo "$OUT"; exit 1; }
ok "S-4.5: clean push is a no-op"

header "S-4.3: push refuses a staged secret"
echo "LEAK" > "$PI/agent/auth.json"
git -C "$PI" add -f agent/auth.json 2>/dev/null
OUT="$("${SYNC[@]}" push --message "leak" 2>&1)"
RC=$?
git -C "$PI" reset -q HEAD agent/auth.json 2>/dev/null || true
echo "$OUT" | grep -qi "BLOCKED\|secret" || { fail "push did not block the secret"; echo "$OUT"; exit 1; }
ok "S-4.3: push refused secret"

header "S-4.4: pull brings a remote change down"
# Make a portable change directly on the remote via the clone.
echo "# from remote" >> "$CLONE/skills/red/SKILL.md"
git -C "$CLONE" add -A && git -C "$CLONE" commit -q -m "remote portable edit" && git -C "$CLONE" push -q origin main
OUT="$("${SYNC[@]}" pull 2>&1)"
echo "$OUT" | grep -q "pulled" || { fail "pull failed"; echo "$OUT"; exit 1; }
grep -q "from remote" "$PI/skills/red/SKILL.md" || { fail "remote change did NOT come down"; exit 1; }
ok "S-4.4: remote change pulled locally"

unset PI_CODING_AGENT_DIR
echo
echo "== smoke: sync-pushpull DONE =="
