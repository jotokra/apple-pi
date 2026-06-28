#!/bin/bash
# smoke/structure.sh — all expected files present, JSON/template valid,
# skill/prompt/extension counts sane.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."
# shellcheck disable=SC1091
source ./smoke/_lib.sh

header "required files present"
for f in install.sh README.md LICENSE .gitignore .docs/PLAN.md \
		config/agent/AGENTS.md config/agent/settings.json.template \
		lib/_common.sh lib/handoff.md \
		lifecycle/collect-metrics.js lifecycle/aggregate-week.js lifecycle/apply-update.js \
		lifecycle/lib/db.js lifecycle/lib/brief.js lifecycle/schema.sql lifecycle/schedule.sh \
		vault/lib/vault.js vault/cli.js \
		bin/apple-pi docs/index.html docs/HOWTO.md PUBLISHING.md; do
	[[ -f "$f" ]] || { fail "missing $f"; exit 1; }
done
ok "required files"

header "skills (8 SKILL.md)"
count=$(find config/skills -type f -name SKILL.md | wc -l | tr -d ' ')
[[ "$count" -eq 8 ]] || { fail "expected 8 skills, got $count"; exit 1; }
ok "8 skills"

header "prompts (4)"
count=$(find config/prompts -type f -name '*.md' | wc -l | tr -d ' ')
[[ "$count" -eq 4 ]] || { fail "expected 4 prompts, got $count"; exit 1; }
ok "4 prompts"

header "extensions (9 single-file .ts)"
count=$(find config/extensions -maxdepth 1 -type f -name '*.ts' | wc -l | tr -d ' ')
[[ "$count" -eq 9 ]] || { fail "expected 9 single-file extensions, got $count"; exit 1; }
ok "9 single-file extensions"

header "web bundle present"
[[ -f config/extensions/web/index.ts ]] || { fail "missing config/extensions/web/index.ts"; exit 1; }
node -e "const p=JSON.parse(require('fs').readFileSync('config/extensions/web/package.json','utf8')); if(!(p.pi&&Array.isArray(p.pi.extensions)&&p.pi.extensions[0]==='./index.ts')) throw 0" 2>/dev/null \
	|| { fail "config/extensions/web/package.json missing pi.extensions manifest -> ./index.ts"; exit 1; }
ok "web bundle (index.ts + valid package.json manifest)"

header "voice package present"
[[ -f config/voice/pivoice.py ]] || { fail "missing config/voice/pivoice.py"; exit 1; }
[[ -x config/voice/bin/pivoice ]] || { fail "config/voice/bin/pivoice not executable"; exit 1; }
node -e "const p=JSON.parse(require('fs').readFileSync('config/voice/package.json','utf8')); if(!p.bin||!p.bin.pivoice) throw 0" 2>/dev/null \
	|| { fail "config/voice/package.json missing bin.pivoice"; exit 1; }
python3 -c "import ast,sys; ast.parse(open('config/voice/pivoice.py').read())" 2>/dev/null \
	|| { fail "config/voice/pivoice.py does not parse"; exit 1; }
ok "voice package (pivoice.py parses + bin + manifest)"

header "settings.json.template placeholders"
for ph in __APPLEPI_PROVIDER__ __APPLEPI_MODEL__ __APPLEPI_EXT_SYSINFO__ __APPLEPI_EXT_WEB__ __APPLEPI_EXT_VOICE__ \
		__APPLEPI_SKILLS_DIR__ __APPLEPI_PROMPTS_DIR__ __APPLEPI_SHELL__ \
		__APPLEPI_SESSIONS_DIR__; do
	grep -q "$ph" config/agent/settings.json.template || { fail "missing placeholder $ph"; exit 1; }
done
ok "all placeholders present"

header "template is marked as internal seed scaffolding"
grep -q '"_applepi_seed": true' config/agent/settings.json.template \
	|| { fail "settings.json.template missing _applepi_seed marker"; exit 1; }
ok "seed marker present (P3 will strip it per REQ-3-5)"

header "skill frontmatter parses (name + description)"
for s in config/skills/*/SKILL.md; do
	head -5 "$s" | grep -q '^name:' || { fail "$s missing name frontmatter"; exit 1; }
	head -5 "$s" | grep -q '^description:' || { fail "$s missing description frontmatter"; exit 1; }
done
ok "skill frontmatter"

header "template renders to valid JSON (smoke values)"
TMP="$(mktemp -d)"
sed -e 's#__APPLEPI_PROVIDER__#openai#' \
	-e 's#__APPLEPI_MODEL__#gpt-test#' \
	-e 's#__APPLEPI_EXT_SYSINFO__#/tmp/x.ts#' \
	-e 's#__APPLEPI_EXT_WEB__#/tmp/web#' \
	-e 's#__APPLEPI_EXT_VOICE__#/tmp/voice.ts#' \
	-e 's#__APPLEPI_SKILLS_DIR__#/tmp/skills#' \
	-e 's#__APPLEPI_PROMPTS_DIR__#/tmp/prompts#' \
	-e 's#__APPLEPI_SHELL__#/bin/zsh#' \
	-e 's#__APPLEPI_SESSIONS_DIR__#/tmp/sessions#' \
	config/agent/settings.json.template > "$TMP/settings.json"
if command -v jq >/dev/null 2>&1; then
	jq -e '.defaultModel == "gpt-test"' "$TMP/settings.json" >/dev/null || { fail "rendered JSON invalid"; exit 1; }
elif command -v node >/dev/null 2>&1; then
	node -e "JSON.parse(require('fs').readFileSync('$TMP/settings.json','utf8'))" || { fail "rendered JSON invalid"; exit 1; }
fi
ok "template renders to valid JSON"
rm -rf "$TMP"

header "install.sh + lib syntax"
bash -n install.sh || { fail "install.sh syntax"; exit 1; }
bash -n lib/_common.sh || { fail "_common.sh syntax"; exit 1; }
bash -n lifecycle/schedule.sh || { fail "schedule.sh syntax"; exit 1; }
bash -n lifecycle/voice-enable.sh || { fail "voice-enable.sh syntax"; exit 1; }
for s in smoke/*.sh; do bash -n "$s" || { fail "$s syntax"; exit 1; }
done
ok "shell syntax clean"

header "lifecycle node files compile"
for j in lifecycle/collect-metrics.js lifecycle/aggregate-week.js lifecycle/apply-update.js \
		lifecycle/update-check.js \
		lifecycle/lib/db.js lifecycle/lib/brief.js bin/apple-pi \
		vault/lib/vault.js vault/cli.js; do
	node --check "$j" || { fail "$j syntax"; exit 1; }
done
ok "lifecycle + CLI + vault node syntax clean"

header "mcp-bridge schema + node syntax"
for j in mcp-bridge/lib/mcp-client.js mcp-bridge/lib/schema.js mcp-bridge/test/fake-server.js; do
	[[ -f "$j" ]] || { fail "missing $j"; exit 1; }
	node --check "$j" || { fail "$j syntax"; exit 1; }
done
ok "mcp-bridge node syntax"
# A-1-1: schema validator accepts a good entry, rejects bad ones (count-neutral)
node -e "
const {validateServers} = require('./mcp-bridge/lib/schema');
const good = validateServers([{name:'github',command:'npx',args:['-y','x']}]);
if (good.errors.length || good.servers.length!==1) { console.error('good entry rejected:',good.errors); process.exit(1); }
const bad = validateServers([{name:'BAD NAME',command:''},{name:'ok',command:'npx',transport:'http'}]);
if (bad.errors.length < 2) { console.error('bad entries not all caught:',bad.errors); process.exit(1); }
" || { fail 'A-1-1: mcp schema validator misbehaves'; exit 1; }
ok "A-1-1: mcp.servers schema validator (good accepted, bad rejected)"

header "landing page + workflow present"
[[ -f docs/index.html ]] || { fail "docs/index.html"; exit 1; }
[[ -f .github/workflows/pages.yml ]] || { fail "pages workflow"; exit 1; }
grep -q 'curl -fsSL https://raw.githubusercontent.com/jotokra/apple-pi/main/install.sh' docs/index.html \
	|| { fail "landing page missing the one-liner"; exit 1; }
ok "landing page + one-liner"

header "docs site (VitePress) source present"
for f in package.json package-lock.json \
		guide/index.md guide/why.md guide/install.md guide/usage.md \
		guide/howto.md guide/commands.md guide/skills.md \
		guide/.vitepress/config.mts guide/.vitepress/theme/index.ts guide/.vitepress/theme/custom.css; do
	[[ -f "$f" ]] || { fail "missing $f"; exit 1; }
done
node -e "const p=require('./package.json'); if(!(p.scripts&&p.scripts['docs:build']&&p.devDependencies&&p.devDependencies.vitepress)) throw 0" 2>/dev/null \
	|| { fail "package.json missing docs:build script or vitepress devDep"; exit 1; }
ok "guide source + docs tooling manifest"

header "extensions type-check (tsc if available)"
if command -v tsc >/dev/null 2>&1; then
	# Best-effort; pi-ai types may not resolve without the package installed.
	tsc --noEmit --skipLibCheck config/extensions/*.ts 2>/dev/null && ok "tsc clean" || warn "tsc reported errors (types need the pi package present; non-blocking)"
else
	warn "tsc not installed; skipping extension type-check"
fi
