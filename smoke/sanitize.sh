#!/bin/bash
# smoke/sanitize.sh — enforce the no-personal-information contract.
# Greps every shipped file for the author's personal identifiers.
# Exit non-zero if any forbidden token is found. Tripwire for D5.
# Portable (no mapfile — works on macOS bash 3.2).

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."
# shellcheck disable=SC1091
source ./smoke/_lib.sh

# Forbidden tokens — author's personal identifiers that must NEVER ship.
FORBIDDEN=(
	'mini\.lan'
	'n8n\.mini\.lan'
	'git\.mini\.lan'
	'llm\.mini\.lan'
	'hermes\.mini\.lan'
	'services\.mini\.lan'
	'192\.168\.1\.185'
	'100\.103\.227\.173'
	'100\.103\.'
	'jkit-consulting'
	'1004486302260'
	'/Users/jay'
	'Hermes-Vault'
	'ZAI_API_KEY'
	'INTERNAL_TOKEN'
	'\.hermes/'
	'\bHermes\b'
	'\bAether\b'
	'\bGLM-5\.2\b'
	'\bglm-5\.2\b'
	'\bzai\b'
)

# Explicit shipped surface (none of these contain a .git dir).
SCAN_PATHS=(config lib install.sh README.md LICENSE .docs)

header "sanitize: scanning ${SCAN_PATHS[*]}"
for p in "${SCAN_PATHS[@]}"; do
	[[ -e "$p" ]] || { fail "scan path missing: $p"; exit 1; }
done

VIOLATIONS=0
for tok in "${FORBIDDEN[@]}"; do
	while IFS= read -r hit; do
		[[ -z "$hit" ]] && continue
		fail "forbidden token /$tok/ → $hit"
		VIOLATIONS=$((VIOLATIONS + 1))
	done < <(grep -rnE --exclude-dir=node_modules "$tok" "${SCAN_PATHS[@]}" 2>/dev/null)
done

# Assert the template uses placeholders (not concrete model/provider defaults).
for key in defaultModel defaultProvider; do
	grep -qE "\"$key\":\s*\"__APPLEPI_(MODEL|PROVIDER)__\"" config/agent/settings.json.template \
		|| { fail "settings.json.template '$key' is not a __APPLEPI_*__ placeholder"; VIOLATIONS=$((VIOLATIONS + 1)); }
done

if [[ $VIOLATIONS -eq 0 ]]; then
	ok "no personal identifiers in shipped tree"
	exit 0
else
	fail "$VIOLATIONS sanitization violation(s)"
	exit 1
fi
