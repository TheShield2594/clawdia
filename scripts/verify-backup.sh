#!/usr/bin/env bash
# Prove a backup archive can actually be restored.
#
# An untested backup is a guess. This restores the archive into a throwaway
# database beside the real one, counts the documents in each collection, and
# compares them with the live database — so a truncated dump, a bad --gzip
# archive or an empty mongodump exits non-zero here rather than at 3am on the
# day you need it.
#
# Nothing is written to the live database, and the scratch database is dropped
# on the way out, including when a step fails.
#
# Usage: ./scripts/verify-backup.sh <path-to-archive.gz>
#        ./scripts/verify-backup.sh --latest [backup-dir]
#
# Meant to be scheduled, not only run by hand (#899). The backup container
# checks every archive it writes is parseable, but a full restore rehearsal
# needs privileges on a second database that the container deliberately does
# not have, so it runs from the host instead. A weekly host crontab line is
# enough, and it is not silent: a failure here posts to ERROR_WEBHOOK_URL, the
# same sink the bot reports crashes to.
#
#   0 4 * * 1  cd /opt/clawdia && ./scripts/verify-backup.sh --latest >> /var/log/clawdia-verify.log 2>&1
#
# Requires: mongorestore and mongosh on PATH, or the clawdia-mongodb container.
set -euo pipefail

# A scheduled run that fails into a log file nobody reads is the failure mode
# this script exists to close, so route it to the same place src/index.js sends
# a crash. Unset — the default — this does nothing at all.
# The same rule src/utils/errorReporter.js applies to the same variable: https
# anywhere, http only to loopback, anything else refused rather than downgraded.
# The report names a host and an archive path, and over cleartext to a third
# party that is readable on the wire.
sink_allowed() {
    case "$1" in
        https://*) return 0 ;;
        http://localhost|http://localhost/*|http://localhost:*) return 0 ;;
        http://127.0.0.1|http://127.0.0.1/*|http://127.0.0.1:*) return 0 ;;
        "http://[::1]"|"http://[::1]/"*|"http://[::1]:"*) return 0 ;;
        *) return 1 ;;
    esac
}

# The message carries ${ARCHIVE}, which comes from argv — a path may hold a
# quote or a backslash, and interpolating one straight into a JSON string
# produces a body the sink rejects, so the report about the failure fails too.
# Control characters are dropped rather than escaped: none can appear in a path
# worth reporting, and \uXXXX escaping in POSIX sh is not worth the lines.
json_escape() {
    printf '%s' "$1" | tr -d '\000-\037' | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

notify_failure() {
    echo "[verify] FAILED: $1" >&2
    [ -n "${ERROR_WEBHOOK_URL:-}" ] || return 0
    if ! sink_allowed "${ERROR_WEBHOOK_URL}"; then
        echo "[verify] Ignoring ERROR_WEBHOOK_URL: expected an https:// URL (or http:// to loopback)" >&2
        return 0
    fi
    command -v curl >/dev/null 2>&1 || { echo "[verify] curl not found; ERROR_WEBHOOK_URL not posted" >&2; return 0; }
    local body message
    message=$(json_escape "$1")
    case "${ERROR_WEBHOOK_URL}" in
        https://discord.com/api/webhooks/*|https://discordapp.com/api/webhooks/*)
            body=$(printf '{"content":"**backup verification failed** on %s: %s"}' "$(json_escape "$(hostname)")" "${message}") ;;
        *)
            body=$(printf '{"kind":"backup_verify_failed","service":"clawdia-backup-verify","message":"%s"}' "${message}") ;;
    esac
    curl -fsS --max-time 10 -X POST -H 'content-type: application/json' \
        -d "${body}" "${ERROR_WEBHOOK_URL}" >/dev/null 2>&1 \
        || echo "[verify] posting to ERROR_WEBHOOK_URL failed" >&2
}

# Installed before anything can fail. Replaced further down by the trap that
# also drops the scratch database, once there is one to drop.
trap 'status=$?; [ "${status}" -eq 0 ] || notify_failure "verification of ${ARCHIVE:-<no archive>} exited ${status}"; exit "${status}"' EXIT

ARCHIVE="${1:-}"
if [ -z "${ARCHIVE}" ]; then
    echo "Usage: $0 <path-to-archive.gz> | --latest [backup-dir]" >&2
    exit 1
fi

if [ "${ARCHIVE}" = "--latest" ]; then
    BACKUP_DIR="${2:-./backups}"
    # -t sorts newest first; the names are timestamped, but mtime is what
    # actually reflects when the dump finished.
    ARCHIVE=$(ls -t "${BACKUP_DIR}"/clawdia-*.gz 2>/dev/null | head -1 || true)
    if [ -z "${ARCHIVE}" ]; then
        echo "[verify] No clawdia-*.gz archives in ${BACKUP_DIR}" >&2
        exit 1
    fi
    echo "[verify] Latest archive: ${ARCHIVE}"
fi

if [ ! -f "${ARCHIVE}" ]; then
    echo "[verify] ERROR: Archive not found: ${ARCHIVE}" >&2
    exit 1
fi

# Load .env if present and MONGODB_URI is not already set
if [ -z "${MONGODB_URI:-}" ] && [ -f "$(dirname "$0")/../.env" ]; then
    # shellcheck disable=SC1090
    set -a; source "$(dirname "$0")/../.env"; set +a
fi

MONGO_URI="${MONGODB_URI:-mongodb://localhost:27017/ultrabot}"
MONGO_URI_MASKED=$(echo "${MONGO_URI}" | sed 's|://[^@]*@|://***@|')

# Split the URI so the scratch database can be addressed without losing the
# credentials, the replica-set options or anything else in the query string.
# sed cannot do this safely across mongodb+srv:// and userinfo containing "/",
# so let node's URL parser do it.
read -r SOURCE_DB URI_PREFIX URI_SUFFIX <<EOF
$(MONGO_URI="${MONGO_URI}" node -e '
const raw = process.env.MONGO_URI;
const q = raw.indexOf("?");
const base = q === -1 ? raw : raw.slice(0, q);
const suffix = q === -1 ? "" : raw.slice(q);
const slash = base.lastIndexOf("/");
const db = base.slice(slash + 1);
if (!db || slash <= base.indexOf("//") + 1) {
    console.error("[verify] ERROR: the URI names no database");
    process.exit(1);
}
// A single line of three fields: database, everything before it, everything
// after it. Re-joined below to address any database on the same server.
console.log([db, base.slice(0, slash + 1), suffix].join(" "));
')
EOF
if [ -z "${SOURCE_DB:-}" ]; then
    echo "[verify] ERROR: could not read a database name out of the URI" >&2
    exit 1
fi
SCRATCH_DB="${SOURCE_DB}_verify_$$"
db_uri() { printf '%s%s%s' "${URI_PREFIX}" "$1" "${URI_SUFFIX}"; }

echo "[verify] Archive:  ${ARCHIVE}"
echo "[verify] URI:      ${MONGO_URI_MASKED}"
echo "[verify] Source:   ${SOURCE_DB}"
echo "[verify] Scratch:  ${SCRATCH_DB} (dropped on exit)"

# Everything below runs either directly or inside the mongo container, so pick
# once and route every command through the same pair of helpers.
if command -v mongorestore &>/dev/null && command -v mongosh &>/dev/null; then
    IN_DOCKER=0
else
    echo "[verify] mongo tools not found locally; using container 'clawdia-mongodb'"
    IN_DOCKER=1
    # The service hostname does not resolve from inside the container itself.
    URI_PREFIX="${URI_PREFIX/localhost/127.0.0.1}"
    REMOTE_DIR=$(docker exec clawdia-mongodb mktemp -d)
    if [ -z "${REMOTE_DIR}" ]; then
        echo "[verify] ERROR: could not create a temp directory in clawdia-mongodb" >&2
        exit 1
    fi
    docker cp "${ARCHIVE}" "clawdia-mongodb:${REMOTE_DIR}/verify.gz"
fi

mongo_eval() {
    if [ "${IN_DOCKER}" -eq 1 ]; then
        docker exec clawdia-mongodb mongosh "$1" --quiet --eval "$2"
    else
        mongosh "$1" --quiet --eval "$2"
    fi
}

# Drop the scratch database whatever happens — a failed restore must not leave
# a half-populated copy of production data lying beside the real one.
cleanup() {
    local status=$?
    mongo_eval "$(db_uri "${SCRATCH_DB}")" 'db.dropDatabase()' >/dev/null 2>&1 || true
    if [ "${IN_DOCKER:-0}" -eq 1 ] && [ -n "${REMOTE_DIR:-}" ]; then
        docker exec clawdia-mongodb rm -rf "${REMOTE_DIR}" >/dev/null 2>&1 || true
    fi
    # This trap replaces the reporting one installed at the top, so it has to
    # carry the reporting itself — otherwise every failure from here on, which
    # is every interesting one, goes back to being silent.
    [ "${status}" -eq 0 ] || notify_failure "restore rehearsal of ${ARCHIVE} exited ${status}"
    return "${status}"
}
trap cleanup EXIT

echo "[verify] Restoring into ${SCRATCH_DB}…"
if [ "${IN_DOCKER}" -eq 1 ]; then
    docker exec clawdia-mongodb mongorestore --uri="$(db_uri "${SOURCE_DB}")" --gzip \
        --archive="${REMOTE_DIR}/verify.gz" \
        --nsFrom="${SOURCE_DB}.*" --nsTo="${SCRATCH_DB}.*" --drop
else
    mongorestore --uri="$(db_uri "${SOURCE_DB}")" --gzip --archive="${ARCHIVE}" \
        --nsFrom="${SOURCE_DB}.*" --nsTo="${SCRATCH_DB}.*" --drop
fi

# Compare document counts collection by collection. A restore that "succeeded"
# but produced an empty or short database fails here.
COUNTS_SCRIPT='
const names = db.getCollectionNames().filter(n => !n.startsWith("system."));
const out = {};
for (const n of names) out[n] = db.getCollection(n).countDocuments({});
print(JSON.stringify(out));
'
LIVE=$(mongo_eval "$(db_uri "${SOURCE_DB}")" "${COUNTS_SCRIPT}" | tail -1)
COPY=$(mongo_eval "$(db_uri "${SCRATCH_DB}")" "${COUNTS_SCRIPT}" | tail -1)

echo "[verify] Comparing collections…"
LIVE="${LIVE}" COPY="${COPY}" node -e '
const live = JSON.parse(process.env.LIVE);
const copy = JSON.parse(process.env.COPY);
const names = [...new Set([...Object.keys(live), ...Object.keys(copy)])].sort();
if (!names.length) {
    console.error("[verify] FAIL: the source database has no collections — nothing was verified");
    process.exit(1);
}
// The live database keeps taking writes while the archive is restored, so a
// restored collection is expected to hold somewhat *fewer* documents than the
// live one — the archive is older. Exact equality would fail on every busy
// database. What has to be caught is a restore that came up materially short:
// "at least one document" would pass an archive that restored 1 row of 100000.
// Override with VERIFY_SHORTFALL when a collection is written to hard enough
// that the default reports a healthy restore as short.
const TOLERANCE = Number(process.env.VERIFY_SHORTFALL || 0.9);
if (!(TOLERANCE > 0 && TOLERANCE <= 1)) {
    console.error(`[verify] FAIL: VERIFY_SHORTFALL must be >0 and <=1, got ${process.env.VERIFY_SHORTFALL}`);
    process.exit(1);
}
let bad = 0;
for (const name of names) {
    const a = live[name] ?? 0;
    const b = copy[name] ?? 0;
    // A collection emptied since the dump was taken leaves nothing to fall
    // short of, so it cannot fail here however many rows the archive holds.
    const floor = Math.ceil(a * TOLERANCE);
    const ok = a === 0 || b >= floor;
    if (!ok) bad++;
    const short = ok ? "" : `  (expected >= ${floor})`;
    console.log(`  ${ok ? "ok  " : "FAIL"} ${name.padEnd(32)} live=${a} restored=${b}${short}`);
}
if (bad) {
    console.error(`[verify] FAIL: ${bad} collection(s) restored short or empty.`);
    process.exit(1);
}
console.log(`[verify] OK: ${names.length} collection(s) restored within ${Math.round((1 - TOLERANCE) * 100)}% of live.`);
'
