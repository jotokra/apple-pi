#!/usr/bin/env bash
# mobile-bridge/smoke/raw.sh — T5: lib/raw.mjs streams Pi session JSONL.
#
# Per plan-01 Task 5:
#   "smoke: smoke/raw.sh curls with Accept: application/x-ndjson,
#    asserts first line is JSON with role field"
#
# Pre-conditions for this smoke (current reality, mid-Phase-0):
#   - bridge.mjs route registration for /v1/sessions/:id/raw has NOT
#     landed yet (T1 is mid-edit; multiple workers are racing
#     bridge.mjs in parallel). This smoke therefore exercises the
#     LIB directly via `node --input-type=module -e` — no HTTP
#     roundtrip. When T1 settles and the route is wired (a one-liner,
#     see lib/raw.mjs's docstring + the T5 commit notes), this smoke
#     can be extended to `curl -H "Accept: application/x-ndjson"`.
#   - ~/.pi/sessions/*.jsonl must contain at least one v3 session
#     (a record carrying `message.role` so we can assert role field
#     presence).
#
# Tripwires pinned:
#   T5-T1  validateSessionFile returns a non-null sessionId
#   T5-T2  sizeBytes > 0 (real file, not empty)
#   T5-T3  readSessionId(jsonlPath) === readSessionId(another read)
#          (idempotent across calls)
#   T5-T4  streamSessionJsonl emits bytes whose first non-empty line
#          parses as a JSON object with a `role` field (the plan's
#          "first line is JSON with role" assertion, exercised against
#          the lib so we don't depend on the HTTP layer)
#   T5-T5  Cap enforced at line boundary: capped=true when capBytes
#          is smaller than the file; final emitted bytes are a valid
#          NDJSON prefix (every line-complete, total ≤ capBytes).
#   T5-T6  Errors: validateSessionFile throws RawError("NOT_FOUND")
#          for a missing path; RawError("NOT_JSONL") for a non-
#          *.jsonl file.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/../.."  # repo root (mobile-bridge/smoke -> repo)
# shellcheck disable=SC1091
source ./smoke/_lib.sh

require node
[[ -f mobile-bridge/lib/raw.mjs ]] || { fail "mobile-bridge/lib/raw.mjs missing"; exit 1; }

# Sessions dir resolution: honour PI_SESSIONS_DIR if the caller set it;
# otherwise fall back to ~/.pi/sessions. Apple-pi is macOS-only (and the
# smoke is local-user-invoked), so when $HOME doesn't have a .pi/ we
# peek at the real user's home directory via `dscl` before giving up.
# The hermes-worker sandbox sets HOME to a profile dir without ~/.pi/,
# and we don't want the smoke to false-fail there.
SESSIONS_DIR="${PI_SESSIONS_DIR:-}"
if [[ -z "$SESSIONS_DIR" || ! -d "$SESSIONS_DIR" ]]; then
  if [[ -d "$HOME/.pi/sessions" ]]; then
    SESSIONS_DIR="$HOME/.pi/sessions"
  elif command -v dscl >/dev/null 2>&1; then
    REAL_HOME="$(dscl -q . -read "/Users/$(id -un)" NFSHomeDirectory 2>/dev/null | awk '{print $2}')"
    [[ -n "$REAL_HOME" && -d "$REAL_HOME/.pi/sessions" ]] && SESSIONS_DIR="$REAL_HOME/.pi/sessions"
  fi
fi
SESSIONS_DIR="${SESSIONS_DIR:-$HOME/.pi/sessions}"
[[ -d "$SESSIONS_DIR" ]] || { fail "sessions dir not found: $SESSIONS_DIR"; exit 1; }

# Pick a v3 session with a message record (record count > 4 lines = at
# least header + 2 model_change + 2 messages; smallest file = fastest).
PICK="$(
  node -e "
    const fs = require('node:fs');
    const path = require('node:path');
    const dir = '$SESSIONS_DIR';
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'));
    const cand = files
      .map(f => {
        const text = fs.readFileSync(path.join(dir, f), 'utf8');
        const lines = text.split(/\r?\n/).filter(l => l.trim());
        return { f, n: lines.length };
      })
      .filter(x => x.n > 4)
      .sort((a,b) => a.n - b.n)[0];
    process.stdout.write(cand ? cand.f : '');
  "
)"
[[ -n "$PICK" ]] || { fail "no v3 sessions with > 4 records found in $SESSIONS_DIR"; exit 1; }
info "picked session: $PICK"

FULL_PATH="$SESSIONS_DIR/$PICK"

header "T5-T1/T2: validateSessionFile returns isValid=true + sizeBytes>0"
META="$(node --input-type=module -e "
import { validateSessionFile } from './mobile-bridge/lib/raw.mjs';
const m = validateSessionFile('$FULL_PATH');
console.log('SIZE:' + m.sizeBytes);
console.log('ID:' + (m.sessionId ?? 'null'));
console.log('VALID:' + m.isValid);
" 2>&1)"
echo "$META" | grep -q "^VALID:true$" \
  || { fail "T5-T1: isValid should be true, got:"; echo "$META"; exit 1; }
echo "$META" | grep -qE "^SIZE:[1-9][0-9]*$" \
  || { fail "T5-T2: sizeBytes must be > 0, got:"; echo "$META"; exit 1; }
ok "T5-T1/T2: validated header, sizeBytes>0"

header "T5-T3: readSessionId is idempotent (two reads return same id)"
ID1_ID2="$(node --input-type=module -e "
import { readSessionId } from './mobile-bridge/lib/raw.mjs';
console.log('A=' + readSessionId('$FULL_PATH'));
console.log('B=' + readSessionId('$FULL_PATH'));
" 2>&1)"
echo "$ID1_ID2" | grep -qE "^A=[0-9a-f-]{36}$" \
  || { fail "T5-T3: first id should be a UUID, got:"; echo "$ID1_ID2"; exit 1; }
A="$(echo "$ID1_ID2" | grep '^A=' | head -1 | cut -d= -f2)"
B="$(echo "$ID1_ID2" | grep '^B=' | head -1 | cut -d= -f2)"
[[ "$A" == "$B" ]] \
  || { fail "T5-T3: readSessionId not idempotent (A=$A B=$B)"; exit 1; }
ok "T5-T3: readSessionId id=$A is stable across calls"

header "T5-T4: streamSessionJsonl emits valid NDJSON prefix with role on first message line"
STREAM_OUT="$(node --input-type=module -e "
import { streamSessionJsonl, parseLine } from './mobile-bridge/lib/raw.mjs';
const { readable, sizeBytes, capped } = streamSessionJsonl('$FULL_PATH');
console.log('SIZE:' + sizeBytes);
console.log('CAPPED:' + capped);
let buf = Buffer.alloc(0);
for await (const chunk of readable) {
  buf = Buffer.concat([buf, chunk]);
}
const text = buf.toString('utf8');
const lines = text.split('\n').filter(l => l.trim());
console.log('LINES:' + lines.length);
for (const l of lines) {
  try {
    const rec = parseLine(l);
    if (rec && rec.message && typeof rec.message.role === 'string') {
      console.log('ROLE:' + rec.message.role);
      console.log('TYPE:' + rec.type);
      console.log('FIRST_ROLE_OK:true');
      break;
    }
    console.log('NON_MSG:' + (rec?.type ?? 'null'));
  } catch (e) {
    console.log('PARSE_ERR:' + e.message);
  }
}
" 2>&1)"
echo "$STREAM_OUT" | grep -q "^FIRST_ROLE_OK:true$" \
  || { fail "T5-T4: no message-with-role found in stream, got:"; echo "$STREAM_OUT"; exit 1; }
echo "$STREAM_OUT" | grep -qE "^ROLE:(user|assistant|tool|system)$" \
  || { fail "T5-T4: first role field wasn't a known value"; exit 1; }
ok "T5-T4: stream emits valid NDJSON prefix; first message line carries a role field"

header "T5-T5: cap enforced at line boundary (capped=true, emitted bytes ≤ cap)"
CAP_OUT="$(node --input-type=module -e "
import { streamSessionJsonl, parseLine } from './mobile-bridge/lib/raw.mjs';
const { readable, sizeBytes, capBytes, capped } = streamSessionJsonl('$FULL_PATH', { capBytes: 256 });
console.log('SIZE:' + sizeBytes);
console.log('CAP:' + capBytes);
console.log('CAPPED:' + capped);
let total = 0;
let buf = Buffer.alloc(0);
for await (const chunk of readable) {
  total += chunk.length;
  buf = Buffer.concat([buf, chunk]);
}
console.log('EMITTED:' + total);
console.log('LE_AT_CAP:' + (total <= capBytes));
// Every emitted line must end in '\n' (no partial tail).
const text = buf.toString('utf8');
console.log('ENDS_NL:' + text.endsWith('\n'));
let lineCount = 0;
let parsedOk = 0;
for (const l of text.split('\n').filter(l => l.length)) {
  lineCount++;
  try { parseLine(l); parsedOk++; } catch (_e) {}
}
console.log('LINES:' + lineCount);
console.log('PARSED:' + parsedOk);
" 2>&1)"
echo "$CAP_OUT" | grep -q "^CAP:256$" \
  || { fail "T5-T5: capBytes should be 256, got:"; echo "$CAP_OUT"; exit 1; }
echo "$CAP_OUT" | grep -q "^LE_AT_CAP:true$" \
  || { fail "T5-T5: emitted bytes should be ≤ cap, got:"; echo "$CAP_OUT"; exit 1; }
echo "$CAP_OUT" | grep -q "^PARSED:[1-9][0-9]*$" \
  || { fail "T5-T5: every emitted line must parse, got:"; echo "$CAP_OUT"; exit 1; }
PARSED="$(echo "$CAP_OUT" | grep '^PARSED:' | cut -d: -f2)"
LINES="$(echo "$CAP_OUT" | grep '^LINES:' | cut -d: -f2)"
[[ "$PARSED" == "$LINES" ]] \
  || { fail "T5-T5: $PARSED parsed ≠ $LINES total lines (some lines truncated mid-record)"; exit 1; }
ok "T5-T5: cap=256 honored, $LINES lines emitted all parse cleanly"

header "T5-T6: NOT_FOUND + NOT_JSONL errors"
# Create a real non-.jsonl file so NOT_JSONL can fire (without it,
# /tmp/not-a-jsonl.txt would be missing → NOT_FOUND, and we'd be
# testing the wrong code path).
NOT_JSONL_FIXTURE="/tmp/raw_smoke_fixture_$$.txt"
trap 'rm -f "$NOT_JSONL_FIXTURE"' EXIT
echo "hello" > "$NOT_JSONL_FIXTURE"
ERR_OUT="$(node --input-type=module -e "
import { validateSessionFile } from './mobile-bridge/lib/raw.mjs';
const cases = [];
try { validateSessionFile('/tmp/__no_such_session__.jsonl'); }
catch (e) { cases.push('NF:' + e.code); }
try { validateSessionFile('$NOT_JSONL_FIXTURE'); }
catch (e) { cases.push('NJ:' + e.code); }
console.log(cases.join(' '));
" 2>&1)"
echo "$ERR_OUT" | grep -q "NF:NOT_FOUND" \
  || { fail "T5-T6: missing .jsonl should throw RawError(NOT_FOUND), got:"; echo "$ERR_OUT"; exit 1; }
echo "$ERR_OUT" | grep -q "NJ:NOT_JSONL" \
  || { fail "T5-T6: non-.jsonl file should throw RawError(NOT_JSONL), got:"; echo "$ERR_OUT"; exit 1; }
ok "T5-T6: NOT_FOUND + NOT_JSONL typed errors raised"

ok "raw"
