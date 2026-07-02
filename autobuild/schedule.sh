#!/usr/bin/env bash
# autobuild/schedule.sh — wire the autonomous builder as a launchd LaunchAgent
# so it runs unattended batches to completion (FULL AUTONOMY). The orchestrator
# is resumable + idempotent, so each wake just advances the queue by --max-tasks
# and stops on done / block / regression / needs_review.
#
#   bash autobuild/schedule.sh install [max-tasks] [every-minutes] [project-dir]
#   bash autobuild/schedule.sh status
#   bash autobuild/schedule.sh uninstall
#   bash autobuild/schedule.sh run-now        # one batch immediately, foreground
#
# Defaults: max-tasks=3, every 10 min, project dir = current dir.
# Label: local.jotokra.autobuild.<sanitized-project-dir>
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"   # apple-pi repo root (for node + orchestrator)
NODE="${NODE:-$(command -v node)}"
CMD=( "$NODE" "$REPO/autobuild/orchestrator.js" --max-tasks "${2:-3}" )

label_for() {
	local d="$(cd "$1" 2>/dev/null && pwd -P 2>/dev/null || echo "$1")"
	echo "local.jotokra.autobuild.$(echo "$d" | tr -c 'A-Za-z0-9' '-' | tr 'A-Z' 'a-z')"
}
PLIST="$HOME/Library/LaunchAgents/$(label_for "${4:-$PWD}").plist"

case "${1:-}" in
	install)
		PROJECT="$(cd "${4:-$PWD}" && pwd -P)"
		LABEL="$(label_for "$PROJECT")"
		PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
		MINS="${3:-10}"
		cat > "$PLIST" <<XML
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>WorkingDirectory</key><string>$PROJECT</string>
  <key>ProgramArguments</key>
  <array>
$(for a in "${CMD[@]}"; do echo "    <string>$a</string>"; done)
  </array>
  <key>StartInterval</key><integer>$((MINS*60))</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$PROJECT/.autobuild/schedule.log</string>
  <key>StandardErrorPath</key><string>$PROJECT/.autobuild/schedule.log</string>
  <key>ProcessType</key><string>Background</string>
</dict></plist>
XML
		launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true
		launchctl bootstrap "gui/$UID" "$PLIST"
		echo "installed: $LABEL  (every ${MINS}m, --max-tasks ${2:-3}, project $PROJECT)"
		echo "logs: $PROJECT/.autobuild/schedule.log   dashboard: $PROJECT/.autobuild/BUILD.md"
		;;
	status)
		LABEL="$(label_for "${4:-$PWD}")"; launchctl print "gui/$UID/$LABEL" 2>/dev/null | grep -E 'state|last exit|program' || echo "not loaded: $LABEL"
		;;
	uninstall)
		LABEL="$(label_for "${4:-$PWD}")"; launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true; rm -f "$HOME/Library/LaunchAgents/$LABEL.plist"; echo "uninstalled: $LABEL"
		;;
	run-now)
		( cd "${4:-$PWD}" && exec "${CMD[@]}" )
		;;
	*) echo "usage: $0 {install [max-tasks] [every-min] [project-dir]|status|uninstall|run-now}"; exit 1 ;;
esac
