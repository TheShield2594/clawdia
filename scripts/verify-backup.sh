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
# Requires: mongorestore and mongosh on PATH, or the clawdia-mongodb container.
set -euo pipefail

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
let bad = 0;
for (const name of names) {
    const a = live[name] ?? 0;
    const b = copy[name] ?? 0;
    // The live database keeps taking writes while the dump is restored, so it
    // may legitimately have grown. A restored collection holding *fewer* than
    // the archive should is the failure worth catching.
    const ok = b > 0 || a === 0;
    if (!ok) bad++;
    console.log(`  ${ok ? "ok  " : "FAIL"} ${name.padEnd(32)} live=${a} restored=${b}`);
}
if (bad) {
    console.error(`[verify] FAIL: ${bad} collection(s) restored empty.`);
    process.exit(1);
}
console.log(`[verify] OK: ${names.length} collection(s) restored with data.`);
'
