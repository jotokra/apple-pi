#!/bin/bash
# smoke/vault-keychain.sh — VW-V-1: the keychain unlock tier (REQ-VW-3).
#
# Verifies the three core keychain helpers (keychainRead/Write/Delete) round-
# trip on the REAL macOS keychain — the linchpin of P3 (headless unlock, no
# passphrase re-typing). Uses a PID-suffixed test service so it NEVER touches
# the live `apple-pi-vault` entry, and cleans up on exit.
#
# This is a per-device viability check (does the keychain resolve headlessly on
# THIS host? — i.e. is auto-login unlocking the login keychain for non-GUI
# processes?). On non-darwin the keychain tier is a documented no-op (the
# helpers return null/false; REQ-VW-1 falls through to env/tty), so the smoke
# SKIPS (exit 0) there — graceful degradation is the design, not a failure.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."
# shellcheck disable=SC1091
source ./smoke/_lib.sh

command -v node >/dev/null 2>&1 || { fail "node required"; exit 1; }

if [[ "$(uname)" != "Darwin" ]]; then
	warn "non-darwin host — keychain tier is a no-op by design (REQ-VW-1 falls through to env/tty); skipping"
	echo "OK   vault-keychain (skipped: non-darwin)"
	exit 0
fi
command -v security >/dev/null 2>&1 || { fail "the macOS 'security' CLI is required on darwin"; exit 1; }

SERVICE="apple-pi-vault-smoke-$$"
PASS="kc-smoke-pass-$(date +%s)-$RANDOM"
CORE="$SCRIPT_DIR/../vault/lib/vault.js"

cleanup() { node -e 'require(process.argv[1]).keychainDelete(process.argv[2])' "$CORE" "$SERVICE" >/dev/null 2>&1 || true; }
trap cleanup EXIT

# ── read of a never-existed service is null (best-effort, never throws) ─
header "read: missing service → null (no throw)"
r=$(node -e 'const c=require(process.argv[1]);const v=c.keychainRead("no-such-svc-'$$'");process.stdout.write(v===null?"null":JSON.stringify(v));' "$CORE") \
	|| { fail "keychainRead threw on a missing service (must be best-effort)"; exit 1; }
[[ "$r" == "null" ]] || { fail "keychainRead on a missing service returned '$r', expected null"; exit 1; }
ok "read: missing service → null, no throw (graceful fall-through tier)"

# ── write → read round-trip ────────────────────────────────────────────
header "write → read round-trip"
node -e 'const c=require(process.argv[1]);process.exit(c.keychainWrite(process.argv[2],process.argv[3])?0:1);' "$CORE" "$SERVICE" "$PASS" \
	|| { fail "keychainWrite returned false (is the login keychain locked for this process? need auto-login)"; exit 1; }
ok "write: stored the test passphrase"
r=$(node -e 'const c=require(process.argv[1]);process.stdout.write(c.keychainRead(process.argv[2])||"");' "$CORE" "$SERVICE") \
	|| { fail "keychainRead threw after write"; exit 1; }
[[ "$r" == "$PASS" ]] || { fail "keychainRead returned '$r', expected the stored passphrase"; exit 1; }
ok "read: returned the stored passphrase (round-trip OK)"

# ── delete → read returns null again ───────────────────────────────────
header "delete → read null"
node -e 'const c=require(process.argv[1]);process.exit(c.keychainDelete(process.argv[2])?0:1);' "$CORE" "$SERVICE" \
	|| { fail "keychainDelete returned false"; exit 1; }
ok "delete: removed the test entry"
r=$(node -e 'const c=require(process.argv[1]);const v=c.keychainRead(process.argv[2]);process.stdout.write(v===null?"null":JSON.stringify(v));' "$CORE" "$SERVICE") \
	|| { fail "keychainRead threw after delete"; exit 1; }
[[ "$r" == "null" ]] || { fail "keychainRead after delete returned '$r', expected null"; exit 1; }
ok "read: null after delete"

# ── parity: the raw `security` CLI sees the same value we wrote ─────────
header "parity with the macOS 'security' CLI"
node -e 'const c=require(process.argv[1]);process.exit(c.keychainWrite(process.argv[2],process.argv[3])?0:1);' "$CORE" "$SERVICE" "$PASS" >/dev/null
sec=$(security find-generic-password -s "$SERVICE" -a "$USER" -w 2>/dev/null) || { fail "the 'security' CLI could not read what we wrote (parity broken)"; exit 1; }
[[ "$sec" == "$PASS" ]] || { fail "the 'security' CLI read '$sec', expected the passphrase (parity broken)"; exit 1; }
ok "parity: raw 'security' CLI reads the same value our helper wrote"

echo
ok "vault-keychain: keychain helpers round-trip — P3 (headless unlock) viable on this host (REQ-VW-3)"
