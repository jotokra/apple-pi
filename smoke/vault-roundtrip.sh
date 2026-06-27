#!/bin/bash
# smoke/vault-roundtrip.sh — V-1: the baseline CRUD round-trip.
#
# The canonical add → list (metadata only, never the secret) → get → remove
# cycle, plus the file-format invariants: the vault is a single 0600 file that
# stays a valid versioned-JSON envelope (re-encrypted) after every mutation.
# This is the "the vault behaves like a vault" baseline; the trace-free +
# rotate/import/export guarantees have their own focused tests.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."
# shellcheck disable=SC1091
source ./smoke/_lib.sh

command -v node >/dev/null 2>&1 || { fail "node required"; exit 1; }

SBX="$(mktemp -d /tmp/cv-rt.XXXXXX)"
trap 'rm -rf "$SBX"' EXIT
export PI_CODING_AGENT_DIR="$SBX"
export CREDENTIALS_VAULT_PASS="rt-test-passphrase"
VAULT="$SBX/agent/credentials.vault"
CLI=(node --no-warnings bin/apple-pi vault)

# helper: assert the vault file is 0600 + decrypts to a valid envelope
assert_vault_invariants() {
	local label="$1"
	[[ -f "$VAULT" ]] || { fail "$label: vault file missing"; exit 1; }
	local mode
	mode=$(stat -f "%Lp" "$VAULT" 2>/dev/null || stat -c "%a" "$VAULT" 2>/dev/null)
	[[ "$mode" == "600" ]] || { fail "$label: vault mode is $mode, expected 600"; exit 1; }
	node -e '
		const core = require(process.argv[1]);
		const env = core.readVault(process.env.CREDENTIALS_VAULT_PASS);
		if (!env || typeof env !== "object") { console.error("  not an envelope"); process.exit(1); }
		if (env.version !== 1) { console.error("  version != 1: " + env.version); process.exit(1); }
		if (!Array.isArray(env.entries)) { console.error("  entries not an array"); process.exit(1); }
	' "$SCRIPT_DIR/../vault/lib/vault.js" >&2 || { fail "$label: vault did not decrypt to a valid v1 envelope"; exit 1; }
}

SECRET="rt-roundtrip-secret-$(date +%s)-$RANDOM"

# ── add ────────────────────────────────────────────────────────────────
header "add"
printf '%s' "$SECRET" | "${CLI[@]}" add openai --provider openai --note "roundtrip test" >/dev/null \
	|| { fail "add failed"; exit 1; }
assert_vault_invariants "after add"
ok "add: entry written, vault 0600 + valid v1 envelope"

# ── list (metadata only — the secret must NOT appear) ──────────────────
header "list (metadata only)"
list_out=$("${CLI[@]}" list 2>/dev/null)
echo "$list_out" | grep -q "openai" || { fail "list did not show the entry"; exit 1; }
echo "$list_out" | grep -q "roundtrip test" || { fail "list did not show the note"; exit 1; }
if echo "$list_out" | grep -qF "$SECRET"; then
	fail "list LEAKED the secret into its output"; exit 1
fi
ok "list: shows id + metadata, NOT the secret"
assert_vault_invariants "after list"

# ── get (returns the secret — privileged) ──────────────────────────────
header "get"
got=$("${CLI[@]}" get openai 2>/dev/null) || { fail "get failed"; exit 1; }
[[ "$got" == "$SECRET" ]] || { fail "get returned '$got', expected the secret"; exit 1; }
ok "get: returns the stored secret"
assert_vault_invariants "after get"

# ── remove (vault re-encrypts; entry gone; invariants hold) ────────────
header "remove"
"${CLI[@]}" remove openai >/dev/null || { fail "remove failed"; exit 1; }
"${CLI[@]}" get openai >/dev/null 2>&1 && { fail "entry still present after remove"; exit 1; }
assert_vault_invariants "after remove"
ok "remove: entry gone, vault re-encrypted, 0600 + valid envelope"

# ── empty vault is still a valid envelope ──────────────────────────────
header "empty vault invariants"
node -e '
	const core = require(process.argv[1]);
	const env = core.readVault(process.env.CREDENTIALS_VAULT_PASS);
	if (env.entries.length !== 0) { console.error("  entries not empty: " + env.entries.length); process.exit(1); }
	console.error("  OK empty vault: 0 entries, version " + env.version);
' "$SCRIPT_DIR/../vault/lib/vault.js" >&2 || { fail "empty vault is not a valid empty envelope"; exit 1; }
ok "empty vault: valid v1 envelope, 0 entries"

echo
ok "vault-roundtrip: add/list/get/remove + 0600 + valid envelope throughout"
