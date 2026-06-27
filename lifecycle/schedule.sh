#!/bin/bash
# lifecycle/schedule.sh — install/remove the autoresearch jobs.
#
#   schedule install   → daily collect (06:00 local) + weekly aggregate (Mon 07:00)
#   schedule remove    → uninstall both
#   schedule status    → report installed/not
#   schedule run-now   → run collect + aggregate immediately (debug)
#
# macOS: launchd plists in ~/Library/LaunchAgents (the native scheduler; L5).
# Other: a single crontab line per job (portable fallback; Linux/cygwin/WSL).
#
# The jobs only run the LLM-free scripts (collect + aggregate). review/apply
# stay interactive — the user gates every config change.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/.." && pwd)"
CLI="$REPO/bin/apple-pi"
NODE_BIN="$(command -v node || echo /usr/bin/env node)"
PI_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi}"
LABEL_DAILY="com.applepi.autoresearch.daily"
LABEL_WEEKLY="com.applepi.autoresearch.weekly"

say() { printf '%s\n' "$*"; }
ok()  { printf '✓ %s\n' "$*"; }
fail(){ printf '✗ %s\n' "$*" >&2; }

on_macos() { [[ "$(uname -s)" == "Darwin" ]]; }

# ── launchd (macOS) ────────────────────────────────────────────────────
launchd_install() {
	local label="$1"; local hour_min="$2"; local cli_args="$3"
	local plist="$HOME/Library/LaunchAgents/${label}.plist"
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
PLIST
	for a in $cli_args; do printf '\t\t<string>%s</string>\n' "$a" >> "$plist"; done
	cat >> "$plist" <<PLIST
	</array>
	<key>StartCalendarInterval</key>
	<dict>
		<key>Hour</key><integer>${hour_min%:*}</integer>
		<key>Minute</key><integer>${hour_min#*:}</integer>
PLIST
	# weekly: add Weekday=1 (Monday) so it only fires Mondays.
	if [[ "$label" == *weekly* ]]; then printf '\t\t<key>Weekday</key><integer>1</integer>\n' >> "$plist"; fi
	cat >> "$plist" <<PLIST
	</dict>
	<key>EnvironmentVariables</key>
	<dict>
		<key>PI_CODING_AGENT_DIR</key><string>${PI_DIR}</string>
		<key>PATH</key><string>${PATH}</string>
	</dict>
	<key>StandardOutPath</key><string>${PI_DIR}/agent/autoresearch-${label##*.}.log</string>
	<key>StandardErrorPath</key><string>${PI_DIR}/agent/autoresearch-${label##*.}.log</string>
	<key>RunAtLoad</key><false/>
</dict>
</plist>
PLIST
	launchctl unload "$plist" 2>/dev/null || true
	launchctl load "$plist" && ok "installed $label (fires at ${hour_min}$([[ $label == *weekly* ]] && echo ' Mon'))"
}

launchd_status() {
	for label in "$LABEL_DAILY" "$LABEL_WEEKLY"; do
		local plist="$HOME/Library/LaunchAgents/${label}.plist"
		if [[ -f "$plist" ]]; then ok "$label: installed ($plist)"; else fail "$label: not installed"; fi
	done
}

launchd_remove() {
	for label in "$LABEL_DAILY" "$LABEL_WEEKLY"; do
		local plist="$HOME/Library/LaunchAgents/${label}.plist"
		if [[ -f "$plist" ]]; then launchctl unload "$plist" 2>/dev/null || true; rm -f "$plist"; ok "removed $label"; fi
	done
}

# ── cron (non-macOS fallback) ──────────────────────────────────────────
cron_install() {
	local cmd="$NODE_BIN --no-warnings $CLI $*"
	local cron_when="$1"; shift
	local marker="# apple-pi autoresearch"
	(crontab -l 2>/dev/null | grep -v "$marker"; echo "$cron_when PI_CODING_AGENT_DIR=$PI_DIR $cmd $marker") | crontab -
	ok "cron job installed: '$cron_when $cmd'"
}
cron_status() {
	if crontab -l 2>/dev/null | grep -q "apple-pi autoresearch"; then ok "cron jobs installed"; else fail "no cron jobs"; fi
}
cron_remove() {
	crontab -l 2>/dev/null | grep -v "apple-pi autoresearch" | crontab - 2>/dev/null || true
	ok "cron jobs removed"
}

# ── dispatch ───────────────────────────────────────────────────────────
cmd="${1:-status}"; shift || true
case "$cmd" in
	install)
		if on_macos; then
			launchd_install "$LABEL_DAILY"  "6:00" "collect"
			launchd_install "$LABEL_WEEKLY" "7:00" "aggregate"
		else
			cron_install "0 6 * * *" collect
			cron_install "0 7 * * 1" aggregate
		fi
		say "review/apply stay interactive — run 'apple-pi status' to check for pending proposals."
		;;
	remove)
		if on_macos; then launchd_remove; else cron_remove; fi
		;;
	status)
		say "host: $(uname -s) ($([[ $(uname -s) == Darwin ]] && echo launchd || echo cron))"
		if on_macos; then launchd_status; else cron_status; fi
		;;
	run-now)
		say "running collect + aggregate immediately…"
		"$NODE_BIN" --no-warnings "$CLI" collect
		"$NODE_BIN" --no-warnings "$CLI" aggregate
		;;
	*)
		fail "unknown schedule subcommand: $cmd (install | remove | status | run-now)"; exit 2 ;;
esac
