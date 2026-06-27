# smoke/_lib.sh — shared helpers for apple-pi smoke scripts. Sourced.

if [[ -t 2 ]]; then
	RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; CYAN=$'\033[36m'; OFF=$'\033[0m'
else
	RED=""; GREEN=""; YELLOW=""; CYAN=""; OFF=""
fi

header() { echo -e "${CYAN}== ${1} ==${OFF}" >&2; }
info()   { echo -e "${CYAN}•${OFF} $1" >&2; }
ok()     { echo -e "${GREEN}OK${OFF}   $1" >&2; }
fail()   { echo -e "${RED}FAIL${OFF} $1" >&2; }
warn()   { echo -e "${YELLOW}WARN${OFF} $1" >&2; }

require() { command -v "$1" >/dev/null 2>&1 || { fail "required command not found: $1"; exit 1; }; }
