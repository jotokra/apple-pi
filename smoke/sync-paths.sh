#!/bin/bash
# smoke/sync-paths.sh — REQ-S-1: classify() buckets every pi path correctly.
#
# Pins the foundation of config sync (card S-1). The classification engine
# is THE authority every other sync module reads from, so it must:
#   S-1.1  put a known portable path in `portable` (skills/, agent/AGENTS.md)
#   S-1.2  put a known secret path in `secret` (auth.json, sessions/,
#          browser-profile/, the vault)
#   S-1.3  honor a custom sessionDir from settings.json (add it to secret)
#   S-1.4  classify models.json as deviceLocal; settings.json as deviceOnly
#         (S-6 evolution: settings.json split — portable extract tracked,
#         device-specific original gitignored)
#   S-1.5  never put a secret in portable (the red line)
#   S-1.6  bucketOf() resolves a single path to the right bucket
#
# Pure: builds a synthetic pi dir in a temp dir; no real ~/.pi, no network.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."
# shellcheck disable=SC1091
source ./smoke/_lib.sh

command -v node >/dev/null 2>&1 || { fail "node required"; exit 1; }
[[ -f sync/lib/paths.js ]] || { fail "sync/lib/paths.js missing"; exit 1; }

header "S-1.0: paths.js parses (node --check)"
node --check sync/lib/paths.js || { fail "paths.js syntax"; exit 1; }
ok "paths.js node --check"

# Build a synthetic pi dir with representative files from every bucket.
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/agent" "$TMP/skills/red-blue" "$TMP/agent/skills/x" \
         "$TMP/extensions/web" "$TMP/prompts" "$TMP/voice/bin" \
         "$TMP/sessions" "$TMP/agent/sessions" "$TMP/browser-profile" \
         "$TMP/custom-sessions"
# portable
echo '{}' > "$TMP/skills/red-blue/SKILL.md"
echo '{}' > "$TMP/agent/AGENTS.md"
echo '{}' > "$TMP/agent/skills/x/SKILL.md"
echo '{}' > "$TMP/extensions/voice.ts"
echo '{}' > "$TMP/extensions/web/index.ts"
echo '{}' > "$TMP/prompts/spec.md"
echo '{}' > "$TMP/agent/self-assessment-2026-01-01.md"
echo '{}' > "$TMP/voice/pivoice.py"
# device-local
echo '{}' > "$TMP/agent/settings.json"
echo '{}' > "$TMP/agent/models.json"
# secret
echo 'KEY' > "$TMP/agent/auth.json"
echo 'KEY' > "$TMP/auth.json"
echo 'KEY' > "$TMP/agent/credentials.vault"
echo 'transcript' > "$TMP/sessions/a.jsonl"
# device-only
echo 'x' > "$TMP/caddy-root.crt"
echo '{}' > "$TMP/agent/trust.json"
echo '/src' > "$TMP/.apple-pi-source"
# settings with a CUSTOM sessionDir inside the pi dir
cat > "$TMP/agent/settings.json" <<JSON
{ "sessionDir": "$TMP/custom-sessions", "shellPath": "/bin/zsh" }
JSON

export PI_CODING_AGENT_DIR="$TMP"

OUT="$(node -e "
const { classify, bucketOf } = require('./sync/lib/paths');
const c = classify();
const has = (arr, p) => arr.includes(p);
const assert = (cond, msg) => { if (!cond) { console.error('FAIL: ' + msg); process.exit(1); } };

// S-1.1 portable
assert(has(c.portable, 'skills/**'), 'skills portable');
assert(has(c.portable, 'agent/AGENTS.md'), 'AGENTS portable');
assert(has(c.portable, 'agent/extensions/**'), 'agent/extensions portable');
assert(has(c.portable, 'voice/**'), 'voice portable');
assert(has(c.portable, 'agent/settings.portable.json'), 'portable settings extract (S-6)');

// S-1.2 secret
assert(has(c.secret, 'agent/auth.json'), 'agent/auth secret');
assert(has(c.secret, 'auth.json'), 'root auth secret');
assert(has(c.secret, 'agent/credentials.vault'), 'vault secret');
assert(has(c.secret, 'browser-profile/**'), 'browser-profile secret');

// S-1.3 custom sessionDir honored (resolved relative to pi dir)
assert(c.sessionDirRel === 'custom-sessions/**', 'sessionDirRel=' + c.sessionDirRel);
assert(has(c.secret, 'custom-sessions/**'), 'custom sessionDir added to secret');

// S-1.4 device-local
assert(has(c.deviceLocal, 'agent/models.json'), 'models deviceLocal');
// S-6: settings.json moved deviceLocal → deviceOnly (device paths/model stay local)
assert(has(c.deviceOnly, 'agent/settings.json'), 'settings.json deviceOnly (S-6)');
assert(!c.deviceLocal.includes('agent/settings.json'), 'settings.json NOT deviceLocal anymore (S-6)');

// S-1.5 red line: no secret path is also in portable
for (const sp of c.secret) assert(!c.portable.includes(sp), 'SECRET IN PORTABLE: ' + sp);

// S-1.6 bucketOf
assert(bucketOf('agent/auth.json', c) === 'secret', 'bucketOf auth=secret');
assert(bucketOf('skills/x/SKILL.md', c) === 'portable', 'bucketOf skill=portable');
assert(bucketOf('agent/settings.json', c) === 'deviceOnly', 'bucketOf settings=deviceOnly (S-6)');
assert(bucketOf('agent/settings.portable.json', c) === 'portable', 'bucketOf portable-extract=portable (S-6)');
assert(bucketOf('agent/trust.json', c) === 'deviceOnly', 'bucketOf trust=deviceOnly');
assert(bucketOf('random/new-file.md', c) === 'unknown', 'bucketOf new=unknown');

console.log('OK buckets: ' + c.portable.length + ' portable, ' + c.deviceLocal.length +
  ' deviceLocal, ' + c.secret.length + ' secret, ' + c.deviceOnly.length + ' deviceOnly');
")" || { fail "S-1 classification mismatch"; exit 1; }
ok "S-1.1-1.6: classify() + bucketOf() correct ($OUT)"

unset PI_CODING_AGENT_DIR
echo
echo "== smoke: sync-paths DONE =="
