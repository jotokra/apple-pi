#!/bin/bash
# smoke/mcp-bridge-ext.sh — REQ-A-3: the mcp-bridge extension loads + bridges
# a real MCP server's tools, with consent + cleanup, under real pi (RPC).
#
# A-3-1  bridge loads when present in the pi-dir extensions tree; a trusted
#        server's tools are registered (the agent can call them).
# A-3-3  no orphan server process after session end (the orphan-ffmpeg lesson).
# A-6-1  (consent) an UNtrusted server is registered-but-skipped with a message.
#
# Uses real `pi --mode rpc` because the bridge registers tools in session_start,
# which the real session emits (SDK inMemory snapshots tools before that fires).

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."
source ./smoke/_lib.sh

command -v pi >/dev/null 2>&1 || { fail "pi required"; exit 1; }
[[ -f mcp-bridge/index.ts ]] || { fail "mcp-bridge/index.ts missing"; exit 1; }

SBX="$(mktemp -d /tmp/mcpe.XXXXXX)"
trap 'rm -rf "$SBX"' EXIT
mkdir -p "$SBX/extensions/mcp-bridge/lib" "$SBX/extensions/mcp-bridge/test" "$SBX/agent"
cp mcp-bridge/index.ts "$SBX/extensions/mcp-bridge/"
cp mcp-bridge/lib/*.js "$SBX/extensions/mcp-bridge/lib/"
cp mcp-bridge/test/fake-server.js "$SBX/extensions/mcp-bridge/test/"
FAKE="$SBX/extensions/mcp-bridge/test/fake-server.js"
export PI_CODING_AGENT_DIR="$SBX"

rpc_session() {
	# $1 = settings json; echo the rpc output for one get_state + a beat
	echo "$1" > "$SBX/agent/settings.json"
	( echo '{"id":"t","type":"get_state"}'; sleep 1.5 ) | pi --mode rpc --no-session 2>&1
}

header "A-3-1: trusted server → tools bridged (notify 'ready')"
OUT=$(rpc_session "$(cat <<JSON
{"defaultModel":"gpt-test","extensions":[],"tools":{"allow":["read","bash"]},
 "mcp":{"trustedServers":["fake"],"servers":[{"name":"fake","command":"$(which node)","args":["$FAKE"]}]}}
JSON
)")
echo "$OUT" | grep -q 'ready ([0-9] tools)' \
	|| { fail "A-3-1: trusted server did not bridge (no 'ready' notify)"; echo "$OUT" | tail -4; exit 1; }
ok "A-3-1: trusted MCP server bridged (1 tool)"

header "A-6-1: untrusted server → skipped with a consent message"
OUT2=$(rpc_session "$(cat <<JSON
{"defaultModel":"gpt-test","extensions":[],"tools":{"allow":["read","bash"]},
 "mcp":{"trustedServers":[],"servers":[{"name":"fake","command":"$(which node)","args":["$FAKE"]}]}}
JSON
)")
# must NOT be ready, and MUST show the trust hint
echo "$OUT" | grep -q 'fake. ready' \
	&& { fail "A-6-1: untrusted server was started anyway (consent broken)"; exit 1; }
echo "$OUT2" | grep -q 'sources trust fake' \
	|| { fail "A-6-1: no consent message for untrusted server"; exit 1; }
ok "A-6-1: untrusted server skipped, consent message shown"

header "A-3-3: no orphan server process after session ends"
# the rpc_session above already ended; check no fake-server lingers
sleep 0.4
REMAINING=$(pgrep -f fake-server.js | wc -l | tr -d ' ')
[[ "$REMAINING" -eq 0 ]] \
	|| { fail "A-3-3: ${REMAINING} orphan MCP server process(es) after session end"; exit 1; }
ok "A-3-3: no orphan MCP server processes"

ok "mcp-bridge-ext"
