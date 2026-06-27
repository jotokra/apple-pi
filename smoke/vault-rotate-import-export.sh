#!/bin/bash
# smoke/vault-rotate-import-export.sh — the cv-rotate-import-export subcommands.
#
# Exercises the three convenience subcommands via the CLI (the non-interactive,
# testable path — same constraint as vault-tracefree.sh: the TUI handlers are
# interactive-only). Covers:
#   - rotate <id>      : refuses a missing entry; rotates an existing one;
#                        get returns the NEW secret, never the old.
#   - import <file>    : envelope {entries:[...]} + bare-array shapes; shreds
#                        the source; one bad entry doesn't abort the batch.
#   - export <id>      : merges into auth.json (preserves other providers),
#                        writes pi's {type:"api_key",key} shape at 0600, REFUSES
#                        to clobber a non-api_key (OAuth) entry; missing entry
#                        refused.
#
# Security assertion: the vault file holds NO plaintext marker (encryption
# holds across rotate + import); the import source is shredded; no marker
# leaks into sessions/logs/telemetry/history. The exported secret IS in
# auth.json in plaintext BY DESIGN (the vault→auth.json bridge) — that's the
# one allowed plaintext sink, asserted explicitly.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."
# shellcheck disable=SC1091
source ./smoke/_lib.sh

command -v node >/dev/null 2>&1 || { fail "node required"; exit 1; }

SBX="$(mktemp -d /tmp/cv-rie.XXXXXX)"
HISTFILE_BACKUP="${HISTFILE:-}"
trap 'rm -rf "$SBX"; export HISTFILE="$HISTFILE_BACKUP"' EXIT
export PI_CODING_AGENT_DIR="$SBX"
export CREDENTIALS_VAULT_PASS="rie-test-passphrase"
export HISTFILE="$SBX/.zsh_history"
VAULT="$SBX/agent/credentials.vault"
AUTH="$SBX/agent/auth.json"
CLI=(node --no-warnings bin/apple-pi vault)

# greppable, unique markers
ROT_OLD="RIE-ROTOLD-$(date +%s)-$RANDOM"
ROT_NEW="RIE-ROTNEW-$(date +%s)-$RANDOM"
IMP_A="RIE-IMPA-$(date +%s)-$RANDOM"
IMP_B="RIE-IMPB-$(date +%s)-$RANDOM"
all_markers=("$ROT_OLD" "$ROT_NEW" "$IMP_A" "$IMP_B")

# ── 1. seed: add alpha with the old secret ─────────────────────────────
header "seed: add alpha"
printf '%s' "$ROT_OLD" | "${CLI[@]}" add alpha --provider openai >/dev/null \
	|| { fail "add alpha failed"; exit 1; }
ok "alpha seeded"

# ── 2. rotate: refuse missing, rotate existing ────────────────────────
header "rotate: refuses a missing entry"
printf '%s' "x" | "${CLI[@]}" rotate ghost >/tmp/rie-r1.out 2>&1
rc=$?
if [[ $rc -eq 0 ]] || ! grep -q "no entry 'ghost'" /tmp/rie-r1.out; then
	fail "rotate should have refused missing 'ghost' (rc=$rc)"; cat /tmp/rie-r1.out; exit 1
fi
ok "rotate refuses missing entry (exit 1)"

header "rotate: replaces the secret"
printf '%s' "$ROT_NEW" | "${CLI[@]}" rotate alpha >/tmp/rie-r2.out 2>&1 \
	|| { fail "rotate alpha failed"; cat /tmp/rie-r2.out; exit 1; }
got=$("${CLI[@]}" get alpha 2>/dev/null)
if [[ "$got" != "$ROT_NEW" ]]; then
	fail "get after rotate returned '$got', expected the NEW marker"
	exit 1
fi
if [[ "$got" == "$ROT_OLD" ]]; then
	fail "get after rotate returned the OLD secret — rotate did not replace it"
	exit 1
fi
ok "rotate replaced the secret (get returns NEW, not OLD)"

# ── 3. import: envelope shape + shred ──────────────────────────────────
header "import: envelope shape, source shredded"
ENV_FILE="$SBX/import-env.json"
printf '{"entries":[{"id":"beta","secret":"%s","provider":"beta"},{"id":"gamma","secret":"%s"}]}' "$IMP_A" "$IMP_B" > "$ENV_FILE"
"${CLI[@]}" import "$ENV_FILE" >/tmp/rie-i1.out 2>&1 \
	|| { fail "import envelope failed"; cat /tmp/rie-i1.out; exit 1; }
grep -q "imported 2 entries" /tmp/rie-i1.out || { fail "import count wrong"; cat /tmp/rie-i1.out; exit 1; }
grep -q "source shredded" /tmp/rie-i1.out || { fail "import did not report shred"; cat /tmp/rie-i1.out; exit 1; }
[[ -f "$ENV_FILE" ]] && { fail "import source was NOT shredded (file still present)"; exit 1; }
# entries present + correct secrets
[[ "$("${CLI[@]}" get beta 2>/dev/null)" == "$IMP_A" ]] || { fail "import: beta secret wrong"; exit 1; }
[[ "$("${CLI[@]}" get gamma 2>/dev/null)" == "$IMP_B" ]] || { fail "import: gamma secret wrong"; exit 1; }
ok "import (envelope): 2 entries, source shredded, secrets correct"

header "import: bare-array shape"
ARR_FILE="$SBX/import-arr.json"
printf '[{"id":"delta","secret":"arr-delta"}]' > "$ARR_FILE"
"${CLI[@]}" import "$ARR_FILE" >/tmp/rie-i2.out 2>&1 \
	|| { fail "import array failed"; cat /tmp/rie-i2.out; exit 1; }
grep -q "imported 1 entry" /tmp/rie-i2.out || { fail "array import count wrong"; cat /tmp/rie-i2.out; exit 1; }
ok "import (bare array): 1 entry"

header "import: one bad entry doesn't abort the batch"
BAD_FILE="$SBX/import-bad.json"
printf '{"entries":[{"id":"epsilon","secret":"good-one"},{"id":"broken"}]}' > "$BAD_FILE"
"${CLI[@]}" import "$BAD_FILE" >/tmp/rie-i3.out 2>&1; rc=$?
# exit code is non-zero (errors present) but the good entry WAS imported + source shredded
[[ $rc -ne 0 ]] || { fail "import with a bad entry should exit non-zero"; cat /tmp/rie-i3.out; exit 1; }
grep -q "imported 1 entry" /tmp/rie-i3.out || { fail "good entry not imported alongside the bad one"; cat /tmp/rie-i3.out; exit 1; }
grep -q "1 error" /tmp/rie-i3.out || { fail "error count not reported"; cat /tmp/rie-i3.out; exit 1; }
"${CLI[@]}" get epsilon >/dev/null 2>&1 || { fail "epsilon (good entry) not actually stored"; exit 1; }
ok "import: good entry stored, bad entry counted, exit non-zero"

# ── 4. export: merge + api_key shape + refuse clobber ──────────────────
header "export: merges into auth.json (preserves other providers)"
# pre-seed auth.json with an existing provider that must survive
mkdir -p "$SBX/agent"
printf '{"keepme":{"type":"api_key","key":"preserved-key"}}' > "$AUTH"
chmod 600 "$AUTH"
"${CLI[@]}" export alpha --provider openai >/tmp/rie-e1.out 2>&1 \
	|| { fail "export failed"; cat /tmp/rie-e1.out; exit 1; }
# validate: keepme preserved, openai added with the rotated secret, shape api_key, mode 0600
node -e '
	const fs = require("fs");
	const a = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
	const assert = (c, m) => { if (!c) { console.error("  " + m); process.exit(1); } };
	assert(a.keepme && a.keepme.key === "preserved-key", "keepme provider was NOT preserved");
	assert(a.openai && a.openai.type === "api_key", "openai not written as api_key shape");
	assert(a.openai.key === process.argv[2], "openai key is not the rotated secret");
	const mode = fs.statSync(process.argv[1]).mode & 0o777;
	assert(mode === 0o600, "auth.json mode is " + mode.toString(8) + ", expected 600");
	console.error("  OK keepme preserved, openai={api_key, rotated-secret}, mode 600");
' "$AUTH" "$ROT_NEW" >&2 || { fail "export: auth.json shape/merge/mode wrong"; exit 1; }
ok "export: merged into auth.json (api_key shape, 0600, other providers preserved)"

header "export: REFUSES to clobber a non-api_key (OAuth) entry"
printf '{"oauth1":{"type":"oauth","access_token":"t","refresh_token":"r"}}' > "$AUTH"
chmod 600 "$AUTH"
"${CLI[@]}" export alpha --provider oauth1 >/tmp/rie-e2.out 2>&1; rc=$?
[[ $rc -ne 0 ]] || { fail "export clobbered an OAuth entry (should have refused)"; cat /tmp/rie-e2.out; exit 1; }
grep -q "refusing to clobber" /tmp/rie-e2.out || { fail "refuse message missing"; cat /tmp/rie-e2.out; exit 1; }
# oauth entry must be UNTOUCHED
node -e '
	const a = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
	if (a.oauth1.type !== "oauth") { console.error("  oauth1 was clobbered!"); process.exit(1); }
	console.error("  OK oauth1 entry untouched");
' "$AUTH" >&2 || { fail "export clobbered the OAuth entry despite refusing"; exit 1; }
ok "export: refuses to clobber non-api_key entry (exit 1, untouched)"

header "export: refuses a missing entry"
"${CLI[@]}" export does-not-exist >/tmp/rie-e3.out 2>&1; rc=$?
[[ $rc -ne 0 ]] || { fail "export of missing entry should fail"; cat /tmp/rie-e3.out; exit 1; }
ok "export: missing entry refused (exit 1)"

# ── 5. SECURITY: no plaintext marker leak; vault stays encrypted ───────
header "security: vault encrypted, source shredded, no leak outside auth.json"
# vault file: NO plaintext marker (encryption holds across rotate + import)
for m in "${all_markers[@]}"; do
	if grep -qaF "$m" "$VAULT"; then
		fail "MARKER '$m' found in PLAINTEXT in the vault file (encryption broken!)"
		exit 1
	fi
done
ok "no plaintext marker in the vault file (encrypted ✓)"
header "shred: refuses to follow a symlink (no target corruption)"
TARGET="$SBX/real-secret.json"
printf '{"entries":[{"id":"zeta","secret":"zeta-symlink-test"}]}' > "$TARGET"
LNK="$SBX/link-to-secret.json"
ln -s "$TARGET" "$LNK"
"${CLI[@]}" import "$LNK" >/tmp/rie-sym.out 2>&1 || { fail "import via symlink failed"; cat /tmp/rie-sym.out; exit 1; }
grep -q "could not shred" /tmp/rie-sym.out || { fail "import should report it could not shred the symlink"; cat /tmp/rie-sym.out; exit 1; }
# the TARGET must still contain its plaintext (NOT zeroed by a followed shred)
grep -q "zeta-symlink-test" "$TARGET" || { fail "shred CORRUPTED the symlink target!"; exit 1; }
# zeta WAS imported (reading through the symlink is fine — only shred refuses)
"${CLI[@]}" get zeta >/dev/null 2>&1 || { fail "zeta not imported via symlink read"; exit 1; }
rm -f "$LNK" "$TARGET"
ok "shred refuses symlink (target untouched); read-through still works"
# import sources all shredded (env + arr + bad files all gone)
for f in "$SBX/import-env.json" "$SBX/import-arr.json" "$SBX/import-bad.json"; do
	[[ -f "$f" ]] && { fail "import source not shredded: $f"; exit 1; }
done
ok "all import source files shredded"
# no marker anywhere in the sandbox EXCEPT auth.json (the designed plaintext sink)
leaks=""
for m in "${all_markers[@]}"; do
	while IFS= read -r hit; do
		[[ "$hit" == "$AUTH" ]] && continue   # auth.json is the allowed sink
		[[ "$hit" == "$VAULT" ]] && continue  # vault (already proven encrypted; binary match false-positive guard)
		leaks="$leaks$hit"$'\n'
	done < <(grep -rIlF "$m" "$SBX" 2>/dev/null || true)
done
if [[ -n "$leaks" ]]; then
	fail "MARKER leaked outside auth.json + vault:"
	printf '%s\n' "$leaks" | sed 's/^/    /'
	exit 1
fi
ok "no marker outside auth.json (the designed sink) + the encrypted vault"
# (The vault→auth.json bridge itself is proven in the export/merge test above,
# which asserts auth.json[openai].key === ROT_NEW in api_key shape at 0600.
# A later sub-test overwrites auth.json, so we don't re-check it here.)

rm -f /tmp/rie-*.out
echo
ok "vault-rotate-import-export: rotate/import/export correct + trace-safe"
