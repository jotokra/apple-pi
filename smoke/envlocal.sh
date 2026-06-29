#!/bin/bash
# smoke/envlocal.sh — REQ-E: device-local env.local for generic extensions.
#   E-1.1  helper merges agent/env.local KEY=VALUE into process.env
#   E-1.2  absent file = no-op (no throw, env unchanged)
#   E-1.3  real process.env wins (env.local does not override an existing var)
#   E-1.4  malformed line is skipped, not fatal; lowercase keys ignored
#   E-1.5  agent/env.local classified secret by paths.js -> gitignored
#
# The helper is TS; node 22 loads it via --experimental-strip-types. Each
# assertion is a FRESH node process because the helper mutates process.env as
# an import side-effect (per-test isolation requires a new process).
# Count-neutral: adds no .ts under config/extensions/ (the helper is in _lib/).

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."
# shellcheck disable=SC1091
source ./smoke/_lib.sh

command -v node >/dev/null 2>&1 || { fail "node required"; exit 1; }
HELP="config/extensions/_lib/envlocal.ts"
[[ -f "$HELP" ]] || { fail "$HELP missing"; exit 1; }
node --check sync/lib/paths.js >/dev/null 2>&1 || { fail "paths.js syntax"; exit 1; }

NODE_TS=(node --experimental-strip-types --no-warnings)

# ---- E-1.1: merge ----
header "E-1.1: env.local merged into process.env"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/agent"
printf 'FORGEJO_BASE_URL=https://git.example.com\nKANBAN_DB_PATH=%s/k.db\n' "$TMP" > "$TMP/agent/env.local"
OUT="$(PI_CODING_AGENT_DIR="$TMP" "${NODE_TS[@]}" --input-type=module -e "
	import('./config/extensions/_lib/envlocal.ts').then(() => {
		console.log(process.env.FORGEJO_BASE_URL + '|' + process.env.KANBAN_DB_PATH);
	});
" 2>/dev/null)"
[[ "$OUT" == "https://git.example.com|$TMP/k.db" ]] || { fail "merge wrong: '$OUT'"; exit 1; }
ok "E-1.1: env.local values merged"

# ---- E-1.2: absent = no-op ----
header "E-1.2: absent env.local is a no-op"
TMP2="$(mktemp -d)"; mkdir -p "$TMP2/agent"   # no env.local created
PI_CODING_AGENT_DIR="$TMP2" "${NODE_TS[@]}" --input-type=module -e "
	import('./config/extensions/_lib/envlocal.ts').then(() => {
		if (process.env.SHOULD_NOT_EXIST !== undefined) { console.log('FAIL'); process.exit(1); }
		console.log('ok');
	});
" 2>/dev/null | grep -q '^ok$' || { fail "absent file threw or mutated env"; exit 1; }
ok "E-1.2: absent file no-op, no throw"

# ---- E-1.3: real env wins ----
header "E-1.3: real process.env wins over env.local"
TMP3="$(mktemp -d)"; mkdir -p "$TMP3/agent"
printf 'WINNER=fromfile\n' > "$TMP3/agent/env.local"
OUT="$(PI_CODING_AGENT_DIR="$TMP3" WINNER=fromenv "${NODE_TS[@]}" --input-type=module -e "
	import('./config/extensions/_lib/envlocal.ts').then(() => console.log(process.env.WINNER));
" 2>/dev/null)"
[[ "$OUT" == "fromenv" ]] || { fail "env.local overrode real env: '$OUT'"; exit 1; }
ok "E-1.3: real env wins"

# ---- E-1.4: malformed skipped ----
header "E-1.4: malformed line skipped, not fatal"
TMP4="$(mktemp -d)"; mkdir -p "$TMP4/agent"
printf '# comment\nbad line no equals\n=missingkey\nGOOD=val\nlowercase=ignored\n' > "$TMP4/agent/env.local"
OUT="$(PI_CODING_AGENT_DIR="$TMP4" "${NODE_TS[@]}" --input-type=module -e "
	import('./config/extensions/_lib/envlocal.ts').then(() => console.log(process.env.GOOD + '|' + (process.env.lowercase ?? 'unset')));
" 2>/dev/null)"
[[ "$OUT" == "val|unset" ]] || { fail "malformed handling wrong: '$OUT'"; exit 1; }
ok "E-1.4: GOOD kept; malformed/lowercase skipped"

# ---- E-1.5: classified secret -> gitignored ----
header "E-1.5: agent/env.local classified secret + emitted by gitignore gen"
node -e "
	const { classify, bucketOf } = require('./sync/lib/paths');
	const { generate } = require('./sync/lib/gitignore');
	const c = classify(process.argv[1]);
	if (bucketOf('agent/env.local', c) !== 'secret') { console.error('bucket:', bucketOf('agent/env.local', c)); process.exit(1); }
	const gi = generate(c);
	if (!gi.includes('agent/env.local')) { console.error('not in gitignore'); process.exit(1); }
" "$TMP" >/dev/null 2>&1 || { fail "paths.js did not class agent/env.local as secret OR gitignore gen did not emit it"; exit 1; }
ok "E-1.5: classified secret + gitignored"

echo
echo "== smoke: envlocal DONE =="
