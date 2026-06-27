#!/bin/bash
# smoke/vault-failclosed.sh — red-blue regression: the two data-loss holes.
#
# These were found in a red/blue pass and FIXED. This smoke pins them shut so
# a future refactor can't silently bring them back:
#
#   B1 — exportToAuth on a CORRUPT auth.json must REFUSE (wrote:false), never
#        silently "start fresh" and destroy every other provider's credential.
#        (Data-loss vector: a concurrent write / disk error leaves auth.json
#        half-written; the old code nuked all providers to write just one.)
#
#   W1 — writeVault must refuse a planted SYMLINK at its predictable temp path
#        (credentials.vault.tmp.<pid>), so a local attacker can't redirect the
#        ciphertext write into an unrelated file (corrupting it).
#        (Defence: O_EXCL temp creation — openSync("wx") — fails if the path
#        exists, including a symlink.)
#
# Both must FAIL CLOSED: error out, touch nothing.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."
# shellcheck disable=SC1091
source ./smoke/_lib.sh

command -v node >/dev/null 2>&1 || { fail "node required"; exit 1; }

header "B1 — corrupt auth.json: exportToAuth refuses, preserves other providers"
SBX="$(mktemp -d /tmp/cv-fc.XXXXXX)"
trap 'rm -rf "$SBX"' EXIT
export PI_CODING_AGENT_DIR="$SBX"
export CREDENTIALS_VAULT_PASS="fc-pass"
node --no-warnings bin/apple-pi vault add openai --provider openai >/dev/null 2>&1 \
	|| true  # CLI add may need masked prompt; seed directly below if it fails
# seed via the lib (deterministic, no TUI needed)
node -e "
const v=require('./vault/lib/vault');
v.ensureVault('fc-pass');
v.addEntry('fc-pass',{id:'openai',secret:'sk-NEW',provider:'openai'});
const fs=require('fs'); fs.mkdirSync('$SBX/agent',{recursive:true});
fs.writeFileSync('$SBX/agent/auth.json','{ \"anthropic\": {\"type\":\"api_key\",\"key\":\"sk-ant-SURVIVOR\"}, CORRUPT not-json');
fs.chmodSync('$SBX/agent/auth.json',0o600);
" 2>/dev/null
RES=$(node -e "const v=require('./vault/lib/vault'); console.log(JSON.stringify(v.exportToAuth('fc-pass','openai')))" 2>/dev/null)
echo "$RES" | grep -q '"wrote":false' \
	|| { fail "B1: exportToAuth should refuse on corrupt auth.json"; exit 1; }
grep -q "sk-ant-SURVIVOR" "$SBX/agent/auth.json" \
	|| { fail "B1: corrupt auth.json was modified (should be untouched)"; exit 1; }
ok "B1: corrupt auth.json refused; other providers preserved"

header "W1 — symlink at predicted temp path: writeVault refuses, victim untouched"
SBX2="$(mktemp -d /tmp/cv-sy.XXXXXX)"
VICTIM="$SBX2/VICTIM"
node -e "
const v=require('./vault/lib/vault');
const fs=require('fs'), os=require('os'), path=require('path');
process.env.PI_CODING_AGENT_DIR='$SBX2';
fs.writeFileSync('$VICTIM','ORIGINAL PRECIOUS');
fs.mkdirSync('$SBX2/agent',{recursive:true});
// plant a symlink at the EXACT temp path writeVault will use
fs.symlinkSync('$VICTIM','$SBX2/agent/credentials.vault.tmp.'+process.pid);
let threw=false;
try { v.addEntry('p',{id:'x',secret:'s'}); } catch(e){ threw=true; }
if(!threw){ process.exit(2); }
const after=fs.readFileSync('$VICTIM','utf8');
if(after!=='ORIGINAL PRECIOUS'){ process.exit(3); }
"
rc=$?
case $rc in
	0) ok "W1: symlink plant refused; victim untouched" ;;
	2) fail "W1: writeVault wrote through the symlink (victim clobbered)"; exit 1 ;;
	3) fail "W1: writeVault refused but victim was still modified"; exit 1 ;;
	*) fail "W1: unexpected rc=$rc"; exit 1 ;;
esac

ok "vault-failclosed"
