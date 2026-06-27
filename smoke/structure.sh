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
		lib/_common.sh lib/handoff.md; do
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

header "extensions (7 .ts)"
count=$(find config/extensions -type f -name '*.ts' | wc -l | tr -d ' ')
[[ "$count" -eq 7 ]] || { fail "expected 7 extensions, got $count"; exit 1; }
ok "7 extensions"

header "settings.json.template placeholders"
for ph in __APPLEPI_PROVIDER__ __APPLEPI_MODEL__ __APPLEPI_EXT_SYSINFO__ \
		__APPLEPI_SKILLS_DIR__ __APPLEPI_PROMPTS_DIR__ __APPLEPI_SHELL__ \
		__APPLEPI_SESSIONS_DIR__; do
	grep -q "$ph" config/agent/settings.json.template || { fail "missing placeholder $ph"; exit 1; }
done
ok "all placeholders present"

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
for s in smoke/*.sh; do bash -n "$s" || { fail "$s syntax"; exit 1; }
done
ok "shell syntax clean"

header "extensions type-check (tsc if available)"
if command -v tsc >/dev/null 2>&1; then
	# Best-effort; pi-ai types may not resolve without the package installed.
	tsc --noEmit --skipLibCheck config/extensions/*.ts 2>/dev/null && ok "tsc clean" || warn "tsc reported errors (types need the pi package present; non-blocking)"
else
	warn "tsc not installed; skipping extension type-check"
fi
