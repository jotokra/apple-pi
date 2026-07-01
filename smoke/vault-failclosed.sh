#!/bin/bash
# smoke/vault-failclosed.sh — red-blue regression: the data-loss / integrity holes.
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
#   B2 — the crypto core must REFUSE an empty / whitespace-only passphrase.
#        (Integrity vector: openssl -aes-256-cbc happily encrypts with a
#        zero-length key, so an empty passphrase produced a vault that LOOKED
#        like ciphertext but decrypted trivially with an empty passphrase —
#        i.e. plaintext — while every addEntry reported {created:true}. The
#        "encrypted at rest" promise collapsed to nothing. SECURITY.md R2
#        claimed a UI-level minimum-length check existed; it didn't. The real
#        enforcement is now in the crypto chokepoint: assertPassphrase() in
#        vault/lib/vault.js, called by encrypt()/decrypt().)
#
# All three must FAIL CLOSED: error out, touch nothing.

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

# B2 — empty / whitespace / null / undefined passphrase must be refused by the
# crypto core. No caller (CLI, TUI, onboarding) may ever create a vault that
# decrypts with an empty passphrase. The guard lives in encrypt()/decrypt();
# every read/write path funnels through them, so this one assertion covers the
# whole surface.
header "B2 — empty/whitespace/null passphrase: core refuses, no plaintext write"
SBX3="$(mktemp -d /tmp/cv-pp.XXXXXX)"
node -e "
	const v = require('./vault/lib/vault');
	process.env.PI_CODING_AGENT_DIR = '$SBX3';
	const cases = ['', '   ', '\t \n', null, undefined];
	let leak = 0;
	for (const bad of cases) {
		// ensureVault + addEntry must both throw; a return = silent plaintext write.
		let threw = false;
		try { v.ensureVault(bad); } catch { threw = true; }
		if (!threw) { console.error('  ensureVault accepted ' + JSON.stringify(bad)); leak++; }
		threw = false;
		try { v.addEntry(bad, { id: 'x', secret: 'plaintext-leak' }); } catch { threw = true; }
		if (!threw) { console.error('  addEntry accepted ' + JSON.stringify(bad)); leak++; }
	}
	// belt-and-suspenders: confirm a real passphrase still works (guard isn't over-broad)
	v.ensureVault('a-real-passphrase');
	v.addEntry('a-real-passphrase', { id: 'openai', secret: 'sk-real' });
	const env = v.readVault('a-real-passphrase');
	if (!env || env.entries[0].secret !== 'sk-real') { console.error('  real passphrase round-trip broke'); leak++; }
	process.exit(leak === 0 ? 0 : 2);
" || { fail "B2: crypto core accepted an empty/invalid passphrase (plaintext-on-disk hole open)"; exit 1; }
# also assert NO vault file was created by the rejected calls
if [[ -f "$SBX3/agent/credentials.vault" ]]; then
	# a vault may legitimately exist from the real-pass round-trip; verify it does
	# NOT decrypt with an empty passphrase (i.e. it is genuinely encrypted).
	node -e "
		const v = require('./vault/lib/vault');
		process.env.PI_CODING_AGENT_DIR = '$SBX3';
		let emptyOpened = false;
		try { if (v.readVault('') !== null) emptyOpened = true; } catch { /* good: refused */ }
		if (emptyOpened) process.exit(2);
	" || { fail "B2: the vault file decrypts with an empty passphrase = plaintext"; exit 1; }
fi
ok "B2: empty/whitespace/null passphrase refused; real passphrase still works"

ok "vault-failclosed"
