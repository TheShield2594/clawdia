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
# quotes removed (a `# comment` may follow them), an unquoted value ending at
# its first `#`, `\n` in a double-quoted value read as a newline, and nothing
# else expanded or executed. A key assigned twice takes its last value, and a
# variable already in the environment wins over the file — both as for the
# bot — so `MONGODB_URI=... ./restore.sh` still means what it says.
#
# Sourced, not run:
#     . "$(dirname "$0")/lib/dotenv.sh"
#     load_dotenv "$(dirname "$0")/../.env"

load_dotenv() {
    local file="$1" line key value
    # Keys this call has assigned, so a later line for the same key replaces
    # the earlier one while a key the environment already had is left alone.
    local -A from_file=()
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
        # Leading whitespace off the value, then one pair of matching quotes,
        # which may be followed by a comment.
        value="${value#"${value%%[![:space:]]*}"}"
        if [[ "${value}" =~ ^\"([^\"]*)\"[[:space:]]*(#.*)?$ ]]; then
            value="${BASH_REMATCH[1]}"
            value="${value//\\n/$'\n'}"
            value="${value//\\r/$'\r'}"
        elif [[ "${value}" =~ ^\'([^\']*)\'[[:space:]]*(#.*)?$ ]] \
            || [[ "${value}" =~ ^\`([^\`]*)\`[[:space:]]*(#.*)?$ ]]; then
            value="${BASH_REMATCH[1]}"
        else
            # Unquoted: the value ends at its first `#`, as in dotenv.
            value="${value%%#*}"
            value="${value%"${value##*[![:space:]]}"}"
        fi
        # Already set in the environment (not by an earlier line here) wins.
        if [ -n "${!key+x}" ] && [ -z "${from_file[${key}]:-}" ]; then continue; fi
        from_file[${key}]=1
        printf -v "${key}" '%s' "${value}"
        # shellcheck disable=SC2163  # exporting the variable named by key, deliberately
        export "${key}"
    done < "${file}"
}
