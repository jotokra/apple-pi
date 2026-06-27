#!/bin/bash
# smoke/run.sh — the apple-pi smoke suite.
#   bash smoke/run.sh           # all
#   bash smoke/run.sh <name>    # one of: sanitize, structure, onboard-sandbox

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

target="${1:-all}"

run_one() {
	local name="$1"
	local script="$SCRIPT_DIR/$name.sh"
	[[ -x "$script" ]] || chmod +x "$script"
	echo
	echo "== smoke: $name =="
	if "$script"; then echo "OK   $name"; else echo "FAIL $name"; FAILED=1; fi
}

FAILED=0
if [[ "$target" == "all" ]]; then
	for s in sanitize structure onboard-sandbox vault-roundtrip vault-tracefree vault-telemetry-safe vault-rotate-import-export vault-onboarding vault-masked-overlay vault-export-to vault-failclosed voice-integration docs-build; do run_one "$s"; done
else
	run_one "$target"
fi

echo
if [[ $FAILED -eq 0 ]]; then echo "ALL SMOKE TESTS PASSED"; exit 0; else echo "SOME SMOKE TESTS FAILED"; exit 1; fi
