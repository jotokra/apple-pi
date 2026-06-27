#!/bin/bash
# smoke/docs-build.sh — the VitePress guide builds clean.
# Catches a broken guide (bad config, unbalanced Vue-template HTML, a missing
# page the sidebar points at) before it ships. The pages.yml workflow is the
# real deploy gate; this is the local pre-push belt-and-suspenders.
#
# Requires node + npm (already assumed by structure.sh's node --check block).
# Uses the committed package-lock.json (npm ci) on a clean tree.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."
# shellcheck disable=SC1091
source ./smoke/_lib.sh

header "docs site (VitePress) builds"

command -v node >/dev/null 2>&1 || { fail "node not found"; exit 1; }
command -v npm  >/dev/null 2>&1 || { fail "npm not found"; exit 1; }

# Install only if missing (keeps repeat runs fast). npm ci honors the lockfile.
if [[ ! -d node_modules/vitepress ]]; then
	npm ci --no-audit --no-fund >/dev/null 2>&1 \
		|| { fail "npm ci failed (run 'npm install' to see why)"; exit 1; }
fi

# Build into guide/.vitepress/dist.
npm run docs:build >/tmp/apidocs-build.log 2>&1 \
	|| { fail "npm run docs:build failed — tail of log:"; tail -20 /tmp/apidocs-build.log; exit 1; }

DIST=guide/.vitepress/dist
# Every sidebar page must have rendered.
for page in index why install usage howto commands skills; do
	[[ -f "$DIST/$page.html" ]] || { fail "missing rendered page: $DIST/$page.html"; exit 1; }
done
ok "all 7 guide pages rendered"

# The base path must be baked into the output (else assets 404 on Pages).
grep -q '/apple-pi/guide/' "$DIST/index.html" \
	|| { fail "base path /apple-pi/guide/ not found in built index.html"; exit 1; }
ok "base path /apple-pi/guide/ baked into output"

# Local search index must exist (the guide's search box depends on it).
ls "$DIST"/assets/chunks/@localSearchIndex* >/dev/null 2>&1 \
	|| { fail "local search index chunk missing"; exit 1; }
ok "local search index built"

rm -f /tmp/apidocs-build.log
