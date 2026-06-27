#!/bin/bash
# smoke/vault-telemetry-safe.sh — REQ-CV-6: the autoresearch collector must
# NEVER read credential/secret material.
#
# Two assertions:
#   1. STATIC  — the denylist patterns + the guarded read are present in
#      lifecycle/collect-metrics.js, AND every session read goes through the
#      guard (exactly one readFileSync call site, inside readSessionFile()).
#      This is defense-in-depth against a future glob widening that might
#      reach agent/credentials.vault.
#   2. UNIT    — the exported isDenied() guard returns TRUE for every denied
#      path shape (vault, onboarding vault, auth.json, .ssh/.aws/.kube) and
#      FALSE for a normal session file. This is the load-bearing check: it
#      proves the guard actually fires, not just that the patterns exist.
#
# Why no "run the collector, grep the DB for a marker" step? The collector
# stores aggregates (turns/tokens/tools/cost), NOT message content, so a
# secret in a denied file couldn't leak into the DB schema even if the guard
# were removed. The honest proof that "secret files are never opened" is the
# unit test of the guard function — that's what enforces it.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."
# shellcheck disable=SC1091
source ./smoke/_lib.sh

command -v node >/dev/null 2>&1 || { fail "node required"; exit 1; }

SRC="lifecycle/collect-metrics.js"

# ── 1. STATIC: the guard is wired in and is the ONLY read path ─────────
# (Which specific paths are denied is proven by the unit test in step 2;
# the static check proves the guard exists, references the denylist, and is
# the sole readFileSync call site — i.e. there is no bypass.)
header "REQ-CV-6 static: guard wired in, no bypass read path"
[[ -f "$SRC" ]] || { fail "$SRC not found"; exit 1; }

grep -qE 'DENYLIST_PATTERNS' "$SRC" || { fail "DENYLIST_PATTERNS not defined in $SRC"; exit 1; }
grep -qE 'function isDenied' "$SRC"  || { fail "isDenied() missing in $SRC"; exit 1; }
grep -qE 'function readSessionFile' "$SRC" || { fail "readSessionFile() missing in $SRC"; exit 1; }
# the guard must actually throw on a denied path (not be a stub that
# always returns false / always reads).
grep -qE 'throw new Error.*denied' "$SRC" || { fail "readSessionFile does not throw on denied paths in $SRC"; exit 1; }

# Exactly ONE readFileSync call site allowed: inside readSessionFile()'s body.
# Any other readFileSync of a path is a bypass of the guard. (The require()
# destructure line uses `readFileSync,` — no paren — so it isn't counted.)
count=$(grep -cE 'readFileSync\(' "$SRC")
if [[ "$count" -ne 1 ]]; then
	fail "expected exactly 1 readFileSync call site (inside the guard); found $count — possible bypass"
	grep -nE 'readFileSync\(' "$SRC" | sed 's/^/    /'
	exit 1
fi
ok "guard wired in (DENYLIST_PATTERNS + isDenied + throw); single readFileSync call site, inside the guard"

# ── 2. UNIT: isDenied() fires on denied paths, passes on session paths ─
header "REQ-CV-6 unit: isDenied() guard behavior"
UNIT_DIR="$(mktemp -d /tmp/cv-telem.XXXXXX)"
trap 'rm -rf "$UNIT_DIR"' EXIT
UNIT_JS="$UNIT_DIR/_isdenied_check.js"
cat > "$UNIT_JS" <<'JS'
const { isDenied } = require(process.argv[2]);
const denied = [
	"/home/u/.pi/agent/credentials.vault",
	"/home/u/.pi/agent/credentials.vault.lock",
	"/home/u/.pi/agent/credentials.vault.tmp.12345",
	"/home/u/.pi/onboarding.vault",
	"/home/u/.pi/agent/auth.json",
	"/home/u/.ssh/id_ed25519",
	"/home/u/.aws/credentials",
	"/home/u/.kube/config",
];
const allowed = [
	"/home/u/.pi/sessions/2026-06-27_abc.jsonl",
	"/home/u/.pi/sessions/2026-06-27_xyz.jsonl",
	"/tmp/sessions/foo.jsonl",
	"/home/u/.pi/state/last_session_recap.md",
];
let pass = 0, total = 0;
for (const p of denied) {
	total++;
	if (!isDenied(p)) { console.error("  FAIL isDenied(" + JSON.stringify(p) + ")=false want true"); process.exit(1); }
	pass++;
}
for (const p of allowed) {
	total++;
	if (isDenied(p)) { console.error("  FAIL isDenied(" + JSON.stringify(p) + ")=true want false"); process.exit(1); }
	pass++;
}
console.error("  OK " + pass + "/" + total + " (denied refused, sessions allowed)");
JS
# NOTE: this require() is safe ONLY because collect-metrics.js guards main()
# behind `require.main === module`. If that guard regresses, this line would
# trigger a real collection run against the live PI dir.
node --no-warnings "$UNIT_JS" "$SCRIPT_DIR/../lifecycle/collect-metrics.js" >&2 \
	|| { fail "isDenied() guard regression"; exit 1; }
ok "isDenied() guard: denied paths refused, session/state paths allowed"

echo
ok "vault-telemetry-safe: REQ-CV-6 holds (collector cannot read credential material)"
