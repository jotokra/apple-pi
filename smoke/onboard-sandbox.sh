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

# Feed the new P1 prompts in order. Use 'gpt-4o' so the provider matcher wires
# openai automatically (exercises D7 BUG A fix), and supply a custom base URL so
# models.json is written (exercises D7 BUG B fix). --skip-confirm bypasses the
# required live connection check (TEST ONLY) since the sandbox key is fake.
#   Proceed(y) · Model(gpt-4o) · Open guide?(n) · API key · base URL · Pass · Confirm
printf 'y\ngpt-4o\nn\nsandbox-key-SECRET123\nhttps://gateway.example/v1\nsb-passphrase\nsb-passphrase\n' \
	| bash install.sh --sandbox "$SANDBOX" --skip-confirm --no-handoff >/tmp/applepi-sandbox.out 2>&1 \
	|| { fail "install.sh exited non-zero"; cat /tmp/applepi-sandbox.out; exit 1; }

header "config tree copied"
for d in skills prompts extensions agent; do
	[[ -d "$SANDBOX/$d" ]] || { fail "missing $SANDBOX/$d"; exit 1; }
done
count=$(find "$SANDBOX/skills" -name SKILL.md | wc -l | tr -d ' ')
[[ "$count" -eq 10 ]] || { fail "expected 10 skills copied, got $count"; exit 1; }
ok "10 skills + prompts + extensions copied"

header "settings.json rendered (internal seed; carries _applepi_seed marker)"
SETTINGS="$SANDBOX/agent/settings.json"
[[ -f "$SETTINGS" ]] || { fail "missing $SETTINGS"; exit 1; }
if command -v jq >/dev/null 2>&1; then
	jq -e '.defaultModel == "gpt-4o"' "$SETTINGS" >/dev/null || { fail "defaultModel not set (got: $(jq -r .defaultModel "$SETTINGS"))"; exit 1; }
	jq -e '._applepi_seed == true' "$SETTINGS" >/dev/null \
		|| { fail "rendered seed missing _applepi_seed marker (D1 contract)"; exit 1; }
elif command -v node >/dev/null 2>&1; then
	node -e "const s=JSON.parse(require('fs').readFileSync('$SETTINGS','utf8'));if(s.defaultModel!=='gpt-4o'||s._applepi_seed!==true)process.exit(1)" \
		|| { fail "defaultModel or _applepi_seed marker wrong"; exit 1; }
fi
ok "settings.json = internal seed (defaultModel=gpt-4o + _applepi_seed); P3 rewrites it clean"

info "NOTE: the clean-user-config state (no _applepi_seed, no _comment) is P3's job"
info "      and needs a live model run; the sandbox only proves the seed is correct."

header "auth.json seeded + 0600 (correct pi shape, BUG A fix)"
AUTH="$SANDBOX/agent/auth.json"
[[ -f "$AUTH" ]] || { fail "missing $AUTH"; exit 1; }
# D7 BUG A fix: pi's loader needs {provider:{type:"api_key",key}}, NOT {provider:{apiKey}}.
if command -v jq >/dev/null 2>&1; then
	jq -e '.openai.type == "api_key" and .openai.key' "$AUTH" >/dev/null || { fail "auth.json wrong shape (need openai.{type:key}, got: $(cat "$AUTH"))"; exit 1; }
elif command -v node >/dev/null 2>&1; then
	node -e "const a=JSON.parse(require('fs').readFileSync('$AUTH','utf8'));if(a.openai?.type!=='api_key'||!a.openai?.key)process.exit(1)" || { fail "auth.json wrong shape (need openai.{type:key})"; exit 1; }
fi
# Mode check (macOS vs Linux).
if stat -f "%Lp" "$AUTH" >/dev/null 2>&1; then MODE="$(stat -f "%Lp" "$AUTH")"; else MODE="$(stat -c "%a" "$AUTH")"; fi
[[ "$MODE" == "600" ]] || { fail "auth.json mode is $MODE (expected 600)"; exit 1; }
ok "auth.json valid ({openai:{type:api_key,key}}), mode 600"

header "models.json written for custom base URL (BUG B fix)"
MODELS="$SANDBOX/agent/models.json"
[[ -f "$MODELS" ]] || { fail "missing $MODELS (custom base URL should produce one)"; exit 1; }
if command -v jq >/dev/null 2>&1; then
	jq -e '.providers.openai.baseUrl == "https://gateway.example/v1"' "$MODELS" >/dev/null || { fail "models.json baseUrl wrong: $(cat "$MODELS")"; exit 1; }
elif command -v node >/dev/null 2>&1; then
	node -e "const m=JSON.parse(require('fs').readFileSync('$MODELS','utf8'));if(m.providers?.openai?.baseUrl!=='https://gateway.example/v1')process.exit(1)" || { fail "models.json baseUrl wrong"; exit 1; }
fi
ok "models.json wires openai → https://gateway.example/v1"

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
