#!/bin/bash
# smoke/vault-pi-load.sh — does credential-vault.ts load + register under pi?
#
# The vault-wire node-level smokes (vault-wire.sh, vault-keychain.sh) prove the
# MODULE LOGIC is correct. They do NOT prove the EXTENSION loads under pi's real
# loader (jiti) — and during P1 a real gap hid there for an hour: node-native
# type-stripping accepts a module that jiti can choke on (import-resolution,
# createRequire-on-eval, CJS/ESM interop). This smoke closes that gap directly.
#
# How: a temp WRAPPER extension (in a sandbox) imports the default factory from
# the REAL shipped credential-vault.ts, calls it with a mock ExtensionAPI (the
# way pi does at startup), and writes what registered to a result file. We load
# the wrapper via `pi -e` (pi's real jiti transpile + import resolution), so the
# whole import chain — credential-vault.ts → ./_lib/vault-registry → node:* +
# @earendil-works/* — resolves exactly as it does in a live session. If jiti
# can't transpile, an import is wrong, or the factory throws on registration,
# the result says ran:false (or the file never appears).
#
# Key-free + portable: the factory runs BEFORE model resolution (verified), so no
# API key / keychain is needed — pi bails at "No API key" AFTER the factory ran.
# Skips (exit 0, warn) if `pi` isn't on PATH, so apple-pi's keyless CI stays green.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."
# shellcheck disable=SC1091
source ./smoke/_lib.sh

command -v node >/dev/null 2>&1 || { fail "node required"; exit 1; }
command -v pi   >/dev/null 2>&1 || { warn "pi not on PATH — skipping (the load smoke needs pi; keyless CI has none)"; echo "OK   vault-pi-load (skipped: no pi)"; exit 0; }

REPO="$SCRIPT_DIR/.."
EXT="$REPO/config/extensions/credential-vault.ts"
[[ -f "$EXT" ]] || { fail "credential-vault.ts not found at $EXT"; exit 1; }

SBX="$(mktemp -d /tmp/vw-load.XXXXXX)"
RESULT="$SBX/result.json"
trap 'rm -rf "$SBX"' EXIT
mkdir -p "$SBX/agent/extensions"
# marker so vault-registry's lazy loadCore (not hit at registration, but complete)
# would resolve; harmless if the repo's vault core isn't present.
printf '%s\n' "$REPO" > "$SBX/.apple-pi-source"

# the wrapper: import the REAL factory, call it with a mock pi, record what registered
cat > "$SBX/agent/extensions/wrap.ts" <<EOF
import * as fs from "node:fs";
import factory from "$EXT";
const calls = { commands: [] as string[], events: [] as string[] };
const mockPi: any = {
	registerCommand: (name: string) => calls.commands.push(name),
	on: (ev: string) => calls.events.push(ev),
};
try {
	factory(mockPi);   // run the factory EXACTLY as pi does at startup
	fs.writeFileSync("$RESULT", JSON.stringify({ ran: true, commands: calls.commands, events: calls.events }));
} catch (e: any) {
	fs.writeFileSync("$RESULT", JSON.stringify({ ran: false, error: String(e && e.message || e), stack: String(e && e.stack || "").split("\\n").slice(0, 5) }));
}
export default function () {};   // pi requires a default factory from the -e entry
EOF
# sandbox settings: a provider that needs a key we DON'T provide → pi bails at
# resolution, but only AFTER the extension factory has run (proven pre-resolution).
cat > "$SBX/agent/settings.json" <<'EOF'
{ "defaultProvider":"<provider>","defaultModel":"glm-4.5-air","tools":{"allow":["bash"]} }
EOF

export PI_CODING_AGENT_DIR="$SBX"
PI_OUT="$SBX/pi.out"; PI_ERR="$SBX/pi.err"
header "load credential-vault.ts under pi's real loader (pi -e)"

# Run pi in the background (it may hang on the no-key bail waiting for input);
# poll for the result file up to 20s, then kill.
( pi --offline --no-session -e "$SBX/agent/extensions/wrap.ts" -p "x" </dev/null >"$PI_OUT" 2>"$PI_ERR" ) &
PID=$!
GOT=""
for i in $(seq 1 20); do
	[[ -f "$RESULT" ]] && { GOT="$RESULT"; break; }
	kill -0 $PID 2>/dev/null || break
	sleep 1
done
kill -9 $PID 2>/dev/null; wait $PID 2>/dev/null

# ── 1. the wrapper ran at all (import chain resolved under jiti) ─────────
if [[ -z "$GOT" ]]; then
	fail "the wrapper never wrote a result — pi didn't load/run it (import chain broken?)"
	echo "--- pi stderr ---"; head -10 "$PI_ERR" | sed 's/^/  /'
	exit 1
fi
ok "wrapper ran under pi -e (the import chain credential-vault → _lib/vault-registry → @earendil-works/* resolved under jiti)"

# ── 2. parse the result ─────────────────────────────────────────────────
node -e '
	const r = JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
	let pass=0, fail=0;
	const ok=(c,m)=>{c?pass++:fail++;console.error((c?"  ok:":"  ASSERT FAIL: ")+m);if(!c)process.exitCode=1;};
	ok(r.ran===true, "factory ran without throwing");
	if (r.ran) {
		ok(Array.isArray(r.commands)&&r.commands.includes("vault"), "/vault command registered");
		ok(Array.isArray(r.events)&&r.events.includes("session_start"), "session_start handler registered (the auto-wire)");
	} else {
		ok(false, "factory threw: "+r.error); if(r.stack)console.error("    "+r.stack.join("\n    "));
	}
	if (fail) process.exit(1);
' "$RESULT" || { fail "a load assertion failed (see above)"; exit 1; }

# ── 3. belt-and-suspenders: no extension-load error in pi's output ───────
if grep -qiE "cannot find module|syntaxerror|is not a function|failed to load extension|extension.*error" "$PI_OUT" "$PI_ERR"; then
	fail "extension-load error detected in pi output:"
	grep -iE "cannot find module|syntaxerror|is not a function|failed to load extension|extension.*error" "$PI_OUT" "$PI_ERR" | sed 's/^/  /'
	exit 1
fi
ok "no extension-load error in pi output"

echo
ok "vault-pi-load: credential-vault.ts loads + registers /vault + session_start under pi's real loader"
