#!/usr/bin/env bash
# Handing mongodump and mongorestore a connection string without putting it on
# the command line (#1156).
#
# `--uri=mongodb://user:pass@…` is in argv, and argv is readable by every user
# on the host through `ps` or /proc/<pid>/cmdline — including for a process
# inside a container, and for the `docker exec` that starts one. The passphrase
# already goes through `-pass env:` for that reason; the database password is
# the same kind of secret. So the URI is written to a 0600 YAML file and the
# tools are given `--config=<file>` (supported since database tools 100.3).
#
# The value is a YAML double-quoted scalar, so only `\` and `"` need escaping;
# a connection string holds no whitespace or control characters that would.
# The stack files' backup entrypoint writes the same file inline and must
# agree with this.
#
# Sourced, not run:
#     . "$(dirname "$0")/lib/mongotools.sh"
#     write_mongo_tools_config "${MONGO_URI}" "${DIR}/tools.yaml"
#     mongodump --config="${DIR}/tools.yaml" …

# mongo_tools_config <uri>
#   Prints the YAML --config accepts, carrying only the URI.
mongo_tools_config() {
    local value=$1
    value=${value//\\/\\\\}
    value=${value//\"/\\\"}
    printf 'uri: "%s"\n' "${value}"
}

# write_mongo_tools_config <uri> <path>
#   Writes that YAML to <path>, readable by its owner only.
write_mongo_tools_config() {
    ( umask 077 && mongo_tools_config "$1" > "$2" )
}

# write_container_mongo_tools_config <container> <uri> <path-in-container>
#   The same, inside a container, for tools run through `docker exec`. The YAML
#   goes over stdin so the URI is not on this `docker exec` command line either.
write_container_mongo_tools_config() {
    mongo_tools_config "$2" \
        | docker exec -i "$1" sh -c 'umask 077 && cat > "$1"' sh "$3"
}
