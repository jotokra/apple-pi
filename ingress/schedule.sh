#!/bin/bash
# ingress/schedule.sh — install/remove the ingress poller jobs.
#
#   ingress install          read ingress.pollers[] from settings, install a
#                            launchd (macOS) / cron (other) job per enabled poller
#   ingress remove           uninstall all ingress jobs
#   ingress status           report installed jobs
#   ingress run <name>       run one poller immediately (fetch + inject)
#
# Reuses the proven pattern from lifecycle/schedule.sh: launchd plists in
# ~/Library/LaunchAgents on macOS, crontab lines elsewhere. Jobs run as the
# USER (never root), fire the apple-pi CLI which calls runPoller + inject.
#
# The injected content is wrapped [INGRESS · UNTRUSTED] by inject.js; the
# persona rule (AGENTS.md) makes the agent treat it as data. This script only
# SCHEDULES — it doesn't change the security model.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/.." && pwd)"
CLI="$REPO/bin/apple-pi"
NODE_BIN="$(command -v node || echo /usr/bin/env node)"
PI_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi}"
LABEL_PREFIX="com.applepi.ingress"

say() { printf '%s\n' "$*"; }
ok()  { printf '✓ %s\n' "$*"; }
fail(){ printf '✗ %s\n' "$*" >&2; }
on_macos() { [[ "$(uname -s)" == "Darwin" ]]; }

# read pollers from settings.json → echo "name\tevery" lines for enabled ones
poller_specs() {
	python3 -c "
import json,sys
try:
    d=json.load(open('$PI_DIR/agent/settings.json'))
except Exception as e:
    sys.exit(0)
for p in d.get('ingress',{}).get('pollers',[]):
    if p.get('enabled',True) is False: continue
    every=p.get('every','24h')
    print(f\"{p['name']} {every}\")
" 2>/dev/null
}

# convert an "every" spec (e.g. 30m, 6h, 2d) to a launchd StartInterval (seconds)
# cron-friendly: also echo a cron schedule on stdout2 later if needed.
every_to_seconds() {
	local e="$1"
	local n="${e//[!0-9]/}"
	local u="${e//[0-9]/}"
	[[ -z "$n" ]] && { n=24; u=h; }
	case "$u" in
		m) echo $((n*60)) ;;
		h) echo $((n*3600)) ;;
		d) echo $((n*86400)) ;;
		*) echo 86400 ;;
	esac
}

launchd_install_one() {
	local name="$1" every="$2"
	local label="${LABEL_PREFIX}.${name}"
	local plist="$HOME/Library/LaunchAgents/${label}.plist"
	local interval; interval=$(every_to_seconds "$every")
	mkdir -p "$HOME/Library/LaunchAgents"
	cat > "$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key><string>${label}</string>
	<key>ProgramArguments</key>
	<array>
		<string>${NODE_BIN}</string>
		<string>--no-warnings</string>
		<string>${CLI}</string>
		<string>ingress</string>
		<string>run</string>
		<string>${name}</string>
	</array>
	<key>StartInterval</key><integer>${interval}</integer>
	<key>EnvironmentVariables</key>
	<dict>
		<key>PI_CODING_AGENT_DIR</key><string>${PI_DIR}</string>
		<key>PATH</key><string>${PATH}</string>
	</dict>
	<key>StandardOutPath</key><string>${PI_DIR}/agent/ingress-${name}.log</string>
	<key>StandardErrorPath</key><string>${PI_DIR}/agent/ingress-${name}.log</string>
	<key>RunAtLoad</key><false/>
</dict>
</plist>
PLIST
	launchctl unload "$plist" 2>/dev/null || true
	launchctl load "$plist" && ok "installed ${label} (every ${every} = ${interval}s)"
}

launchd_status() {
	say "host: $(uname -s) (launchd)"
	poller_specs | while IFS=' ' read -r name _every; do
		[[ -z "$name" ]] && continue
		local label="${LABEL_PREFIX}.${name}"
		local plist="$HOME/Library/LaunchAgents/${label}.plist"
		if [[ -f "$plist" ]]; then ok "${label}: installed"; else fail "${label}: not installed"; fi
	done
}

launchd_remove() {
	for plist in "$HOME/Library/LaunchAgents/${LABEL_PREFIX}."*.plist; do
		[[ -f "$plist" ]] || continue
		launchctl unload "$plist" 2>/dev/null || true
		rm -f "$plist"
		ok "removed $(basename "$plist" .plist)"
	done
}

cron_install_one() {
	local name="$1" every="$2"
	local interval; interval=$(every_to_seconds "$every")
	# cron min resolution is 1m; for sub-minute intervals, round up to 1m
	local mins=$(( (interval + 59) / 60 ))
	local when="*/${mins} * * * *"
	local marker="# apple-pi ingress:${name}"
	(crontab -l 2>/dev/null | grep -v "$marker"; \
	 echo "$when PI_CODING_AGENT_DIR=$PI_DIR $NODE_BIN --no-warnings $CLI ingress run $name $marker") | crontab -
	ok "cron job installed for ${name} (every ${mins}m)"
}
cron_status() {
	say "host: $(uname -s) (cron)"
	if crontab -l 2>/dev/null | grep -q "apple-pi ingress"; then ok "cron jobs installed"; else fail "no ingress cron jobs"; fi
}
cron_remove() {
	crontab -l 2>/dev/null | grep -v "apple-pi ingress" | crontab - 2>/dev/null || true
	ok "cron jobs removed"
}

cmd="${1:-status}"; shift || true
case "$cmd" in
	install)
		count=0
		poller_specs | while IFS=' ' read -r local_name local_every; do
			[[ -z "$local_name" ]] && continue
			[[ -z "$local_every" ]] && local_every="24h"
			if on_macos; then launchd_install_one "$local_name" "$local_every"
			else cron_install_one "$local_name" "$local_every"; fi
			count=$((count+1))
		done
		if [[ $count -eq 0 ]]; then say "no enabled pollers in settings — add some: /ingress add rss <name> <url>"; fi
		say "ingress jobs run as user $(whoami), never root. Items inject wrapped [UNTRUSTED]."
		;;
	remove)
		if on_macos; then launchd_remove; else cron_remove; fi
		;;
	status)
		if on_macos; then launchd_status; else cron_status; fi
		;;
	run)
		# delegate to the node CLI (same path the scheduled job uses)
		"$NODE_BIN" --no-warnings "$CLI" ingress run "$@"
		;;
	*)
		fail "unknown ingress subcommand: $cmd (install | remove | status | run <name>)"; exit 2 ;;
esac
