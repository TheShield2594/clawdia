#!/usr/bin/env bash
# Opening a backup archive, sealed or not (#886).
#
# The backup service writes `clawdia-<timestamp>.gz.enc` when
# BACKUP_ENCRYPTION_PASSPHRASE is set and `clawdia-<timestamp>.gz` when it is
# not, and every consumer — restore.sh, verify-backup.sh — has to handle both or
# the encryption is a feature that quietly makes the archives unusable. One
# copy of that, sourced, rather than the same fifteen lines in each: the cipher
# and its parameters have to match what sealed the archive, and two copies of
# those are two chances to change one of them.
#
# AES-256-CBC and not the GCM that config/secretBox.js uses for the credentials
# inside the dump. `openssl enc` is a stream cipher tool with no AEAD mode worth
# relying on from the command line, and the alternative — a second tool in the
# stock mongo image the backup service runs in — is a dependency that image does
# not have. What CBC costs is tamper *detection*: an altered archive decrypts to
# garbage rather than refusing to open. The backup service parses every sealed
# archive back on the night it is taken, which is where an unreadable one is
# found; what neither catches is a deliberate, valid-looking substitution, and
# an archive store where that is the threat wants a signature, not a cipher mode.
#
# Sourced, not run:
#     . "$(dirname "$0")/lib/archive.sh"
#     READABLE=$(open_archive "${ARCHIVE}" "${WORKDIR}") || exit 1

# Whether this path names a sealed archive.
archive_is_encrypted() {
    case "$1" in
        *.enc) return 0 ;;
        *) return 1 ;;
    esac
}

# Prints a path mongorestore can read for the archive named in $1.
#
# A plain archive is its own answer and nothing is copied. A sealed one is
# decrypted into $2 — a directory the caller creates and removes, because both
# callers already own an EXIT trap and a second one installed here would replace
# it. Diagnostics go to stderr so stdout carries only the path.
open_archive() {
    local archive="$1" workdir="$2" out

    archive_is_encrypted "${archive}" || { printf '%s' "${archive}"; return 0; }

    if [ -z "${BACKUP_ENCRYPTION_PASSPHRASE:-}" ]; then
        echo "[archive] ERROR: ${archive} is encrypted and BACKUP_ENCRYPTION_PASSPHRASE is not set." >&2
        echo "[archive] It is the passphrase the backup service sealed it with; without it the" >&2
        echo "[archive] archive cannot be read back. See .env.example." >&2
        return 1
    fi
    if ! command -v openssl >/dev/null 2>&1; then
        echo "[archive] ERROR: ${archive} is encrypted and openssl is not on PATH." >&2
        return 1
    fi
    if [ -z "${workdir}" ] || [ ! -d "${workdir}" ]; then
        echo "[archive] ERROR: no working directory to decrypt ${archive} into." >&2
        return 1
    fi

    # Into the caller's private directory (mktemp -d is 0700), never beside the
    # archive: the plaintext of the whole database must not appear in the backup
    # directory whose readability is the reason the archive is sealed at all.
    out="${workdir}/$(basename "${archive%.enc}")"
    echo "[archive] Decrypting ${archive}…" >&2
    if ! openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 \
        -pass env:BACKUP_ENCRYPTION_PASSPHRASE -in "${archive}" -out "${out}"; then
        echo "[archive] ERROR: ${archive} did not decrypt — wrong BACKUP_ENCRYPTION_PASSPHRASE," >&2
        echo "[archive] or the file was altered." >&2
        rm -f "${out}"
        return 1
    fi
    printf '%s' "${out}"
}
