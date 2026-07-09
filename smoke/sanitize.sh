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
# agentdb/ is the unified DB + native kanban module (M10-4); its build/ subdir
# is the autobuild automation workspace (task queue + logs), not product
# surface — excluded below via --exclude-dir=build.
SCAN_PATHS=(config lib install.sh README.md LICENSE .docs docs guide agentdb)

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
	done < <(grep -rnE --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=cache --exclude-dir=build "$tok" "${SCAN_PATHS[@]}" 2>/dev/null)
done

# Assert the template uses placeholders (not concrete model/provider defaults).
for key in defaultModel defaultProvider; do
	grep -qE "\"$key\":\s*\"__APPLEPI_(MODEL|PROVIDER)__\"" config/agent/settings.json.template \
		|| { fail "settings.json.template '$key' is not a __APPLEPI_*__ placeholder"; VIOLATIONS=$((VIOLATIONS + 1)); }
done

# Dep budget (decision D10): the shipped product may add exactly chokidar as a
# runtime dep (+ gray-matter ONLY if the D3 frontmatter parser actually falls
# back to it). No other external module may enter package.json `dependencies`
# or be required from agentdb/.
header "sanitize: dependency budget (D10)"
allowed="chokidar"
if grep -rqE "require\(['\"]gray-matter['\"]\)|from ['\"]gray-matter['\"]" agentdb --exclude-dir=build 2>/dev/null; then
	allowed="$allowed gray-matter"
	info "gray-matter required in agentdb (D3 fallback) — permitted"
fi

# (a) package.json runtime dependencies must be a subset of the allowed set.
while IFS= read -r dep; do
	[[ -z "$dep" ]] && continue
	if [[ " $allowed " != *" $dep "* ]]; then
		fail "package.json dependency '$dep' outside budget (allowed: $allowed)"
		VIOLATIONS=$((VIOLATIONS + 1))
	fi
done < <(node -e 'console.log(Object.keys(require("./package.json").dependencies||{}).join("\n"))')

# (b) agentdb must not require/import any external module outside the allowed
# set (node: built-ins and relative modules are always fine).
while IFS= read -r mod; do
	[[ -z "$mod" ]] && continue
	case "$mod" in
		node:*|.*) continue ;;
	esac
	if [[ " $allowed " != *" $mod "* ]]; then
		fail "agentdb requires external module '$mod' outside dep budget (allowed: $allowed)"
		VIOLATIONS=$((VIOLATIONS + 1))
	fi
done < <(grep -rhoE "(require\(|from )['\"][^'\"]+['\"]" agentdb --exclude-dir=build 2>/dev/null \
	| sed -E "s/.*['\"]([^'\"]+)['\"].*/\1/" | sort -u)

if [[ $VIOLATIONS -eq 0 ]]; then
	ok "no personal identifiers in shipped tree"
	exit 0
else
	fail "$VIOLATIONS sanitization violation(s)"
	exit 1
fi
