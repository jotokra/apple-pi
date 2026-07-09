#!/bin/bash
# smoke/install-symlink-aware.sh — REQ: install.sh must not destroy a symlinked
# $PI_DIR/<dir>. A user who symlinks ~/.pi/extensions (the config-sync / overlay
# pattern) must not have it materialized into a real dir by a re-run of
# install.sh (the 2026-06-29 incident: rm-then-cp silently replaced the overlay
# with stale generic content).
#
#   ISA-1  _install_tree skips (warns) when $PI_DIR/<kind> is a symlink
#   ISA-2  the symlink + its target's content survive an install.sh run
#   ISA-3  mcp-bridge/ingress also skip when $PI_DIR/extensions is a symlink
#
# Runs the REAL install.sh via the sandbox path (--sandbox + --skip-confirm,
# matching onboard-sandbox.sh), with a symlink pre-seeded, and asserts it
# survives. No network (secrets purged).

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."
# shellcheck disable=SC1091
source ./smoke/_lib.sh

command -v node >/dev/null 2>&1 || { fail "node required"; exit 1; }

SANDBOX="$(mktemp -d)"
trap 'rm -rf "$SANDBOX"' EXIT
SANDBOX_OVL_EXT="$SANDBOX.ovl-ext"
SANDBOX_OVL_SKILLS="$SANDBOX.ovl-skills"
trap 'rm -rf "$SANDBOX" "$SANDBOX_OVL_EXT" "$SANDBOX_OVL_SKILLS"' EXIT

# A pretend overlay target the user manages.
mkdir -p "$SANDBOX_OVL_EXT" "$SANDBOX_OVL_SKILLS"
echo "MY-OVERLAY-EXT" > "$SANDBOX_OVL_EXT/telegram-pi-topic.ts"
echo "MY-OVERLAY-SKILL" > "$SANDBOX_OVL_SKILLS/mine.md"

header "ISA-1 + ISA-2: _install_tree skips a symlinked dst, overlay survives"
# --sandbox forces PI_DIR=$SANDBOX, so the symlinks must live AT the sandbox
# (which IS the pi-dir for the run), pointing at the overlay targets.
ln -sfn "$SANDBOX_OVL_EXT"   "$SANDBOX/extensions"
ln -sfn "$SANDBOX_OVL_SKILLS" "$SANDBOX/skills"

OUT="$(printf 'y\ngpt-4o\nn\nsandbox-key-SECRET123\nhttps://gateway.example/v1\nsb-passphrase\nsb-passphrase\n' \
	| bash install.sh --sandbox "$SANDBOX" --skip-confirm --no-handoff 2>&1 || true)"

# ISA-1: still symlinks (NOT materialized into real dirs)
[[ -L "$SANDBOX/extensions" ]] || { fail "extensions symlink was destroyed/materialized"; echo "$OUT"; exit 1; }
[[ -L "$SANDBOX/skills" ]]     || { fail "skills symlink was destroyed/materialized"; exit 1; }
ok "ISA-1: extensions + skills survived as symlinks"

# ISA-2: the overlay content the user wrote is intact (install did not clobber it)
[[ "$(cat "$SANDBOX_OVL_EXT/telegram-pi-topic.ts")"  == "MY-OVERLAY-EXT" ]]   || { fail "overlay ext content clobbered"; exit 1; }
[[ "$(cat "$SANDBOX_OVL_SKILLS/mine.md")" == "MY-OVERLAY-SKILL" ]] || { fail "overlay skills content clobbered"; exit 1; }
ok "ISA-2: overlay content intact (install respected the symlink)"

# ISA-1b: install.sh told the user what it did (warn lines present)
echo "$OUT" | grep -qi "symlink" || { fail "install.sh did not warn about the symlinks"; exit 1; }
ok "ISA-1b: install.sh reported the symlink skips"

header "ISA-3: mcp-bridge/ingress skip when extensions is a symlink"
# They cp into $PI_DIR/extensions/<subdir>; with extensions symlinked, they must
# skip too (else they'd clobber overlay content through the symlink).
# The same run above already exercised this; assert no mcp-bridge/ingress dirs
# were written INTO the overlay target.
[[ ! -e "$SANDBOX_OVL_EXT/mcp-bridge" ]] || { fail "mcp-bridge was written through the symlink into the overlay"; exit 1; }
[[ ! -e "$SANDBOX_OVL_EXT/ingress" ]]    || { fail "ingress was written through the symlink into the overlay"; exit 1; }
ok "ISA-3: no mcp-bridge/ingress written through the symlink"

echo
echo "== smoke: install-symlink-aware DONE =="
