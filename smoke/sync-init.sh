#!/bin/bash
# smoke/sync-init.sh — REQ-S-3: `apple-pi sync init` wires a pi dir into a
# sync repo correctly, safely, and idempotently.
#
#   S-3.1  init on a fresh pi dir: git repo created, .gitignore written,
#         hook installed (core.hooksPath=.githooks, shim executable)
#   S-3.2  the portable set is committed, secrets are NOT (agent/auth.json,
#         sessions/, browser-profile/ absent from HEAD)
#   S-3.3  hook-run refuses a force-added secret (the shim path works)
#   S-3.4  init is idempotent (second run is a no-op, no error)
#   S-3.5  `apple-pi sync help` and unknown-subcommand exit sensibly
#
# No network: --no-push + gh masked out of PATH. Invokes the real bin/apple-pi
# wrapper (matches vault-onboarding.sh's CLI=(node bin/apple-pi …) pattern).

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."
# shellcheck disable=SC1091
source ./smoke/_lib.sh

command -v node >/dev/null 2>&1 || { fail "node required"; exit 1; }
command -v git  >/dev/null 2>&1 || { fail "git required"; exit 1; }
[[ -f sync/cli.js ]] || { fail "sync/cli.js missing"; exit 1; }
node --check sync/cli.js || { fail "sync/cli.js syntax"; exit 1; }
node --check sync/lib/repo.js || { fail "repo.js syntax"; exit 1; }

# Invoke the real bin/apple-pi wrapper (no quoting gymnastics — array form).
SYNC=(node --no-warnings bin/apple-pi sync)

# ---- synthetic pi dir ----
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/agent" "$TMP/skills/red" "$TMP/sessions" "$TMP/browser-profile" "$TMP/extensions/web"
echo '{}' > "$TMP/agent/AGENTS.md"
echo '{}' > "$TMP/agent/settings.json"
echo '{}' > "$TMP/skills/red/SKILL.md"
echo '{}' > "$TMP/extensions/voice.ts"
echo '{}' > "$TMP/extensions/web/index.ts"
echo 'KEY' > "$TMP/agent/auth.json"          # secret
echo 'x'   > "$TMP/sessions/a.jsonl"         # secret
echo 'x'   > "$TMP/.apple-pi-source"         # device-only

export PI_CODING_AGENT_DIR="$TMP"
# Mask ONLY `gh` (not its whole bin dir — node lives in the same dir on macOS).
# hasGh() returns false → init takes the no-remote path. No network in smoke.
GHBIN="$(command -v gh 2>/dev/null || true)"
if [ -n "$GHBIN" ]; then
	GHDIR="$(dirname "$GHBIN")"
	GHNAME="$(basename "$GHBIN")"
	MASK="$GHDIR/.${GHNAME}.smoke-masked"
	[ -e "$MASK" ] || mv "$GHBIN" "$MASK"
fi
trap 'rm -rf "$TMP"; [ -n "$GHBIN" ] && [ -e "$(dirname "$GHBIN")/.$(basename "$GHBIN").smoke-masked" ] && mv "$(dirname "$GHBIN")/.$(basename "$GHBIN").smoke-masked" "$GHBIN" 2>/dev/null || true' EXIT

header "S-3.1: init creates repo + gitignore + hook"
OUT="$("${SYNC[@]}" init --no-push --yes 2>&1)"
echo "$OUT" | grep -q "sync initialized" || { fail "init did not report success"; echo "$OUT"; exit 1; }
[[ -d "$TMP/.git" ]]                 || { fail ".git not created"; exit 1; }
[[ -f "$TMP/.gitignore" ]]           || { fail ".gitignore not written"; exit 1; }
[[ -x "$TMP/.githooks/pre-commit" ]] || { fail "hook shim not installed/executable"; exit 1; }
HP="$(git -C "$TMP" config --get core.hooksPath)"
[[ "$HP" == ".githooks" ]] || { fail "core.hooksPath='$HP' (want .githooks)"; exit 1; }
ok "S-3.1: repo + .gitignore + hook (hooksPath=.githooks)"

header "S-3.2: portable committed, secrets absent from HEAD"
# init committed already; ensure a git identity exists (init may need it).
git -C "$TMP" config user.email t@t.t 2>/dev/null || true
git -C "$TMP" config user.name t 2>/dev/null || true
# If init couldn't commit (no identity at init time), make the baseline commit now.
if [ -z "$(git -C "$TMP" rev-parse --short HEAD 2>/dev/null)" ]; then
	node --no-warnings -e "require('./sync/lib/repo').commitAll('$TMP','baseline')" >/dev/null 2>&1
fi
TRACKED="$(git -C "$TMP" ls-tree -r --name-only HEAD)"
echo "$TRACKED" | grep -qx "agent/AGENTS.md"     || { fail "AGENTS.md not in HEAD"; exit 1; }
echo "$TRACKED" | grep -qx "skills/red/SKILL.md" || { fail "skill not in HEAD"; exit 1; }
echo "$TRACKED" | grep -q "agent/auth.json"      && { fail "SECRET in HEAD: agent/auth.json"; exit 1; } || true
echo "$TRACKED" | grep -q "sessions/"            && { fail "SECRET in HEAD: sessions/"; exit 1; } || true
ok "S-3.2: portable in HEAD, secrets NOT ($(echo "$TRACKED" | wc -l | tr -d ' ') files)"

header "S-3.3: hook-run refuses a force-added secret (shim path)"
git -C "$TMP" add -f agent/auth.json 2>/dev/null
# hook-run resolves the repo via `git rev-parse --show-toplevel`, so it MUST
# run from inside the target repo (the real hook fires with CWD=repo).
RC=0; (cd "$TMP" && node --no-warnings "$SCRIPT_DIR/../bin/apple-pi" sync hook-run >/dev/null 2>&1) || RC=$?
git -C "$TMP" reset -q HEAD agent/auth.json 2>/dev/null || \
	git -C "$TMP" rm --cached -q --force agent/auth.json 2>/dev/null || true
[[ $RC -ne 0 ]] || { fail "hook-run did NOT refuse the secret (exit=$RC)"; exit 1; }
ok "S-3.3: hook-run refused secret (exit non-zero)"

header "S-3.3b: real `git commit` is blocked by the installed hook (end-to-end)"
git -C "$TMP" add -f agent/auth.json 2>/dev/null
COMMIT_RC=0; git -C "$TMP" commit -q -m "should-be-blocked" >/dev/null 2>&1 || COMMIT_RC=$?
git -C "$TMP" reset -q HEAD agent/auth.json 2>/dev/null || true
[[ $COMMIT_RC -ne 0 ]] || { fail "git commit was NOT blocked by the installed hook"; exit 1; }
ok "S-3.3b: real commit blocked by installed hook (exit non-zero)"

header "S-3.4: init is idempotent"
OUT2="$("${SYNC[@]}" init --no-push --yes 2>&1)"
echo "$OUT2" | grep -q "sync initialized" || { fail "second init failed"; echo "$OUT2"; exit 1; }
ok "S-3.4: second init is a no-op success"

header "S-3.5: help + unknown subcommand"
"${SYNC[@]}" help >/dev/null 2>&1 || { fail "help exited non-zero"; exit 1; }
RC=0; "${SYNC[@]}" bogus-subcommand >/dev/null 2>&1 || RC=$?
[[ $RC -eq 2 ]] || { fail "unknown cmd should exit 2 (got $RC)"; exit 1; }
ok "S-3.5: help ok, unknown → exit 2"

unset PI_CODING_AGENT_DIR
echo
echo "== smoke: sync-init DONE =="
