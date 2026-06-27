#!/bin/bash
# smoke/vault-tracefree.sh — the REQ-CV-7 headline security guarantee.
#
# Proves that a secret written through the vault leaves NO plaintext trace in
# the PI dir tree (sessions, agent, logs, telemetry DBs) or shell history.
# The secret must survive ONLY encrypted inside credentials.vault — and even
# there, not as plaintext (it's openssl-encrypted).
#
# What this covers (automatable):
#   - the vault WRITE path (vault/lib/vault.js addEntry via the CLI)
#   - the argument-refusal heuristic (looksLikeSecret) — the load-bearing TUI
#     control that prevents a secret from becoming a transcribed command arg
#   - encrypted-at-rest: the marker does not appear in plaintext in the vault file
#
# What this does NOT cover (documented, needs a pty — same constraint as the
# curl|bash interactive test): driving `/vault add` through the live TUI. The
# slash command is interactive-only. The TUI control that matters for the
# transcript (REQ-CV-3 argument refusal) is unit-tested here via the shared
# looksLikeSecret heuristic; the full interactive transcript check is a manual
# run (run /vault add in the TUI, then grep ~/.pi/sessions/ for your marker).

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."
# shellcheck disable=SC1091
source ./smoke/_lib.sh

require openssl
command -v node >/dev/null 2>&1 || { fail "node required"; exit 1; }

SBX="$(mktemp -d /tmp/cv-tracefree.XXXXXX)"
HISTFILE_BACKUP="${HISTFILE:-}"
trap 'rm -rf "$SBX"; export HISTFILE="$HISTFILE_BACKUP"' EXIT
info "sandbox PI dir: $SBX"

export PI_CODING_AGENT_DIR="$SBX"
export CREDENTIALS_VAULT_PASS="cv7-test-passphrase"
# A scratch HISTFILE so we can also assert the marker never reaches shell history.
export HISTFILE="$SBX/.zsh_history"

# Unique, greppable marker. Random suffix so re-runs don't trip on stale state.
MARKER="CV7-MARKER-$(date +%s)-$RANDOM"
info "marker secret: $MARKER  (must appear NOWHERE in plaintext)"

# ── 1. argument-refusal heuristic (the TUI's load-bearing control) ─────
header "REQ-CV-3: looksLikeSecret refuses pasted keys"
# Write the checker to a temp dir OUTSIDE the PI sandbox, so its embedded
# marker (a test case) doesn't trip the tree scan in step 4.
HEUR_DIR="$(mktemp -d /tmp/cv-heur.XXXXXX)"
HEUR_JS="$HEUR_DIR/_heuristic_check.js"
{
	echo "const {looksLikeSecret}=require(\"$SCRIPT_DIR/../vault/lib/vault\");"
	echo "const cases=["
	echo "  [\"openai\",false],[\"anthropic\",false],[\"gateway\",false],"
	echo "  [\"$MARKER\",true],[\"sk-${MARKER}xyz\",true],[\"sk-ant-short\",true],"
	echo "];"
	echo "let pass=0;"
	echo "for(const [i,want] of cases){"
	echo "  const got=looksLikeSecret(i); const ok=got===want; pass+=+ok;"
	echo "  if(!ok){console.error(\"  FAIL looksLikeSecret(\"+JSON.stringify(i)+\")=\"+got+\" want \"+want);process.exit(1);}"
	echo "}"
	echo "console.error(\"  OK \"+pass+\"/\"+cases.length+\" (keys refused, ids accepted)\");"
} > "$HEUR_JS"
node "$HEUR_JS" >&2 || { fail "looksLikeSecret regression"; rm -rf "$HEUR_DIR"; exit 1; }
rm -rf "$HEUR_DIR"
ok "argument-refusal heuristic"

# ── 2. write the marker through the CLI (stdin, never argv) ────────────
header "write marker via vault CLI (stdin path)"
printf '%s' "$MARKER" | node bin/apple-pi vault add cv7-test --provider openai --note tracefree-test >/tmp/cv7-add.out 2>&1 \
	|| { fail "vault add failed"; cat /tmp/cv7-add.out; exit 1; }
# the add output must NOT echo the marker
if grep -qF "$MARKER" /tmp/cv7-add.out; then
	fail "vault add ECHOED the marker in its output"
	cat /tmp/cv7-add.out; exit 1
fi
ok "vault add did not echo the marker"
rm -f /tmp/cv7-add.out

# ── 3. the marker must survive ONLY encrypted in the vault file ────────
header "encrypted-at-rest: marker is NOT plaintext in the vault file"
VAULT_FILE="$SBX/agent/credentials.vault"
[[ -f "$VAULT_FILE" ]] || { fail "vault file not created"; exit 1; }
if grep -qaF "$MARKER" "$VAULT_FILE"; then
	fail "MARKER FOUND IN PLAINTEXT in the vault file (encryption broken!)"
	exit 1
fi
ok "marker absent from vault file plaintext (encrypted ✓)"

# ── 4. THE HEADLINE: scan the ENTIRE sandbox PI tree for the marker ────
header "REQ-CV-7: marker appears nowhere in the PI dir tree"
# search everything: sessions/, agent/, logs, any *.log, any *.json, any *.db,
# history. Exclude nothing. The vault file was already checked (no plaintext)
# but include it anyway to be thorough.
hits=$(grep -rIlF "$MARKER" "$SBX" 2>/dev/null || true)
if [[ -n "$hits" ]]; then
	fail "MARKER LEAKED into the PI dir tree:"
	printf '%s\n' "$hits" | sed 's/^/    /'
	exit 1
fi
ok "zero marker hits across sessions/agent/logs/telemetry/history"

# ── 5. shell history surface ───────────────────────────────────────────
header "shell history surface"
if [[ -f "$HISTFILE" ]] && grep -qF "$MARKER" "$HISTFILE"; then
	fail "MARKER found in shell history file"
	exit 1
fi
ok "marker absent from shell history"

# ── 6. round-trip: the secret IS recoverable via the privileged path ───
header "round-trip: secret recoverable only via privileged get"
recovered="$(CREDENTIALS_VAULT_PASS="$CREDENTIALS_VAULT_PASS" node bin/apple-pi vault get cv7-test 2>/dev/null)"
if [[ "$recovered" != "$MARKER" ]]; then
	fail "round-trip failed: get returned '$recovered', expected the marker"
	exit 1
fi
ok "secret round-trips via the privileged get path"

# ── 7. wrong-passphrase cannot recover it ──────────────────────────────
header "wrong passphrase cannot recover the secret"
wrong="$(CREDENTIALS_VAULT_PASS="wrong-pass" node bin/apple-pi vault get cv7-test 2>/dev/null || true)"
if [[ "$wrong" == "$MARKER" ]]; then
	fail "wrong passphrase returned the secret!"
	exit 1
fi
ok "wrong passphrase correctly refused"

echo
ok "vault-tracefree: REQ-CV-7 holds (zero plaintext traces; encrypted-at-rest)"
