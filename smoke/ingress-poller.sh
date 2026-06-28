#!/bin/bash
# smoke/ingress-poller.sh — REQ-B-1: poller core fetches + dedupes via state.
#
# B-1-1  parseRss extracts items (title/url/id/summary) from a fixture feed
# B-1-2  re-running with the same state yields 0 new items (dedup works)
# B-1-3  the webdiff kind detects a change (returns 1 item) then nothing on rerun
#
# Pure logic — no network (file:// fixture), no injection (that's B-2).

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."
source ./smoke/_lib.sh

command -v node >/dev/null 2>&1 || { fail "node required"; exit 1; }
[[ -f ingress/lib/poller.js ]] || { fail "ingress/lib/poller.js missing"; exit 1; }
[[ -f ingress/lib/state.js ]] || { fail "ingress/lib/state.js missing"; exit 1; }
[[ -f ingress/test/fixture.xml ]] || { fail "fixture.xml missing"; exit 1; }

FIXTURE="$(pwd)/ingress/test/fixture.xml"

header "B-1-1: parseRss extracts items from the fixture"
node -e "
const { parseRss } = require('./ingress/lib/poller');
const fs = require('fs');
const items = parseRss(fs.readFileSync('$FIXTURE','utf8'));
if (items.length !== 3) { console.error('expected 3 items, got', items.length); process.exit(1); }
if (!items[0].title || !items[0].url || !items[0].id) { console.error('item missing fields', items[0]); process.exit(1); }
console.log('items:', items.length, '| first id:', items[0].id, '| first title:', items[0].title);
" || { fail "B-1-1: parseRss failed"; exit 1; }
ok "B-1-1: parseRss extracts 3 well-formed items"

header "B-1-2: dedup — same feed twice → second run returns 0 new items"
node -e "
const poller = require('./ingress/lib/poller');
const { memStore } = require('./ingress/lib/state');
const fs = require('fs');
const xml = fs.readFileSync('$FIXTURE','utf8');
const store = memStore();
const fakeFetch = async () => ({ status: 200, contentType: 'text/xml', text: xml, finalUrl: 'fixture' });
(async () => {
  const r1 = await poller.runPoller({ name:'t', kind:'rss', url:'fixture' }, store, fakeFetch);
  const r2 = await poller.runPoller({ name:'t', kind:'rss', url:'fixture' }, store, fakeFetch);
  if (r1.error) { console.error('run1 error:', r1.error); process.exit(1); }
  console.log('run1:', r1.items.length, '| run2:', r2.items.length);
  if (!(r1.items.length === 3 && r2.items.length === 0)) { console.error('dedup wrong'); process.exit(1); }
})();
" || { fail "B-1-2: dedup failed"; exit 1; }
ok "B-1-2: re-run dedupes (3 → 0 new)"

header "B-1-3: webdiff detects change, then stable"
node -e "
const poller = require('./ingress/lib/poller');
const { memStore } = require('./ingress/lib/state');
const store = memStore();
let version = 'AAA';
const fakeFetch = async () => ({ status:200, contentType:'text/html', text: version, finalUrl:'x' });
(async () => {
  const r1 = await poller.runPoller({ name:'w', kind:'webdiff', url:'x' }, store, fakeFetch);
  const r2 = await poller.runPoller({ name:'w', kind:'webdiff', url:'x' }, store, fakeFetch);
  version = 'BBB';
  const r3 = await poller.runPoller({ name:'w', kind:'webdiff', url:'x' }, store, fakeFetch);
  if (!(r1.items.length === 1 && r2.items.length === 0 && r3.items.length === 1)) {
    console.error('webdiff sequence wrong:', r1.items.length, r2.items.length, r3.items.length); process.exit(1);
  }
  console.log('webdiff: change/stable/change =', r1.items.length, r2.items.length, r3.items.length);
})();
" || { fail "B-1-3: webdiff failed"; exit 1; }
ok "B-1-3: webdiff detects change, stable on rerun, change again"

header "B-1-2: SQLite state store persists across instances"
SBX="$(mktemp -d /tmp/ing.XXXXXX)"
trap 'rm -rf "$SBX"' EXIT
export PI_CODING_AGENT_DIR="$SBX"
node -e "
const { SqliteStore } = require('./ingress/lib/state');
let s = new SqliteStore('$SBX/ingress.db');
s.markSeen('p', 'id-1');
s.close();
s = new SqliteStore('$SBX/ingress.db');   // reopen
if (!s.hasSeen('p','id-1')) { console.error('seen id not persisted'); process.exit(1); }
s.close();
console.log('sqlite store persists across instances');
" || { fail "B-1-2: SQLite state didn't persist"; exit 1; }
ok "B-1-2: SQLite state store persists"

ok "ingress-poller"
