#!/usr/bin/env bash
# Copy the backup archives somewhere the host cannot take with it (#900).
#
# The nightly archives and the database they protect share a machine: they land
# in ./backups, beside the volume mongod writes to. That covers logical damage —
# a bad migration, an accidental delete, a restore rehearsal — and covers
# nothing at all about losing the machine. A failed disk, a wiped VPS or a
# mistaken `docker volume prune` takes the database and every backup of it in
# one event.
#
# This is the other copy. It is a host script rather than a service in the
# compose stack for the same reason scripts/verify-backup.sh is: what it needs —
# an rclone remote, its credentials, a network path off the host — is the
# operator's to configure, and a stack service that cannot work until they have
# would be a container in a crash loop rather than a feature.
#
# Usage: ./scripts/offsite-sync.sh [backup-dir]
#        BACKUP_REMOTE=s3:my-bucket/clawdia ./scripts/offsite-sync.sh
#
# Meant to be scheduled. Hourly is plenty — the archives are written once a day:
#
#   17 * * * *  cd /opt/clawdia && ./scripts/offsite-sync.sh >> /var/log/clawdia-offsite.log 2>&1
#
# Requires: rclone on PATH, and a remote already set up with `rclone config`.
set -euo pipefail

BACKUP_DIR="${1:-./backups}"

# Load .env if present and BACKUP_REMOTE is not already set, the same way
# backup.sh and verify-backup.sh pick up MONGODB_URI.
if [ -z "${BACKUP_REMOTE:-}" ] && [ -f "$(dirname "$0")/../.env" ]; then
    # shellcheck disable=SC1090
    set -a; source "$(dirname "$0")/../.env"; set +a
fi

# The same sink and the same rules as scripts/verify-backup.sh: https anywhere,
# http only to loopback, anything else refused rather than downgraded. A
# replication that has been failing for a month is indistinguishable from one
# that was never set up, and both are found out on the same day.
sink_allowed() {
    case "$1" in
        https://*) return 0 ;;
        http://localhost|http://localhost/*|http://localhost:*) return 0 ;;
        http://127.0.0.1|http://127.0.0.1/*|http://127.0.0.1:*) return 0 ;;
        "http://[::1]"|"http://[::1]/"*|"http://[::1]:"*) return 0 ;;
        *) return 1 ;;
    esac
}

json_escape() {
    printf '%s' "$1" | tr -d '\000-\037' | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

notify_failure() {
    echo "[offsite] FAILED: $1" >&2
    [ -n "${ERROR_WEBHOOK_URL:-}" ] || return 0
    if ! sink_allowed "${ERROR_WEBHOOK_URL}"; then
        echo "[offsite] Ignoring ERROR_WEBHOOK_URL: expected an https:// URL (or http:// to loopback)" >&2
        return 0
    fi
    command -v curl >/dev/null 2>&1 || { echo "[offsite] curl not found; ERROR_WEBHOOK_URL not posted" >&2; return 0; }
    local body message
    message=$(json_escape "$1")
    case "${ERROR_WEBHOOK_URL}" in
        https://discord.com/api/webhooks/*|https://discordapp.com/api/webhooks/*)
            body=$(printf '{"content":"**off-site backup sync failed** on %s: %s"}' "$(json_escape "$(hostname)")" "${message}") ;;
        *)
            body=$(printf '{"kind":"backup_offsite_failed","service":"clawdia-offsite","message":"%s"}' "${message}") ;;
    esac
    curl -fsS --max-time 10 -X POST -H 'content-type: application/json' \
        -d "${body}" "${ERROR_WEBHOOK_URL}" >/dev/null 2>&1 \
        || echo "[offsite] posting to ERROR_WEBHOOK_URL failed" >&2
}

# shellcheck disable=SC2154  # `status` is assigned by the trap's own first
# command; shellcheck reads a trap string without knowing when it runs.
trap 'status=$?; [ "${status}" -eq 0 ] || notify_failure "sync to ${BACKUP_REMOTE:-<no remote>} exited ${status}"; exit "${status}"' EXIT

if [ -z "${BACKUP_REMOTE:-}" ]; then
    echo "[offsite] BACKUP_REMOTE is not set. Set it in .env to an rclone remote," >&2
    echo "[offsite] e.g. BACKUP_REMOTE=s3:my-bucket/clawdia — see \`rclone config\`." >&2
    exit 1
fi

if [ ! -d "${BACKUP_DIR}" ]; then
    echo "[offsite] ERROR: no such directory: ${BACKUP_DIR}" >&2
    exit 1
fi

if ! command -v rclone >/dev/null 2>&1; then
    echo "[offsite] ERROR: rclone is not on PATH. https://rclone.org/install/" >&2
    exit 1
fi

# Sending a readable copy of the whole database to a third party is a larger
# exposure than the one this script exists to close, not a smaller one. An
# archive is ciphertext when the backup service sealed it, which it does when
# BACKUP_ENCRYPTION_PASSPHRASE is set (#886), and `.enc` is how one says so.
#
# Skipped rather than refused, because "some of these are plaintext" is the
# ordinary state of a directory that has encryption on: the bot's own
# pre-migration dump is written by src/migrations/runner.js, which has no
# passphrase, so one turns up after every irreversible migration and stays for
# the retention window. Refusing the whole run over it would take the off-site
# copy away for a month, and it is the sealed nightly archives that the copy is
# for. What is refused is a run that would copy nothing at all — that is an
# install with no passphrase, and it should hear about it rather than succeed
# silently having sent nothing.
#
# The override is for an operator whose remote is itself encrypted — an rclone
# `crypt` remote, a bucket with SSE-KMS — where the second layer is genuinely
# redundant. It is a variable and not a flag so a cron line carries it too.
count_matching() {
    find "${BACKUP_DIR}" -maxdepth 1 -name "$1" 2>/dev/null | wc -l | tr -d ' '
}

SEALED=$(count_matching 'clawdia-*.gz.enc')
PLAINTEXT=$(( $(count_matching 'clawdia-*.gz') + $(count_matching 'pre-migration-*.gz') ))

if [ "${BACKUP_REMOTE_ALLOW_PLAINTEXT:-}" = "true" ]; then
    INCLUDES=(--include 'clawdia-*.gz' --include 'clawdia-*.gz.enc'
              --include 'pre-migration-*.gz' --include 'pre-migration-*.gz.enc')
else
    INCLUDES=(--include 'clawdia-*.gz.enc' --include 'pre-migration-*.gz.enc')
    if [ "${SEALED}" -eq 0 ]; then
        echo "[offsite] ERROR: ${BACKUP_DIR} holds no encrypted archives, only ${PLAINTEXT} plaintext one(s)." >&2
        echo "[offsite] Set BACKUP_ENCRYPTION_PASSPHRASE so the backup service seals them," >&2
        echo "[offsite] or set BACKUP_REMOTE_ALLOW_PLAINTEXT=true if the remote encrypts for you." >&2
        exit 1
    fi
    if [ "${PLAINTEXT}" -gt 0 ]; then
        echo "[offsite] Skipping ${PLAINTEXT} unencrypted archive(s); they stay on this host."
    fi
fi

echo "[offsite] Source: ${BACKUP_DIR}"
echo "[offsite] Remote: ${BACKUP_REMOTE}"

# `copy` and not `sync`. `sync` mirrors deletions, which sounds right — the
# nightly prune ages archives out and the remote would follow — and means that
# anything which empties ./backups empties the off-site copy on the next run.
# That is the event this script exists for. Expiry belongs to the remote's own
# lifecycle policy, where deleting is a decision somebody configured.
#
# The `.unverified` quarantine is deliberately not copied: it is an archive that
# failed its own parse check, kept for a human to look at, and off-site storage
# holding a known-bad archive beside good ones is a trap for the person
# restoring at 3am.
rclone copy "${BACKUP_DIR}" "${BACKUP_REMOTE}" \
    "${INCLUDES[@]}" \
    --stats-one-line \
    --stats 5m

echo "[offsite] Done."
