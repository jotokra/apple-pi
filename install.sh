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
#   --skip-confirm     Skip the live model-confirm call (for air-gapped / OAuth flows).
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
_BS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
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
	exec env -u APPLEPI_GIT_TOKEN bash "$CLONE_TO/install.sh" "$@"
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/lib/_common.sh"

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

header "P0 · consent"
cat <<'EOF'
apple-pi will, with your permission:
  1. Ask which model you'll use (ANY input accepted).
  2. Capture a credential, ENCRYPT it into ~/.pi/onboarding.vault.
  3. Write a config with NO personal information from you.
  4. Make ONE model call to confirm it works.
  5. On confirm, DELETE the encrypted vault + all onboarding scratch.
  6. Hand control to the agent, which asks permission to look around,
     then tunes the config to your model and offers a workflow.

Your credentials live only in (a) the transient encrypted vault [deleted]
and (b) ~/.pi/agent/auth.json [Pi's own 0600 auth store]. Nothing is sent
anywhere except the single confirmation call to your model provider.
EOF
[[ "$(yorn 'Proceed?' y)" == "y" ]] || die "aborted by user."

# ── P1 — onboarding ───────────────────────────────────────────────────
header "P1 · model"

cat <<'EOF'
Which model will you use? Type anything — a name, a provider/id, even a
custom endpoint description. apple-pi's agent will recognise and wire it.
Examples: "gpt-5", "claude-opus-4", "deepseek-chat",
          "my local ollama llama3", "qwen-max".
EOF
while true; do
	MODEL="$(ask 'Model')"
	[[ -n "$MODEL" ]] && break
	warn "model can't be empty — any non-empty string is accepted."
done
info "recorded model: $MODEL"

PROVIDER="$(ask 'Provider (optional — e.g. openai, anthropic, ollama, mistral; blank to let the agent resolve)' '')"

echo
info "Now the credential. For API-key providers, paste the key."
info "For subscription/OAuth providers (ChatGPT Plus, Copilot, Claude Pro),"
info "leave the key blank — you'll authorise via /login after onboarding."
API_KEY="$(ask_secret 'API key (leave blank for OAuth)')"
BASE_URL="$(ask 'Custom base URL (optional — for OpenAI/Anthropic-compatible gateways)' '')"

# Passphrase for the vault.
header "P1 · encrypt credentials"
echo "Set a passphrase for the onboarding vault. It encrypts your credential"
echo "at rest during bootstrap and is NEVER written to disk. You won't need"
echo "it again — the vault is destroyed at the end of this phase."
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

# persona (agent/AGENTS.md) persists; settings.json is rendered from template.
cp "$REPO_DIR/config/agent/AGENTS.md" "$AGENT_DIR/AGENTS.md" || die "failed to copy persona"
ok "installed persona → $AGENT_DIR/AGENTS.md"

# Resolve shell + dirs for the template.
SHELL_BIN="$(command -v zsh || command -v bash || echo /bin/sh)"
EXT_SYSINFO="$PI_DIR/extensions/sysinfo-guard.ts"

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
AUTH_OUT="$AGENT_DIR/auth.json"
if [[ -n "$API_KEY" ]]; then
	AUTH_PROVIDER="$RESOLVED_PROVIDER"
	[[ -n "$AUTH_PROVIDER" ]] || AUTH_PROVIDER="openai"
	printf '{"%s":{"apiKey":%s}}' "$AUTH_PROVIDER" "$(printf '%s' "$API_KEY" | _jq_escape)" > "$AUTH_OUT"
	chmod 600 "$AUTH_OUT"
	ok "seeded $AUTH_OUT (provider=$AUTH_PROVIDER, mode 0600)"
else
	warn "no API key captured — auth.json left for /login (subscription/OAuth provider)."
	info "after handoff, run:  pi /login"
fi

# Record the source repo for future updates.
printf '%s\n' "$REPO_DIR" > "$SOURCE_MARKER"

# ── P1 · confirm the model works ──────────────────────────────────────
CONFIRMED=0
if [[ "$SKIP_CONFIRM" == 0 ]]; then
	header "P1 · confirm model"
	if [[ -z "$API_KEY" ]]; then
		warn "no API key → skipping live confirm (OAuth/subscription path)."
		info "the model is taken as confirmed; run /login after handoff to authorise."
		CONFIRMED=1
	elif ! command -v pi >/dev/null 2>&1; then
		warn "pi not on PATH → skipping live confirm."
		CONFIRMED=1
	else
		info "making one call to: $MODEL"
		CONFIRM_ARGS=(--no-tools --no-session -p "Reply with exactly the two characters: OK")
		[[ -n "$RESOLVED_PROVIDER" ]] && CONFIRM_ARGS=(--provider "$RESOLVED_PROVIDER" "${CONFIRM_ARGS[@]}")
		CONFIRM_ARGS=(--model "$MODEL" "${CONFIRM_ARGS[@]}")
		if OUT="$(pi "${CONFIRM_ARGS[@]}" 2>&1)"; then
			if printf '%s' "$OUT" | grep -qiE '(^|[[:space:]])OK([[:space:]]|$)'; then
				ok "model confirmed — it replied."
				CONFIRMED=1
			else
				warn "model call succeeded but didn't reply 'OK':"
				printf '%s\n' "$OUT" | head -20 | sed 's/^/    /'
			fi
		else
			warn "model call failed:"
			printf '%s\n' "$OUT" | head -20 | sed 's/^/    /'
		fi
		while [[ "$CONFIRMED" == 0 ]]; do
			echo
			case "$(yorn 'Retry the confirm call?' y)" in
				y)
					if OUT="$(pi "${CONFIRM_ARGS[@]}" 2>&1)"; then
						if printf '%s' "$OUT" | grep -qiE '(^|[[:space:]])OK([[:space:]]|$)'; then
							ok "model confirmed — it replied."
							CONFIRMED=1
						else
							warn "retry: still not 'OK':"
							printf '%s\n' "$OUT" | head -20 | sed 's/^/    /'
						fi
					else
						warn "retry: call failed:"
						printf '%s\n' "$OUT" | head -20 | sed 's/^/    /'
					fi
					;;
				n)
					[[ "$(yorn 'Proceed anyway (model not confirmed)? The agent will retry recognition in P3.' n)" == "y" ]] \
						&& CONFIRMED=1
					break ;;
			esac
		done
	fi
else
	warn "confirm skipped (--skip-confirm)."
	CONFIRMED=1
fi

# ── P1 · purge bootstrap secrets ──────────────────────────────────────
header "P1 · purge bootstrap secrets"
if [[ "$CONFIRMED" == 1 ]]; then
	secure_shred "$VAULT"
	rm -rf "$SCRATCH"
	ok "destroyed: onboarding.vault + scratch dir (encrypted creds gone)"
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
