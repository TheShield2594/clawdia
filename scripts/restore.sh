#!/usr/bin/env bash
# Restore Clawdia MongoDB data from a backup archive.
# Usage: ./scripts/restore.sh <path-to-archive.gz|.gz.enc> [--drop]
#   --drop  Drop existing collections before restoring (clean restore)
#
# A `.gz.enc` archive is one the backup service sealed (#886); it is decrypted
# into a private temp directory first, which needs BACKUP_ENCRYPTION_PASSPHRASE
# — .env is read for it, the same way MONGODB_URI is below.
set -euo pipefail

# shellcheck source=scripts/lib/archive.sh
. "$(dirname "$0")/lib/archive.sh"

ARCHIVE="${1:-}"
DROP_FLAG=""

if [ -z "${ARCHIVE}" ]; then
    echo "Usage: $0 <path-to-archive.gz|.gz.enc> [--drop]" >&2
    exit 1
fi

if [ ! -f "${ARCHIVE}" ]; then
    echo "[restore] ERROR: Archive not found: ${ARCHIVE}" >&2
    exit 1
fi

if [[ "${2:-}" == "--drop" ]]; then
    DROP_FLAG="--drop"
    echo "[restore] WARNING: --drop specified. Existing collections will be dropped before restore."
fi

# Load .env if present and MONGODB_URI is not already set
if [ -z "${MONGODB_URI:-}" ] && [ -f "$(dirname "$0")/../.env" ]; then
    # shellcheck disable=SC1090
    set -a; source "$(dirname "$0")/../.env"; set +a
fi

MONGO_URI="${MONGODB_URI:-mongodb://localhost:27017/ultrabot}"

# One trap for the whole script. The Docker branch below used to install its own
# and would have replaced this one, stranding a decrypted copy of the database
# in /tmp — so the container temp directory is cleaned from here too.
WORKDIR=$(mktemp -d)
cleanup() {
    rm -rf "${WORKDIR}"
    if [ -n "${REMOTE_DIR:-}" ]; then
        docker exec clawdia-mongodb rm -rf "${REMOTE_DIR}" >/dev/null 2>&1 || true
    fi
}
trap cleanup EXIT

MONGO_URI_MASKED=$(echo "${MONGO_URI}" | sed 's|://[^@]*@|://***@|')
echo "[restore] Archive:  ${ARCHIVE}"
echo "[restore] URI:      ${MONGO_URI_MASKED}"

read -rp "[restore] Confirm restore? This will overwrite data. (yes/no): " CONFIRM
if [[ "${CONFIRM}" != "yes" ]]; then
    echo "[restore] Aborted."
    exit 0
fi

# A sealed archive is opened into WORKDIR; a plain one is used where it lies.
READABLE=$(open_archive "${ARCHIVE}" "${WORKDIR}")

if command -v mongorestore &>/dev/null; then
    # shellcheck disable=SC2086
    mongorestore --uri="${MONGO_URI}" --gzip --archive="${READABLE}" ${DROP_FLAG}
else
    echo "[restore] mongorestore not found locally; attempting via Docker container 'clawdia-mongodb'"
    # Stage the archive in a private directory (mktemp -d is 0700) rather than a
    # fixed, guessable path in the container's world-readable /tmp. Cleanup runs
    # from an EXIT trap: a trailing rm would be skipped by `set -e` if
    # mongorestore failed, stranding a full copy of the data in the container.
    REMOTE_DIR=$(docker exec clawdia-mongodb mktemp -d)
    # An empty result would stage the archive at the container root and make the
    # cleanup a no-op, so refuse rather than guess a path. `set -u` does not
    # catch this: the variable is set, just empty.
    if [ -z "${REMOTE_DIR}" ]; then
        echo "[restore] ERROR: could not create a temp directory in clawdia-mongodb" >&2
        exit 1
    fi
    docker cp "${READABLE}" "clawdia-mongodb:${REMOTE_DIR}/restore.gz"
    # Replace 'localhost' with '127.0.0.1' so the URI resolves inside the container.
    SAFE_URI="${MONGO_URI/localhost/127.0.0.1}"
    # shellcheck disable=SC2086
    docker exec clawdia-mongodb \
        mongorestore --uri="${SAFE_URI}" --gzip --archive="${REMOTE_DIR}/restore.gz" ${DROP_FLAG}
fi

echo "[restore] Restore complete."
