#!/bin/bash
# smoke/ingress-schedule.sh — REQ-B-3: scheduler install/remove/status.
#
# B-3-1  apple-pi ingress install reads enabled pollers from settings and
#        creates launchd plists (one per poller), owned by the USER not root.
# B-3-1  remove cleans them; status reports them.
# B-3-2  jobs run as the user (plist has no UserName key → runs as the loading
#        user, never root).
#
# Uses a sandbox HOME so it doesn't touch the user's real LaunchAgents.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."
source ./smoke/_lib.sh

command -v node >/dev/null 2>&1 || { fail "node required"; exit 1; }
[[ -f ingress/schedule.sh ]] || { fail "ingress/schedule.sh missing"; exit 1; }
[[ "$(uname -s)" == "Darwin" ]] || { warn "B-3 launchd tests are macOS-only; skipping on $(uname -s)"; exit 0; }

SBX_HOME="$(mktemp -d /tmp/inghome.XXXXXX)"
trap 'rm -rf "$SBX_HOME"' EXIT
SBX_PI="$SBX_HOME/.pi"
mkdir -p "$SBX_PI/agent" "$SBX_HOME/Library/LaunchAgents"

# two enabled pollers + one paused (paused must be skipped)
cat > "$SBX_PI/agent/settings.json" <<JSON
{ "ingress": { "pollers": [
  { "name": "hn", "kind": "rss", "url": "https://x", "enabled": true, "every": "6h" },
  { "name": "blog", "kind": "webdiff", "url": "https://y", "enabled": true, "every": "30m" },
  { "name": "paused", "kind": "rss", "url": "https://z", "enabled": false, "every": "1h" }
]}}
JSON

export HOME="$SBX_HOME"
export PI_CODING_AGENT_DIR="$SBX_PI"

header "B-3-1: install creates a launchd plist per ENABLED poller (paused skipped)"
bash ingress/schedule.sh install 2>&1 | grep -vE "OSC emit|supacode" | tail -5
PLIST_HN="$SBX_HOME/Library/LaunchAgents/com.applepi.ingress.hn.plist"
PLIST_BLOG="$SBX_HOME/Library/LaunchAgents/com.applepi.ingress.blog.plist"
PLIST_PAUSED="$SBX_HOME/Library/LaunchAgents/com.applepi.ingress.paused.plist"
[[ -f "$PLIST_HN" ]]   || { fail "B-3-1: hn plist not created"; exit 1; }
[[ -f "$PLIST_BLOG" ]] || { fail "B-3-1: blog plist not created"; exit 1; }
[[ -f "$PLIST_PAUSED" ]] && { fail "B-3-1: paused poller got a plist (should be skipped)"; exit 1; }
ok "B-3-1: enabled pollers → plists; paused skipped"

header "B-3-1: every → StartInterval (6h=21600, 30m=1800)"
grep -q "<integer>21600</integer>" "$PLIST_HN"   || { fail "B-3-1: hn interval wrong"; exit 1; }
grep -q "<integer>1800</integer>" "$PLIST_BLOG"  || { fail "B-3-1: blog interval wrong"; exit 1; }
ok "B-3-1: every spec → correct StartInterval"

header "B-3-2: jobs never run as root (no UserName key → loading user)"
grep -q "<key>UserName</key>" "$PLIST_HN" \
	&& { fail "B-3-2: plist has a UserName key (could escalate)"; exit 1; } || true
ok "B-3-2: no UserName key → runs as the user, never root"

header "B-3-1: status reports installed jobs"
bash ingress/schedule.sh status 2>&1 | grep -vE "OSC emit|supacode" | grep -c "installed" | grep -q "^2$" \
	|| { fail "B-3-1: status didn't report 2 installed jobs"; exit 1; }
ok "B-3-1: status reports the 2 installed jobs"

header "B-3-1: remove cleans all ingress plists"
bash ingress/schedule.sh remove 2>&1 | grep -vE "OSC emit|supacode" | tail -3
[[ -f "$PLIST_HN" ]]   && { fail "B-3-1: hn plist survived remove"; exit 1; } || true
[[ -f "$PLIST_BLOG" ]] && { fail "B-3-1: blog plist survived remove"; exit 1; } || true
ok "B-3-1: remove cleans all ingress plists"

ok "ingress-schedule"
