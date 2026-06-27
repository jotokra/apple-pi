#!/bin/bash
# smoke/vault-onboarding.sh — V-3: the dual-lifetime guarantee.
#
# Onboarding creds are TRANSIENT (pruned at confirm); user-added creds are
# PERSISTENT (survive until /vault remove). Two mechanisms enforce this, and
# both are exercised here via the CLI/core (the testable path — the live
# install.sh flow is interactive):
#   1. install.sh's purge does a TARGETED `vault remove onboarding` (see
#      install.sh ~L498-505). It must remove ONLY that id, leaving any other
#      entry — transient OR persistent — that the user added intact. This is
#      NOT a "nuke all transient" (that would defeat the dual-lifetime model).
#   2. The R6 safety net pruneTransient reaps stale transient entries by AGE
#      (default > 24h), never persistent ones. It catches a transient entry
#      left behind if the confirm step crashed mid-onboarding.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."
# shellcheck disable=SC1091
source ./smoke/_lib.sh

command -v node >/dev/null 2>&1 || { fail "node required"; exit 1; }

SBX="$(mktemp -d /tmp/cv-onb.XXXXXX)"
trap 'rm -rf "$SBX"' EXIT
export PI_CODING_AGENT_DIR="$SBX"
export CREDENTIALS_VAULT_PASS="onb-test-passphrase"
CORE="$SCRIPT_DIR/../vault/lib/vault.js"
CLI=(node --no-warnings bin/apple-pi vault)

# ── V-3a: targeted remove (install.sh's purge mechanism) is surgical ───
header "V-3a: targeted 'remove onboarding' leaves other entries intact"
printf 'onb-secret'   | "${CLI[@]}" add onboarding   --lifetime transient   >/dev/null
printf 'user-secret'  | "${CLI[@]}" add userkey      --lifetime persistent  >/dev/null
printf 'temp2-secret' | "${CLI[@]}" add anothertemp  --lifetime transient   >/dev/null
# this is exactly what install.sh runs at successful confirm:
"${CLI[@]}" remove onboarding >/dev/null || { fail "remove onboarding failed"; exit 1; }
# onboarding gone; BOTH the persistent entry AND the unrelated transient kept
"${CLI[@]}" get onboarding  >/dev/null 2>&1 && { fail "onboarding was not removed"; exit 1; }
"${CLI[@]}" get userkey     >/dev/null 2>&1 || { fail "PERSISTENT userkey removed by the onboarding purge!"; exit 1; }
"${CLI[@]}" get anothertemp >/dev/null 2>&1 || { fail "unrelated transient removed by purge (must be targeted, not nuke-all-transient)!"; exit 1; }
ok "targeted remove: onboarding gone; persistent + other transient kept"

# ── V-3b: pruneTransient is lifetime- AND age-selective ───────────────
header "V-3b: pruneTransient reaps stale transient, keeps persistent"
# Backdate `anothertemp` by 2 days so it crosses the 24h reap threshold. This
# simulates a transient entry left behind by a crashed confirm (R6 scenario).
node -e '
	const core = require(process.argv[1]);
	core.modifyVault(process.env.CREDENTIALS_VAULT_PASS, (env) => {
		const e = env.entries.find((x) => x.id === "anothertemp");
		if (e) e.updatedAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
	});
' "$CORE" || { fail "could not backdate the transient entry"; exit 1; }
"${CLI[@]}" prune-transient >/tmp/vo-prune.out 2>&1
grep -qE 'pruned 1 stale transient' /tmp/vo-prune.out || { fail "prune count wrong (expected 1)"; cat /tmp/vo-prune.out; exit 1; }
"${CLI[@]}" get anothertemp >/dev/null 2>&1 && { fail "stale transient was NOT reaped by pruneTransient"; exit 1; }
"${CLI[@]}" get userkey     >/dev/null 2>&1 || { fail "PERSISTENT entry reaped by pruneTransient!"; exit 1; }
ok "pruneTransient: stale transient reaped, persistent kept"

# ── V-3c: a fresh transient is NOT prematurely reaped ──────────────────
header "V-3c: fresh transient (< 24h) survives pruneTransient"
printf 'fresh-secret' | "${CLI[@]}" add freshtransient --lifetime transient >/dev/null
"${CLI[@]}" prune-transient >/tmp/vo-prune2.out 2>&1
grep -qE 'pruned 0 stale transient' /tmp/vo-prune2.out || { fail "fresh transient should not be pruned"; cat /tmp/vo-prune2.out; exit 1; }
"${CLI[@]}" get freshtransient >/dev/null 2>&1 || { fail "fresh transient was prematurely reaped"; exit 1; }
ok "fresh transient survives pruneTransient (age threshold honoured)"

rm -f /tmp/vo-prune*.out
echo
ok "vault-onboarding: dual-lifetime holds (transient pruned, persistent survives)"
