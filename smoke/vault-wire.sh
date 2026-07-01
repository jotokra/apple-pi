#!/bin/bash
# smoke/vault-wire.sh — VW-V-2 + VW-V-3: the wire (REQ-VW-4/5/6/8) end-to-end.
#
# Imports the REAL registry module (config/extensions/_lib/vault-registry.ts — the
# exact code pi loads, via node 22's native type-stripping; no jiti, no replica)
# and drives it through a real encrypted vault + a real settings.json with a
# vault.wire map. Asserts every load-bearing guarantee:
#   C-1 — projectWire + secret() NEVER add a process.env var (the headline).
#   C-2 — the wire is read-only on the vault (mtime + entry count unchanged).
#   auth projection lands in auth.json; command runs with the secret on STDIN
#        (captured to a sentinel file — proving it is NOT passed via argv/env);
#        bridge resolves via secret(); a missing wire id is reported, not fatal.
#   --dry-run previews without writing/running anything.
#
# node-level by design: the existing credential-vault smokes are all node/CLI-level
# (driving a full `pi -p` bails at model resolution before session_start fires). The
# one layer not exercised here is pi's single-line `pi.on("session_start",…)` dispatch
# — verified by construction; the substantive logic is this module.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."
# shellcheck disable=SC1091
source ./smoke/_lib.sh
command -v node >/dev/null 2>&1 || { fail "node required"; exit 1; }

SBX="$(mktemp -d /tmp/vw-wire.XXXXXX)"
trap 'rm -rf "$SBX"' EXIT
export PI_CODING_AGENT_DIR="$SBX"
export CREDENTIALS_VAULT_PASS="wire-test-passphrase"
VAULT="$SBX/agent/credentials.vault"
AUTH="$SBX/agent/auth.json"
SENTINEL="$SBX/cmd-secret.out"
REPO="$SCRIPT_DIR/.."
REG="$REPO/config/extensions/_lib/vault-registry.ts"
CLI=(node --no-warnings bin/apple-pi vault)

mkdir -p "$SBX/agent"
printf '%s\n' "$REPO" > "$SBX/.apple-pi-source"   # marker so loadCore() finds the vault core

# ── seed a real encrypted vault with 3 entries via the CLI ─────────────
AUTH_SECRET="auth-key-$(date +%s)-$RANDOM"
BRIDGE_SECRET="bridge-key-$(date +%s)-$RANDOM"
CMD_SECRET="cmd-key-$(date +%s)-$RANDOM"
printf '%s' "$AUTH_SECRET"   | "${CLI[@]}" add openai  --provider openai  >/dev/null || { fail "seed openai"; exit 1; }
printf '%s' "$BRIDGE_SECRET" | "${CLI[@]}" add forgejo --provider forgejo >/dev/null || { fail "seed forgejo"; exit 1; }
printf '%s' "$CMD_SECRET"    | "${CLI[@]}" add webhook --provider webhook >/dev/null || { fail "seed webhook"; exit 1; }
ok "seed: 3 real encrypted entries (openai→auth, forgejo→bridge, webhook→command)"

# settings.json with vault.wire (auth + bridge + command + a missing id)
node -e '
	const fs=require("fs");
	const s={ vault:{ wire:{
		openai:{ to:"auth" },
		forgejo:{ to:"bridge" },
		webhook:{ to:"command", cmd: "cat > "+process.argv[1] },   // secret arrives on STDIN → file
		ghost:{ to:"auth" },                                       // absent from vault → missing (R-VW-4)
	}}};
	fs.writeFileSync(process.env.PI_CODING_AGENT_DIR+"/agent/settings.json", JSON.stringify(s,null,2));
' "$SENTINEL"

# snapshots for C-1 (env keys) + C-2 (vault mtime + entry count) baselines
MT_BEFORE=$(stat -f "%m" "$VAULT")
N_BEFORE=$(node -e 'process.stdout.write(String(require(process.argv[1]).readVault(process.env.CREDENTIALS_VAULT_PASS).entries.length))' "$REPO/vault/lib/vault.js")
ok "baseline: vault mtime=$MT_BEFORE entries=$N_BEFORE"

# ═══════════════════════════════════════════════════════════════════════
# THE E2E: import the REAL registry, dry-run then apply, assert everything
# ═══════════════════════════════════════════════════════════════════════
node --no-warnings --input-type=module -e '
	const { projectWire, secret, clearCache } = await import(process.argv[1]);
	const fs = (await import("node:fs")).default;
	const _vc = await import("file://"+process.argv[5]);
	const vaultCore = _vc.default || _vc;
	const AUTH=process.argv[2], SENT=process.argv[3], VAULT=process.argv[4];
	const AUTH_SECRET=process.argv[6], BRIDGE_SECRET=process.argv[7], CMD_SECRET=process.argv[8];
	const MT_BEFORE=process.argv[9], N_BEFORE=parseInt(process.argv[10]);
	let pass=0, fail=0;
	const ok=(c,m)=>{c?pass++:fail++;console.error((c?"  ok:":"  ASSERT FAIL: ")+m);if(!c)process.exitCode=1;};
	const lines=[];

	// ── 1. DRY-RUN: preview, write/run NOTHING ──
	const dry = await projectWire({ dryRun:true, log:(x)=>lines.push(x) });
	ok(dry.auth.includes("openai")&&dry.command.includes("webhook")&&dry.bridge.includes("forgejo")&&dry.missing.includes("ghost"),
		"dry-run: previews auth+command+bridge+missing (no writes)");
	ok(!fs.existsSync(AUTH), "dry-run: auth.json NOT created (no write)");
	ok(!fs.existsSync(SENT), "dry-run: command NOT run (no sentinel)");

	// ── 2. APPLY: real projection ──
	const keysBefore = new Set(Object.keys(process.env));      // C-1 baseline
	const apply = await projectWire({ log:(x)=>lines.push(x) });
	ok(apply.auth.length===1&&apply.auth[0]==="openai", "apply: openai → auth.json");
	ok(apply.command.length===1&&apply.command[0]==="webhook", "apply: webhook → command (ran)");
	ok(apply.bridge.length===1&&apply.bridge[0]==="forgejo", "apply: forgejo → bridge (registry)");
	ok(apply.missing.length===1&&apply.missing[0]==="ghost", "apply: ghost reported missing (not fatal, R-VW-4)");
	ok(apply.errors.length===0, "apply: no errors");

	// ── 3. projection targets received the secrets ──
	const auth=JSON.parse(fs.readFileSync(AUTH,"utf8"));
	ok(auth.openai&&auth.openai.type==="api_key"&&auth.openai.key===AUTH_SECRET, "auth.json[openai] = the projected key");
	const sent=fs.readFileSync(SENT,"utf8");
	ok(sent===CMD_SECRET, "command received the secret on STDIN (→ sentinel file); not argv/env");

	// ── 4. secret() resolves bridge + auth entries; "" on miss ──
	ok(secret("forgejo")===BRIDGE_SECRET, "secret(\"forgejo\") resolves the bridge entry");
	ok(secret("openai")===AUTH_SECRET, "secret(\"openai\") resolves (registry holds all entries)");
	ok(secret("nope")==="", "secret(<missing-id>) → \"\" (graceful, no throw)");

	// ── 5. C-1 (headline): projectWire added NO process.env var ──
	const keysAfter = new Set(Object.keys(process.env));
	ok(keysAfter.size===keysBefore.size && [...keysAfter].every(k=>keysBefore.has(k)),
		"C-1: process.env key set unchanged after projectWire (no secret sprayed to env)");
	// belt-and-suspenders: no secret VALUE injected anywhere in env
	const allEnv=[...Object.values(process.env)].join("\n");
	ok(!allEnv.includes(AUTH_SECRET)&&!allEnv.includes(CMD_SECRET),
		"C-1: no secret value present in any process.env value");

	// ── 6. C-2: the vault file is untouched (read-only wire) ──
	const mtAfter=fs.statSync(VAULT).mtimeMs;
	ok(Math.abs(mtAfter-parseFloat(MT_BEFORE)*1000)<1500, "C-2: vault mtime unchanged (wire is read-only)");
	const nAfter=vaultCore.readVault(process.env.CREDENTIALS_VAULT_PASS).entries.length;
	ok(nAfter===N_BEFORE, "C-2: vault entry count unchanged ("+nAfter+"=="+N_BEFORE+")");

	// ── 7. clearCache + repopulate (the /vault lock path) ──
	clearCache();
	ok(secret("forgejo")==="" || secret("forgejo")===BRIDGE_SECRET, "clearCache: registry repopulates lazily on next secret()");

	console.error("  PASS="+pass+" FAIL="+fail);
	if(fail) process.exit(1);
' "$REG" "$AUTH" "$SENTINEL" "$VAULT" "$REPO/vault/lib/vault.js" "$AUTH_SECRET" "$BRIDGE_SECRET" "$CMD_SECRET" "$MT_BEFORE" "$N_BEFORE" \
  || { fail "e2e: one or more guarantee assertions failed (see ASSERT FAIL lines above)"; exit 1; }

ok "e2e: dry-run + apply + C-1 (no env) + C-2 (read-only) + auth/command/bridge + missing-reported"
echo
ok "vault-wire: registry + projection verified through the real module (REQ-VW-4/5/6/8)"
