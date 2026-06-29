#!/bin/bash
# smoke/sync-profile.sh — REQ-S-6: settings.json portable/device split.
#
# The structural fix for clean consolidation (spec R2). settings.json mixes
# portable tuning with device-specific paths/model; the split keeps device
# fields local and merges only portable fields on pull.
#
#   S-6.1  extractPortable removes device fields, keeps everything else
#   S-6.2  mergePortable overwrites portable fields, preserves device fields
#         byte-for-byte (the R2 correctness contract)
#   S-6.3  writePortableExtract produces the tracked settings.portable.json
#         and EXCLUDES device fields (no sessionDir/shellPath/model leak)
#   S-6.4  applyPortableMerge into a DIFFERENT device's settings.json keeps
#         that device's sessionDir/shellPath/model, takes the remote's tuning
#   S-6.5  round-trip: extract → merge is idempotent on the same device
#
# Pure: synthetic pi dirs, no git/network.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."
# shellcheck disable=SC1091
source ./smoke/_lib.sh

command -v node >/dev/null 2>&1 || { fail "node required"; exit 1; }
node --check sync/lib/profile.js || { fail "profile.js syntax"; exit 1; }

RUN() {
	node --no-warnings -e "$1" || { fail "node snippet failed"; exit 1; }
}

header "S-6.1: extractPortable drops device fields, keeps the rest"
RUN "
const { extractPortable, DEVICE_FIELDS } = require('./sync/lib/profile');
const s = {
  sessionDir: '/home/a/.pi/sessions', shellPath: '/bin/zsh',
  defaultModel: 'claude-x', defaultProvider: 'anthropic', _models: {x:1},
  compaction: { enabled: true, reserveTokens: 4096 },
  treeFilterMode: 'noTools', theme: 'dark', extensions: ['/v.ts'],
};
const p = extractPortable(s);
const dev = ['sessionDir','shellPath','defaultModel','defaultProvider','_models'];
for (const k of dev) if (k in p) { console.error('FAIL device field leaked: '+k); process.exit(1); }
for (const k of ['compaction','treeFilterMode','theme','extensions']) if (!(k in p)) { console.error('FAIL portable field dropped: '+k); process.exit(1); }
if (p.compaction.enabled !== true) { console.error('FAIL nested not preserved'); process.exit(1); }
console.log('OK extract: ' + Object.keys(p).length + ' portable fields, 0 device fields');
"

header "S-6.2: mergePortable preserves device fields byte-for-byte (R2)"
RUN "
const { mergePortable } = require('./sync/lib/profile');
const local = {
  sessionDir: '/device-A/sessions', shellPath: '/bin/zsh',
  defaultModel: 'model-A', defaultProvider: 'prov-A', _models: {a:1},
  compaction: { enabled: false }, theme: 'light',
};
const remotePortable = {
  compaction: { enabled: true, reserveTokens: 8192 },
  theme: 'dark', treeFilterMode: 'noTools',
  // a portable extract must never carry device fields, but if it did, merge
  // must STILL keep local's device value (defense in depth):
  sessionDir: '/evil/should-not-win',
};
const m = mergePortable(local, remotePortable);
if (m.sessionDir !== '/device-A/sessions') { console.error('FAIL sessionDir clobbered: '+m.sessionDir); process.exit(1); }
if (m.shellPath !== '/bin/zsh')     { console.error('FAIL shellPath clobbered'); process.exit(1); }
if (m.defaultModel !== 'model-A')   { console.error('FAIL model clobbered'); process.exit(1); }
if (m.defaultProvider !== 'prov-A') { console.error('FAIL provider clobbered'); process.exit(1); }
if (m.compaction.enabled !== true)  { console.error('FAIL portable not merged'); process.exit(1); }
if (m.theme !== 'dark')             { console.error('FAIL theme not converged'); process.exit(1); }
if (m.treeFilterMode !== 'noTools') { console.error('FAIL new portable field not added'); process.exit(1); }
console.log('OK merge: device fields preserved, portable fields converged');
"

header "S-6.3: writePortableExtract excludes device fields from the file"
TMP="$(mktemp -d)"; mkdir -p "$TMP/agent"
cat > "$TMP/agent/settings.json" <<JSON
{
  "sessionDir": "$TMP/sessions",
  "shellPath": "/bin/zsh",
  "defaultModel": "gpt-test",
  "defaultProvider": "openai",
  "_models": { "openai": {} },
  "compaction": { "enabled": true },
  "theme": "dark"
}
JSON
export PI_CODING_AGENT_DIR="$TMP"
RUN "
const { writePortableExtract, portablePath } = require('./sync/lib/profile');
const fs = require('fs');
const wrote = writePortableExtract('$TMP');
if (!wrote) { console.error('FAIL reported no write'); process.exit(1); }
const p = JSON.parse(fs.readFileSync(portablePath('$TMP'),'utf8'));
for (const k of ['sessionDir','shellPath','defaultModel','defaultProvider','_models']) {
  if (k in p) { console.error('FAIL device field '+k+' leaked into portable file'); process.exit(1); }
}
if (!p.compaction || p.compaction.enabled !== true) { console.error('FAIL portable compaction missing'); process.exit(1); }
console.log('OK portable file written, device fields excluded');
"
ok "S-6.3: settings.portable.json excludes device fields"

header "S-6.4: applyPortableMerge into a different device keeps its device fields"
# Device B has DIFFERENT device-specific values; remote portable (from A) has new tuning.
cat > "$TMP/agent/settings.json" <<JSON
{
  "sessionDir": "/home/B/.pi/sessions",
  "shellPath": "/bin/bash",
  "defaultModel": "claude-B",
  "defaultProvider": "anthropic",
  "compaction": { "enabled": false },
  "theme": "light"
}
JSON
cat > "$TMP/agent/settings.portable.json" <<JSON
{
  "compaction": { "enabled": true, "reserveTokens": 4096 },
  "theme": "dark",
  "treeFilterMode": "userOnly"
}
JSON
RUN "
const { applyPortableMerge, readSettings } = require('./sync/lib/profile');
const { changed, merged } = applyPortableMerge('$TMP');
const s = readSettings('$TMP');
if (s.sessionDir !== '/home/B/.pi/sessions') { console.error('FAIL B sessionDir clobbered: '+s.sessionDir); process.exit(1); }
if (s.shellPath !== '/bin/bash')     { console.error('FAIL B shellPath clobbered'); process.exit(1); }
if (s.defaultModel !== 'claude-B')   { console.error('FAIL B model clobbered'); process.exit(1); }
if (s.defaultProvider !== 'anthropic') { console.error('FAIL B provider clobbered'); process.exit(1); }
if (s.compaction.enabled !== true)   { console.error('FAIL portable not merged into B'); process.exit(1); }
if (s.theme !== 'dark')              { console.error('FAIL theme not converged on B'); process.exit(1); }
if (s.treeFilterMode !== 'userOnly') { console.error('FAIL new field not added to B'); process.exit(1); }
if (!changed) { console.error('FAIL reported no change'); process.exit(1); }
console.log('OK merge into device B: device fields kept, portable converged');
"
ok "S-6.4: cross-device merge preserves device fields"

header "S-6.5: extract → merge is idempotent on the same device"
RUN "
const { writePortableExtract, applyPortableMerge, readSettings } = require('./sync/lib/profile');
const before = JSON.stringify(readSettings('$TMP'));
writePortableExtract('$TMP');           // refresh extract from current settings
const { changed } = applyPortableMerge('$TMP');  // merge it back (should be no-op)
const after = JSON.stringify(readSettings('$TMP'));
if (changed) { console.error('FAIL merge reported change on idempotent round-trip'); process.exit(1); }
if (before !== after) { console.error('FAIL settings changed on idempotent round-trip'); process.exit(1); }
console.log('OK idempotent: extract→merge leaves settings unchanged');
"
ok "S-6.5: extract→merge idempotent"

unset PI_CODING_AGENT_DIR
rm -rf "$TMP"
echo
echo "== smoke: sync-profile DONE =="
