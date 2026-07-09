#!/bin/bash
# smoke/sidecar-alias.sh — REQ-E4: llm_call_minimax is a working alias for
# llm_cross_check (kept for backward compat with skills/prompts/contracts).
#
#   E-4.1  llm-sidecar.ts defines BOTH names (llm_cross_check + llm_call_minimax)
#   E-4.2  both share one execute + one parameters definition (DRY — no drift)
#   E-4.3  the legacy name is marked deprecated in its description
#   E-4.4  count-neutral: no new top-level .ts in config/extensions/ (still 10)
#
# Structural (source-level) smoke. The authoritative end-to-end proof —
# invoking llm_call_minimax through real pi and getting a sidecar reply —
# runs on the consuming repo (pi-config) against the live sidecar.
# Runtime tool registration is verified there via `pi -p`, not here, because
# it needs the pi runtime + a configured LLM_SIDECAR_URL.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."
# shellcheck disable=SC1091
source ./smoke/_lib.sh

F="config/extensions/llm-sidecar.ts"
[[ -f "$F" ]] || { fail "$F missing"; exit 1; }
node --experimental-strip-types --check "$F" >/dev/null 2>&1 || { fail "$F syntax"; exit 1; }

header "E-4.1: both tool names defined"
grep -q 'name: "llm_cross_check"' "$F"  || { fail "llm_cross_check not defined"; exit 1; }
grep -q 'name: "llm_call_minimax"' "$F" || { fail "llm_call_minimax alias not defined"; exit 1; }
ok "E-4.1: llm_cross_check + llm_call_minimax both defined"

header "E-4.2: shared parameters + execute (DRY, no drift)"
# the shared execute must be a standalone declaration referenced by both tools
grep -q '^async function execute' "$F"   || { fail "shared execute() not factored out"; exit 1; }
grep -q '^const parameters' "$F"         || { fail "shared parameters const not factored out"; exit 1; }
# both tools must delegate to the shared execute (count the call sites)
CALLS=$(grep -c 'return execute(id, p)' "$F")
[[ "$CALLS" -eq 2 ]] || { fail "expected 2 execute() call sites (one per tool), got $CALLS"; exit 1; }
ok "E-4.2: both tools delegate to one shared execute + parameters ($CALLS call sites)"

header "E-4.3: legacy alias marked deprecated"
grep -q 'DEPRECATED alias' "$F" || { fail "llm_call_minimax description does not mark itself deprecated"; exit 1; }
ok "E-4.3: legacy name marked DEPRECATED"

header "E-4.4: count-neutral (top-level extension .ts unchanged)"
COUNT=$(find config/extensions -maxdepth 1 -type f -name '*.ts' | wc -l | tr -d ' ')
[[ "$COUNT" -eq 10 ]] || { fail "expected 10 top-level extensions, got $COUNT (alias must not add a file)"; exit 1; }
ok "E-4.4: 10 top-level extensions (alias added inside llm-sidecar.ts, no new file)"

echo
echo "== smoke: sidecar-alias DONE =="
