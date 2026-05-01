#!/usr/bin/env bash
# Backup UltraBot MongoDB data to a timestamped archive.
# Usage: ./scripts/backup.sh [output-dir]
# Requires: mongodump on PATH, or runs inside the ultrabot-mongodb container.
set -euo pipefail

BACKUP_DIR="${1:-./backups}"
TIMESTAMP=$(date -u +"%Y%m%dT%H%M%SZ")
ARCHIVE="${BACKUP_DIR}/ultrabot-${TIMESTAMP}.gz"

# Load .env if present and MONGODB_URI is not already set
if [ -z "${MONGODB_URI:-}" ] && [ -f "$(dirname "$0")/../.env" ]; then
    # shellcheck disable=SC1090
    set -a; source "$(dirname "$0")/../.env"; set +a
fi

MONGO_URI="${MONGODB_URI:-mongodb://localhost:27017/ultrabot}"

mkdir -p "${BACKUP_DIR}"

echo "[backup] Starting backup → ${ARCHIVE}"
echo "[backup] URI: ${MONGO_URI}"

if command -v mongodump &>/dev/null; then
    mongodump --uri="${MONGO_URI}" --gzip --archive="${ARCHIVE}"
else
    # Fall back to running mongodump inside the Docker container
    echo "[backup] mongodump not found locally; attempting via Docker container 'ultrabot-mongodb'"
    docker exec ultrabot-mongodb \
        mongodump --uri="${MONGO_URI}" --gzip --archive=/tmp/ultrabot-backup.gz
    docker cp ultrabot-mongodb:/tmp/ultrabot-backup.gz "${ARCHIVE}"
    docker exec ultrabot-mongodb rm /tmp/ultrabot-backup.gz
fi

SIZE=$(du -sh "${ARCHIVE}" | cut -f1)
echo "[backup] Done. Archive size: ${SIZE} → ${ARCHIVE}"

# Prune archives older than 30 days
find "${BACKUP_DIR}" -name 'ultrabot-*.gz' -mtime +30 -print -delete \
    && echo "[backup] Pruned backups older than 30 days"
