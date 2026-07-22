#!/usr/bin/env bash
# smoke/mobile-cli.sh — round-trip the apple-pi mobile CLI subcommands.
#
# Verifies, with no bridge running, that:
#   - `apple-pi mobile status` exits 0 (always; the status call must not
#     fail just because no bridge is up)
#   - `apple-pi mobile install` writes the LaunchAgent plist
#   - `apple-pi mobile uninstall` removes it
#
# The install path requires `mobile-bridge/bin/bridge.mjs` to exist (otherwise
# launchd would start the daemon on login and crash). When the bridge hasn't
# been built yet (Tasks 0-6 of plan-01 are still in flight), this smoke stubs
# bridge.mjs in a sandboxed copy of the repo so the round-trip is exercisable
# end-to-end without dragging the iOS + node_modules story in.
#
# Exits non-zero on the first failure. Cleanup with `trap` so a failed run
# never leaves a LaunchAgent plist behind on the host.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/.." && pwd)"

# Run inside an isolated HOME so we never touch the real
# ~/Library/LaunchAgents or ~/.pi on the host.
WORK="$(mktemp -d)"
trap 'cleanup' EXIT
cleanup() {
	if [[ -n "${FAKE_HOME:-}" && -d "$FAKE_HOME" ]]; then
		# The script under test may have written a real-looking plist here.
		# launchd never sees it (we never called bootstrap on a real gui domain),
		# but be tidy.
		rm -rf "$FAKE_HOME"
	fi
	rm -rf "$WORK"
}

fail() { echo "FAIL mobile-cli: $*" >&2; exit 1; }
ok()   { echo "OK   mobile-cli: $*"; }

FAKE_HOME="$WORK/home"
mkdir -p "$FAKE_HOME/Library/LaunchAgents" "$FAKE_HOME/.pi/agent"

# Stub bridge.mjs in a sandbox copy of the repo. We can't `cp -r` the whole
# repo (node_modules alone is huge and breaks), so we copy just the path we
# exercise and symlink everything else from the real checkout.
SANDBOX="$WORK/sandbox"
mkdir -p "$SANDBOX"
# Symlink the dirs the CLI/installer walks, EXCEPT mobile-bridge — that one
# we build as a real sandbox dir below with a stubbed bridge.mjs, because
# writing through a symlinked mobile-bridge would clobber the REAL
# mobile-bridge/bin/bridge.mjs in the checkout (the original bug).
for entry in bin lifecycle vault sync lib; do
	[[ -e "$REPO/$entry" ]] || continue
	ln -s "$REPO/$entry" "$SANDBOX/$entry"
done
mkdir -p "$SANDBOX/mobile-bridge/bin"
# Stub bridge.mjs — the existence check is the only thing install probes; we
# don't have to actually run it for this smoke.
cat > "$SANDBOX/mobile-bridge/bin/bridge.mjs" <<'EOF'
// smoke stub — never executed. mobile.sh only checks `[[ -f $BRIDGE ]]`.
console.log("smoke stub bridge — not for production");
EOF

CLI="$SANDBOX/bin/apple-pi"
[[ -x "$CLI" ]] || fail "bin/apple-pi not executable at $CLI"
node --check "$CLI" || fail "bin/apple-pi syntax error"

# ── status with no bridge: must exit 0 ─────────────────────────────────────
echo "── status (no bridge) ──"
HOME="$FAKE_HOME" PI_CODING_AGENT_DIR="$FAKE_HOME/.pi" \
	PATH="/opt/homebrew/bin:/usr/bin:/bin" \
	"$CLI" mobile status >/dev/null 2>&1 \
	|| fail "mobile status exited non-zero when no bridge running (expected 0)"
ok "mobile status exits 0 with no bridge"

# ── install: writes the LaunchAgent plist ─────────────────────────────────
echo "── install ──"
HOME="$FAKE_HOME" PI_CODING_AGENT_DIR="$FAKE_HOME/.pi" \
	PATH="/opt/homebrew/bin:/usr/bin:/bin" \
	"$CLI" mobile install >/dev/null 2>&1 \
	|| fail "mobile install exited non-zero"
PLIST="$FAKE_HOME/Library/LaunchAgents/local.mobile-bridge.plist"
[[ -f "$PLIST" ]] || fail "plist not written at $PLIST"
# Validate the rendered plist parses (catches placeholder bugs early).
plutil -lint "$PLIST" >/dev/null 2>&1 \
	|| { plutil -lint "$PLIST" >&2; fail "rendered plist failed plutil -lint"; }
# Confirm the substitution actually happened — no placeholders leaked through.
grep -q '__NODE_BIN__\|__REPO__\|__BRIDGE_PORT__\|__PI_DIR__\|__PATH__' "$PLIST" \
	&& fail "rendered plist still contains unsubstituted placeholders"
grep -q '<string>local.mobile-bridge</string>' "$PLIST" \
	|| fail "rendered plist missing Label=local.mobile-bridge"
grep -q '<true/>' "$PLIST" || fail "rendered plist missing KeepAlive/RunAtLoad"
grep -q 'BRIDGE_PORT' "$PLIST" || fail "rendered plist missing BRIDGE_PORT env"
grep -q 'mobile-bridge/bin/bridge.mjs' "$PLIST" || fail "rendered plist missing bridge.mjs in args"
ok "install wrote a valid plist at $PLIST"

# ── status again: now reports launchd installed (process still not running)
echo "── status (after install) ──"
HOME="$FAKE_HOME" PI_CODING_AGENT_DIR="$FAKE_HOME/.pi" \
	PATH="/opt/homebrew/bin:/usr/bin:/bin" \
	"$CLI" mobile status >/dev/null 2>&1 \
	|| fail "mobile status exited non-zero after install"
ok "mobile status still exits 0 after install"

# ── uninstall: removes the LaunchAgent plist ──────────────────────────────
echo "── uninstall ──"
HOME="$FAKE_HOME" PI_CODING_AGENT_DIR="$FAKE_HOME/.pi" \
	PATH="/opt/homebrew/bin:/usr/bin:/bin" \
	"$CLI" mobile uninstall >/dev/null 2>&1 \
	|| fail "mobile uninstall exited non-zero"
[[ -f "$PLIST" ]] && fail "plist not removed at $PLIST (still present)"
ok "uninstall removed the plist"

# ── uninstall again: idempotent, exits 0 ─────────────────────────────────
echo "── uninstall (idempotent re-run) ──"
HOME="$FAKE_HOME" PI_CODING_AGENT_DIR="$FAKE_HOME/.pi" \
	PATH="/opt/homebrew/bin:/usr/bin:/bin" \
	"$CLI" mobile uninstall >/dev/null 2>&1 \
	|| fail "second mobile uninstall exited non-zero (should be idempotent)"
ok "uninstall is idempotent"

# ── pair-device with no bridge: must fail with a useful message ───────────
echo "── pair-device (no bridge) ──"
HOME="$FAKE_HOME" PI_CODING_AGENT_DIR="$FAKE_HOME/.pi" \
	PATH="/opt/homebrew/bin:/usr/bin:/bin" \
	"$CLI" mobile pair-device >/dev/null 2>&1 \
	&& fail "pair-device succeeded with no bridge running (should refuse)"
ok "pair-device refuses when no bridge is running"

# ── unknown subcommand: must exit non-zero with a message ────────────────
echo "── unknown subcommand ──"
HOME="$FAKE_HOME" PI_CODING_AGENT_DIR="$FAKE_HOME/.pi" \
	PATH="/opt/homebrew/bin:/usr/bin:/bin" \
	"$CLI" mobile bogus-bogus >/dev/null 2>&1
[[ "$?" -ne 0 ]] || fail "unknown subcommand exited 0 (should be non-zero)"
ok "unknown subcommand exits non-zero"

echo
echo "PASS: mobile-cli round-trip (status / install / uninstall / idempotent / unknown)"