#!/usr/bin/env bash
# Reading .env as data, not as shell (#1161).
#
# The host scripts used to `set -a; source .env`, which runs the file: a value
# holding `$(...)` or a backtick executed, and a line that was not an
# assignment at all ran as a command, with whatever privileges the backup or
# restore was started with. The bot reads the same file through Node's dotenv,
# which only ever assigns — so a .env that works for the bot could still do
# something quite different to these scripts.
#
# This parses it the way dotenv does: `KEY=value` lines, an optional `export `
# prefix, blank lines and `#` comments skipped, one pair of matching surrounding
# quotes removed, and nothing expanded or executed. A variable already in the
# environment wins, as it does for the bot, so `MONGODB_URI=... ./restore.sh`
# still means what it says.
#
# Sourced, not run:
#     . "$(dirname "$0")/lib/dotenv.sh"
#     load_dotenv "$(dirname "$0")/../.env"

load_dotenv() {
    local file="$1" line key value
    [ -f "${file}" ] || return 0
    while IFS= read -r line || [ -n "${line}" ]; do
        line="${line%$'\r'}"
        # Leading whitespace, then skip blanks and comments.
        line="${line#"${line%%[![:space:]]*}"}"
        case "${line}" in ''|'#'*) continue ;; esac
        line="${line#export }"
        case "${line}" in *=*) ;; *) continue ;; esac
        key="${line%%=*}"
        value="${line#*=}"
        # Trailing whitespace off the key; a key that is not a plain name is
        # not an assignment and is skipped rather than guessed at.
        key="${key%"${key##*[![:space:]]}"}"
        [[ "${key}" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
        # Leading whitespace off the value, then one pair of matching quotes.
        value="${value#"${value%%[![:space:]]*}"}"
        if [[ "${value}" =~ ^\"(.*)\"[[:space:]]*$ ]] || [[ "${value}" =~ ^\'(.*)\'[[:space:]]*$ ]]; then
            value="${BASH_REMATCH[1]}"
        else
            # Unquoted: an inline ` #` comment ends the value, as in dotenv.
            value="${value%%[[:space:]]#*}"
            value="${value%"${value##*[![:space:]]}"}"
        fi
        # Already set in the environment wins.
        if [ -n "${!key+x}" ]; then continue; fi
        printf -v "${key}" '%s' "${value}"
        # shellcheck disable=SC2163  # exporting the variable named by key, deliberately
        export "${key}"
    done < "${file}"
}
