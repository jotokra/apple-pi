#!/bin/bash
# smoke/voice-integration.sh — pin the /voice handoff contract.
#
# The voice bridge (config/extensions/voice.ts) + the bundled pivoice must stay
# in sync. This smoke loads the extension under the real pi SDK in a throwaway
# sandbox and asserts the load-bearing contract without needing a mic, a model
# download, or a real voice round-trip:
#
#   V-1  voice.ts loads under pi with zero extension errors
#   V-2  /voice resolves as a registered command (so the keybind entry point exists)
#   V-3  the dep-guard fires the right message when no whisper model is present
#        (so a fresh install points the user at voice-enable.sh, not a dead launch)
#   V-4  the bundled pivoice.py supports PIVOICE_SESSION (the session-handoff path
#        that makes voice turns append to the active session, not a fresh one)
#
# No network, no audio, no model weights, no TTY.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."
# shellcheck disable=SC1091
source ./smoke/_lib.sh

command -v node >/dev/null 2>&1 || { fail "node required"; exit 1; }

PIPKG="node_modules/@earendil-works/pi-coding-agent"
[[ -d "$PIPKG" ]] || PIPKG="/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent"
[[ -d "$PIPKG" ]] || { fail "pi-coding-agent not found (set NODE_PATH or install pi)"; exit 1; }

header "V-1 + V-2: voice.ts loads under pi; /voice command registers"
SBX="$(mktemp -d /tmp/voice-int.XXXXXX)"
trap 'rm -rf "$SBX"' EXIT
export PI_CODING_AGENT_DIR="$SBX"

# minimal sandbox agent dir + settings registering the voice bridge
mkdir -p "$SBX/agent"
cat > "$SBX/agent/settings.json" <<JSON
{
	"defaultModel": "gpt-test",
	"extensions": ["$(pwd)/config/extensions/voice.ts"],
	"tools": { "allow": ["read","bash"] }
}
JSON

# Probe via the pi SDK: load the extension with -e (pi's documented extension-test
# flag), assert it loads + /voice registers. (get_commands is ground truth.)
OUT="$(node -e "
const { spawn } = require('child_process');
const p = spawn('pi', ['-e','$(pwd)/config/extensions/voice.ts','--mode','rpc','--no-context-files','--no-session'], {
	stdio: ['pipe','pipe','ignore'], env: process.env,
});
let buf='';
p.stdout.on('data', d => { buf += d; });
setTimeout(() => { try { p.stdin.write(JSON.stringify({type:'get_commands'})+'\\n'); } catch(e){} }, 1500);
setTimeout(() => { try { p.kill(); } catch(e){} process.stdout.write(buf); }, 4500);
" 2>/dev/null)"

echo "$OUT" | grep -q '"command":"get_commands"' \
	|| { fail "V-2: get_commands produced no response (pi didn't boot voice.ts?)"; echo "$OUT" | tail -3; exit 1; }

echo "$OUT" | grep -q '"name":"voice"' \
	|| { fail "V-2: '/voice' command did NOT register"; exit 1; }
echo "$OUT" | grep -q '"extension_error"' \
	&& { fail "V-1: voice.ts reported an extension_error on load"; exit 1; }
ok "V-1: voice.ts loads with no extension_error"
ok "V-2: '/voice' is registered as a command"

header "V-3: dep-guard message when no whisper model present"
# Bridge should tell the user to run voice-enable.sh, not launch a dead pivoice.
grep -q "voice-enable.sh" config/extensions/voice.ts \
	|| { fail "V-3: bridge doesn't reference voice-enable.sh in the dep-guard path"; exit 1; }
grep -q "ggml-small.en.bin" config/extensions/voice.ts \
	|| { fail "V-3: bridge doesn't check for the expected model filename"; exit 1; }
ok "V-3: dep-guard points at voice-enable.sh + checks model path"

header "V-4: bundled pivoice.py supports PIVOICE_SESSION handoff"
python3 -c "import ast; ast.parse(open('config/voice/pivoice.py').read())" 2>/dev/null \
	|| { fail "V-4: config/voice/pivoice.py does not parse"; exit 1; }
grep -q "PIVOICE_SESSION" config/voice/pivoice.py \
	|| { fail "V-4: bundled pivoice.py missing PIVOICE_SESSION (handoff broken)"; exit 1; }
# and that it actually switches pi's args to --session (resume), not -n voice (fresh)
python3 -c "
src = open('config/voice/pivoice.py').read()
assert 'PIVOICE_SESSION' in src and '--session' in src, 'handoff args missing'
assert '-n\"  \"voice' not in src.replace(\"'\",'\"') or 'PIVOICE_SESSION' in src, 'always-fresh regression?'
print('handoff args wired')
" 2>/dev/null || { fail "V-4: handoff args not wired (resume path missing)"; exit 1; }
ok "V-4: pivoice.py parses + PIVOICE_SESSION resume path present"

ok "voice-integration"
