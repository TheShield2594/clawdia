#!/usr/bin/env bash
# Restore UltraBot MongoDB data from a backup archive.
# Usage: ./scripts/restore.sh <path-to-archive.gz> [--drop]
#   --drop  Drop existing collections before restoring (clean restore)
set -euo pipefail

ARCHIVE="${1:-}"
DROP_FLAG=""

if [ -z "${ARCHIVE}" ]; then
    echo "Usage: $0 <path-to-archive.gz> [--drop]" >&2
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

echo "[restore] Archive:  ${ARCHIVE}"
echo "[restore] URI:      ${MONGO_URI}"

read -rp "[restore] Confirm restore? This will overwrite data. (yes/no): " CONFIRM
if [[ "${CONFIRM}" != "yes" ]]; then
    echo "[restore] Aborted."
    exit 0
fi

if command -v mongorestore &>/dev/null; then
    # shellcheck disable=SC2086
    mongorestore --uri="${MONGO_URI}" --gzip --archive="${ARCHIVE}" ${DROP_FLAG}
else
    echo "[restore] mongorestore not found locally; attempting via Docker container 'ultrabot-mongodb'"
    docker cp "${ARCHIVE}" ultrabot-mongodb:/tmp/ultrabot-restore.gz
    # shellcheck disable=SC2086
    docker exec ultrabot-mongodb \
        mongorestore --uri="${MONGO_URI}" --gzip --archive=/tmp/ultrabot-restore.gz ${DROP_FLAG}
    docker exec ultrabot-mongodb rm /tmp/ultrabot-restore.gz
fi

echo "[restore] Restore complete."
