#!/bin/bash
# smoke/kanban-query.sh — REQ-M8-2 / M10-1: the read-only kanban CLI
# (list / show / next / graph), end-to-end through the REAL bin/apple-pi
# wrapper.
#
# Facet covered (SPEC "query"):
#   - list    M3-1 filters AND-compose; --json returns rows
#   - show    single card incl. body; missing id exits non-zero
#   - next    WIP-aware (M0-2) + ready (M3-2): recommends the highest-priority
#             READY card; at the KANBAN_WIP limit a ready card is HELD
#   - graph   edges (depends_on) + ready set + cycles
#
# Drives the real `node --no-warnings bin/apple-pi kanban ...` subprocess against
# a throwaway cwd + throwaway $AGENT_DB (the disposable-DB facet from the index
# smoke; reused here so every read path is isolation-safe). Mirrors
# bin/apple-pi.kanban.list.test.js (the node:test suite + the shared 6-card
# fixture: a,b,c,d,e,f).

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."
# shellcheck disable=SC1091
source ./smoke/_lib.sh

command -v node >/dev/null 2>&1 || { fail "node required"; exit 1; }
[[ -f agentdb/cli.js ]] || { fail "agentdb/cli.js missing"; exit 1; }

BIN="$SCRIPT_DIR/../bin/apple-pi"
CLI=(node --no-warnings "$BIN" kanban)

# card(id, opts...) -> a .card.md body. opts: title status priority assignee
# tags(csv) deps(csv). Same 6-card fixture the node:test suite uses.
#   a : todo   p5  alice [m8,ready] deps=[]      -> READY (lowest-priority ready)
#   b : todo   p8  bob   [m8]        deps=[c]    -> READY (c done) — top ready
#   c : done   p5  alice [m8]        deps=[]     -> the satisfied dep of b
#   d : todo   p9  bob   [m8]        deps=[e]    -> NOT READY (e in_progress)
#   e : in_progress p5  alice [m8]   deps=[]     -> WIP
#   f : in_progress p3  bob   [m8]   deps=[]     -> WIP
# ready()={a,b}; WIP count=2; default WIP limit=3.
card() {
	local id="$1" title="$2" status="$3" pri="$4" who="$5" tags="$6" deps="$7"
	cat <<EOF
---
id: $id
title: $title
status: $status
priority: $pri
project: apple-pi
assignee: $who
parent: root
depends_on: [$deps]
tags: [$tags]
created_at: 2026-07-02T22:00:00Z
updated_at: 2026-07-02T22:00:00Z
---

# $title
Body for $id.
EOF
}

# jget PATH JSON_STR -> prints the dotted-path value (via node -p).
jget() { node -pe "JSON.parse(process.argv[1]).$1" "$2"; }

SBX="$(mktemp -d /tmp/kb-q.XXXXXX)"
trap 'rm -rf "$SBX"' EXIT
ROOT="$SBX/root"
DB="$SBX/agent.db"
export AGENT_DB="$DB"
mkdir -p "$ROOT/cards"
card a "Card A" todo 5 alice "m8,ready" "" > "$ROOT/cards/a.card.md"
card b "Card B" todo 8 bob "m8" "c" > "$ROOT/cards/b.card.md"
card c "Card C" done 5 alice "m8" "" > "$ROOT/cards/c.card.md"
card d "Card D" todo 9 bob "m8" "e" > "$ROOT/cards/d.card.md"
card e "Card E" in_progress 5 alice "m8" "" > "$ROOT/cards/e.card.md"
card f "Card F" in_progress 3 bob "m8" "" > "$ROOT/cards/f.card.md"

# list/show/next/graph lazily reconcile the mirror (ensureCurrent) — so a fresh
# tree + `kanban list` works with no prior `kanban index`.

# ── list: no filters -> 6 cards; --status narrows ─────────────────────
header "list: no filters returns 6; --status todo AND-narrows to {a,b,d}"
J=$("${CLI[@]}" list --json --root "$ROOT" 2>/tmp/kb-q.err) || { fail "list failed"; cat /tmp/kb-q.err; exit 1; }
N=$(node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).length))" <<<"$J")
[[ "$N" == "6" ]] || { fail "list should return 6 cards; got '$N'"; exit 1; }

J=$("${CLI[@]}" list --status todo --json --root "$ROOT" 2>/dev/null)
IDS=$(node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).map(x=>x.id).sort().join(',')))" <<<"$J")
[[ "$IDS" == "a,b,d" ]] || { fail "list --status todo -> {a,b,d}; got '$IDS'"; exit 1; }
ok "list: 6 cards unfiltered; --status todo -> {a,b,d}"

# ── show: single card incl. body; missing id exits non-zero ───────────
header "show: returns the card incl. body; missing id exits non-zero"
J=$("${CLI[@]}" show a --json --root "$ROOT" 2>/dev/null) || { fail "show a failed"; exit 1; }
[[ "$(jget id "$J")" == "a" ]] || { fail "show a -> id a"; exit 1; }
BODY=$(jget body "$J")
[[ "$BODY" == *"Body for a"* ]] || { fail "show a should include the body"; exit 1; }
"${CLI[@]}" show nope --root "$ROOT" >/dev/null 2>&1; RC=$?
[[ $RC -ne 0 ]] || { fail "show <missing> should exit non-zero"; exit 1; }
ok "show: returns id+body; missing id exits non-zero"

# ── next: under WIP limit recommends b; at KANBAN_WIP=2 holds ─────────
header "next: under limit -> b (highest-priority ready; d is dep-blocked)"
J=$("${CLI[@]}" next --json --root "$ROOT" 2>/dev/null) || { fail "next failed"; exit 1; }
[[ "$(jget next "$J")" == "b" ]] || { fail "next should be b; got '$(jget next "$J")'"; exit 1; }
[[ "$(jget held "$J")" == "false" ]] || { fail "under limit -> not held"; exit 1; }
[[ "$(jget 'wip.count' "$J")" == "2" ]] || { fail "wip.count should be 2"; exit 1; }
READY=$(node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).ready.sort().join(',')))" <<<"$J")
[[ "$READY" == "a,b" ]] || { fail "ready should be {a,b}; got '$READY'"; exit 1; }
ok "next (under limit): next=b, ready={a,b}, not held"

header "next: at KANBAN_WIP=2 -> HELD (next suppressed)"
J=$(KANBAN_WIP=2 "${CLI[@]}" next --json --root "$ROOT" 2>/dev/null) || { fail "next (wip2) failed"; exit 1; }
[[ "$(jget next "$J")" == "null" ]] || { fail "at limit -> next should be null; got '$(jget next "$J")'"; exit 1; }
[[ "$(jget held "$J")" == "true" ]] || { fail "at limit + ready -> held=true"; exit 1; }
[[ "$(jget heldId "$J")" == "b" ]] || { fail "heldId should be b"; exit 1; }
ok "next (at KANBAN_WIP=2): next=null, held=true, heldId=b"

# ── graph: edges (depends_on) + ready + cycles ────────────────────────
header "graph: forward edges {b->c, d->e}, ready {a,b}, no cycles"
J=$("${CLI[@]}" graph --json --root "$ROOT" 2>/dev/null) || { fail "graph failed"; exit 1; }
EDGES=$(node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).edges.map(e=>e.from+'->'+e.to).sort().join(',')))" <<<"$J")
[[ "$EDGES" == "b->c,d->e" ]] || { fail "edges should be {b->c, d->e}; got '$EDGES'"; exit 1; }
READY=$(node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).ready.sort().join(',')))" <<<"$J")
[[ "$READY" == "a,b" ]] || { fail "graph ready should be {a,b}; got '$READY'"; exit 1; }
CYC=$(node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).cycles.length))" <<<"$J")
[[ "$CYC" == "0" ]] || { fail "no cycles expected; got '$CYC'"; exit 1; }
ok "graph: edges={b->c,d->e}, ready={a,b}, cycles=0"

rm -f /tmp/kb-q.err
echo
ok "kanban-query: list + show + next + graph"
