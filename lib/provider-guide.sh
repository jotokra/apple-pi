# lib/provider-guide.sh — interactive provider key-acquisition guide.
#
# Sourced by install.sh AFTER lib/_common.sh. Reads lib/providers/*.md, each
# with a small frontmatter block + ## sections. Solves the chicken-and-egg of
# "ask the agent how to get a key" before any key exists: the guidance is a
# curated OFFLINE knowledge base, so it works with zero credentials. (A live
# LLM assistant isn't possible pre-key; post-connection the handoff agent
# itself is the assistant.)
#
# Bash-3.2-safe (awk for parsing; no associative arrays).

PROVIDERS_DIR="${PROVIDERS_DIR:-$SCRIPT_DIR/lib/providers}"

# list of provider .md paths (sorted, deterministic)
_provider_files() {
	find "$PROVIDERS_DIR" -maxdepth 1 -type f -name '*.md' 2>/dev/null | sort
}

# provider_field <file> <field>  →  frontmatter value (key match, case-insensitive)
provider_field() {
	local file="$1" field="$2"
	[[ -f "$file" ]] || return 0
	awk -v f="$field" '
		NR==1 && /^---[[:space:]]*$/ { infm=1; next }
		infm && /^---[[:space:]]*$/ { exit }
		infm {
			i=index($0,":")
			if (i>0) {
				k=tolower(substr($0,1,i-1)); v=substr($0,i+1)
				gsub(/^[ \t]+/,"",v); gsub(/[ \t]+$/,"",v)
				if (k==f) { print v; exit }
			}
		}
	' "$file"
}

# provider_section <file> <heading>  →  body under ## <heading> until next ##
provider_section() {
	local file="$1" heading="$2"
	[[ -f "$file" ]] || return 0
	awk -v h="$heading" '
		{ line=$0 }
		/^##[[:space:]]/ {
			cur=line; sub(/^##[[:space:]]+/,"",cur)
			insec=(tolower(cur) ~ tolower(h))
			next
		}
		insec { print }
	' "$file"
}

# provider_file <slug>  →  path for a slug (empty if absent)
provider_file() {
	local slug="$1" f
	while IFS= read -r f; do
		[[ "$(provider_field "$f" slug)" == "$slug" ]] && { printf '%s\n' "$f"; return; }
	done < <(_provider_files)
}

# provider_show <slug>  →  render the key-acquisition guide for a provider.
provider_show() {
	local slug="$1"
	local file; file="$(provider_file "$slug")"
	[[ -n "$file" ]] || { warn "no provider guide for '$slug'."; return 1; }
	local display env default base models
	display="$(provider_field "$file" display)"
	env="$(provider_field "$file" env)"
	default="$(provider_field "$file" default)"
	base="$(provider_field "$file" base)"
	models="$(provider_field "$file" models)"

	echo
	echo "${C_BOLD}${APPLEPI_ACCENT}● ${display}${C_OFF}"
	[[ -n "$default" ]] && echo "  ${C_DIM}a good first model:${C_OFF} ${C_BOLD}${default}${C_OFF}"
	[[ -n "$models" ]]  && echo "  ${C_DIM}popular:${C_OFF} ${models}"
	[[ -n "$env" ]]     && echo "  ${C_DIM}pi sees it via:${C_OFF} auth.json key ${C_BOLD}${slug}${C_OFF}  ${C_DIM}(or \$${env})${C_OFF}"
	[[ -n "$base" ]]    && echo "  ${C_DIM}base URL:${C_OFF} ${base}  ${C_DIM}(leave blank unless you use a proxy)${C_OFF}"

	local steps; steps="$(provider_section "$file" 'Get a key')"
	if [[ -n "$steps" ]]; then
		panel "How to get a ${display} key" "$steps"
	else
		echo
	fi
	return 0
}

# provider_match <string>  →  best slug for a model/provider string (empty if none).
# Scores substring hits across display/slug/env/models.
provider_match() {
	local q="$1" best="" bestscore=0 f
	q="$(printf '%s' "$q" | tr '[:upper:]' '[:lower:]')"
	[[ -z "$q" ]] && return 0
	local display slug env models hay score
	while IFS= read -r f; do
		display="$(provider_field "$f" display | tr '[:upper:]' '[:lower:]')"
		slug="$(provider_field "$f" slug | tr '[:upper:]' '[:lower:]')"
		env="$(provider_field "$f" env | tr '[:upper:]' '[:lower:]')"
		models="$(provider_field "$f" models | tr '[:upper:]' '[:lower:]')"
		hay="$display $slug $env $models"
		score=0
		# exact slug/display hit is strong
		[[ "$q" == "$slug" || "$q" == "$display" ]] && score=$((score+10))
		# substring containment either direction (so "gemini" matches "gemini-2.5-pro",
		# and "llama-3.3-70b" matches "llama-3.3-70b-versatile")
		[[ -n "$slug" && "$q" == *"$slug"* ]] && score=$((score+5))
		[[ -n "$slug" && "$slug" == *"$q"* ]] && score=$((score+3))
		[[ -n "$display" && ("$q" == *"$display"* || "$display" == *"$q"*) ]] && score=$((score+5))
		# any of the model aliases present (either direction)
		local m
		for m in ${models//,/ }; do
			m="${m// /}"
			[[ -n "$m" && ("$q" == *"$m"* || "$m" == *"$q"*) ]] && score=$((score+4))
		done
		[[ -n "$env" && "$q" == *"$env"* ]] && score=$((score+3))
		if (( score > bestscore )); then bestscore=$score; best="$slug"; fi
	done < <(_provider_files)
	(( bestscore > 0 )) && printf '%s\n' "$best"
	return 0
}

# provider_guide [hint]  →  interactive menu + Q&A. Display only.
provider_guide() {
	local hint="${1:-}"
	local _iter=0
	while true; do
		# Safety cap: this is an interactive menu. If we've spun this many times
		# without exiting, stdin is a non-interactive stream that's not navigating
		# the menu — break out instead of looping on exhausted/EOF reads (the
		# top-level while can outlive a pipeline-subshell kill).
		(( ++_iter > 64 )) && { warn "too many guide interactions without exit — returning."; return 0; }
		echo
		local -a menu=( "Browse all providers" "Search by name" "Done" )
		local choice
		choice="$(select_option "How do you want to find your provider?" "${menu[@]}")"
		case "$choice" in
			"Browse all providers")
				local -a opts=() slugs=() f disp
				while IFS= read -r f; do
					disp="$(provider_field "$f" display)"
					[[ -n "$disp" ]] && { opts+=( "$disp" ); slugs+=( "$(provider_field "$f" slug)" ); }
				done < <(_provider_files)
				[[ ${#opts[@]} -eq 0 ]] && { warn "no provider guides found in $PROVIDERS_DIR"; return 1; }
				opts+=( "Back" )
				local pick; pick="$(select_option "Pick a provider to learn how to get a key" "${opts[@]}")"
				local i found=-1
				for ((i=0;i<${#opts[@]};i++)); do [[ "${opts[i]}" == "$pick" ]] && { found=$i; break; }; done
				if (( found >= 0 )) && [[ "$pick" != "Back" ]]; then
					provider_show "${slugs[found]}"
					_provider_qa "${slugs[found]}"
				fi
				;;
			"Search by name")
				local q; q="$(ask 'Type a provider or model name (e.g. claude, gpt-5, minimax)')"
				local slug="${hint:-}"
				[[ -n "$q" ]] && slug="$(provider_match "$q")"
				if [[ -n "$slug" ]]; then
					provider_show "$slug"
					_provider_qa "$slug"
				else
					warn "no close match for '$q'. Try Browse, or pick a gateway like OpenRouter (one key → many models)."
				fi
				;;
			Done) echo "${C_DIM}exiting guide.${C_OFF}"; return 0 ;;
		esac
	done
}

# _provider_qa <slug>  →  keyword Q&A over one provider's sections.
_provider_qa() {
	local slug="$1"
	local file; file="$(provider_file "$slug")"
	[[ -n "$file" ]] || return 0
	echo "${C_DIM}Ask about: key · pricing · free tier · errors · models · base URL · done${C_OFF}"
	local q ans _iter=0
	while true; do
		(( ++_iter > 64 )) && return 0
		q="$(ask 'question (blank = done)')"
		[[ -z "$q" ]] && return 0
		case "$(printf '%s' "$q" | tr '[:upper:]' '[:lower:]')" in
			*done*|*exit*|*quit*) return 0 ;;
			*free*|*price*|*cost*|*budget*|*cheap*)
				ans="$(provider_section "$file" 'Pricing')" ; [[ -z "$ans" ]] && ans="$(provider_section "$file" 'Free tier')"
				;;
			*error*|*401*|*403*|*fail*|*wrong*|*invalid*|*denied*)
				ans="$(provider_section "$file" 'errors')" ; [[ -z "$ans" ]] && ans="$(provider_section "$file" 'Common errors')"
				;;
			*model*|*list*|*best*|*which*)
				ans="$(provider_field "$file" models)"; [[ -n "$ans" ]] && ans="Popular models: $ans"
				;;
			*base*|*endpoint*|*proxy*|*gateway*|*url*)
				ans="$(provider_field "$file" base)"; [[ -n "$ans" ]] && ans="Base URL: $ans — leave blank in the wizard unless you use a proxy/gateway."
				;;
			*paste*|*where*|*how*|*get*|*sign*|*register*|*create*|*key*)
				ans="$(provider_section "$file" 'Get a key')"
				;;
			*) ans="$(provider_section "$file" 'Get a key')" ;;
		esac
		if [[ -n "$ans" ]]; then
			echo; while IFS= read -r _l; do echo "  $_l"; done <<< "$ans"; echo
		else
			warn "no specific entry — re-showing the full guide:"; provider_show "$slug"
		fi
	done
}
