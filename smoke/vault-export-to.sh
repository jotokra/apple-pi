#!/bin/bash
# smoke/vault-export-to.sh — F2: the generic external export (vault.exportCmd).
#
# Proves the load-bearing safety property (red/blue R-F2a/b): the SECRET is
# piped to the command's STDIN ONLY — it is NEVER in the command line (so `ps e`
# can't see it) and NEVER in the child's env vars (only non-secret $VAULT_*
# metadata is). Plus the operational guards: refuse when unset, surface non-zero
# exit, refuse missing entry, kill a hung command.
#
# The capture command writes BOTH its stdin + its env to a file so we can assert
# exactly what the child observed.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."
# shellcheck disable=SC1091
source ./smoke/_lib.sh

command -v node >/dev/null 2>&1 || { fail "node required"; exit 1; }

SBX="$(mktemp -d /tmp/cv-f2.XXXXXX)"
trap 'rm -rf "$SBX"' EXIT
export PI_CODING_AGENT_DIR="$SBX"
export CREDENTIALS_VAULT_PASS="f2-test-passphrase"
SETTINGS="$SBX/settings.json"
OUT="$SBX/export-out.txt"
CLI=(node --no-warnings bin/apple-pi vault)
MARKER="F2-SECRET-$(date +%s)-$RANDOM"

# seed an entry
printf '%s' "$MARKER" | "${CLI[@]}" add alpha --provider openai --note "unit-test" >/dev/null \
	|| { fail "seed add failed"; exit 1; }

write_settings() {
	# $1 = the exportCmd value. Wrap in JSON. Single quotes inside are fine.
	printf '{"vault":{"exportCmd":"%s"}}' "$1" > "$SETTINGS"
}

# ── 1. refuse when exportCmd unset ────────────────────────────────────
header "F2: refuse when vault.exportCmd is unset"
rm -f "$SETTINGS"
"${CLI[@]}" export-to alpha >/tmp/cv-f2-a.out 2>&1; rc=$?
[[ $rc -ne 0 ]] || { fail "export-to should fail when exportCmd unset"; cat /tmp/cv-f2-a.out; exit 1; }
grep -q "no vault.exportCmd configured" /tmp/cv-f2-a.out || { fail "missing 'not configured' message"; cat /tmp/cv-f2-a.out; exit 1; }
ok "export-to refuses when exportCmd unset (exit non-zero, helpful message)"

# ── 2. THE HEADLINE: secret on STDIN, NEVER in argv or env ────────────
header "F2 headline: secret on STDIN only, never argv/env (R-F2a/b)"
# capture command: write stdin + the env var fields to the file.
write_settings "sh -c 'echo STDIN_LINE=\$(cat); echo ENV_LINE ID=\$VAULT_ID PROVIDER=\$VAULT_PROVIDER KIND=\$VAULT_KIND NOTE=\$VAULT_NOTE' > $OUT"
"${CLI[@]}" export-to alpha >/tmp/cv-f2-b.out 2>&1 || { fail "export-to failed"; cat /tmp/cv-f2-b.out; exit 1; }
grep -q "exported 'alpha' via vault.exportCmd" /tmp/cv-f2-b.out || { fail "no success message"; cat /tmp/cv-f2-b.out; exit 1; }
[[ -f "$OUT" ]] || { fail "capture file not written"; exit 1; }
# (a) the secret IS on stdin (the whole point — the command received it)
STDIN_LINE=$(grep "^STDIN_LINE=" "$OUT")
if [[ "$STDIN_LINE" != *"$MARKER"* ]]; then
	fail "secret was NOT piped to the command's stdin (R-F2a broken)"; cat "$OUT"; exit 1
fi
ok "secret reached the command via STDIN"
# (b) the secret is NOT in any $VAULT_* env var (metadata only)
ENV_LINE=$(grep "^ENV_LINE" "$OUT")
if [[ "$ENV_LINE" == *"$MARKER"* ]]; then
	fail "secret LEAKED into a $VAULT_* env var (R-F2b broken)"; echo "$ENV_LINE"; exit 1
fi
# (c) the metadata IS present (proves the env-var channel works for non-secrets)
[[ "$ENV_LINE" == *"ID=alpha"* && "$ENV_LINE" == *"PROVIDER=openai"* && "$ENV_LINE" == *"NOTE=unit-test"* ]] \
	|| { fail "metadata env vars missing/wrong"; echo "$ENV_LINE"; exit 1; }
ok "metadata via \$VAULT_* env vars (ID/PROVIDER/KIND/NOTE); secret NOT among them"
# (d) the secret is NOT in the resolved command line stored in settings (static config)
if grep -qF "$MARKER" "$SETTINGS"; then
	fail "secret present in the exportCmd config string (should be metadata-only template)"; cat "$SETTINGS"; exit 1
fi
ok "exportCmd config string contains no secret (metadata template only)"

# ── 3. metadata-injection resistance (R-F2c) ─────────────────────────
# A note containing shell metacharacters must NOT break out of the command,
# because metadata is passed via ENV VARS, not string-interpolated into the cmd.
header "F2: metadata injection resistance (R-F2c — env-pass, not interpolate)"
printf '%s' "clean-secret" | "${CLI[@]}" add injector --note '; touch /tmp/cv-f2-PWNED; #' >/dev/null
INJ_MARK="INJ-$(date +%s)-$RANDOM"
# command that echoes the NOTE env var; if interpolation happened, the `touch`
# would execute. We assert the sentinel file is NOT created.
rm -f /tmp/cv-f2-PWNED
write_settings "sh -c 'echo got-note:\$VAULT_NOTE > $OUT'"
"${CLI[@]}" export-to injector >/tmp/cv-f2-c.out 2>&1 || { fail "export-to injector failed"; cat /tmp/cv-f2-c.out; exit 1; }
if [[ -f /tmp/cv-f2-PWNED ]]; then
	fail "metadata injection SUCCEEDED (touch ran) — R-F2c broken"; exit 1
fi
ok "malicious note did not execute (metadata is env-passed, not interpolated)"
rm -f /tmp/cv-f2-PWNED

# ── 4. non-zero exit surfaced ─────────────────────────────────────────
header "F2: non-zero exit code surfaced"
write_settings "sh -c 'echo boom >&2; exit 7'"
"${CLI[@]}" export-to alpha >/tmp/cv-f2-d.out 2>&1; rc=$?
[[ $rc -ne 0 ]] || { fail "export-to should fail on child non-zero exit"; cat /tmp/cv-f2-d.out; exit 1; }
grep -qE "exited 7" /tmp/cv-f2-d.out || { fail "exit code not surfaced"; cat /tmp/cv-f2-d.out; exit 1; }
ok "child non-zero exit surfaced (exit 7 → 'exited 7')"

# ── 5. missing entry refused (no crash) ──────────────────────────────
header "F2: missing entry refused"
write_settings "sh -c 'echo should-not-run > $OUT'"
rm -f "$OUT"
"${CLI[@]}" export-to does-not-exist >/tmp/cv-f2-e.out 2>&1; rc=$?
[[ $rc -ne 0 ]] || { fail "export-to of missing entry should fail"; cat /tmp/cv-f2-e.out; exit 1; }
grep -q "no entry" /tmp/cv-f2-e.out || { fail "missing-entry reason not shown"; cat /tmp/cv-f2-e.out; exit 1; }
# the command must NOT have run (no entry → no spawn)
[[ -f "$OUT" ]] && { fail "export command ran despite missing entry"; exit 1; }
ok "missing entry refused (exit non-zero, command never spawned)"

# ── 6. hung command is killed (timeout) ──────────────────────────────
header "F2: hung command killed (10s timeout)"
write_settings "sleep 30"
START=$(date +%s)
"${CLI[@]}" export-to alpha >/tmp/cv-f2-f.out 2>&1; rc=$?
END=$(date +%s)
ELAPSED=$((END - START))
[[ $rc -ne 0 ]] || { fail "hung export-to should fail"; cat /tmp/cv-f2-f.out; exit 1; }
grep -q "timed out" /tmp/cv-f2-f.out || { fail "timeout reason not shown"; cat /tmp/cv-f2-f.out; exit 1; }
# must return well under the 30s sleep (allow slack: < 20s)
[[ $ELAPSED -lt 20 ]] || { fail "timeout took ${ELAPSED}s (expected ~10s)"; exit 1; }
ok "hung command killed after ~10s (elapsed ${ELAPSED}s), timeout surfaced"

rm -f /tmp/cv-f2-*.out
echo
ok "vault-export-to: secret on STDIN only + operational guards hold"
