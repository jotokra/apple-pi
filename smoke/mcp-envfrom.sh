#!/bin/bash
# smoke/mcp-envfrom.sh — REQ-A-4: vault envFrom resolution.
#
# A server with envFrom: { VAR: "vault:<id>" } resolves the secret from the
# credential vault at spawn time. If the named entry is MISSING, the server is
# SKIPPED with a clear message (fail-loud per server, not fail-whole), and
# other servers still load. The secret never reaches settings/logs.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."
source ./smoke/_lib.sh

command -v pi >/dev/null 2>&1 || { fail "pi required"; exit 1; }

SBX="$(mktemp -d /tmp/envf.XXXXXX)"
trap 'rm -rf "$SBX"' EXIT
mkdir -p "$SBX/extensions/mcp-bridge/lib" "$SBX/extensions/mcp-bridge/test" "$SBX/agent"
cp mcp-bridge/*.ts "$SBX/extensions/mcp-bridge/"
cp mcp-bridge/lib/*.js "$SBX/extensions/mcp-bridge/lib/"
cp mcp-bridge/test/fake-server.js "$SBX/extensions/mcp-bridge/test/"
export PI_CODING_AGENT_DIR="$SBX"
export CREDENTIALS_VAULT_PASS="envfrom-test"

# Seed the vault with one entry ("realcred"), but the server will reference a
# DIFFERENT id ("missingcred") to exercise the skip path.
node -e "
const v=require('$(pwd)/vault/lib/vault');
v.ensureVault('envfrom-test');
v.addEntry('envfrom-test',{id:'realcred',secret:'sk-REAL-SECRET',provider:'x'});
" 2>/dev/null

header "A-4-2: missing vault entry → server skipped with clear message"
cat > "$SBX/agent/settings.json" <<JSON
{ "defaultModel":"gpt-test","extensions":[],"tools":{"allow":["read","bash"]},
  "mcp":{ "trustedServers":["needskey"],
    "servers":[{"name":"needskey","command":"$(which node)","args":["$SBX/extensions/mcp-bridge/test/fake-server.js"],
                "envFrom":{"API_KEY":"vault:missingcred"}}]}}
JSON
OUT=$(( echo '{"id":"t","type":"get_state"}'; sleep 1.5 ) | pi --mode rpc --no-session 2>&1)
echo "$OUT" | grep -q 'vault entry missing' \
	|| { fail "A-4-2: missing vault entry did not produce a skip message"; echo "$OUT" | tail -3; exit 1; }
echo "$OUT" | grep -q 'missingcred' \
	|| { fail "A-4-2: skip message didn't name the missing id"; exit 1; }
echo "$OUT" | grep -q 'needskey. ready' \
	&& { fail "A-4-2: server with missing cred was started anyway"; exit 1; }
ok "A-4-2: missing vault entry skips the server, names the id"

header "A-4-1: present vault entry → secret passed to server env (server starts)"
cat > "$SBX/agent/settings.json" <<JSON
{ "defaultModel":"gpt-test","extensions":[],"tools":{"allow":["read","bash"]},
  "mcp":{ "trustedServers":["haskey"],
    "servers":[{"name":"haskey","command":"$(which node)","args":["$SBX/extensions/mcp-bridge/test/fake-server.js"],
                "envFrom":{"API_KEY":"vault:realcred"}}]}}
JSON
OUT=$(( echo '{"id":"t","type":"get_state"}'; sleep 1.5 ) | pi --mode rpc --no-session 2>&1)
echo "$OUT" | grep -q 'ready ([0-9] tools)' \
	|| { fail "A-4-1: server with present vault cred did not start"; echo "$OUT" | tail -3; exit 1; }
ok "A-4-1: present vault entry → server starts"
# the secret itself must NEVER appear in pi's output (it transits vault→child env only)
echo "$OUT" | grep -q 'sk-REAL-SECRET' \
	&& { fail "A-4-1: SECRET LEAKED into pi output"; exit 1; } || ok "A-4-1: secret never appears in pi output"

ok "mcp-envfrom"
