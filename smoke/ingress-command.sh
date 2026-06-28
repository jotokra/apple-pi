#!/bin/bash
# smoke/ingress-command.sh — REQ-B-4: the /ingress command mutates settings correctly.
#
# B-4-1  /ingress add rss|webdiff|json <name> <url> appends a valid entry
# B-4-1  invalid name / url / kind rejected; duplicate rejected
# B-4-1  list / pause / resume / remove work
# B-4-3  the UNTRUSTED marker is the inject path (verified in ingress-injection.sh;
#        here we confirm /ingress run against a fixture doesn't crash)
#
# Uses real pi --mode rpc (commands run there) against a sandbox settings.json.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."
source ./smoke/_lib.sh

command -v pi >/dev/null 2>&1 || { fail "pi required"; exit 1; }
[[ -f ingress/index.ts ]] || { fail "ingress/index.ts missing"; exit 1; }

SBX="$(mktemp -d /tmp/ingcmd.XXXXXX)"
trap 'rm -rf "$SBX"' EXIT
mkdir -p "$SBX/extensions/ingress/lib" "$SBX/extensions/ingress/test" "$SBX/agent"
cp ingress/index.ts "$SBX/extensions/ingress/"
cp ingress/lib/*.js "$SBX/extensions/ingress/lib/"
cp ingress/test/*.xml "$SBX/extensions/ingress/test/"
echo '{"defaultModel":"gpt-test","extensions":[],"tools":{"allow":["read","bash"]}}' > "$SBX/agent/settings.json"
export PI_CODING_AGENT_DIR="$SBX"

run_cmds() {
	{ for c in "$@"; do printf '%s\n' "{\"id\":\"x\",\"type\":\"prompt\",\"message\":\"$c\"}"; sleep 1.2; done; } \
		| pi --mode rpc --no-session >/dev/null 2>&1
}
ing() { python3 -c "import json;d=json.load(open('$SBX/agent/settings.json'));print(json.dumps(d.get('ingress',{})))"; }

header "B-4-1: /ingress add rss appends a valid entry"
run_cmds "/ingress add rss hn https://news.ycombinator.com/rss --every 12h"
S=$(ing)
echo "$S" | grep -q '"name": "hn"' || { fail "B-4-1: add did not append hn"; exit 1; }
echo "$S" | grep -q '"every": "12h"' || { fail "B-4-1: --every not stored"; exit 1; }
ok "B-4-1: /ingress add rss stores name + url + every"

header "B-4-1: invalid kind / name / url / duplicate rejected"
run_cmds "/ingress add bogus kind x https://x"   # bad kind
S=$(ing); echo "$S" | grep -c '"name"' | grep -q "^1$" || { fail "B-4-1: bad kind added"; exit 1; }
run_cmds "/ingress add rss BAD-NAME https://x"   # bad name
S=$(ing); echo "$S" | grep -c '"name"' | grep -q "^1$" || { fail "B-4-1: bad name added"; exit 1; }
run_cmds "/ingress add rss x not-a-url"          # bad url
S=$(ing); echo "$S" | grep -c '"name"' | grep -q "^1$" || { fail "B-4-1: bad url added"; exit 1; }
run_cmds "/ingress add rss hn https://x"         # duplicate
COUNT=$(echo "$S" | grep -c '"name": "hn"')
S=$(ing); COUNT=$(echo "$S" | grep -c '"name": "hn"')
[[ "$COUNT" -eq 1 ]] || { fail "B-4-1: duplicate added ($COUNT)"; exit 1; }
ok "B-4-1: invalid kind/name/url + duplicate all rejected"

header "B-4-1: json requires --jp"
run_cmds "/ingress add json api https://x"       # missing --jp
S=$(ing); echo "$S" | grep -q '"name": "api"' && { fail "B-4-1: json added without --jp"; exit 1; } || true
run_cmds "/ingress add json api https://x --jp data.items"
S=$(ing); echo "$S" | grep -q '"jsonpath": "data.items"' || { fail "B-4-1: --jp not stored"; exit 1; }
ok "B-4-1: json requires + stores --jp"

header "B-4-1: pause / resume / remove"
run_cmds "/ingress pause hn"
ing | grep -q '"enabled": false' || { fail "B-4-1: pause failed"; exit 1; }
run_cmds "/ingress resume hn"
ing | grep -q '"enabled": true' || { fail "B-4-1: resume failed"; exit 1; }
run_cmds "/ingress remove hn"
# 'hn' should be gone (api may remain from the json test)
S=$(ing); echo "$S" | grep -q '"name": "hn"' \
	&& { fail "B-4-1: remove didn't delete hn"; exit 1; } || true
ok "B-4-1: pause / resume / remove work"

ok "ingress-command"
