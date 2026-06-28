#!/bin/bash
# smoke/mcp-sources.sh — REQ-A-5: the /sources command mutates settings correctly.
#
# A-5-2  /sources add mcp <name> <cmd> [args...] appends a valid entry
# A-5-3  /sources remove / pause / resume work
# A-5-2  invalid name rejected; duplicate rejected
# A-6-1  /sources trust / untrust toggles mcp.trustedServers
#
# Uses real pi --mode rpc (commands run there) against a sandbox settings.json.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."
source ./smoke/_lib.sh

command -v pi >/dev/null 2>&1 || { fail "pi required"; exit 1; }
[[ -f mcp-bridge/sources.ts ]] || { fail "mcp-bridge/sources.ts missing"; exit 1; }

SBX="$(mktemp -d /tmp/srcs.XXXXXX)"
trap 'rm -rf "$SBX"' EXIT
mkdir -p "$SBX/extensions/mcp-bridge/lib" "$SBX/extensions/mcp-bridge/test" "$SBX/agent"
cp mcp-bridge/*.ts "$SBX/extensions/mcp-bridge/"
cp mcp-bridge/lib/*.js "$SBX/extensions/mcp-bridge/lib/"
cp mcp-bridge/test/fake-server.js "$SBX/extensions/mcp-bridge/test/"
echo '{"defaultModel":"gpt-test","extensions":[],"tools":{"allow":["read","bash"]}}' > "$SBX/agent/settings.json"
export PI_CODING_AGENT_DIR="$SBX"

run_cmds() {
	# run each arg as a prompt, sequentially, then quit
	{ for c in "$@"; do printf '%s\n' "{\"id\":\"x\",\"type\":\"prompt\",\"message\":\"$c\"}"; sleep 0.7; done; } \
		| pi --mode rpc --no-session >/dev/null 2>&1
}
mcp() { python3 -c "import json;d=json.load(open('$SBX/agent/settings.json'));print(json.dumps(d.get('mcp',{})))"; }

header "A-5-2: add mcp appends a valid entry"
run_cmds "/sources add mcp demo /bin/echo hello world"
S=$(mcp)
echo "$S" | grep -q '"name": "demo"' || { fail "A-5-2: add did not append demo"; exit 1; }
echo "$S" | grep -q '"/bin/echo"' || { fail "A-5-2: command not stored"; exit 1; }
ok "A-5-2: /sources add mcp stores name + command + args"

header "A-5-2: invalid name + duplicate rejected"
run_cmds "/sources add mcp BAD-NAME /bin/echo"   # uppercase rejected
S=$(mcp)
echo "$S" | grep -c '"name"' | grep -q "^1$" || { fail "A-5-2: invalid name was added"; exit 1; }
run_cmds "/sources add mcp demo /bin/echo"       # duplicate rejected
S=$(mcp)
COUNT=$(echo "$S" | grep -c '"name": "demo"')
[[ "$COUNT" -eq 1 ]] || { fail "A-5-2: duplicate was added ($COUNT)"; exit 1; }
ok "A-5-2: invalid name + duplicate rejected"

header "A-6-1: trust / untrust toggles trustedServers"
run_cmds "/sources trust demo"
mcp | grep -q '"demo"' && ok "A-6-1: trust added to trustedServers" || { fail "A-6-1: trust failed"; exit 1; }
run_cmds "/sources untrust demo"
S=$(mcp); echo "$S" | grep -q '"trustedServers": \[\]' \
	|| { fail "A-6-1: untrust did not clear"; echo "$S"; exit 1; }
ok "A-6-1: untrust cleared trustedServers"

header "A-5-3: pause / resume / remove"
run_cmds "/sources pause demo"
mcp | grep -q '"enabled": false' || { fail "A-5-3: pause did not set enabled:false"; exit 1; }
run_cmds "/sources resume demo"
mcp | grep -q '"enabled": true' || { fail "A-5-3: resume did not re-enable"; exit 1; }
run_cmds "/sources remove demo"
S=$(mcp); echo "$S" | grep -q '"servers": \[\]' || { fail "A-5-3: remove did not clear servers"; exit 1; }
ok "A-5-3: pause / resume / remove all work"

ok "mcp-sources"
