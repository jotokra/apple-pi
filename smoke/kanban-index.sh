#!/bin/bash
# smoke/kanban-index.sh — REQ-M8-1 / M10-1: the `apple-pi kanban index` CLI,
# end-to-end through the REAL bin/apple-pi wrapper.
#
# Facets covered (SPEC "index" + "disposable db"):
#   - index --rebuild   exits 0, reports the kb_cards row count, indexes disk
#   - index (default)   ensureCurrent converged over a current mirror -> noop
#   - disposable DB     the AGENT_DB file is created on demand by the CLI,
#                       and is FULLY RECONSTRUCTABLE from the on-disk truth:
#                       delete the DB file, rebuild, and every card is back.
#                       (The kb_* mirror is disposable; .card.md is the truth.)
#
# Drives the real `node --no-warnings bin/apple-pi kanban ...` subprocess against
# a throwaway cwd + throwaway $AGENT_DB. The live ~/.pi/agent/agent.db is never
# referenced. Mirrors bin/apple-pi.kanban.index.test.js (the node:test suite).

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."
# shellcheck disable=SC1091
source ./smoke/_lib.sh

command -v node >/dev/null 2>&1 || { fail "node required"; exit 1; }
[[ -f agentdb/cli.js ]] || { fail "agentdb/cli.js missing"; exit 1; }

BIN="$SCRIPT_DIR/../bin/apple-pi"
CLI=(node --no-warnings "$BIN" kanban)

# card(id, status, deps) -> a .card.md body (same template the kb/ suites use).
card() {
	cat <<EOF
---
id: $1
title: Card $1
status: $2
project: apple-pi
parent: root
depends_on: $3
created_at: 2026-07-02T22:00:00Z
updated_at: 2026-07-02T22:00:00Z
---

# Card $1
Body for $1.
EOF
}

# jget PATH JSON_STR -> prints the dotted-path value (via node -p).
jget() { node -pe "JSON.parse(process.argv[1]).$1" "$2"; }

SBX="$(mktemp -d /tmp/kb-idx.XXXXXX)"
trap 'rm -rf "$SBX"' EXIT
ROOT="$SBX/root"
DB="$SBX/agent.db"
export AGENT_DB="$DB"
mkdir -p "$ROOT/cards"
card a todo "[]" > "$ROOT/cards/a.card.md"
card b review "[a]" > "$ROOT/cards/b.card.md"

# ── index --rebuild: exit 0, row count, DB created ────────────────────
header "index --rebuild: exit 0, reports row count, creates the DB"
[[ ! -e "$DB" ]] || { fail "precondition: DB must not exist yet"; exit 1; }
OUT=$("${CLI[@]}" index --rebuild --root "$ROOT" 2>/tmp/kb-idx.err); RC=$?
[[ $RC -eq 0 ]] || { fail "index --rebuild exited $RC"; cat /tmp/kb-idx.err; exit 1; }
echo "$OUT" | grep -Eq "cards[[:space:]]*:[[:space:]]*2" \
	|| { fail "stdout should report 'cards: 2'; got:"; echo "$OUT"; exit 1; }
[[ -f "$DB" ]] || { fail "AGENT_DB file was not created by index"; exit 1; }
ok "index --rebuild exits 0, reports 2 cards, creates \$AGENT_DB"

# ── index (default): ensureCurrent over a current mirror -> noop ──────
header "index (default): idempotent noop over a current mirror"
OUT=$("${CLI[@]}" index --root "$ROOT" 2>/tmp/kb-idx.err); RC=$?
[[ $RC -eq 0 ]] || { fail "second index exited $RC"; cat /tmp/kb-idx.err; exit 1; }
echo "$OUT" | grep -qi "noop" \
	|| { fail "second index should report noop (ensureCurrent converged); got:"; echo "$OUT"; exit 1; }
ok "index (default) is a noop when the mirror is current"

# ── disposable DB: delete it, rebuild, every card is back ─────────────
header "disposable DB: delete the DB file, rebuild, all cards reconstruct"
rm -f "$DB"
[[ ! -e "$DB" ]] || { fail "DB file should be gone after rm"; exit 1; }
OUT=$("${CLI[@]}" index --rebuild --root "$ROOT" 2>/tmp/kb-idx.err); RC=$?
[[ $RC -eq 0 ]] || { fail "rebuild after delete exited $RC"; cat /tmp/kb-idx.err; exit 1; }
echo "$OUT" | grep -Eq "cards[[:space:]]*:[[:space:]]*2" \
	|| { fail "rebuild after delete should still report 2 cards; got:"; echo "$OUT"; exit 1; }
[[ -f "$DB" ]] || { fail "DB file recreated by rebuild"; exit 1; }
# the rebuilt disposable DB is queryable through the normal read path
COUNT=$("${CLI[@]}" list --json --root "$ROOT" 2>/dev/null \
	| node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).length))")
[[ "$COUNT" == "2" ]] || { fail "list should see 2 cards in the rebuilt DB; got '$COUNT'"; exit 1; }
ok "DB is disposable: deleted + rebuilt → all cards reconstruct from disk"

rm -f /tmp/kb-idx.err
echo
ok "kanban-index: index --rebuild + noop + disposable DB"
