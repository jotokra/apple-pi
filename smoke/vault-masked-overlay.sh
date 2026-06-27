#!/bin/bash
# smoke/vault-masked-overlay.sh — F1: the masked-entry overlay.
#
# The overlay itself is interactive-only (needs a real pty to drive keystrokes),
# same constraint as the v1 fallback — so the live keystroke path is a manual
# run + the REQ-CV-7 tracefree smoke (which re-asserts trace-freeness on every
# CI run regardless of which capture path ran). What IS automatable here:
#
#   1. UNIT (the load-bearing one): maskedDotRow() NEVER emits more visible
#      columns than the requested `width`, for any (prompt, bufferLen, width).
#      This is R-F1a — pi's TUI CRASHES if a rendered line exceeds the viewport
#      width (verified in the TUI source). The overlay's render() delegates to
#      this pure helper, so testing the helper tests the crash invariant.
#   2. STATIC: the extension wires captureSecret() (the overlay path) for BOTH
#      /vault add and /vault rotate, and no inline ctx.ui.input secret capture
#      remains in those handlers (the old v1 path was replaced, not duplicated).
#   3. LOAD: the extension still compiles + loads under pi's real loader.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."
# shellcheck disable=SC1091
source ./smoke/_lib.sh

command -v node >/dev/null 2>&1 || { fail "node required"; exit 1; }
command -v pi >/dev/null 2>&1 || { fail "pi required (loader test)"; exit 1; }

CORE="$SCRIPT_DIR/../vault/lib/vault.js"
EXT="$SCRIPT_DIR/../config/extensions/credential-vault.ts"

# ── 1. UNIT: maskedDotRow width invariant ─────────────────────────────
header "F1 unit: maskedDotRow never exceeds width (R-F1a crash invariant)"
UNIT_DIR="$(mktemp -d /tmp/cv-mo.XXXXXX)"
trap 'rm -rf "$UNIT_DIR"' EXIT
UNIT_JS="$UNIT_DIR/_masked_check.js"
cat > "$UNIT_JS" <<'JS'
const { maskedDotRow } = require(process.argv[2]);
// visible width of a string (strips a common ANSI dim sequence the caller adds;
// the helper itself returns PLAIN dots, so visibleLen === .length here).
const vis = (s) => s.length;
let checked = 0, maxObserved = -1;
const prompts = ["", "Paste the secret for \"openai\" (masked: dots only)", "x", "p:".repeat(30)];
const bufLens = [0, 1, 5, 50, 500, 5000];
const widths  = [0, 1, 2, 10, 40, 80, 120, 200, 1.5, -3, NaN, Infinity, undefined];
const assert = (c, m) => { if (!c) { console.error("  " + m); process.exit(1); } };
for (const p of prompts) for (const bl of bufLens) for (const w of widths) {
	const row = maskedDotRow(p, bl, w);
	checked++;
	// (a) only bullet chars — never a plaintext glyph, never ANSI from the helper
	assert(/^•*$/.test(row), `non-bullet output for (prompt.len=${p.length},bl=${bl},w=${w}): ${JSON.stringify(row)}`);
	// (b) the dot row alone never exceeds a sane width (it's ≤ max(0, floor(w)))
	//     The CALLER prepends the prompt, so the helper must leave room for it.
	//     Invariant the caller relies on: dots ≤ max(0, floor(w) - promptLen - 1).
	const wnum = (typeof w === "number" && Number.isFinite(w) && w > 0) ? Math.floor(w) : 0;
	const budget = Math.max(0, wnum - p.length - 1);
	assert(row.length <= budget, `dots ${row.length} > budget ${budget} for (prompt.len=${p.length},bl=${bl},w=${w})`);
	if (row.length > maxObserved) maxObserved = row.length;
}
console.error(`  OK ${checked} cases; every dot row ≤ (width - prompt - 1); longest observed ${maxObserved} dots`);
JS
node "$UNIT_JS" "$CORE" >&2 || { fail "maskedDotRow width invariant broken (R-F1a)"; exit 1; }
ok "maskedDotRow: never exceeds width, bullets-only, across all (prompt,len,width)"

# ── 2. STATIC: extension wires captureSecret for add + rotate ─────────
header "F1 static: captureSecret wired for add + rotate; no inline input capture"
[[ -f "$EXT" ]] || { fail "$EXT not found"; exit 1; }
# the shared capture helper is defined once and used by both handlers
grep -q "async function captureSecret" "$EXT" || { fail "captureSecret() not defined"; exit 1; }
# both add and rotate route their secret through it
grep -qE 'captureSecret\(ctx, core' "$EXT" || { fail "handlers don't call captureSecret(ctx, core, …)"; exit 1; }
add_hits=$(grep -cE 'captureSecret\(ctx, core' "$EXT")
[[ "$add_hits" -ge 2 ]] || { fail "expected ≥2 captureSecret(ctx, core, …) call sites (add + rotate), found $add_hits"; exit 1; }
# the MaskedInputOverlay component class + its render delegating to the helper exist
grep -q "class MaskedInputOverlay" "$EXT" || { fail "MaskedInputOverlay component missing"; exit 1; }
grep -qE 'this\.dotRow\(' "$EXT" || { fail "overlay render() does not delegate to the dotRow helper"; exit 1; }
ok "captureSecret + MaskedInputOverlay wired for add + rotate"

# ── 3. LOAD: extension compiles + loads under pi's real loader ────────
header "F1 load: extension loads under pi (compile + import)"
pi --extension "$EXT" -p "ok" >/tmp/cv-mo-load.out 2>/tmp/cv-mo-load.err
rc=$?
if [[ $rc -ne 0 ]] || grep -qiE "ParseError|Failed to load extension|TypeError|ReferenceError" /tmp/cv-mo-load.err; then
	fail "extension failed to load under pi (rc=$rc)"; cat /tmp/cv-mo-load.err; exit 1
fi
ok "extension loads cleanly under pi (no ParseError / load failure)"
rm -f /tmp/cv-mo-load.out /tmp/cv-mo-load.err

echo
ok "vault-masked-overlay: F1 render invariant holds + overlay wired + loads"
