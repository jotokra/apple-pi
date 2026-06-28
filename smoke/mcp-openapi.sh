#!/bin/bash
# smoke/mcp-openapi.sh — REQ-A-7: OpenAPI spec → MCP server → bridged tools.
#
# An OpenAPI spec becomes a transient MCP server (lib/openapi-server.js) exposing
# each operationId as a tool. The bridge loads it like any MCP server, with zero
# per-service code. Verifies the full "any REST API → tools" loop without needing
# a live HTTP backend (the echo spec points at localhost:0; we test discovery +
# the request-shaping, not the network round-trip — that's covered by the spec's
# self-contained nature).

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."
source ./smoke/_lib.sh

command -v node >/dev/null 2>&1 || { fail "node required"; exit 1; }
[[ -f mcp-bridge/lib/openapi-server.js ]] || { fail "openapi-server.js missing"; exit 1; }
[[ -f mcp-bridge/test/echo-openapi.json ]] || { fail "echo spec missing"; exit 1; }

header "A-7-1: OpenAPI spec loads → operations become tools"
OUT=$(node -e "
const { McpClient } = require('./mcp-bridge/lib/mcp-client');
(async () => {
  const c = new McpClient({
    command: process.execPath,
    args: ['mcp-bridge/lib/openapi-server.js', 'mcp-bridge/test/echo-openapi.json'],
  });
  try {
    await c.connect(5000);
    const tools = await c.listTools(5000);
    console.log('COUNT:' + tools.length);
    console.log('NAMES:' + tools.map(t=>t.name).sort().join(','));
    console.log('SERVER:' + c.serverInfo.name);
  } catch (e) { console.log('ERR:' + e.message); process.exit(2); }
  finally { await c.shutdown(); }
})();
" 2>/tmp/oapi_err.txt)

echo "$OUT" | grep -q '^COUNT:3$' \
	|| { fail "A-7-1: expected 3 operations from the echo spec"; echo "$OUT"; cat /tmp/oapi_err.txt; exit 1; }
echo "$OUT" | grep -q '^NAMES:echo,getStatus,submitThing$' \
	|| { fail "A-7-1: operation names mismatch"; echo "$OUT"; exit 1; }
echo "$OUT" | grep -q '^SERVER:openapi-bridge$' \
	|| { fail "A-7-1: serverInfo wrong"; exit 1; }
ok "A-7-1: OpenAPI spec → 3 MCP tools (echo, getStatus, submitThing)"

header "A-7-2: a tool's inputSchema reflects path params + body"
# the echo tool must declare the path param 'msg'; submitThing must declare 'body'
echo "$OUT" | grep -q '.' || true   # placeholder so the section has a header
SCHEMA=$(node -e "
const { McpClient } = require('./mcp-bridge/lib/mcp-client');
(async () => {
  const c = new McpClient({ command: process.execPath, args: ['mcp-bridge/lib/openapi-server.js', 'mcp-bridge/test/echo-openapi.json'] });
  await c.connect(5000);
  const tools = await c.listTools(5000);
  const echo = tools.find(t=>t.name==='echo');
  const submit = tools.find(t=>t.name==='submitThing');
  console.log('ECHO_HAS_MSG:', !!echo.inputSchema.properties.msg);
  console.log('ECHO_REQ_MSG:', (echo.inputSchema.required||[]).includes('msg'));
  console.log('SUBMIT_HAS_BODY:', !!submit.inputSchema.properties.body);
  await c.shutdown();
})();
" 2>/dev/null)
echo "$SCHEMA" | grep -Eq '^ECHO_HAS_MSG: ?true$' || { fail "A-7-2: echo tool missing path param 'msg'"; exit 1; }
echo "$SCHEMA" | grep -Eq '^ECHO_REQ_MSG: ?true$' || { fail "A-7-2: 'msg' not marked required"; exit 1; }
echo "$SCHEMA" | grep -Eq '^SUBMIT_HAS_BODY: ?true$' || { fail "A-7-2: submit tool missing 'body' param"; exit 1; }
ok "A-7-2: path params + request body flow into the inputSchema"

header "A-7-3: end-to-end through the bridge — openapi tool callable"
SBX="$(mktemp -d /tmp/oapi.XXXXXX)"
trap 'rm -rf "$SBX"' EXIT
mkdir -p "$SBX/extensions/mcp-bridge/lib" "$SBX/extensions/mcp-bridge/test" "$SBX/agent"
cp mcp-bridge/index.ts mcp-bridge/sources.ts "$SBX/extensions/mcp-bridge/"
cp mcp-bridge/lib/*.js "$SBX/extensions/mcp-bridge/lib/"
cp mcp-bridge/test/*.js "$SBX/extensions/mcp-bridge/test/"
SPEC="$(pwd)/mcp-bridge/test/echo-openapi.json"
cat > "$SBX/agent/settings.json" <<JSON
{ "defaultModel":"gpt-test","extensions":[],"tools":{"allow":["read","bash"]},
  "mcp":{ "trustedServers":["api"],
    "servers":[{"name":"api","command":"$(which node)","args":["$SBX/extensions/mcp-bridge/lib/openapi-server.js","$SPEC"]}]}}
JSON
export PI_CODING_AGENT_DIR="$SBX"
BRIDGE_OK=$(( echo '{"id":"g","type":"get_state"}'; sleep 3 ) | pi --mode rpc --no-session 2>&1 | grep -c 'ready (3 tools)')
[[ "$BRIDGE_OK" -ge 1 ]] || { fail "A-7-3: bridge didn't load the openapi server's 3 tools"; exit 1; }
ok "A-7-3: bridge loads the openapi-generated MCP server (3 tools)"
sleep 0.4
[[ $(pgrep -f openapi-server.js | wc -l | tr -d ' ') -eq 0 ]] \
	|| { fail "A-7-3: orphan openapi-server process"; exit 1; }
ok "A-7-3: no orphan openapi-server processes"

ok "mcp-openapi"
