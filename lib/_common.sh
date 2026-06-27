# lib/_common.sh — shared helpers for the apple-pi installer.
# Sourced, not executed. Pure POSIX-ish bash (works on macOS bash 3.2 + Linux).

# Palette. Detect color support: prefer 256-color accents when available,
# but every glyph also degrades to the basic 8 + plain. All C_* are empty when
# stderr isn't a tty (so piped/CI output stays clean).
if [[ -t 2 ]]; then
	C_RED=$'\033[31m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'
	C_CYAN=$'\033[36m'; C_BOLD=$'\033[1m'; C_OFF=$'\033[0m'
	C_DIM=$'\033[2m'; C_MAGENTA=$'\033[35m'; C_BLUE=$'\033[34m'
	C_BR_CYAN=$'\033[96m'; C_BR_GREEN=$'\033[92m'; C_BR_YELLOW=$'\033[93m'
else
	C_RED=""; C_GREEN=""; C_YELLOW=""; C_CYAN=""; C_BOLD=""; C_OFF=""
	C_DIM=""; C_MAGENTA=""; C_BLUE=""; C_BR_CYAN=""; C_BR_GREEN=""; C_BR_YELLOW=""
fi

# apple-pi accent = warm apple-pink/magenta; phase accent = cyan.
APPLEPI_ACCENT="${C_MAGENTA}"
PHASE_ACCENT="${C_BR_CYAN}"
_OK="${C_BR_GREEN}"
_WARN="${C_BR_YELLOW}"
_BAD="${C_RED}"

# Box glyphs (UTF-8; fine on every terminal we target).
BOX_TL="┌"; BOX_TR="┐"; BOX_BL="└"; BOX_BR="┘"; BOX_H="─"; BOX_V="│"
BOX_RTL="╭"; BOX_RTR="╮"; BOX_RBL="╰"; BOX_RBR="╰"   # rounded (BL/BR distinct below)
BOX_RBL="╰"; BOX_RBR="╯"

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

# banner <multi-line text> — the apple-pi title card (rounded, accent border).
banner() {
	local body="$1"
	local bar="──────────────────────────────────────────────"
	echo
	echo "${C_BOLD}${APPLEPI_ACCENT}╭── 🥧 apple-pi ──${C_OFF}${C_DIM}${bar}${C_OFF}"
	while IFS= read -r _line; do
		echo "${APPLEPI_ACCENT}│${C_OFF} ${C_BOLD}${_line}${C_OFF}"
	done <<< "$body"
	echo "${APPLEPI_ACCENT}╰${C_OFF}${C_DIM}${bar}${C_OFF}"
	echo
}

# panel <title> <body> — a titled rounded box (used for guidance text).
panel() {
	local title="$1" body="$2"
	local bar="──────────────────────────────────────────────────"
	echo
	echo "${C_BOLD}${C_CYAN}╭─ ${title} ${C_OFF}${C_DIM}${bar}${C_OFF}"
	while IFS= read -r _line; do
		echo "${C_CYAN}│${C_OFF} ${_line}"
	done <<< "$body"
	echo "${C_CYAN}╰${C_OFF}${C_DIM}${bar}${C_OFF}"
	echo
}

# phase <n> <total> <title> — progress stepper. e.g.  phase 2 5 "connect provider"
phase() {
	local n="$1" total="$2" title="$3" i
	local dots=""
	for ((i=1; i<=total; i++)); do
		if (( i < n )); then dots+="${_OK}◆${C_OFF} "
		elif (( i == n )); then dots+="${PHASE_ACCENT}◆${C_OFF} "
		else dots+="${C_DIM}◇${C_OFF} "
		fi
	done
	echo
	echo "${C_DIM}──${C_OFF} ${dots} ${C_BOLD}${PHASE_ACCENT}${n}${C_OFF}${C_DIM}/${total}${C_OFF}  ${C_BOLD}${title}${C_OFF}"
	echo "${C_DIM}──────────────────────────────────────────────────────────${C_OFF}"
}

# mask_key <key> — show first4 + … + last4 for safe display.
mask_key() {
	local k="$1"
	if [[ -z "$k" ]]; then echo "${C_DIM}(none)${C_OFF}"; return; fi
	local len=${#k}
	if (( len <= 8 )); then echo "${C_DIM}(set, ${len} chars)${C_OFF}"; return; fi
	printf '%s…%s\n' "${k:0:4}" "${k: -4}"
}

# select_option <prompt> <options...>  (options as remaining args, one per line)
# Prints the chosen option to stdout. Arrow-key + enter on a tty; number+enter
# (or a bare return = first) when stdin is not a tty (keeps piped tests working).
# Bash 3.2-safe (no associative arrays).
select_option() {
	local prompt="$1"; shift
	local -a opts=( "$@" )
	local n=${#opts[@]}
	local sel=0 i key

	# Non-interactive: read one line, accept a 1-based number or exact text.
	if [[ ! -t 0 ]]; then
		local reply
		read -r reply || _input_eof
		reply="${reply:-1}"
		if [[ "$reply" =~ ^[0-9]+$ ]] && (( reply >= 1 && reply <= n )); then
			printf '%s\n' "${opts[$((reply-1))]}"
		else
			for ((i=0;i<n;i++)); do
				[[ "${opts[i]}" == "$reply" ]] && { printf '%s\n' "$reply"; return; }
			done
			printf '%s\n' "${opts[0]}"   # forgiving default for scripted runs
		fi
		return
	fi

	# Interactive arrow-key menu. Render once, redraw in place on each key.
	_render_menu() {
		# move up n lines + 1 (the prompt line) to redraw
		printf '\033[%dA' "$((n+1))"
		printf '%s\n' "${C_BOLD}${prompt}${C_OFF}"
		for ((i=0;i<n;i++)); do
			if (( i == sel )); then
				printf '  %s❯ %s%s%s\n' "${PHASE_ACCENT}" "${C_BOLD}" "${opts[i]}" "${C_OFF}"
			else
				printf '    %s%s%s\n' "${C_DIM}" "${opts[i]}" "${C_OFF}"
			fi
		done
	}

	echo "${C_BOLD}${prompt}${C_OFF}"
	for ((i=0;i<n;i++)); do
		if (( i == sel )); then
			echo "  ${PHASE_ACCENT}❯ ${C_BOLD}${opts[i]}${C_OFF}"
		else
			echo "    ${C_DIM}${opts[i]}${C_OFF}"
		fi
	done

	# hide cursor, read raw keys
	printf '\033[?25l'
	while true; do
		IFS= read -rsn1 key || { printf '\033[?25h'; _input_eof; }
		case "$key" in
			$'\x1b')
				IFS= read -rsn1 -t 0.01 _a || true
				IFS= read -rsn1 -t 0.01 _b || true
			case "$_b" in
				A) (( sel=(sel-1+n)%n )); _render_menu ;;   # up
				B) (( sel=(sel+1)%n )); _render_menu ;;     # down
			esac ;;
			$'\r'|$'\n') printf '\033[?25h'; printf '%s\n' "${opts[sel]}"; return ;;
			[1-9])
				if (( key-1 < n )); then sel=$((key-1)); _render_menu; fi ;;
			q|Q) printf '\033[?25h'; _input_eof ;;
		esac
	done
}

# run_with_spinner <msg> <logfile> -- <cmd...>
# Runs cmd with stdout+stderr captured to logfile; animates a spinner on the tty
# (stderr) while it runs; prints ✓/✗ + elapsed on completion. Returns cmd's exit.
run_with_spinner() {
	local msg="$1" log="$2"; shift 3   # shift past msg, log, and "--"
	local start=$SECONDS
	local spin_pid
	if [[ -t 2 ]]; then
		(
			local f=0 frames=('⠋' '⠙' '⠹' '⠸' '⠼' '⠴' '⠦' '⠧' '⠇' '⠏')
			while true; do
				printf '\r%s %s%s%s' "${C_CYAN}" "${frames[f]}" "${C_OFF}" "${msg}   " >&2
				f=$(( (f+1) % 10 ))
				sleep 0.08
			done
		) >&2 &
		spin_pid=$!
	fi
	"$@" >"$log" 2>&1
	local rc=$?
	if [[ -n "${spin_pid:-}" ]]; then
		kill "$spin_pid" 2>/dev/null; wait "$spin_pid" 2>/dev/null || true
		printf '\r\033[K' >&2   # clear the spinner line
	fi
	local elapsed=$(( SECONDS - start ))
	if (( rc == 0 )); then
		printf '%s✓%s %s  %s(%ss)%s\n' "${_OK}" "${C_OFF}" "${msg}" "${C_DIM}" "${elapsed}" "${C_OFF}"
	else
		printf '%s✗%s %s  %s(%ss, exit %d)%s\n' "${_BAD}" "${C_OFF}" "${msg}" "${C_DIM}" "${elapsed}" "$rc" "${C_OFF}"
	fi
	return $rc
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
