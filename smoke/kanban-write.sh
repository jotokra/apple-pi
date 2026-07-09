#!/bin/bash
# smoke/kanban-write.sh — REQ-M8-3 / M10-1: the kanban TRUTH WRITERS
# (`apple-pi kanban new` / `move`), end-to-end through the REAL bin/apple-pi
# wrapper.
#
# Facet covered (SPEC "truth writer"):
#   - new   creates cards/<id>.card.md (the on-disk TRUTH), validates it, and
#           the mirror reconciles lazily so `show` reflects it immediately
#   - move  a legal status transition edits the TRUTH file; the on-disk diff is
#           EXACTLY 2 lines (status + updated_at); the mirror reflects it
#   - red-blue reject paths write NOTHING: bad id slug, path-escaping --dir,
#           illegal status transition all exit non-zero with the file untouched
#
# The .card.md files ARE the truth (Tier B, durable); the kb_* mirror is the
# disposable index. `new`/`move` write the truth; reads reconcile from it.
#
# Drives the real `node --no-warnings bin/apple-pi kanban ...` subprocess against
# a throwaway cwd + throwaway $AGENT_DB (the disposable-DB facet). Mirrors
# bin/apple-pi.kanban.write.test.js (the node:test suite).

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."
# shellcheck disable=SC1091
source ./smoke/_lib.sh

command -v node >/dev/null 2>&1 || { fail "node required"; exit 1; }
[[ -f agentdb/cli.js ]] || { fail "agentdb/cli.js missing"; exit 1; }

BIN="$SCRIPT_DIR/../bin/apple-pi"
CLI=(node --no-warnings "$BIN" kanban)

# jget PATH JSON_STR -> prints the dotted-path value (via node -p).
jget() { node -pe "JSON.parse(process.argv[1]).$1" "$2"; }

SBX="$(mktemp -d /tmp/kb-w.XXXXXX)"
trap 'rm -rf "$SBX"' EXIT
ROOT="$SBX/root"
DB="$SBX/agent.db"
export AGENT_DB="$DB"
mkdir -p "$ROOT"

# ── new: create -> validate -> show (mirror reconciles lazily) ────────
header "new: writes cards/<id>.card.md, validates, show reflects it"
OUT=$("${CLI[@]}" new alpha --title "Alpha card" --root "$ROOT" 2>/tmp/kb-w.err); RC=$?
[[ $RC -eq 0 ]] || { fail "new alpha exited $RC"; cat /tmp/kb-w.err; exit 1; }
[[ -f "$ROOT/cards/alpha.card.md" ]] || { fail "cards/alpha.card.md not written"; cat "$OUT"; exit 1; }
# validate reads the freshly-written .card.md straight from disk (M1-3)
"${CLI[@]}" validate --root "$ROOT" >/tmp/kb-w.val 2>&1; RC=$?
[[ $RC -eq 0 ]] || { fail "validate should pass on the created card"; cat /tmp/kb-w.val; exit 1; }
# the mirror reconciled lazily — `show` returns the new card
J=$("${CLI[@]}" show alpha --json --root "$ROOT" 2>/dev/null) || { fail "show alpha failed"; exit 1; }
[[ "$(jget id "$J")" == "alpha" ]] || { fail "show alpha -> id alpha"; exit 1; }
[[ "$(jget status "$J")" == "triage" ]] || { fail "new card defaults to triage"; exit 1; }
ok "new: cards/alpha.card.md written, validates, show returns it (status triage)"

# ── move: legal transition, diff EXACTLY 2 lines (status + updated_at) ─
header "move: legal todo->in_progress, on-disk diff is exactly 2 lines"
"${CLI[@]}" new mv --title "Move me" --status todo --root "$ROOT" >/dev/null 2>/tmp/kb-w.err \
	|| { fail "seed mv failed"; cat /tmp/kb-w.err; exit 1; }
FILE="$ROOT/cards/mv.card.md"
BEFORE=$(cat "$FILE")
"${CLI[@]}" move mv in_progress --root "$ROOT" >/dev/null 2>/tmp/kb-w.err \
	|| { fail "move mv failed"; cat /tmp/kb-w.err; exit 1; }
AFTER=$(cat "$FILE")
# added/removed line counts via diff against line-streams
ADDED=$(diff <(printf '%s\n' "$BEFORE") <(printf '%s\n' "$AFTER") | grep -c '^>') || true
REMOVED=$(diff <(printf '%s\n' "$BEFORE") <(printf '%s\n' "$AFTER") | grep -c '^<') || true
[[ "$ADDED" == "2" ]] || { fail "exactly 2 lines added (status + updated_at); got $ADDED"; diff <(printf '%s\n' "$BEFORE") <(printf '%s\n' "$AFTER"); exit 1; }
[[ "$REMOVED" == "2" ]] || { fail "exactly 2 lines removed; got $REMOVED"; exit 1; }
AFTER_DIFF=$(diff <(printf '%s\n' "$BEFORE") <(printf '%s\n' "$AFTER"))
echo "$AFTER_DIFF" | grep -Eq '^> status:[[:space:]]*in_progress[[:space:]]*$' \
	|| { fail "added lines must include 'status: in_progress'"; echo "$AFTER_DIFF"; exit 1; }
# the mirror reflects the new status
J=$("${CLI[@]}" show mv --json --root "$ROOT" 2>/dev/null) || { fail "show mv failed"; exit 1; }
[[ "$(jget status "$J")" == "in_progress" ]] || { fail "mirror should reflect in_progress"; exit 1; }
ok "move: todo->in_progress, diff exactly 2 lines (status+updated_at), mirror reflects"

# ── red-blue: bad slug + path-escaping --dir write NOTHING ────────────
header "new red-blue: bad slug + path-escaping --dir -> non-zero, no file"
"${CLI[@]}" new "UPPER Bad" --title X --root "$ROOT" >/tmp/kb-w.bad1 2>&1; RC=$?
[[ $RC -ne 0 ]] || { fail "bad slug must exit non-zero"; cat /tmp/kb-w.bad1; exit 1; }
[[ ! -e "$ROOT/cards/UPPER Bad.card.md" ]] || { fail "bad slug must not write a file"; exit 1; }

"${CLI[@]}" new esc --title Esc --dir ../escape --root "$ROOT" >/tmp/kb-w.bad2 2>&1; RC=$?
[[ $RC -ne 0 ]] || { fail "--dir ../escape must exit non-zero"; cat /tmp/kb-w.bad2; exit 1; }
[[ ! -e "$ROOT/cards/esc.card.md" ]] || { fail "escape --dir must not write inside root"; exit 1; }
[[ ! -e "$SBX/escape/esc.card.md" ]] || { fail "escape --dir must not write OUTSIDE root (red-blue)"; exit 1; }
ok "new red-blue: bad slug + path-escaping --dir both rejected with no file write"

# ── red-blue: illegal transition leaves the file byte-identical ───────
header "move red-blue: illegal todo->done -> non-zero, file byte-identical"
"${CLI[@]}" new bad --title "Bad move" --status todo --root "$ROOT" >/dev/null 2>/tmp/kb-w.err \
	|| { fail "seed bad failed"; cat /tmp/kb-w.err; exit 1; }
BFILE="$ROOT/cards/bad.card.md"
BEFORE=$(cat "$BFILE")
"${CLI[@]}" move bad done --root "$ROOT" >/tmp/kb-w.bad3 2>&1; RC=$?
[[ $RC -ne 0 ]] || { fail "illegal todo->done must exit non-zero"; cat /tmp/kb-w.bad3; exit 1; }
AFTER=$(cat "$BFILE")
[[ "$AFTER" == "$BEFORE" ]] || { fail "file must be byte-identical after rejected move"; exit 1; }
ok "move red-blue: illegal transition rejected, file byte-identical"

rm -f /tmp/kb-w.err /tmp/kb-w.val /tmp/kb-w.bad1 /tmp/kb-w.bad2 /tmp/kb-w.bad3
echo
ok "kanban-write: new + move + red-blue reject paths"
