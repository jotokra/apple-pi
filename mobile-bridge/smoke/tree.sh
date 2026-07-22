#!/usr/bin/env bash
# smoke/tree.sh — T4: lib/tree.mjs builds a parent-child tree from Pi JSONL.
#
# Per plan-01 Task 4:
#   "smoke: smoke/tree.sh asserts first node has parent_id null + ≥1 child"
#
# Pre-conditions for this smoke (current reality, mid-Phase-0):
#   - mobile-bridge/bin/bridge.mjs has NOT landed yet (T1 in flight).
#     This smoke therefore exercises the LIB directly via node -e — no
#     HTTP roundtrip. When T1 lands, this smoke can be extended to hit
#     GET /v1/sessions/:id/tree as well (additive — won't break the
#     direct-lib check).
#   - ~/.pi/sessions/*.jsonl must contain at least one v3 session
#     (parentId field on every non-session record).
#
# Tripwires pinned:
#   T4-T1  Build returns {schema_version:1, legacy:false, root:{...}, ...}
#   T4-T2  root.parent_id === null
#   T4-T3  root.children.length >= 1
#   T4-T4  Every node's parent_id resolves to either another node's id
#          OR is null (no dangling references for v3 data)
#   T4-T5  Legacy fallback: JSONL with no parentId returns flat[] + warning

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/../.."  # repo root (mobile-bridge/smoke -> repo)
# shellcheck disable=SC1091
source ./smoke/_lib.sh

require node
[[ -f mobile-bridge/lib/tree.mjs ]] || { fail "mobile-bridge/lib/tree.mjs missing"; exit 1; }

SESSIONS_DIR="${PI_SESSIONS_DIR:-$HOME/.pi/sessions}"
[[ -d "$SESSIONS_DIR" ]] || { fail "sessions dir not found: $SESSIONS_DIR"; exit 1; }

# Pick a v3 session deterministically (smallest file with > 4 records = a
# real conversation, not a one-shot ping). Skip pure ping sessions which
# have very few records and may not exercise the tree-builder's link pass.
PICK="$(
  node -e "
    const fs = require('node:fs');
    const path = require('node:path');
    const dir = '$SESSIONS_DIR';
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'));
    // Prefer: any session with > 5 records (real conversation)
    const cand = files
      .map(f => {
        const text = fs.readFileSync(path.join(dir, f), 'utf8');
        const lines = text.split(/\r?\n/).filter(l => l.trim());
        return { f, n: lines.length };
      })
      .filter(x => x.n > 5)
      .sort((a,b) => a.n - b.n)[0];  // smallest real session = fastest
    process.stdout.write(cand ? cand.f : '');
  "
)"
[[ -n "$PICK" ]] || { fail "no v3 sessions with > 5 records found in $SESSIONS_DIR"; exit 1; }
info "picked session: $PICK"

header "T4-T1/T2/T3: buildTree(root.parent_id=null, root.children>=1)"
OUT="$(node --input-type=module -e "
import { buildTreeFromFile } from './mobile-bridge/lib/tree.mjs';
import { join } from 'node:path';
const t = buildTreeFromFile(join('$SESSIONS_DIR', '$PICK'));
const root = t.root;
console.log('SCHEMA:' + t.schema_version);
console.log('LEGACY:' + t.legacy);
console.log('ROOT_ID:' + root.id);
console.log('ROOT_TYPE:' + root.type);
console.log('ROOT_PARENT_ID:' + JSON.stringify(root.parent_id));
console.log('ROOT_CHILDREN:' + root.children.length);
console.log('STATS:' + JSON.stringify(t.stats));
console.log('FIRST_CHILD_TYPE:' + (root.children[0]?.type ?? 'NONE'));
console.log('FIRST_CHILD_ROLE:' + (root.children[0]?.role ?? 'NONE'));
" 2>&1)"

echo "$OUT" | grep -q "^SCHEMA:1$" \
  || { fail "T4-T1: schema_version should be 1, got:"; echo "$OUT"; exit 1; }
echo "$OUT" | grep -q "^LEGACY:false$" \
  || { fail "T4-T1: v3 session should NOT be legacy, got:"; echo "$OUT"; exit 1; }
echo "$OUT" | grep -q "^ROOT_PARENT_ID:null$" \
  || { fail "T4-T2: root.parent_id must be null, got:"; echo "$OUT"; exit 1; }
echo "$OUT" | grep -q "^ROOT_CHILDREN:[1-9][0-9]*$" \
  || { fail "T4-T3: root.children.length must be >= 1, got:"; echo "$OUT"; exit 1; }
ok "T4-T1/T2/T3: schema=1, legacy=false, root.parent_id=null, root.children>=1"

header "T4-T4: every node.parent_id resolves (no dangling refs)"
DANGLING="$(node --input-type=module -e "
import { buildTreeFromFile } from './mobile-bridge/lib/tree.mjs';
import { join } from 'node:path';
const t = buildTreeFromFile(join('$SESSIONS_DIR', '$PICK'));
const ids = new Set(Object.keys(t.nodes_by_id));
let dangling = 0;
for (const id of ids) {
  const n = t.nodes_by_id[id];
  if (n.parent_id !== null && !ids.has(n.parent_id)) dangling++;
}
process.stdout.write(String(dangling));
")"
[[ "$DANGLING" -eq 0 ]] \
  || { fail "T4-T4: ${DANGLING} dangling parent_id references"; exit 1; }
ok "T4-T4: 0 dangling parent_id references across $(echo "$OUT" | grep -oE 'TOTAL_NODES:[0-9]+' | head -1 || echo 'all') nodes"

header "T4-T5: legacy fallback (JSONL with no parentId → flat + warning)"
LEGACY_OUT="$(node --input-type=module -e "
import { buildTree } from './mobile-bridge/lib/tree.mjs';
const legacy = [
  { type: 'session', id: 's', timestamp: '2026-01-01T00:00:00Z' },
  { type: 'message', id: 'm1', timestamp: '2026-01-01T00:00:01Z', message: { role: 'user', content: [{type:'text',text:'hi'}] } },
  { type: 'message', id: 'm2', timestamp: '2026-01-01T00:00:02Z', message: { role: 'assistant', content: [{type:'text',text:'hello'}] } },
];
const t = buildTree(legacy);
console.log('LEGACY:' + t.legacy);
console.log('FLAT_LEN:' + (t.flat?.length ?? -1));
console.log('HAS_WARNING:' + (typeof t.warning === 'string' && t.warning.length > 0));
console.log('HAS_ROOT:' + (t.root !== undefined));
" 2>&1)"
echo "$LEGACY_OUT" | grep -q "^LEGACY:true$" \
  || { fail "T4-T5: legacy flag should be true, got:"; echo "$LEGACY_OUT"; exit 1; }
echo "$LEGACY_OUT" | grep -q "^FLAT_LEN:2$" \
  || { fail "T4-T5: flat should have 2 entries (session header skipped), got:"; echo "$LEGACY_OUT"; exit 1; }
echo "$LEGACY_OUT" | grep -q "^HAS_WARNING:true$" \
  || { fail "T4-T5: warning string should be present, got:"; echo "$LEGACY_OUT"; exit 1; }
echo "$LEGACY_OUT" | grep -q "^HAS_ROOT:false$" \
  || { fail "T4-T5: root should be undefined in legacy mode, got:"; echo "$LEGACY_OUT"; exit 1; }
ok "T4-T5: legacy fallback returns flat[2] + warning, no root"

ok "tree"