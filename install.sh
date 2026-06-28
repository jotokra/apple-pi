#!/bin/bash
# install.sh — apple-pi onboarding wizard.
#
# Phases (see .docs/PLAN.md):
#   P0 WELCOME   greet + consent
#   P1 ONBOARD   model (any input) → creds → encrypt → config → auth → confirm → purge
#   HANDOFF      exec a Pi agent session that runs P2 discovery, P3 self-improve,
#                P4 integrated, P5 workflow-offer
#
# Flags:
#   --purge-auth-too   Also delete ~/.pi/agent/auth.json at purge (opt-in; off by
#                      default — Pi needs runtime auth, and the user keeps their own
#                      config + auth.json after onboarding).
#   --sandbox <dir>    Use <dir> as PI_CODING_AGENT_DIR (for testing; never touches ~/.pi).
#   --no-handoff       Stop after P1+purge; print the handoff command instead of exec'ing.
#   --skip-confirm     TEST ONLY: bypass the required live connection check.
#			      (Was the OAuth/blank-key shortcut in v1; that path is gone —
#			      a working connection is now mandatory in normal runs.)
#   -h, --help
#
# Privacy: the only credential copies are (a) the encrypted ~/.pi/onboarding.vault
# (deleted at purge) and (b) ~/.pi/agent/auth.json (Pi's own 0600 store). Plaintext
# creds live in-memory only. See .docs/PLAN.md decisions D1/D2.

set -uo pipefail

# ── bootstrap: if run from curl|sh (no repo alongside), clone + re-exec ─────────
# The one-liner (`curl -fsSL <url>/install.sh | bash`) pipes this script with no
# repo on disk. Detect that (config/ missing alongside) and clone+re-exec.
# Bootstrap env: APPLEPI_REPO_URL (default github.com/jotokra/apple-pi),
# APPLEPI_HOME (default ~/.apple-pi), APPLEPI_GIT_TOKEN (private repos),
# APPLEPI_BRANCH (default main).
# NOTE: under `set -u`, a piped invocation (`curl … | bash`, i.e. `bash -s`)
# has NO source file so BASH_SOURCE[0] is unbound — referencing it bare
# errors out. Default to $0 so the lookup is clean; the empty/cwd result
# correctly forces the bootstrap (clone) path below.
_BS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd)"
if [[ ! -d "$_BS_DIR/config" ]]; then
	_bdie() { printf '\xc3\x97 apple-pi bootstrap: %s\n' "$*" >&2; exit 1; }
	command -v git >/dev/null 2>&1 || _bdie "git is required for the one-liner install. Install it and re-run."
	REPO_URL="${APPLEPI_REPO_URL:-https://github.com/jotokra/apple-pi}"
	CLONE_TO="${APPLEPI_HOME:-$HOME/.apple-pi}"
	BRANCH="${APPLEPI_BRANCH:-main}"
	CLONE_URL="$REPO_URL"
	if [[ -n "${APPLEPI_GIT_TOKEN:-}" ]]; then
		CLONE_URL="${REPO_URL/:\/\//:\/\/${APPLEPI_GIT_TOKEN}@}"
	fi
	printf '\xf0\x9f\xa5\xa7 apple-pi — cloning %s (%s)\n' "$REPO_URL" "$BRANCH"
	if [[ -d "$CLONE_TO/.git" ]]; then
		git -C "$CLONE_TO" fetch --quiet origin "$BRANCH" \
			&& git -C "$CLONE_TO" checkout --quiet "$BRANCH" \
			&& git -C "$CLONE_TO" reset --quiet --hard "origin/$BRANCH" \
			|| _bdie "git update of $CLONE_TO failed. Remove it (or set APPLEPI_HOME) and re-run."
		printf '   updated %s\n' "$CLONE_TO"
	else
		git clone --quiet --branch "$BRANCH" "$CLONE_URL" "$CLONE_TO" \
			|| _bdie "git clone failed. Private repo? set APPLEPI_GIT_TOKEN. Wrong URL? set APPLEPI_REPO_URL."
		printf '   cloned to %s\n' "$CLONE_TO"
	fi
	# Re-exec the repo's install.sh. Scrub the token first so it can't leak into the wizard.
	#
	# Red/blue — the `curl|bash` failure modes (all stem from the piped form,
	# `bash -s`, having NO source file, so BASH_SOURCE[0] is unset):
	#   1. EOF loop: fd 0 is the script-delivery pipe; curl closes it once the
	#      script is delivered, so a later `read` returns EOF → the prompt loops
	#      (`passphrase can't be empty.` × ∞). Handled by _common.sh's _input_eof
	#      (kills the whole script on first EOF, not just the subshell).
	#   2. `set -u` + unset BASH_SOURCE: line 75's `"${BASH_SOURCE[0]}"` aborts
	#      under `set -u`, leaving SCRIPT_DIR wrong → lib/_common.sh doesn't load
	#      → ask/warn/die are undefined → ANOTHER infinite loop. Handled by the
	#      `${BASH_SOURCE[0]:-$0}` default AND by `cd "$CLONE_TO"` here so the
	#      re-exec'd script resolves its own lib/ relative to the clone.
	#
	# Reattach stdin to the controlling terminal if (and only if) one is really
	# openable: `[[ -r /dev/tty ]]` lies — it returns true even when /dev/tty
	# can't be opened (no controlling process). Probe by actually opening it in
	# a subshell (no side effect on the current shell); on success add `</dev/tty`
	# to the re-exec so the wizard reads answers from the keyboard, not the
	# now-closed script-delivery pipe. With no tty, fall through and let
	# _common.sh's _input_eof exit cleanly on first read.
	cd "$CLONE_TO" || _bdie "could not enter $CLONE_TO"
	if ( exec </dev/tty ) 2>/dev/null; then
		exec env -u APPLEPI_GIT_TOKEN bash "$CLONE_TO/install.sh" "$@" </dev/tty
	else
		exec env -u APPLEPI_GIT_TOKEN bash "$CLONE_TO/install.sh" "$@"
	fi
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/lib/_common.sh"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/lib/provider-guide.sh"

# normalize_url <s>  → echo a clean base URL (https scheme, no trailing slash), or empty.
# Fixes BUG C (D7): users paste "api.minimax.io/anthropic" or with a stray trailing /.
normalize_url() {
	local u="${1// /}"
	[[ -z "$u" ]] && return 0
	case "$u" in
		http://*|https://*) ;;
		*) u="https://$u" ;;
	esac
	u="${u%/}"
	u="${u%%/}"
	printf '%s\n' "$u"
}

PURGE_AUTH_TOO=0
SANDBOX=""
NO_HANDOFF=0
SKIP_CONFIRM=0

while [[ $# -gt 0 ]]; do
	case "$1" in
		--purge-auth-too) PURGE_AUTH_TOO=1; shift ;;
		--sandbox)        SANDBOX="$2";     shift 2 ;;
		--no-handoff)     NO_HANDOFF=1;     shift ;;
		--skip-confirm)   SKIP_CONFIRM=1;   shift ;;
		-h|--help)
			sed -n '2,40p' "$0"
			exit 0 ;;
		*) die "unknown flag: $1 (try --help)" ;;
	esac
done

# ── Resolve directories ────────────────────────────────────────────────
REPO_DIR="$SCRIPT_DIR"
if [[ -n "$SANDBOX" ]]; then
	PI_DIR="$SANDBOX"
else
	PI_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi}"
fi
AGENT_DIR="$PI_DIR/agent"
VAULT="$PI_DIR/onboarding.vault"
SCRATCH="$PI_DIR/.onboarding"
SOURCE_MARKER="$PI_DIR/.apple-pi-source"

# Red/blue: refuse an unsafe PI_DIR (system root / empty / not absolute).
case "$PI_DIR" in
	""|"/"|"/etc"|"/usr"|"/var"|"/opt"|"/System"|"/private/etc"|"/bin"|"/sbin")
		die "refusing unsafe PI_DIR: '$PI_DIR'" ;;
esac
[[ "$PI_DIR" == /* ]] || die "PI_DIR must be an absolute path: '$PI_DIR'"

banner "delicious and warm. Better than other pi's.
A refined, self-tuning Pi Coding Agent distribution.
You bring the model + a key; apple-pi boots, proves the
model, DESTROYS the bootstrap secrets, then tunes itself
to your model's real capabilities."

info "Pi config dir : $PI_DIR"
info "apple-pi repo : $REPO_DIR"
[[ -n "$SANDBOX" ]] && warn "SANDBOX MODE — nothing in your real ~/.pi will be touched."

[[ -f "$REPO_DIR/.docs/PLAN.md" ]] || die "could not find .docs/PLAN.md next to install.sh; run from the repo root."

# ── P0 — prerequisites + consent ──────────────────────────────────────
header "P0 · prerequisites"
require_cmd openssl
if [[ -z "$SANDBOX" ]]; then
	if ! command -v pi >/dev/null 2>&1; then
		warn "the 'pi' binary is not on your PATH."
		[[ "$(yorn 'Install Pi now via npm? (needs Node)' n)" == "y" ]] \
			|| die "Pi is required. Install with: npm install -g --ignore-scripts @earendil-works/pi-coding-agent"
		npm install -g --ignore-scripts @earendil-works/pi-coding-agent \
			|| die "npm install failed"
		require_cmd pi
	fi
	pi --version >/dev/null 2>&1 && ok "pi: $(pi --version)" || warn "pi --version returned non-zero (will retry at confirm)"
else
	# sandbox: pi optional; confirm step will be skipped or stubbed
	command -v pi >/dev/null 2>&1 && info "pi: $(pi --version 2>/dev/null || echo 'present')" || warn "pi not on PATH (sandbox confirm will be skipped)"
fi
ok "openssl present"

phase 1 5 "welcome"
header "P0 · consent"
cat <<'EOF'
apple-pi will, with your permission:
  1. Help you pick a model + provider (with an offline guide if you're unsure).
  2. Capture an API key and ENCRYPT it into ~/.pi/onboarding.vault.
  3. Write a config with NO personal information from you.
  4. Make ONE live model call to PROVE the connection works.
  5. Only on success: DELETE the encrypted vault + all onboarding scratch.
  6. Hand control to the agent, which asks permission to look around,
     then tunes the config to your model and offers a workflow.

A working connection is REQUIRED — onboarding does not finish until the
model answers. Your credentials live only in (a) the transient encrypted
vault [deleted on success] and (b) ~/.pi/agent/auth.json [Pi's own 0600
auth store]. Nothing is sent anywhere except the single confirmation call.
EOF
[[ "$(yorn 'Proceed?' y)" == "y" ]] || die "aborted by user."

# ── P1 — onboarding ───────────────────────────────────────────────────
phase 2 5 "choose your model"
cat <<'EOF'
Which model will you use? Type anything — a name, a provider/id, or a
custom endpoint. apple-pi's agent will recognise and wire it.
Examples:  gpt-5 · claude-sonnet-4-5 · gemini-2.5-flash · deepseek-chat
          minimax-m3 · llama-3.3-70b (Groq) · ollama llama3 (local)
Not sure how to get a key? Pick a provider and the guide will walk you
through it at the next step.
EOF
while true; do
	MODEL="$(ask 'Model')"
	[[ -n "$MODEL" ]] && break
	warn "model can't be empty — any non-empty string is accepted."
done
info "recorded model: ${C_BOLD}$MODEL${C_OFF}"

# Provider: resolve from the knowledge base if possible; else ask.
GUIDE_SLUG="$(provider_match "$MODEL")"
if [[ -n "$GUIDE_SLUG" ]]; then
	GUIDE_DISPLAY="$(provider_field "$(provider_file "$GUIDE_SLUG")" display)"
	info "looks like ${C_BOLD}${GUIDE_DISPLAY}${C_OFF} — I'll wire it."
	PROVIDER="$(provider_field "$(provider_file "$GUIDE_SLUG")" auth)"
	[[ -z "$PROVIDER" ]] && PROVIDER="$GUIDE_SLUG"
	GUIDE_BASE="$(provider_field "$(provider_file "$GUIDE_SLUG")" base)"
else
	GUIDE_DISPLAY=""
	PROVIDER="$(ask 'Provider (optional — e.g. openai, anthropic, ollama, mistral; blank to let the agent resolve)' '')"
	GUIDE_BASE=""
fi

# ── credential + guide ────────────────────────────────────────────────
phase 3 5 "connect your provider"
echo
if [[ -n "$GUIDE_SLUG" ]]; then
	info "Getting a ${GUIDE_DISPLAY} key:"
else
	info "Getting a key:"
fi
# Offer the guide (it's interactive; harmless if declined).
if [[ "$(yorn 'Open the key guide? (how/where to get a key, pricing, errors)' y)" == "y" ]]; then
	provider_guide "$GUIDE_SLUG"
fi

echo
info "Paste your API key now. (It's encrypted at rest, never echoed, and"
info "the encrypted copy is destroyed the moment the connection is confirmed.)"
if [[ "$GUIDE_SLUG" == "ollama" ]]; then
	info "Ollama needs no key — just press Enter to leave it blank."
fi
API_KEY="$(ask_secret 'API key')"

# Base URL: pre-fill from the guide's known default if non-standard.
BASE_URL=""
if [[ -n "$GUIDE_BASE" ]]; then
	local_default=""
	case "$GUIDE_SLUG" in
		minimax) local_default="$GUIDE_BASE" ;;   # non-standard: must be set
		ollama)  local_default="$GUIDE_BASE" ;;   # local, must be set
	esac
	if [[ -n "$local_default" ]]; then
		info "${GUIDE_DISPLAY} uses a non-standard base URL: ${C_BOLD}${local_default}${C_OFF}"
		BASE_URL="$local_default"
		ok "base URL set: $BASE_URL"
	else
		raw="$(ask 'Custom base URL (blank = provider default; use a proxy/gateway URL here)' '')"
		BASE_URL="$(normalize_url "$raw")"
	fi
else
	raw="$(ask 'Custom base URL (optional — for OpenAI/Anthropic-compatible gateways)' '')"
	BASE_URL="$(normalize_url "$raw")"
fi
[[ -n "$BASE_URL" ]] && info "base URL: ${C_BOLD}$BASE_URL${C_OFF}"

# Passphrase for the vault.
phase 4 5 "encrypt credentials"
echo "Set a passphrase for the onboarding vault. It encrypts your credential"
echo "at rest during bootstrap and is NEVER written to disk. You won't need"
echo "it again — the vault is destroyed as soon as the connection is confirmed."
while true; do
	PASS1="$(ask_secret 'Passphrase')"
	[[ -n "$PASS1" ]] || { warn "passphrase can't be empty."; continue; }
	PASS2="$(ask_secret 'Confirm passphrase')"
	[[ "$PASS1" == "$PASS2" ]] && break
	warn "passphrases didn't match — retry."
done
VAULT_PASS="$PASS1"

# ── write the encrypted vault ─────────────────────────────────────────
mkdir -p "$SCRATCH" "$AGENT_DIR"
chmod 700 "$SCRATCH" 2>/dev/null || true

CREDS_JSON="$(printf '%s' "{" \
	"\"model\":$(printf '%s' "$MODEL" | _jq_escape), " \
	"\"provider\":$(printf '%s' "$PROVIDER" | _jq_escape), " \
	"\"apiKey\":$(printf '%s' "$API_KEY" | _jq_escape), " \
	"\"baseUrl\":$(printf '%s' "$BASE_URL" | _jq_escape)" \
	"}")"

PLAINTEXT="$SCRATCH/creds.json"
printf '%s' "$CREDS_JSON" > "$PLAINTEXT"
chmod 600 "$PLAINTEXT"

printf '%s' "$VAULT_PASS" | openssl enc -aes-256-cbc -pbkdf2 -iter 600000 -salt \
	-in "$PLAINTEXT" -out "$VAULT" -pass stdin \
	|| die "openssl encryption failed"
chmod 600 "$VAULT"
secure_shred "$PLAINTEXT"
ok "encrypted vault: $VAULT ($(wc -c < "$VAULT" | tr -d ' ') bytes)"

# ── install the config tree into PI_DIR ───────────────────────────────
header "P1 · install config (no personal info)"
_install_tree() {
	local kind="$1"
	if [[ -d "$REPO_DIR/config/$kind" ]]; then
		rm -rf "$PI_DIR/$kind"
		cp -R "$REPO_DIR/config/$kind" "$PI_DIR/$kind" || die "failed to copy config/$kind"
		ok "copied config/$kind → $PI_DIR/$kind"
	fi
}
_install_tree skills
_install_tree prompts
_install_tree extensions

# mcp-bridge ships at the repo root (a multi-file TS extension: index.ts + lib/
# + test/). Copy it into the pi-dir extensions tree so pi auto-discovers it
# (the same way sysinfo/voice/web load). No-op until the user adds mcp.servers
# to their settings — the bridge waits for servers to bridge.
if [[ -d "$REPO_DIR/mcp-bridge" ]]; then
	rm -rf "$PI_DIR/extensions/mcp-bridge"
	cp -R "$REPO_DIR/mcp-bridge" "$PI_DIR/extensions/mcp-bridge" || die "failed to copy mcp-bridge"
	ok "copied mcp-bridge → $PI_DIR/extensions/mcp-bridge (opt-in: add mcp.servers to enable)"
fi

# Voice bundle ships as a pi package (pivoice.py + bin + manifest). The bundle
# is always copied (cheap; makes /voice + Ctrl+Shift+V exist). The heavy deps
# (brew packages + ~465MB model) are OPT-IN: one yorn prompt calls the
# reusable lifecycle/voice-enable.sh. Decline -> /voice still exists and
# prints the enable command when the user tries it.
VOICE_DIR="$PI_DIR/voice"
if [[ -d "$REPO_DIR/config/voice" ]]; then
	rm -rf "$VOICE_DIR"
	cp -R "$REPO_DIR/config/voice" "$VOICE_DIR" || die "failed to copy config/voice"
	ok "copied config/voice → $VOICE_DIR (/voice available; deps optional)"
fi

# Opt-in voice deps (Path A): ask once, never force, never fail onboarding.
# In --sandbox/test mode (or non-interactive stdin), skip the prompt and just
# point the user at the enable script — onboarding must never block on voice.
if [[ -x "$REPO_DIR/lifecycle/voice-enable.sh" ]]; then
	if [[ -n "$SANDBOX" ]]; then
		info "sandbox mode — voice deps not installed. Enable later: bash $REPO_DIR/lifecycle/voice-enable.sh"
	elif [[ "$(yorn 'Enable voice mode now? (downloads ~465MB + brew packages; optional)' n)" == "y" ]]; then
		bash "$REPO_DIR/lifecycle/voice-enable.sh" --yes || warn "voice-enable reported issues — /voice will print the command later"
	else
		info "voice skipped. Enable any time: bash $REPO_DIR/lifecycle/voice-enable.sh"
	fi
fi

# Web bundle ships with its own package.json (playwright + node-html-parser).
# Best-effort `npm install` so its tools work out of the box; never fail the
# whole onboarding if Node/npm are missing or it errors (tools degrade with a
# helpful message instead).
WEB_DIR="$PI_DIR/extensions/web"
if [[ -d "$WEB_DIR" && -f "$WEB_DIR/package.json" ]]; then
	if command -v npm >/dev/null 2>&1; then
		if (cd "$WEB_DIR" && npm install --no-audit --no-fund >/dev/null 2>&1); then
			ok "web bundle deps installed ($WEB_DIR)"
		else
			warn "web bundle npm install failed — run it later: (cd $WEB_DIR && npm install)"
		fi
	else
		warn "npm not found — web bundle deps not installed (browser/search tools will prompt to install)"
	fi
fi

# persona (agent/AGENTS.md) persists; settings.json is rendered from template.
cp "$REPO_DIR/config/agent/AGENTS.md" "$AGENT_DIR/AGENTS.md" || die "failed to copy persona"
ok "installed persona → $AGENT_DIR/AGENTS.md"

# Resolve shell + dirs for the template.
SHELL_BIN="$(command -v zsh || command -v bash || echo /bin/sh)"
EXT_SYSINFO="$PI_DIR/extensions/sysinfo-guard.ts"
EXT_WEB="$PI_DIR/extensions/web"
EXT_VOICE="$PI_DIR/extensions/voice.ts"

# Render settings.json from the template.
TEMPLATE="$REPO_DIR/config/agent/settings.json.template"
SETTINGS_OUT="$AGENT_DIR/settings.json"
# provider: prefer explicit, else derive from model if it has provider/id form, else blank.
RESOLVED_PROVIDER="$PROVIDER"
if [[ -z "$RESOLVED_PROVIDER" && "$MODEL" == */* ]]; then
	RESOLVED_PROVIDER="${MODEL%%/*}"
fi
sed \
	-e "s#__APPLEPI_PROVIDER__#${RESOLVED_PROVIDER}#g" \
	-e "s#__APPLEPI_MODEL__#${MODEL}#g" \
	-e "s#__APPLEPI_EXT_SYSINFO__#${EXT_SYSINFO}#g" \
	-e "s#__APPLEPI_EXT_WEB__#${EXT_WEB}#g" \
	-e "s#__APPLEPI_EXT_VOICE__#${EXT_VOICE}#g" \
	-e "s#__APPLEPI_SKILLS_DIR__#$PI_DIR/skills#g" \
	-e "s#__APPLEPI_PROMPTS_DIR__#$PI_DIR/prompts#g" \
	-e "s#__APPLEPI_SHELL__#${SHELL_BIN}#g" \
	-e "s#__APPLEPI_SESSIONS_DIR__#$PI_DIR/sessions#g" \
	"$TEMPLATE" > "$SETTINGS_OUT" || die "failed to render settings.json"
# Validate JSON (prefer jq; fall back to node; accept if neither).
if command -v jq >/dev/null 2>&1; then
	jq -e '.defaultModel' "$SETTINGS_OUT" >/dev/null || die "rendered settings.json invalid"
elif command -v node >/dev/null 2>&1; then
	node -e "JSON.parse(require('fs').readFileSync('$SETTINGS_OUT','utf8'))" >/dev/null \
		|| die "rendered settings.json invalid"
fi
ok "rendered settings.json (model placeholder set; P3 will retune)"

# ── seed auth.json (Pi's own store, 0600) ─────────────────────────────
# BUG A fix (D7): pi's auth loader (auth-storage.js) requires each entry to be
#   {provider:{type:"api_key",key}}  — NOT {provider:{apiKey}}. The old shape
#   silently failed auth for every key onboarding (verified: pi reported the
#   key MISSING with the old shape, FOUND with the correct one).
AUTH_OUT="$AGENT_DIR/auth.json"
AUTH_PROVIDER="$RESOLVED_PROVIDER"
[[ -n "$AUTH_PROVIDER" ]] || AUTH_PROVIDER="openai"
if [[ -n "$API_KEY" ]]; then
	printf '{"%s":{"type":"api_key","key":%s}}' "$AUTH_PROVIDER" "$(printf '%s' "$API_KEY" | _jq_escape)" > "$AUTH_OUT"
	chmod 600 "$AUTH_OUT"
	ok "seeded $AUTH_OUT (provider=$AUTH_PROVIDER, key $(mask_key "$API_KEY"), mode 0600)"
else
	# No key captured (e.g. Ollama, or a user who'll /login later). Seed an empty
	# store so the confirm step's auth check has something to read; the gate below
	# will require a real connection before finishing.
	printf '{}' > "$AUTH_OUT"
	chmod 600 "$AUTH_OUT"
	info "no API key captured (provider=$AUTH_PROVIDER). The connection check below"
	info "will require a working call — run \`pi /login\` now if you use a subscription/OAuth provider."
fi

# ── models.json: wire a custom base URL (BUG B fix, D7) ────────────────
# pi reads custom base URLs from ~/.pi/agent/models.json (docs/models.md),
# NOT from the vault or settings.json. Without this, a gateway/proxy user got
# a dead config. We write a provider baseUrl override; for a fully custom
# provider the agent resolves it in P3.
MODELS_OUT="$AGENT_DIR/models.json"
if [[ -n "$BASE_URL" ]]; then
	printf '{"providers":{"%s":{"baseUrl":%s}}}' "$AUTH_PROVIDER" "$(printf '%s' "$BASE_URL" | _jq_escape)" > "$MODELS_OUT"
	chmod 600 "$MODELS_OUT"
	ok "wrote $MODELS_OUT (baseUrl override for $AUTH_PROVIDER)"
fi

# ── mirror the key into the persistent credential vault (REQ-CV-4) ────
# onboarding.vault (the transient full-creds carrier above) is shredded at
# confirm. credentials.vault is the NEW persistent user-facing store: we mirror
# the API key here as a `transient` entry so (a) the vault is initialized during
# onboarding and (b) a crashed confirm leaves a reapable entry. At confirm we
# prune transient entries; any PERSISTENT entry the user added later survives.
# The onboarding key ALSO lands in auth.json (the live-use path) — unchanged.
# This is best-effort: if node or the vault core is missing, onboarding still
# works via onboarding.vault + auth.json (the v1 path).
if [[ -n "$API_KEY" ]] && command -v node >/dev/null 2>&1 && [[ -f "$REPO_DIR/vault/lib/vault.js" ]]; then
	if CREDENTIALS_VAULT_PASS="$VAULT_PASS" PI_CODING_AGENT_DIR="$PI_DIR" \
		node "$REPO_DIR/bin/apple-pi" vault add onboarding \
			--provider "$AUTH_PROVIDER" --lifetime transient \
			--note "onboarding (auto-pruned on confirm)" \
			<<<"$API_KEY" >/dev/null 2>&1; then
		ok "mirrored key into credentials.vault (transient; pruned on confirm)"
	else
		warn "could not mirror key into credentials.vault (continuing — onboarding.vault + auth.json still work)"
	fi
fi

# Record the source repo for future updates.
printf '%s\n' "$REPO_DIR" > "$SOURCE_MARKER"

# ── P1 · confirm the connection (REQUIRED gate, D7) ───────────────────
# Onboarding does NOT finish until a live model call replies OK. The old
# "blank key = confirmed" path is gone — a working connection is mandatory.
# --skip-confirm is a test-only escape hatch (it warns loudly when used).
phase 5 5 "confirm the connection"
CONFIRMED=0
_confirm_call() {
	# echoes the raw pi output; sets global CONFIRM_OK=1/0. Uses run_with_spinner
	# for UX. Returns pi's exit code.
	CONFIRM_OK=0
	local args=(--no-tools --no-session -p "Reply with exactly: OK")
	[[ -n "$RESOLVED_PROVIDER" ]] && args=(--provider "$RESOLVED_PROVIDER" "${args[@]}")
	args=(--model "$MODEL" "${args[@]}")
	local log; log="$(mktemp)"
	run_with_spinner "calling $MODEL" "$log" -- pi "${args[@]}"
	local rc=$?
	OUT="$(cat "$log" 2>/dev/null)"; rm -f "$log"
	if (( rc == 0 )) && printf '%s' "$OUT" | grep -qiE '(^|[[:space:]])OK([[:space:]]|$)'; then
		CONFIRM_OK=1
	fi
	return $rc
}

if [[ "$SKIP_CONFIRM" == 1 ]]; then
	warn "--skip-confirm: bypassing the REQUIRED connection check (TEST ONLY)."
	warn "onboarding will finish without proving the model answers."
	CONFIRMED=1
elif ! command -v pi >/dev/null 2>&1; then
	die "pi is not on PATH — cannot run the required connection check. Re-run after installing pi (npm i -g @earendil-works/pi-coding-agent), or use --skip-confirm for tests."
else
	# first attempt
	_confirm_call || true
	if (( CONFIRM_OK == 1 )); then
		ok "connection confirmed — $MODEL replied."
		CONFIRMED=1
	else
		warn "the model did not reply OK on the first try. Common causes:"
		printf '%s\n' "$OUT" | head -12 | sed 's/^/    /'
	fi
	# remediation loop: fix the key/url, peek at the guide, retry — until OK or abort.
	while [[ "$CONFIRMED" == 0 ]]; do
		echo
		info "Pick how to proceed:"
		local -a fixmenu=( "Re-enter the API key" "Change base URL / provider" "Open the key guide (errors + pricing)" "Retry as-is" "Abort" )
		case "$(select_option "What next?" "${fixmenu[@]}")" in
			"Re-enter the API key")
				API_KEY="$(ask_secret 'New API key')"
				if [[ -n "$API_KEY" ]]; then
					printf '{"%s":{"type":"api_key","key":%s}}' "$AUTH_PROVIDER" "$(printf '%s' "$API_KEY" | _jq_escape)" > "$AUTH_OUT"
					chmod 600 "$AUTH_OUT"
					ok "auth.json updated ($(mask_key "$API_KEY"))."
				fi
				;;
			"Change base URL / provider")
				raw="$(ask "Provider [default: ${AUTH_PROVIDER:-openai}]" "")"; [[ -n "$raw" ]] && { RESOLVED_PROVIDER="$raw"; AUTH_PROVIDER="$raw"; }
			raw="$(ask "Base URL [current: ${BASE_URL:-<provider default>}]" "")"; [[ -n "$raw" ]] && { BASE_URL="$(normalize_url "$raw")"; }
				if [[ -n "$BASE_URL" ]]; then
					printf '{"providers":{"%s":{"baseUrl":%s}}}' "$AUTH_PROVIDER" "$(printf '%s' "$BASE_URL" | _jq_escape)" > "$MODELS_OUT"
					chmod 600 "$MODELS_OUT"
					ok "models.json updated (baseUrl=$BASE_URL)."
				fi
				;;
			"Open the key guide (errors + pricing)")
				provider_guide "$GUIDE_SLUG"
				;;
			"Retry as-is") : ;;
			Abort)
				die "connection not confirmed. Bootstrap secrets RETAINED for retry — re-run when ready." ;;
		esac
		_confirm_call || true
		if (( CONFIRM_OK == 1 )); then
			ok "connection confirmed — $MODEL replied."
			CONFIRMED=1
		else
			warn "still not OK:"
			printf '%s\n' "$OUT" | head -8 | sed 's/^/    /'
		fi
	done
fi

# ── P1 · purge bootstrap secrets ──────────────────────────────────────
header "P1 · purge bootstrap secrets"
if [[ "$CONFIRMED" == 1 ]]; then
	secure_shred "$VAULT"
	rm -rf "$SCRATCH"
	ok "destroyed: onboarding.vault + scratch dir (encrypted creds gone)"
	# REQ-CV-4: remove the TRANSIENT entry we mirrored into credentials.vault.
	# (Targeted removal of the "onboarding" id — NOT prune-transient, which is
	# age-gated 24h for R6 crash recovery. Any PERSISTENT entry the user added
	# now or later via /vault add survives intact.) Best-effort.
	if command -v node >/dev/null 2>&1 && [[ -f "$REPO_DIR/vault/lib/vault.js" ]]; then
		if CREDENTIALS_VAULT_PASS="$VAULT_PASS" PI_CODING_AGENT_DIR="$PI_DIR" \
			node "$REPO_DIR/bin/apple-pi" vault remove onboarding >/dev/null 2>&1; then
			ok "removed transient entry from credentials.vault (persistent entries kept)"
		fi
	fi
	# settings.json is the INTERNAL SEED (marked _applepi_seed=true). It is NOT yet the
	# user's config — P3 rewrites it clean (strips the seed marker + every _comment field,
	# retunes to the model). We keep it as the seed because Pi needs a settings.json to
	# run P3 at all. After P3, what remains is the user's own config, not an apple-pi artifact.
	info "kept settings.json as the internal seed (P3 will rewrite it into the user's clean config)"
	if [[ "$PURGE_AUTH_TOO" == 1 ]]; then
		secure_shred "$AUTH_OUT"
		ok "destroyed: auth.json (--purge-auth-too). Re-authorise via /login after handoff."
	else
		info "kept auth.json (the user's runtime auth; lives alongside the tuned config)."
	fi
else
	die "model not confirmed; bootstrap secrets RETAINED for retry. Re-run when ready."
fi

# Scrub secrets from the environment we control.
unset API_KEY VAULT_PASS PASS1 PASS2 CREDS_JSON 2>/dev/null || true

# ── HANDOFF to the agent (P2 discovery, P3 self-improve, P4, P5) ───────
header "handoff → agent"
HANDOFF_PROMPT="$REPO_DIR/lib/handoff.md"
[[ -f "$HANDOFF_PROMPT" ]] || die "missing $HANDOFF_PROMPT"

# Compose the handoff message: the prompt + a status block the agent reads.
HANDOFF_BODY="$(cat <<EOF
$(cat "$HANDOFF_PROMPT")

---
## Onboarding status (machine-generated, read this first)
- pi config dir : $PI_DIR
- model (user)  : $MODEL
- provider      : ${RESOLVED_PROVIDER:-<unspecified — resolve in P3>}
- auth.json     : $([ -f "$AUTH_OUT" ] && echo 'seeded' || echo 'NOT seeded — guide /login')
- settings.json : $([ -f "$SETTINGS_OUT" ] && echo 'present (seed; retune it in P3)' || echo 'absent — write it fresh in P3')
- skills/prompts/extensions : installed under $PI_DIR/
- source repo   : $REPO_DIR (spec: $REPO_DIR/.docs/PLAN.md)
- vault         : DESTROYED (creds live only in auth.json now)
EOF
)"

if [[ "$NO_HANDOFF" == 1 ]]; then
	info "--no-handoff: model confirmed + secrets purged. Hand off with:"
	echo
	echo "  PI_CODING_AGENT_DIR='$PI_DIR' \\"
	echo "  pi --model '$MODEL' ${RESOLVED_PROVIDER:+--provider '$RESOLVED_PROVIDER'} \\"
	echo "    --name apple-pi-onboarding -p \"\$(cat $HANDOFF_PROMPT)\""
	echo
	ok "onboarding complete. Re-run without --no-handoff to auto-hand-off."
	exit 0
fi

if [[ -n "$SANDBOX" ]] || ! command -v pi >/dev/null 2>&1; then
	info "(sandbox or no pi on PATH) — printing the handoff command instead of exec'ing:"
	echo
	printf '%s\n' "$HANDOFF_BODY" | sed 's/^/    /' | head -40
	echo
	ok "onboarding flow complete in sandbox."
	exit 0
fi

info "launching Pi agent on $MODEL to run discovery → self-improve → offer..."
echo
export PI_CODING_AGENT_DIR="$PI_DIR"
HANDOFF_ARGS=(--model "$MODEL" --name "apple-pi-onboarding")
[[ -n "$RESOLVED_PROVIDER" ]] && HANDOFF_ARGS=(--provider "$RESOLVED_PROVIDER" "${HANDOFF_ARGS[@]}")
exec pi "${HANDOFF_ARGS[@]}" -p "$HANDOFF_BODY"
