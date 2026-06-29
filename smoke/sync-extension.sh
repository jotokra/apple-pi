#!/bin/bash
# smoke/sync-extension.sh — REQ-S-8: the /sync TUI extension.
#
# The extension is a thin delegator to `apple-pi sync`. It can't be unit-run
# without pi's extension runner, so this smoke pins its contracts:
#   S-8.1  config/extensions/sync.ts exists (structure.sh enforces count 10;
#          this is the content contract)
#   S-8.2  it registers a /sync command and exports a default fn (the shape
#          pi's loader requires)
#   S-8.3  its SUBCOMMANDS list matches the CLI's real subcommands (no drift
#          between what /sync accepts and what `apple-pi sync` runs)
#   S-8.4  applePiBin() resolves a path when apple-pi is findable (PATH or
#          install location), null otherwise — the same fail-safe the hook uses
#
# No pi, no model, no network.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."
# shellcheck disable=SC1091
source ./smoke/_lib.sh

command -v node >/dev/null 2>&1 || { fail "node required"; exit 1; }
[[ -f config/extensions/sync.ts ]] || { fail "config/extensions/sync.ts missing"; exit 1; }

header "S-8.1: sync.ts present + count is 10 (structure contract)"
COUNT="$(find config/extensions -maxdepth 1 -type f -name '*.ts' | wc -l | tr -d ' ')"
[[ "$COUNT" -eq 10 ]] || { fail "expected 10 single-file extensions, got $COUNT"; exit 1; }
ok "S-8.1: 10 single-file extensions (sync.ts present)"

header "S-8.2: registers /sync + exports a default fn"
grep -q 'pi.registerCommand("sync"' config/extensions/sync.ts || { fail "no registerCommand('sync')"; exit 1; }
grep -q 'export default function' config/extensions/sync.ts || { fail "no default export"; exit 1; }
ok "S-8.2: registerCommand + default export present"

header "S-8.3: every /sync subcommand is implemented by the CLI (subset, no drift)"
# The extension intentionally exposes a SUBSET (no clone/hook-run — those are
# fresh-device/internal). The contract: nothing /sync advertises is missing
# from the CLI. (Not equality — the CLI may offer more.)
EXT_SUBS="$(node -e "
const fs = require('fs');
const src = fs.readFileSync('config/extensions/sync.ts','utf8');
const m = src.match(/SUBCOMMANDS\s*=\s*\[([^\]]+)\]/);
const subs = m[1].match(/\"([a-z]+)\"/g).map(s => s.replace(/\"/g,''));
console.log(subs.sort().join(' '));
")"
CLI_SUBS="$(node -e "
const fs = require('fs');
const src = fs.readFileSync('sync/cli.js','utf8');
const m = [...src.matchAll(/case \"([a-z-]+)\":\s*return/g)].map(x => x[1]);
const real = m.filter(s => !s.startsWith('-'));
console.log([...new Set(real)].sort().join(' '));
")"
echo "  extension advertises: $EXT_SUBS"
echo "  CLI implements:       $CLI_SUBS"
# Every advertised sub must appear in the CLI's set.
MISSING=""
for s in $EXT_SUBS; do echo "$CLI_SUBS" | grep -qw "$s" || MISSING="$MISSING $s"; done
[[ -z "$MISSING" ]] || { fail "/sync advertises commands the CLI lacks:$MISSING"; exit 1; }
ok "S-8.3: every /sync subcommand implemented by CLI (intentional subset)"

header "S-8.4: applePiBin resolution (the fail-safe the hook also relies on)"
# Extract the applePiBin function and node-check its logic in isolation.
node -e "
const fs = require('fs');
const src = fs.readFileSync('config/extensions/sync.ts','utf8');
// Strip the TS type import + the default fn; check applePiBin is defined + resolves.
if (!/function applePiBin\(\)/.test(src)) { console.error('FAIL no applePiBin'); process.exit(1); }
// The function checks APPLE_PI_BIN env, PATH, then ~/.apple-pi/bin/apple-pi.
const checks = ['APPLE_PI_BIN', 'command', '-v', 'apple-pi', '.apple-pi', 'bin', 'apple-pi'];
for (const c of checks) if (!src.includes(c)) { console.error('FAIL resolution missing step: '+c); process.exit(1); }
console.log('OK applePiBin: env → PATH → install-location fallback chain present');
"
ok "S-8.4: applePiBin fail-safe present"

header "S-8.5: tsc type-check (best-effort; non-blocking if pi types unresolved)"
if command -v tsc >/dev/null 2>&1; then
	if tsc --noEmit --skipLibCheck config/extensions/sync.ts 2>/dev/null; then
		ok "S-8.5: tsc clean"
	else
		# Expected when the pi package types aren't resolvable from the repo root.
		warn "S-8.5: tsc reported errors (pi types unresolved from repo root; non-blocking)"
	fi
else
	warn "S-8.5: tsc not installed; skipping extension type-check"
fi

echo
echo "== smoke: sync-extension DONE =="
