# lib/_common.sh — shared helpers for the apple-pi installer.
# Sourced, not executed. Pure POSIX-ish bash (works on macOS bash 3.2 + Linux).

if [[ -t 2 ]]; then
	C_RED=$'\033[31m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'
	C_CYAN=$'\033[36m'; C_BOLD=$'\033[1m'; C_OFF=$'\033[0m'
else
	C_RED=""; C_GREEN=""; C_YELLOW=""; C_CYAN=""; C_BOLD=""; C_OFF=""
fi

# _input_eof — fatal: stdin closed mid-prompt.
#
# ask/ask_secret/yorn are ALWAYS invoked inside command substitution (a
# subshell), so a plain `exit` here would only end the subshell and the
# caller would loop forever on the empty result (this was the `curl|bash`
# infinite-loop bug: "passphrase can't be empty." × ∞). Kill the WHOLE
# script instead so a missing/closed tty fails loud and exactly once.
# `$$` is the top-level shell PID even from inside a subshell.
_input_eof() {
	echo >&2
	echo "${C_RED}✗ apple-pi: input closed (EOF).${C_OFF}" >&2
	echo "${C_RED}  Run apple-pi from an interactive terminal, or pipe answers via stdin.${C_OFF}" >&2
	kill -TERM "$$" 2>/dev/null || true
	exit 130
}

banner() {
	echo
	echo "${C_BOLD}${C_CYAN}┌─ apple-pi ─────────────────────────────────────────${C_OFF}"
	while IFS= read -r _line; do
		echo "${C_CYAN}│${C_OFF} $_line"
	done <<< "$1"
	echo "${C_BOLD}${C_CYAN}└────────────────────────────────────────────────────${C_OFF}"
	echo
}

header() { echo; echo "${C_BOLD}${C_CYAN}== $1 ==${C_OFF}"; }
info()   { echo "${C_CYAN}•${C_OFF} $1"; }
ok()     { echo "${C_GREEN}✓${C_OFF} $1"; }
warn()   { echo "${C_YELLOW}!${C_OFF} $1" >&2; }
die()    { echo "${C_RED}✗ apple-pi: $1${C_OFF}" >&2; exit "${2:-1}"; }

# ask <prompt> [default]   → echoes user input (or default on empty enter)
ask() {
	local prompt="$1"; local default="${2:-}"
	local suffix=""
	[[ -n "$default" ]] && suffix=" ${C_YELLOW}[$default]${C_OFF}"
	local reply
	if [[ -n "$default" ]]; then
		read -rp "${C_BOLD}${prompt}${suffix}:${C_OFF} " reply || _input_eof
		echo "${reply:-$default}"
	else
		read -rp "${C_BOLD}${prompt}:${C_OFF} " reply || _input_eof
		echo "$reply"
	fi
}

# ask_secret <prompt>   → echoes the secret (no echo to terminal)
ask_secret() {
	local prompt="$1"
	local reply
	read -rs -p "${C_BOLD}${prompt}:${C_OFF} " reply || _input_eof
	echo >&2
	echo "$reply"
}

# yorn <prompt> [default(y/n)]   → echoes "y" or "n"
yorn() {
	local prompt="$1"; local default="${2:-y}"
	local hint="y/N"; [[ "$default" == "y" ]] && hint="Y/n"
	local reply
	while true; do
		read -rp "${C_BOLD}${prompt}${C_OFF} ${C_YELLOW}[$hint]${C_OFF} " reply || _input_eof
		reply="${reply:-$default}"
		case "$reply" in
			y|Y|yes) echo "y"; return ;;
			n|N|no)  echo "n"; return ;;
		esac
	done
}

require_cmd() {
	command -v "$1" >/dev/null 2>&1 || die "required command not found: $1 (install it and re-run)"
}

# secure_shred <file> — best-effort overwrite+remove (rm -P on macOS, shred on Linux, else rm)
secure_shred() {
	local f="$1"
	[[ -f "$f" ]] || return 0
	if rm -Pf "$f" 2>/dev/null; then return 0; fi
	if command -v shred >/dev/null 2>&1; then shred -u "$f"; return 0; fi
	rm -f "$f"
}

# _jq_escape — read a string from stdin, emit a JSON-quoted+escaped string.
# Minimal (no jq dependency). Handles backslash, double-quote, newline, CR, tab.
# Usage: printf '%s' "$val" | _jq_escape   →   "escaped value"
_jq_escape() {
	local s
	s="$(cat)"
	s="${s//\\/\\\\}"
	s="${s//\"/\\\"}"
	s="${s//$'\n'/\\n}"
	s="${s//$'\r'/\\r}"
	s="${s//$'\t'/\\t}"
	printf '"%s"' "$s"
}
