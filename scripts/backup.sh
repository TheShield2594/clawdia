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
    docker exec clawdia-mongodb \
        mongodump --uri="${CONTAINER_URI}" --gzip --archive=/tmp/clawdia-backup.gz
    docker cp clawdia-mongodb:/tmp/clawdia-backup.gz "${ARCHIVE}"
    docker exec clawdia-mongodb rm /tmp/clawdia-backup.gz
fi

SIZE=$(du -sh "${ARCHIVE}" | cut -f1)
echo "[backup] Done. Archive size: ${SIZE} → ${ARCHIVE}"

# Prune archives older than 30 days. Matches the old ultrabot-* prefix too, so
# archives written before the rename are still aged out.
find "${BACKUP_DIR}" \( -name 'clawdia-*.gz' -o -name 'ultrabot-*.gz' \) -mtime +30 -print -delete \
    && echo "[backup] Pruned backups older than 30 days"
