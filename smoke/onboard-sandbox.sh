#!/bin/bash
# smoke/onboard-sandbox.sh — run the full P1 onboarding flow against a
# throwaway PI_CODING_AGENT_DIR. Never touches ~/.pi. Verifies:
#   - config tree copied (skills/prompts/extensions)
#   - settings.json rendered with the model
#   - auth.json seeded, valid JSON, mode 0600
#   - onboarding.vault + .onboarding/ DESTROYED after purge
#   - the API key survives ONLY in auth.json (nowhere else)
# (Confirm + handoff are skipped via flags; those need a real key.)

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$SCRIPT_DIR/.."
cd "$REPO"
# shellcheck disable=SC1091
source ./smoke/_lib.sh

require openssl
command -v pi >/dev/null 2>&1 || { warn "pi not on PATH — sandbox smoke needs the binary present"; exit 0; }

SANDBOX="$(mktemp -d)"
trap 'rm -rf "$SANDBOX"' EXIT
info "sandbox: $SANDBOX"

# Feed the 7 prompts in order. --skip-confirm avoids a real API call.
printf 'y\nsandbox-model\n\nsandbox-key-SECRET123\n\nsb-passphrase\nsb-passphrase\n' \
	| bash install.sh --sandbox "$SANDBOX" --skip-confirm --no-handoff >/tmp/applepi-sandbox.out 2>&1 \
	|| { fail "install.sh exited non-zero"; cat /tmp/applepi-sandbox.out; exit 1; }

header "config tree copied"
for d in skills prompts extensions agent; do
	[[ -d "$SANDBOX/$d" ]] || { fail "missing $SANDBOX/$d"; exit 1; }
done
count=$(find "$SANDBOX/skills" -name SKILL.md | wc -l | tr -d ' ')
[[ "$count" -eq 8 ]] || { fail "expected 8 skills copied, got $count"; exit 1; }
ok "8 skills + prompts + extensions copied"

header "settings.json rendered (model, not purged)"
SETTINGS="$SANDBOX/agent/settings.json"
[[ -f "$SETTINGS" ]] || { fail "missing $SETTINGS"; exit 1; }
if command -v jq >/dev/null 2>&1; then
	jq -e '.defaultModel == "sandbox-model"' "$SETTINGS" >/dev/null || { fail "defaultModel not set"; exit 1; }
elif command -v node >/dev/null 2>&1; then
	node -e "const s=JSON.parse(require('fs').readFileSync('$SETTINGS','utf8'));if(s.defaultModel!=='sandbox-model')process.exit(1)" || { fail "defaultModel not set"; exit 1; }
fi
ok "settings.json defaultModel=sandbox-model"

header "auth.json seeded + 0600"
AUTH="$SANDBOX/agent/auth.json"
[[ -f "$AUTH" ]] || { fail "missing $AUTH"; exit 1; }
if command -v jq >/dev/null 2>&1; then
	jq -e '.openai.apiKey' "$AUTH" >/dev/null || { fail "auth.json missing openai.apiKey"; exit 1; }
elif command -v node >/dev/null 2>&1; then
	node -e "const a=JSON.parse(require('fs').readFileSync('$AUTH','utf8'));if(!a.openai||!a.openai.apiKey)process.exit(1)" || { fail "auth.json shape"; exit 1; }
fi
# Mode check (macOS vs Linux).
if stat -f "%Lp" "$AUTH" >/dev/null 2>&1; then MODE="$(stat -f "%Lp" "$AUTH")"; else MODE="$(stat -c "%a" "$AUTH")"; fi
[[ "$MODE" == "600" ]] || { fail "auth.json mode is $MODE (expected 600)"; exit 1; }
ok "auth.json valid, mode 600"

header "bootstrap secrets DESTROYED"
[[ ! -e "$SANDBOX/onboarding.vault" ]] || { fail "onboarding.vault still exists (not purged!)"; exit 1; }
[[ ! -e "$SANDBOX/.onboarding" ]]     || { fail ".onboarding/ still exists (not purged!)"; exit 1; }
ok "vault + scratch purged"

header "API key survives ONLY in auth.json"
hits=$(grep -rl "sandbox-key-SECRET123" "$SANDBOX" 2>/dev/null | sort)
count=$(printf '%s\n' "$hits" | grep -c . )
if [[ "$count" -eq 1 ]] && [[ "$hits" == "$AUTH" ]]; then
	ok "key present only in auth.json"
else
	fail "key found in unexpected places:"; printf '%s\n' "$hits" | sed 's/^/    /'
	exit 1
fi

header "source marker"
[[ -f "$SANDBOX/.apple-pi-source" ]] || { fail "missing .apple-pi-source"; exit 1; }
ok "source recorded"

echo
ok "onboard-sandbox: full P1 flow + purge verified"
