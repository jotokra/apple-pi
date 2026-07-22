#!/bin/bash
# lifecycle/mobile.sh — manage the apple-pi mobile-bridge daemon.
#
#   mobile start         spawn bridge.mjs in the background (no launchd)
#   mobile stop          kill any running bridge (launchd-managed or not)
#   mobile status        report bridge process + launchd registration
#   mobile install       write ~/Library/LaunchAgents/local.mobile-bridge.plist
#   mobile uninstall     remove that LaunchAgent + unload it
#   mobile pair-device   POST /v1/pair/issue on a running bridge, print the 6-char code
#
# Subcommands match the shape of lifecycle/schedule.sh (install|status|remove|...)
# so the same mental model works. mobile-bridge itself is a Phase-0 piece of
# work; this script lets you exercise it without dragging the iOS app into the
# loop. plan-01 Task 7 + SUPERPROMPT §7.3.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/.." && pwd)"
BRIDGE="$REPO/mobile-bridge/bin/bridge.mjs"
PLIST_TEMPLATE="$SCRIPT_DIR/lib/mobile-bridge-launchd.plist"
PLIST="$HOME/Library/LaunchAgents/local.mobile-bridge.plist"
LABEL="local.mobile-bridge"
BRIDGE_PORT="${BRIDGE_PORT:-7892}"
BRIDGE_HOST="${BRIDGE_HOST:-127.0.0.1}"
PI_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi}"

say() { printf '%s\n' "$*"; }
ok()  { printf '✓ %s\n' "$*"; }
fail(){ printf '✗ %s\n' "$*" >&2; }
on_macos() { [[ "$(uname -s)" == "Darwin" ]]; }

bridge_pid() {
	# Match either:
	#   - launchd-managed: "node ... mobile-bridge/bin/bridge.mjs"
	#   - manual start:    same argv, started by mobile.sh
	pgrep -f "mobile-bridge/bin/bridge\\.mjs" 2>/dev/null | head -1
}

bridge_running() {
	local pid; pid="$(bridge_pid)"
	[[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null
}

start_bridge() {
	if bridge_running; then
		say "(bridge already running, pid $(bridge_pid))"
		return 0
	fi
	[[ -f "$BRIDGE" ]] || { fail "bridge entrypoint not found: $BRIDGE (mobile-bridge package not installed)"; return 1; }
	local node_bin; node_bin="$(command -v node || echo /usr/bin/env node)"
	mkdir -p "$PI_DIR/agent"
	BRIDGE_PORT="$BRIDGE_PORT" BRIDGE_HOST="$BRIDGE_HOST" \
		PI_CODING_AGENT_DIR="$PI_DIR" \
		PI_SESSIONS_DIR="$PI_DIR/sessions" \
		"$node_bin" --no-warnings "$BRIDGE" \
		>> "$PI_DIR/agent/mobile-bridge.log" 2>&1 &
	disown || true
	sleep 0.3
	if bridge_running; then ok "bridge started (pid $(bridge_pid))"; else fail "bridge failed to start — see $PI_DIR/agent/mobile-bridge.log"; return 1; fi
}

stop_bridge() {
	local pid; pid="$(bridge_pid)"
	if [[ -z "$pid" ]]; then say "(bridge not running)"; return 0; fi
	kill "$pid" 2>/dev/null || true
	# give it a moment, then SIGKILL if still alive
	for _ in 1 2 3 4 5; do kill -0 "$pid" 2>/dev/null || break; sleep 0.2; done
	if kill -0 "$pid" 2>/dev/null; then kill -9 "$pid" 2>/dev/null || true; fi
	ok "bridge stopped (pid was $pid)"
}

status_bridge() {
	say "host       : $(uname -s)"
	if on_macos; then say "scheduler  : launchd"; else say "scheduler  : (no launchd — only manual start/stop supported)"; fi
	say "bridge bin : $BRIDGE"
	say "bridge log : $PI_DIR/agent/mobile-bridge.log"
	say "port       : $BRIDGE_PORT"
	local pid; pid="$(bridge_pid)"
	if [[ -n "$pid" ]]; then ok "process    : running (pid $pid)"; else say "process    : not running"; fi
	if on_macos; then
		if [[ -f "$PLIST" ]]; then ok "launchd    : installed ($PLIST)"; else say "launchd    : not installed"; fi
	else
		say "launchd    : (skipped, non-macOS)"
	fi
	# probe HTTP only if it looks like something is up; never fail status on a down bridge.
	if [[ -n "$pid" ]]; then
		local code; code="$(curl -fsS -o /dev/null -w '%{http_code}' "http://${BRIDGE_HOST}:${BRIDGE_PORT}/v1/health" 2>/dev/null || echo "000")"
		if [[ "$code" == "200" ]]; then ok "health     : HTTP 200"; else say "health     : HTTP $code (bridge up but endpoint unreachable)"; fi
	fi
}

install_launchd() {
	on_macos || { fail "install is macOS-only (launchd). use 'mobile start' on Linux/WSL."; return 1; }
	[[ -f "$PLIST_TEMPLATE" ]] || { fail "plist template not found: $PLIST_TEMPLATE"; return 1; }
	[[ -f "$BRIDGE" ]] || { fail "bridge entrypoint not found: $BRIDGE (mobile-bridge package not installed)"; return 1; }
	local node_bin; node_bin="$(command -v node || echo /usr/bin/env node)"
	mkdir -p "$HOME/Library/LaunchAgents" "$PI_DIR/agent"
	# Substitute placeholders. Using sed here (not envsubst) so we don't pull in
	# gettext as a dep just for one templated plist.
	sed \
		-e "s|__NODE_BIN__|${node_bin}|g" \
		-e "s|__REPO__|${REPO}|g" \
		-e "s|__PI_DIR__|${PI_DIR}|g" \
		-e "s|__BRIDGE_PORT__|${BRIDGE_PORT}|g" \
		-e "s|__PATH__|${PATH}|g" \
		"$PLIST_TEMPLATE" > "$PLIST"
	# Validate before handing it to launchctl — a malformed plist crashes the
	# load with no actionable error.
	if ! plutil -lint "$PLIST" >/dev/null 2>&1; then
		fail "rendered plist failed plutil -lint:"
		plutil -lint "$PLIST" >&2 || true
		rm -f "$PLIST"
		return 1
	fi
	# Unload any prior registration so the new one takes cleanly.
	launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
	if launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null; then
		ok "installed LaunchAgent ($PLIST) — bridge will autostart on login"
	elif launchctl load "$PLIST" 2>/dev/null; then
		# launchctl load is the legacy spelling; works on older macOS.
		ok "installed LaunchAgent ($PLIST) via launchctl load (legacy)"
	else
		fail "launchctl could not register the agent (try: launchctl load $PLIST)"
		return 1
	fi
}

uninstall_launchd() {
	on_macos || { say "(non-macOS, nothing to uninstall)"; return 0; }
	if [[ ! -f "$PLIST" ]]; then say "(no plist at $PLIST; nothing to uninstall)"; return 0; fi
	launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || launchctl unload "$PLIST" 2>/dev/null || true
	rm -f "$PLIST"
	ok "uninstalled LaunchAgent (removed $PLIST)"
}

pair_device() {
	# The bridge must be running for /v1/pair/issue to respond. We don't
	# auto-start — pairing is an explicit user intent, so let them know if the
	# bridge is down rather than silently spinning one up.
	if ! bridge_running; then
		fail "bridge is not running. start it first: 'apple-pi mobile start' (or 'apple-pi mobile install' + log in)."
		return 1
	fi
	local resp; resp="$(curl -fsS -X POST "http://${BRIDGE_HOST}:${BRIDGE_PORT}/v1/pair/issue" 2>/dev/null)" || {
		fail "POST /v1/pair/issue failed — bridge is up but the endpoint did not respond."
		return 1
	}
	# Pull the code out of the JSON without taking on a jq dep. The bridge
	# returns {"code":"ABC123","expires_at":"..."} per plan-01 Task 3.
	local code; code="$(printf '%s' "$resp" | sed -n 's/.*"code":"\([^"]*\)".*/\1/p')"
	if [[ -z "$code" ]]; then
		fail "could not parse code from response: $resp"
		return 1
	fi
	printf 'pairing code: %s\n' "$code"
	printf 'enter this in the iOS app to pair. code is valid for 10 minutes.\n'
}

cmd="${1:-status}"; shift || true
case "$cmd" in
	start)        start_bridge ;;
	stop)         stop_bridge ;;
	status)       status_bridge ;;
	install)      install_launchd ;;
	uninstall)    uninstall_launchd ;;
	pair-device)  pair_device ;;
	*)
		fail "unknown mobile subcommand: $cmd (start | stop | status | install | uninstall | pair-device)"
		exit 2 ;;
esac