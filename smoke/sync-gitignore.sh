#!/bin/bash
# smoke/sync-gitignore.sh — REQ-S-2: gitignore generator + secret hook.
#
# Pins card S-2. The gitignore must be default-deny AND actually work under
# real git; the hook must block secrets by path AND by content.
#   S-2.1  generate() output is default-deny (starts with `*`, has `!*/`)
#   S-2.2  under REAL git, the generated gitignore tracks portable files and
#          IGNORES secret files (agent/auth.json, sessions/, browser-profile/)
#   S-2.3  runHook() blocks a staged secret path
#   S-2.4  runHook() blocks a staged file containing a real key shape
#   S-2.5  runHook() passes on a clean portable file
#
# Self-contained: synthetic pi dir + real `git init` in a temp dir.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."
source ./smoke/_lib.sh

command -v node >/dev/null 2>&1 || { fail "node required"; exit 1; }
command -v git  >/dev/null 2>&1 || { fail "git required"; exit 1; }
[[ -f sync/lib/gitignore.js ]] || { fail "gitignore.js missing"; exit 1; }
[[ -f sync/lib/hookrun.js ]]   || { fail "hookrun.js missing"; exit 1; }
[[ -f sync/lib/paths.js ]]     || { fail "paths.js missing"; exit 1; }

for j in sync/lib/gitignore.js sync/lib/hookrun.js sync/hook/pre-commit; do
	[[ "$j" == *.js ]] && { node --check "$j" || { fail "$j syntax"; exit 1; }; }
done
ok "S-2.0: node --check clean"

header "S-2.1: generate() is default-deny"
GI="$(node -e "const {classify}=require('./sync/lib/paths');const {generate}=require('./sync/lib/gitignore');process.stdout.write(generate(classify('${SCRIPT_DIR}/..')))" 2>/dev/null)"
# (classify on the apple-pi repo is fine — just needs a dir with no settings.json)
echo "$GI" | grep -qE '^\*$' || { fail "no top-level '*' ignore"; exit 1; }
echo "$GI" | grep -qE '^!\*/$' || { fail "no '!*/' traversal re-allow"; exit 1; }
echo "$GI" | grep -qE '^!/skills/$' || { fail "skills not allowlisted"; exit 1; }
echo "$GI" | grep -qE '^/agent/auth\.json$' || { fail "agent/auth.json not listed as secret"; exit 1; }
ok "S-2.1: default-deny with portable allowlist + secret intent"

# ---- real-git validation in a temp pi dir ----
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/agent" "$TMP/skills/red" "$TMP/sessions" "$TMP/browser-profile"
echo '{}' > "$TMP/agent/AGENTS.md"        # portable
echo '{}' > "$TMP/skills/red/SKILL.md"    # portable
echo 'KEY' > "$TMP/agent/auth.json"       # secret
echo 'x'   > "$TMP/sessions/a.jsonl"      # secret
echo 'x'   > "$TMP/.apple-pi-source"      # device-only

export PI_CODING_AGENT_DIR="$TMP"
node -e "const fs=require('fs');const {classify}=require('$SCRIPT_DIR/../sync/lib/paths');const {generate}=require('$SCRIPT_DIR/../sync/lib/gitignore');fs.writeFileSync('$TMP/.gitignore',generate(classify()))"

git -C "$TMP" init -q
git -C "$TMP" add -A
STAGED="$(git -C "$TMP" diff --cached --name-only)"

header "S-2.2: real git tracks portable, ignores secret"
echo "$STAGED" | grep -qx ".gitignore"        || { fail ".gitignore not tracked"; exit 1; }
echo "$STAGED" | grep -qx "agent/AGENTS.md"   || { fail "AGENTS.md not tracked"; exit 1; }
echo "$STAGED" | grep -qx "skills/red/SKILL.md" || { fail "skill not tracked"; exit 1; }
echo "$STAGED" | grep -q "agent/auth.json"    && { fail "agent/auth.json LEAKED into staging"; exit 1; } || true
echo "$STAGED" | grep -q "sessions/"          && { fail "sessions/ LEAKED"; exit 1; } || true
echo "$STAGED" | grep -q "browser-profile/"   && { fail "browser-profile LEAKED"; exit 1; } || true
ok "S-2.2: portable tracked, secret NOT tracked ($(echo "$STAGED" | wc -l | tr -d ' ') files staged)"

# Establish a HEAD so the S-2.3/S-2.4 `git reset HEAD <file>` unstaging works
# (in a HEAD-less repo `reset HEAD` silently fails and leaves secrets staged).
git -C "$TMP" config user.email t@t.t
git -C "$TMP" config user.name t
git -C "$TMP" commit -q -m baseline

header "S-2.3: runHook blocks a force-added secret path"
git -C "$TMP" add -f agent/auth.json 2>/dev/null
BLOCKED="$(node -e "process.chdir('$TMP');const {runHook}=require('$SCRIPT_DIR/../sync/lib/hookrun');const r=runHook();console.log(r.blocked?'BLOCKED':'PASS')" 2>&1)"
git -C "$TMP" reset -q HEAD agent/auth.json 2>/dev/null
[[ "$BLOCKED" == "BLOCKED" ]] || { fail "hook did NOT block force-added auth.json ($BLOCKED)"; exit 1; }
ok "S-2.3: secret path blocked"

header "S-2.4: runHook blocks a real key shape in content"
echo 'const k = "sk-ant-api03-'$(printf 'a%.0s' {1..40})'"' > "$TMP/skills/red/SKILL.md"
git -C "$TMP" add skills/red/SKILL.md
BLOCKED="$(node -e "process.chdir('$TMP');const {runHook}=require('$SCRIPT_DIR/../sync/lib/hookrun');const r=runHook();console.log(r.blocked?'BLOCKED':'PASS')" 2>&1)"
git -C "$TMP" reset -q HEAD skills/red/SKILL.md 2>/dev/null
echo '{}' > "$TMP/skills/red/SKILL.md"   # restore clean
[[ "$BLOCKED" == "BLOCKED" ]] || { fail "hook did NOT block key shape"; exit 1; }
ok "S-2.4: key shape blocked"

header "S-2.5: runHook passes a clean portable file"
git -C "$TMP" add skills/red/SKILL.md
PASSED="$(node -e "process.chdir('$TMP');const {runHook}=require('$SCRIPT_DIR/../sync/lib/hookrun');const r=runHook();console.log(r.blocked?'BLOCKED':'PASS')" 2>&1)"
[[ "$PASSED" == "PASS" ]] || { fail "hook blocked a clean file ($PASSED)"; exit 1; }
ok "S-2.5: clean portable passes"

unset PI_CODING_AGENT_DIR
echo
echo "== smoke: sync-gitignore DONE =="
