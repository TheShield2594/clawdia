#!/usr/bin/env bash
# Backup Clawdia MongoDB data to a timestamped archive.
# Usage: ./scripts/backup.sh [output-dir]
# Requires: mongodump on PATH, or runs inside the clawdia-mongodb container.
#
# With BACKUP_ENCRYPTION_PASSPHRASE set the archive is sealed the same way the
# nightly `backup` service seals its own (#886) and lands as .gz.enc — so a dump
# taken by hand does not quietly become the one readable copy in a directory of
# encrypted ones. scripts/restore.sh reads either.
set -euo pipefail

# Everything this writes is a copy of the database, so nothing it writes is
# readable by anyone but its owner (#1161): the archive, its tag, and the
# backup directory when this creates it.
umask 077

# shellcheck source=scripts/lib/archive.sh
. "$(dirname "$0")/lib/archive.sh"
# shellcheck source=scripts/lib/mongotools.sh
. "$(dirname "$0")/lib/mongotools.sh"

BACKUP_DIR="${1:-./backups}"
TIMESTAMP=$(date -u +"%Y%m%dT%H%M%SZ")
ARCHIVE="${BACKUP_DIR}/clawdia-${TIMESTAMP}.gz"

# Load .env if present and MONGODB_URI is not already set
if [ -z "${MONGODB_URI:-}" ] && [ -f "$(dirname "$0")/../.env" ]; then
    # Parsed as data, never run as shell (#1161) — see scripts/lib/dotenv.sh.
    # shellcheck source=scripts/lib/dotenv.sh
    . "$(dirname "$0")/lib/dotenv.sh"
    load_dotenv "$(dirname "$0")/../.env"
fi

MONGO_URI="${MONGODB_URI:-mongodb://localhost:27017/ultrabot}"

if [ -n "${BACKUP_ENCRYPTION_PASSPHRASE:-}" ] && ! command -v openssl &>/dev/null; then
    echo "[backup] ERROR: BACKUP_ENCRYPTION_PASSPHRASE is set but openssl is not on PATH." >&2
    echo "[backup] Refusing to write the archive in the clear." >&2
    exit 1
fi

mkdir -p "${BACKUP_DIR}"

# Where mongodump writes. Unencrypted that is the archive itself, as it always
# was. Encrypted, it is a private directory (mktemp -d is 0700) outside
# BACKUP_DIR and only the sealed file is moved in — the plaintext of the whole
# database must not appear in the directory whose readability is the reason the
# archive is sealed at all, and a dump or an openssl invocation that fails part
# way must not leave it there either. The nightly service stages the same way.
WORK="${ARCHIVE}"
if [ -n "${BACKUP_ENCRYPTION_PASSPHRASE:-}" ]; then
    STAGING=$(mktemp -d)
    WORK="${STAGING}/clawdia-${TIMESTAMP}.gz"
    ARCHIVE="${ARCHIVE}.enc"
fi

# One trap for everything this leaves behind, however it ends — a failed dump,
# a failed seal, a Ctrl-C between them: the staged plaintext, the file holding
# the connection string, and the container's temp directory.
cleanup() {
    rm -rf "${STAGING:-}" "${TOOLS_DIR:-}"
    if [ -n "${REMOTE_DIR:-}" ]; then
        docker exec clawdia-mongodb rm -rf "${REMOTE_DIR}" >/dev/null 2>&1 || true
    fi
}
trap cleanup EXIT

MONGO_URI_MASKED=$(echo "${MONGO_URI}" | sed 's|://[^@]*@|://***@|')
echo "[backup] Starting backup → ${ARCHIVE}"
echo "[backup] URI: ${MONGO_URI_MASKED}"

if command -v mongodump &>/dev/null; then
    # The URI goes in a 0600 file, not on the command line where every user of
    # the host can read the password out of `ps` (#1156).
    TOOLS_DIR=$(mktemp -d)
    write_mongo_tools_config "${MONGO_URI}" "${TOOLS_DIR}/tools.yaml"
    mongodump --config="${TOOLS_DIR}/tools.yaml" --gzip --archive="${WORK}"
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
    # Written inside the container's private directory and handed over stdin,
    # so the URI is on neither mongodump's command line nor docker exec's.
    write_container_mongo_tools_config clawdia-mongodb "${CONTAINER_URI}" "${REMOTE_DIR}/tools.yaml"
    docker exec clawdia-mongodb \
        mongodump --config="${REMOTE_DIR}/tools.yaml" --gzip --archive="${REMOTE_DIR}/backup.gz"
    docker cp "clawdia-mongodb:${REMOTE_DIR}/backup.gz" "${WORK}"
fi

# Sealed out of the staging directory and into BACKUP_DIR, so the only thing
# that ever lands there is the finished ciphertext.
if [ -n "${BACKUP_ENCRYPTION_PASSPHRASE:-}" ]; then
    # `-pass env:` and not the passphrase on the command line, which every other
    # user of the host can read out of `ps`.
    if ! openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt \
        -pass env:BACKUP_ENCRYPTION_PASSPHRASE -in "${WORK}" -out "${ARCHIVE}"; then
        # A half-written .enc is not an archive, and leaving it under a name the
        # prune and `verify-backup.sh --latest` both reach for is a failure that
        # reads as a success.
        rm -f "${ARCHIVE}"
        echo "[backup] ERROR: encrypting the archive failed; nothing was kept." >&2
        exit 1
    fi
    # The tag that lets restore.sh and verify-backup.sh detect a substituted
    # or altered archive before decrypting it (scripts/lib/archive.sh).
    if ! write_archive_tag "${ARCHIVE}"; then
        rm -f "${ARCHIVE}" "${ARCHIVE}.tag"
        echo "[backup] ERROR: tagging the archive failed; nothing was kept." >&2
        exit 1
    fi
fi

SIZE=$(du -sh "${ARCHIVE}" | cut -f1)
echo "[backup] Done. Archive size: ${SIZE} → ${ARCHIVE}"

# Prune archives older than 30 days. Matches the old ultrabot-* prefix too, so
# archives written before the rename are still aged out.
find "${BACKUP_DIR}" \( -name 'clawdia-*.gz' -o -name 'clawdia-*.gz.enc' -o -name 'clawdia-*.gz.enc.tag' -o -name 'ultrabot-*.gz' \) -mtime +30 -print -delete \
    && echo "[backup] Pruned backups older than 30 days"
