#!/bin/bash
# lifecycle/voice-enable.sh — opt-in installer for voice-mode dependencies.
#
#   voice-enable.sh                interactive: prompt, then install everything
#   voice-enable.sh --yes          non-interactive (assume yes to all)
#   voice-enable.sh --check        report what's missing, change nothing
#
# Voice mode (/voice → pivoice) needs three things beyond the bundled app:
#   - python3     (usually already present on macOS)
#   - ffmpeg      (Homebrew) — avfoundation mic capture
#   - whisper-cpp (Homebrew) — on-device speech-to-text
#   - a ggml model (~465MB)   — the actual whisper weights
#
# This script is opt-in: onboarding offers it once (Path A). It never fails the
# parent install — every step degrades to a clear "do this later" message.
# Re-runnable: skips anything already present.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/.." && pwd)"
PI_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi}"
VOICE_DIR="$PI_DIR/voice"
MODEL_URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin"
MODEL_PATH="$VOICE_DIR/models/ggml-small.en.bin"

# minimal color helpers (don't depend on _common.sh so this runs standalone)
C_OFF=""; C_BOLD=""; C_GREEN=""; C_YELLOW=""; C_RED=""; C_DIM=""
if [[ -t 1 ]]; then
	C_OFF=$'\033[0m'; C_BOLD=$'\033[1m'; C_GREEN=$'\033[32m'
	C_YELLOW=$'\033[33m'; C_RED=$'\033[31m'; C_DIM=$'\033[90m'
fi
ok()   { printf '%s✓%s %s\n' "$C_GREEN" "$C_OFF" "$*"; }
warn() { printf '%s!%s %s\n' "$C_YELLOW" "$C_OFF" "$*" >&2; }
info() { printf '%s·%s %s\n' "$C_DIM" "$C_OFF" "$*"; }
die()  { printf '%s✗%s %s\n' "$C_RED" "$C_OFF" "$*" >&2; exit 1; }

yorn() {
	local prompt="$1"; local default="${2:-y}"; local hint="y/N"
	[[ "$default" == "y" ]] && hint="Y/n"
	local reply
	while true; do
		read -rp "${C_BOLD}${prompt}${C_OFF} ${C_YELLOW}[${hint}]${C_OFF} " reply || return 1
		reply="${reply:-$default}"
		case "$reply" in y|Y|yes) return 0 ;; n|N|no) return 1 ;; esac
	done
}

ASSUME_YES=0; CHECK_ONLY=0
for a in "$@"; do
	case "$a" in
		--yes|-y) ASSUME_YES=1 ;;
		--check)  CHECK_ONLY=1 ;;
		-h|--help)
			sed -n '2,18p' "$0"; exit 0 ;;
		*) die "unknown arg: $a" ;;
	esac
done

# ── status check ────────────────────────────────────────────────────────
have_python=0; have_ffmpeg=0; have_whisper=0; have_model=0
command -v python3    >/dev/null 2>&1 && have_python=1
command -v ffmpeg     >/dev/null 2>&1 && have_ffmpeg=1
command -v whisper-cli >/dev/null 2>&1 && have_whisper=1   # whisper-cpp binary
[[ -f "$MODEL_PATH" ]] && have_model=1

if [[ $CHECK_ONLY -eq 1 ]]; then
	echo "voice-mode dependency status:"
	[[ $have_python  -eq 1 ]] && ok "python3"     || warn "python3      MISSING"
	[[ $have_ffmpeg  -eq 1 ]] && ok "ffmpeg"      || warn "ffmpeg       MISSING"
	[[ $have_whisper -eq 1 ]] && ok "whisper-cpp" || warn "whisper-cpp  MISSING"
	[[ $have_model   -eq 1 ]] && ok "ggml model"  || warn "ggml model   MISSING (~465MB)"
	exit 0
fi

# ── the offer ───────────────────────────────────────────────────────────
echo
echo "${C_BOLD}Enable voice mode?${C_OFF}"
echo "  Installs: ffmpeg + whisper-cpp (Homebrew) and a ~465MB whisper model."
echo "  Lets you type ${C_DIM}/${C_OFF}voice${C_DIM} (or Ctrl+V) to talk to the agent.${C_OFF}"
echo "  On-device, private (whisper.cpp + macOS 'say')."
echo

if [[ $ASSUME_YES -ne 1 ]]; then
	yorn "Download voice dependencies now?" n || { info "skipped — /voice will print this command if you try it later."; exit 0; }
fi

mkdir -p "$VOICE_DIR/models"

# ── Homebrew packages ───────────────────────────────────────────────────
if ! command -v brew >/dev/null 2>&1; then
	warn "Homebrew not found — can't auto-install ffmpeg/whisper-cpp."
	info "Install brew (https://brew.sh) then re-run: bash $0"
else
	for pkg in ffmpeg whisper-cpp; do
		# whisper-cpp's CLI is whisper-cli; ffmpeg's is ffmpeg
		if [[ "$pkg" == "whisper-cpp" && $have_whisper -eq 1 ]]; then continue; fi
		if [[ "$pkg" == "ffmpeg"     && $have_ffmpeg -eq 1 ]]; then continue; fi
		info "brew install $pkg …"
		if brew install "$pkg" >/dev/null 2>&1; then ok "installed $pkg"
		else warn "brew install $pkg failed — install manually later"; fi
	done
fi

command -v python3 >/dev/null 2>&1 || warn "python3 not found — voice mode needs it (install via brew or xcode cli tools)"

# ── the model (the big one) ─────────────────────────────────────────────
if [[ $have_model -eq 1 ]]; then
	ok "ggml model already present ($MODEL_PATH)"
else
	info "downloading ggml-small.en.bin (~465MB)…"
	if curl -fL --progress-bar -o "$MODEL_PATH" "$MODEL_URL"; then
		ok "model downloaded → $MODEL_PATH"
	else
		warn "model download failed. Get it manually:"
		warn "  curl -L -o \"$MODEL_PATH\" \"$MODEL_URL\""
		rm -f "$MODEL_PATH"
	fi
fi

# ── report ──────────────────────────────────────────────────────────────
echo
echo "${C_BOLD}Voice mode status:${C_OFF}"
[[ $(command -v python3 >/dev/null 2>&1; echo $?) -eq 0 ]] && ok "python3"  || warn "python3 missing"
[[ $(command -v ffmpeg  >/dev/null 2>&1; echo $?) -eq 0 ]] && ok "ffmpeg"   || warn "ffmpeg missing"
[[ $(command -v whisper-cli >/dev/null 2>&1; echo $?) -eq 0 ]] && ok "whisper-cpp" || warn "whisper-cpp missing"
[[ -f "$MODEL_PATH" ]] && ok "ggml model" || warn "ggml model missing"
echo
if [[ $(command -v python3 >/dev/null 2>&1; echo $?) -eq 0 && $(command -v ffmpeg >/dev/null 2>&1; echo $?) -eq 0 \
	&& $(command -v whisper-cli >/dev/null 2>&1; echo $?) -eq 0 && -f "$MODEL_PATH" ]]; then
	ok "${C_BOLD}Voice ready.${C_OFF} Type ${C_DIM}/voice${C_OFF} (or Ctrl+V) in any pi session."
else
	warn "Some deps missing — finish them, then /voice will work."
fi
