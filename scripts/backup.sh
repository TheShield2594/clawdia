#!/usr/bin/env bash
# Backup Clawdia MongoDB data to a timestamped archive.
# Usage: ./scripts/backup.sh [output-dir]
# Requires: mongodump on PATH, or runs inside the clawdia-mongodb container.
set -euo pipefail

BACKUP_DIR="${1:-./backups}"
TIMESTAMP=$(date -u +"%Y%m%dT%H%M%SZ")
ARCHIVE="${BACKUP_DIR}/clawdia-${TIMESTAMP}.gz"

# Load .env if present and MONGODB_URI is not already set
if [ -z "${MONGODB_URI:-}" ] && [ -f "$(dirname "$0")/../.env" ]; then
    # shellcheck disable=SC1090
    set -a; source "$(dirname "$0")/../.env"; set +a
fi

MONGO_URI="${MONGODB_URI:-mongodb://localhost:27017/ultrabot}"

mkdir -p "${BACKUP_DIR}"

MONGO_URI_MASKED=$(echo "${MONGO_URI}" | sed 's|://[^@]*@|://***@|')
echo "[backup] Starting backup → ${ARCHIVE}"
echo "[backup] URI: ${MONGO_URI_MASKED}"

if command -v mongodump &>/dev/null; then
    mongodump --uri="${MONGO_URI}" --gzip --archive="${ARCHIVE}"
else
    # Fall back to running mongodump inside the Docker container.
    # Replace 'localhost' with '127.0.0.1' so the URI points to the container's
    # own loopback interface (the service hostname is not reachable from within).
    echo "[backup] mongodump not found locally; attempting via Docker container 'clawdia-mongodb'"
    CONTAINER_URI="${MONGO_URI/localhost/127.0.0.1}"
    # Dump into a private directory (mktemp -d is 0700) rather than a fixed,
    # guessable path in the container's world-readable /tmp. Cleanup runs from an
    # EXIT trap: a trailing rm would be skipped by `set -e` if mongodump or
    # docker cp failed, stranding a full copy of the database in the container.
    REMOTE_DIR=$(docker exec clawdia-mongodb mktemp -d)
    # An empty result would send the dump to the container root and make the
    # cleanup a no-op, so refuse rather than guess a path. `set -u` does not
    # catch this: the variable is set, just empty.
    if [ -z "${REMOTE_DIR}" ]; then
        echo "[backup] ERROR: could not create a temp directory in clawdia-mongodb" >&2
        exit 1
    fi
    trap 'docker exec clawdia-mongodb rm -rf "${REMOTE_DIR}" >/dev/null 2>&1 || true' EXIT
    docker exec clawdia-mongodb \
        mongodump --uri="${CONTAINER_URI}" --gzip --archive="${REMOTE_DIR}/backup.gz"
    docker cp "clawdia-mongodb:${REMOTE_DIR}/backup.gz" "${ARCHIVE}"
fi

SIZE=$(du -sh "${ARCHIVE}" | cut -f1)
echo "[backup] Done. Archive size: ${SIZE} → ${ARCHIVE}"

# Prune archives older than 30 days. Matches the old ultrabot-* prefix too, so
# archives written before the rename are still aged out.
find "${BACKUP_DIR}" \( -name 'clawdia-*.gz' -o -name 'ultrabot-*.gz' \) -mtime +30 -print -delete \
    && echo "[backup] Pruned backups older than 30 days"
