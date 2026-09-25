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
# found; what neither catches is a deliberate, valid-looking substitution.
#
# That is what the tag is for (#1161). Every sealed archive gets a sidecar
# `<archive>.tag`, a MAC over the ciphertext keyed by the same passphrase, and
# `open_archive` refuses an archive whose tag is missing or does not match
# before anything is decrypted — so a substituted or edited archive is caught
# here rather than by `mongorestore --drop` over the live database.
#
# The tag is SHA-256 of the ciphertext, encrypted (AES-256-CBC) under a key
# derived from the passphrase with a fixed salt, and compared rather than
# decrypted. That is hash-then-PRF, a MAC, built from the one tool already
# here: `openssl dgst -hmac` and `openssl mac` only take their key on the
# command line, which is readable from the host by anyone, and `-pass env:` is
# how this file keeps the passphrase off it. The fixed salt keeps the tag key
# apart from every archive key, which each come from a random salt.
# src/migrations/runner.js computes the same tag in Node for the pre-migration
# dump, and tests/backupArchiveEncryption.test.js holds the two to each other.
#
# Sourced, not run:
#     . "$(dirname "$0")/lib/archive.sh"
#     READABLE=$(open_archive "${ARCHIVE}" "${WORKDIR}") || exit 1

# The fixed PBKDF2 salt of the tag key, as hex: "clawdiam". Must match the
# backup service entrypoint in both stack files and runner.js ARCHIVE_TAG_SALT.
ARCHIVE_TAG_SALT=636c61776469616d

# Prints the hex tag of the sealed archive $1 (see above). OpenSSL 1.1.1 writes
# `Salted__` and the salt ahead of the ciphertext even when the salt is given
# with -S; 3.x does not. That header is stripped, so the tag is the encrypted
# digest alone on either version, as runner.js computes it.
archive_tag() {
    openssl dgst -sha256 -binary "$1" \
        | openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -S "${ARCHIVE_TAG_SALT}" \
            -pass env:BACKUP_ENCRYPTION_PASSPHRASE \
        | od -An -v -tx1 | tr -d ' \n' \
        | sed 's/^53616c7465645f5f[0-9a-f]\{16\}//'
}

# Writes `$1.tag` for the sealed archive $1, mode 0600.
write_archive_tag() {
    local tag
    tag=$(archive_tag "$1") || return 1
    [ -n "${tag}" ] || return 1
    (umask 077 && printf '%s\n' "${tag}" > "$1.tag")
}

# Whether the sealed archive $1 matches its tag. An archive sealed before tags
# existed has none; it is refused unless BACKUP_ALLOW_UNTAGGED=true, since a
# missing tag is exactly what a substituted archive would have too.
verify_archive_tag() {
    local archive="$1" expected actual
    if [ ! -f "${archive}.tag" ]; then
        if [ "${BACKUP_ALLOW_UNTAGGED:-}" = "true" ]; then
            echo "[archive] WARNING: ${archive} has no .tag; opening it unauthenticated (BACKUP_ALLOW_UNTAGGED=true)." >&2
            return 0
        fi
        echo "[archive] ERROR: ${archive} has no ${archive}.tag, so it cannot be checked for tampering." >&2
        echo "[archive] Archives sealed before tags were added have none: set BACKUP_ALLOW_UNTAGGED=true" >&2
        echo "[archive] to open one of those, once you are sure it is the file you took." >&2
        return 1
    fi
    expected=$(tr -d ' \r\n' < "${archive}.tag")
    actual=$(archive_tag "${archive}") || actual=""
    if [ -z "${actual}" ] || [ "${expected}" != "${actual}" ]; then
        echo "[archive] ERROR: ${archive} does not match its tag — the archive or its .tag was" >&2
        echo "[archive] altered or substituted, or it was sealed with a different BACKUP_ENCRYPTION_PASSPHRASE." >&2
        return 1
    fi
}

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

    verify_archive_tag "${archive}" || return 1

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
