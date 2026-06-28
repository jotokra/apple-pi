#!/bin/bash
# smoke/mcp-bridge.sh — REQ-A-2: McpClient round-trips through a fake server.
#
# Pins the foundation of the mcp-bridge (PHASE-A-SPEC.md A-2):
#   A-2-1  initialize handshake → tools/list returns the echo tool
#   A-2-2  a crashed/missing server fails fast (no silent hang) — covered by
#          the bogus-command case below
#   A-2-3  callTool("echo", {msg:"hi"}) returns the echoed content
#
# No pi, no model, no network — pure McpClient ↔ fake-server over stdio.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."
# shellcheck disable=SC1091
source ./smoke/_lib.sh

command -v node >/dev/null 2>&1 || { fail "node required"; exit 1; }
[[ -f mcp-bridge/lib/mcp-client.js ]] || { fail "mcp-bridge/lib/mcp-client.js missing"; exit 1; }
[[ -f mcp-bridge/test/fake-server.js ]] || { fail "mcp-bridge/test/fake-server.js missing"; exit 1; }

header "A-2-1/A-2-3: McpClient ↔ fake-server round-trip (initialize + list + call)"
OUT="$(node -e "
const { McpClient } = require('./mcp-bridge/lib/mcp-client');
(async () => {
  const c = new McpClient({ command: process.execPath, args: ['mcp-bridge/test/fake-server.js'] });
  try {
    await c.connect(5000);
    const tools = await c.listTools(5000);
    console.log('TOOLS:' + tools.map(t => t.name).join(','));
    console.log('SERVER:' + (c.serverInfo && c.serverInfo.name));
    const r = await c.callTool('echo', { msg: 'hello-mcp' }, 5000);
    console.log('CALL:' + (r.content && r.content[0] && r.content[0].text));
  } catch (e) {
    console.log('ERR:' + e.message);
    process.exit(2);
  } finally {
    await c.shutdown();
  }
})();
" 2>&1)"

echo "$OUT" | grep -q "^TOOLS:echo$" \
	|| { fail "A-2-1: listTools did not return [echo]"; echo "$OUT" | tail -5; exit 1; }
echo "$OUT" | grep -q "^SERVER:fake-mcp$" \
	|| { fail "A-2-1: initialize did not yield serverInfo.name"; exit 1; }
echo "$OUT" | grep -q '^CALL:{"msg":"hello-mcp"}$' \
	|| { fail "A-2-3: callTool echo did not return the echoed args"; echo "$OUT" | tail -3; exit 1; }
ok "A-2-1: initialize handshake + tools/list"
ok "A-2-3: tools/call echo round-trips"

header "A-2-2: missing server fails fast (no hang)"
START=$(date +%s)
BOGUS="$(node -e "
const { McpClient } = require('./mcp-bridge/lib/mcp-client');
(async () => {
  const c = new McpClient({ command: '/usr/local/nonexistent-bogus-mcp-binary-xyz' });
  try { await c.connect(3000); console.log('BAD:connected'); }
  catch (e) { console.log('OK:' + e.message.slice(0,50)); }
})();
" 2>&1)"
END=$(date +%s)
ELAPSED=$((END - START))
echo "$BOGUS" | grep -q "^OK:" \
	|| { fail "A-2-2: missing server should have thrown"; echo "$BOGUS"; exit 1; }
[[ $ELAPSED -lt 8 ]] \
	|| { fail "A-2-2: hung for ${ELAPSED}s (should fail fast)"; exit 1; }
ok "A-2-2: missing server fails in ${ELAPSED}s (no hang)"

header "A-2-3: child reaped on shutdown"
PID_BEFORE=$(pgrep -f "fake-server.js" | head -1 || true)
# spawn + shutdown, then check the PID is gone
node -e "
const { McpClient } = require('./mcp-bridge/lib/mcp-client');
(async () => {
  const c = new McpClient({ command: process.execPath, args: ['mcp-bridge/test/fake-server.js'] });
  await c.connect(5000); await new Promise(r=>setTimeout(r,200)); await c.shutdown();
  await new Promise(r=>setTimeout(r,500));
})();
" >/dev/null 2>&1
sleep 0.6
REMAINING=$(pgrep -f "fake-server.js" | wc -l | tr -d ' ')
[[ "$REMAINING" -eq 0 ]] \
	|| { fail "A-2-3: ${REMAINING} fake-server process(es) leaked after shutdown"; exit 1; }
ok "A-2-3: no orphan server processes after shutdown"

ok "mcp-bridge"
