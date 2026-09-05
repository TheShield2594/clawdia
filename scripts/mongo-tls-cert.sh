#!/usr/bin/env bash
# The certificate material MONGODB_TLS_ARGS names (#975).
#
# Encrypting db-network is opt-in, and the thing that decides whether it is
# worth having on is not the crypto — it is this file. A self-signed CA and a
# server certificate are ten minutes of openssl and then a dated bomb: a mongod
# that stops accepting connections at midnight on an expiry nobody recorded is a
# worse outage than the cleartext it was turned on to prevent. So the two jobs
# live together here, and the second one is schedulable.
#
# Usage:
#   ./scripts/mongo-tls-cert.sh [dir] [extra-hostname ...]   issue CA + server cert
#   ./scripts/mongo-tls-cert.sh --check [dir]                how long is left
#   ./scripts/mongo-tls-cert.sh --new-ca [dir] [host ...]    roll the CA over
#
# `dir` defaults to ./secrets/mongo-tls, which is what the commented mounts in
# docker-compose.yml expect. On a Portainer host it is wherever you pointed
# /opt/clawdia/mongo-tls at.
#
# What it writes:
#   ca.crt      the CA every client validates mongod against (world-readable)
#   ca.key      the CA private key — the only thing here that can mint a
#               certificate this deployment would trust. It is mounted into no
#               container, and it is the one file worth moving off the host
#   server.pem  certificate + private key concatenated, which is the one file
#               mongod's --tlsCertificateKeyFile wants
#
# The server certificate is issued for `mongodb` — the service name on
# db-network, which is the name every client dials and therefore the name the
# certificate has to carry — plus localhost and 127.0.0.1 for a `docker exec`
# mongosh, plus any extra names given on the command line.
#
# Lifetimes are deliberately long: ten years for the CA, five for the server
# certificate — or whatever is left of the CA, if that is less, since a leaf
# outlives its issuer only on paper. A private CA on an internal-only network gains nothing from short
# rotation — there is no revocation path here to make it meaningful — and every
# month shaved off is a month closer to the outage above. Renewing is this
# script again with the same directory and a restart; see "Encrypting MongoDB
# traffic with TLS" in docs/SETUP_GUIDE.md.
#
# `--check` prints the days remaining and exits non-zero under
# MONGO_TLS_WARN_DAYS (60), reporting to ERROR_WEBHOOK_URL the same way
# verify-backup.sh does. It reads nothing secret, so it is safe in a host
# crontab:
#
#   0 6 * * *  cd /opt/clawdia && ./scripts/mongo-tls-cert.sh --check >> /var/log/clawdia-tls.log 2>&1
#
# Requires: openssl.
set -euo pipefail

CA_DAYS=3650
SERVER_DAYS=1825
WARN_DAYS="${MONGO_TLS_WARN_DAYS:-60}"
# The mongo image runs mongod as this uid, and it is the only process that has
# to be able to read server.pem.
MONGO_UID=999
MONGO_GID=999

command -v openssl >/dev/null 2>&1 || { echo "[mongo-tls] openssl is not on PATH" >&2; exit 1; }

# The same rule src/utils/errorReporter.js applies to the same variable: https
# anywhere, http only to loopback, anything else refused rather than downgraded.
sink_allowed() {
    case "$1" in
        https://*) return 0 ;;
        http://localhost|http://localhost/*|http://localhost:*) return 0 ;;
        http://127.0.0.1|http://127.0.0.1/*|http://127.0.0.1:*) return 0 ;;
        "http://[::1]"|"http://[::1]/"*|"http://[::1]:"*) return 0 ;;
        *) return 1 ;;
    esac
}

# A path or a hostname may hold a quote or a backslash, and interpolating one
# straight into a JSON string produces a body the sink rejects — so the report
# about the problem fails too.
json_escape() {
    printf '%s' "$1" | tr -d '\000-\037' | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

notify_failure() {
    echo "[mongo-tls] $1" >&2
    [ -n "${ERROR_WEBHOOK_URL:-}" ] || return 0
    if ! sink_allowed "${ERROR_WEBHOOK_URL}"; then
        echo "[mongo-tls] Ignoring ERROR_WEBHOOK_URL: expected an https:// URL (or http:// to loopback)" >&2
        return 0
    fi
    command -v curl >/dev/null 2>&1 || { echo "[mongo-tls] curl not found; ERROR_WEBHOOK_URL not posted" >&2; return 0; }
    local body message
    message=$(json_escape "$1")
    case "${ERROR_WEBHOOK_URL}" in
        https://discord.com/api/webhooks/*|https://discordapp.com/api/webhooks/*)
            body=$(printf '{"content":"**MongoDB TLS certificate** on %s: %s"}' "$(json_escape "$(hostname)")" "${message}") ;;
        *)
            body=$(printf '{"kind":"mongo_tls_expiring","service":"clawdia-mongodb","message":"%s"}' "${message}") ;;
    esac
    curl -fsS --max-time 10 -X POST -H 'content-type: application/json' \
        -d "${body}" "${ERROR_WEBHOOK_URL}" >/dev/null 2>&1 \
        || echo "[mongo-tls] posting to ERROR_WEBHOOK_URL failed" >&2
}

# Days until a certificate expires, negative once it has. `openssl x509
# -checkend` answers a yes/no and this needs the number, so the notBefore date
# is parsed instead — GNU date and BSD date disagree about how, hence both.
days_left() {
    local cert not_after end now
    cert="$1"
    not_after=$(openssl x509 -in "${cert}" -noout -enddate | cut -d= -f2-)
    end=$(date -u -d "${not_after}" +%s 2>/dev/null \
        || date -u -j -f '%b %d %T %Y %Z' "${not_after}" +%s 2>/dev/null) || {
        echo "[mongo-tls] could not parse the expiry date of ${cert}: ${not_after}" >&2
        return 1
    }
    now=$(date -u +%s)
    echo $(( (end - now) / 86400 ))
}

check() {
    local dir server ca status left
    dir="$1"
    server="${dir}/server.pem"
    ca="${dir}/ca.crt"
    status=0
    for cert in "${ca}" "${server}"; do
        if [ ! -r "${cert}" ]; then
            echo "[mongo-tls] ${cert} is missing or unreadable" >&2
            return 1
        fi
    done
    for cert in "${ca}" "${server}"; do
        left=$(days_left "${cert}") || return 1
        if [ "${left}" -lt 0 ]; then
            notify_failure "${cert} EXPIRED $(( -left )) days ago; mongod is refusing connections or about to"
            status=1
        elif [ "${left}" -lt "${WARN_DAYS}" ]; then
            notify_failure "${cert} expires in ${left} days; reissue it with scripts/mongo-tls-cert.sh"
            status=1
        else
            echo "[mongo-tls] ${cert}: ${left} days left"
        fi
    done
    return "${status}"
}

issue() {
    local dir
    dir="$1"
    shift

    if [ -e "${dir}/server.pem" ]; then
        # Reissuing in place is the renewal path and is meant to work, but it
        # invalidates nothing until mongod is restarted — and a half-written
        # pair while mongod is running is the one state that breaks a live
        # deployment. Everything is written to temporary names and moved into
        # place at the end, so the window is a rename rather than an openssl run.
        echo "[mongo-tls] ${dir} already holds a certificate; reissuing (mongod keeps the old one until it is restarted)"
    fi

    mkdir -p "${dir}"
    chmod 750 "${dir}"

    # Every name a client might dial. `mongodb` is the service name on
    # db-network and the one that actually matters; without it in the SAN list
    # the driver rejects the certificate on hostname verification and no amount
    # of trusting the CA helps.
    local alt_names
    alt_names="DNS:mongodb,DNS:localhost,IP:127.0.0.1"
    for extra in "$@"; do
        case "${extra}" in
            *[!0-9.]*) alt_names="${alt_names},DNS:${extra}" ;;
            *) alt_names="${alt_names},IP:${extra}" ;;
        esac
    done

    # WORK is deliberately not `local`: the EXIT trap runs after this function
    # has returned, and a local would be unbound by then — which under `set -u`
    # turns a clean run into an error on the way out.
    WORK=$(mktemp -d "${dir}/.issue.XXXXXX")
    trap 'rm -rf "${WORK:-}"' EXIT

    # Reuse an existing CA when there is one: reissuing the server certificate
    # under a new CA would mean re-distributing ca.crt to all four containers,
    # which is the step an operator renewing in a hurry would skip.
    local issue_days ca_left
    issue_days="${SERVER_DAYS}"
    if [ "${NEW_CA}" != yes ] && [ -r "${dir}/ca.key" ] && [ -r "${dir}/ca.crt" ]; then
        ca_left=$(days_left "${dir}/ca.crt") || return 1
        # A leaf certificate is only good for as long as the chain above it. Its
        # own notAfter says nothing once the issuer has expired — every client
        # rejects it on the CA date, whatever the server certificate claims. So
        # a CA that cannot cover the requested lifetime does not silently issue
        # a certificate that lies about when it stops working.
        if [ "${ca_left}" -lt "${WARN_DAYS}" ]; then
            echo "[mongo-tls] The CA in ${dir} has ${ca_left} days left, which is not enough to issue against." >&2
            echo "[mongo-tls] Roll it over deliberately — this replaces the trust material every client holds:" >&2
            echo "[mongo-tls]   ${0} --new-ca ${dir}" >&2
            echo "[mongo-tls] then recreate every container with a mongo-tls mount. See docs/SETUP_GUIDE.md." >&2
            return 1
        fi
        echo "[mongo-tls] Reusing the existing CA in ${dir} (${ca_left} days left)"
        if [ "${ca_left}" -lt "${issue_days}" ]; then
            echo "[mongo-tls] Capping the server certificate at ${ca_left} days to match it, rather than the usual ${SERVER_DAYS}."
            issue_days="${ca_left}"
        fi
        cp "${dir}/ca.key" "${WORK}/ca.key"
        cp "${dir}/ca.crt" "${WORK}/ca.crt"
    else
        if [ -r "${dir}/ca.crt" ]; then
            echo "[mongo-tls] Replacing the CA in ${dir}. Every client holding the old ca.crt stops"
            echo "[mongo-tls] trusting mongod the moment it restarts, so redistribute the new one and"
            echo "[mongo-tls] recreate all four containers together."
        fi
        echo "[mongo-tls] Creating a CA valid for ${CA_DAYS} days"
        openssl req -x509 -newkey rsa:4096 -sha256 -nodes \
            -days "${CA_DAYS}" \
            -keyout "${WORK}/ca.key" -out "${WORK}/ca.crt" \
            -subj "/CN=Clawdia MongoDB CA/O=Clawdia" \
            -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
            -addext "keyUsage=critical,keyCertSign,cRLSign" 2>/dev/null
    fi

    echo "[mongo-tls] Issuing a server certificate valid for ${issue_days} days (${alt_names})"
    openssl req -newkey rsa:4096 -sha256 -nodes \
        -keyout "${WORK}/server.key" -out "${WORK}/server.csr" \
        -subj "/CN=mongodb/O=Clawdia" 2>/dev/null

    # clientAuth as well as serverAuth: a single-node replica set opens a
    # replication connection to itself, and on that one mongod is the client.
    # Without it the set never reaches primary and the healthcheck stays red.
    cat > "${WORK}/ext" <<EXT
basicConstraints=CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth,clientAuth
subjectAltName=${alt_names}
EXT

    openssl x509 -req -in "${WORK}/server.csr" -sha256 \
        -CA "${WORK}/ca.crt" -CAkey "${WORK}/ca.key" -CAcreateserial \
        -days "${issue_days}" -extfile "${WORK}/ext" \
        -out "${WORK}/server.crt" 2>/dev/null

    # mongod wants one file, key first is conventional and either order parses.
    cat "${WORK}/server.key" "${WORK}/server.crt" > "${WORK}/server.pem"

    mv "${WORK}/ca.crt" "${dir}/ca.crt"
    mv "${WORK}/ca.key" "${dir}/ca.key"
    mv "${WORK}/server.pem" "${dir}/server.pem"

    chmod 444 "${dir}/ca.crt"
    chmod 400 "${dir}/ca.key" "${dir}/server.pem"
    # server.pem is bind-mounted into a container whose mongod runs as uid 999,
    # and 0400 owned by anyone else is a file that container cannot read. Not
    # fatal when this is not run as root — say so rather than leaving a mongod
    # that will not start with no explanation.
    if ! chown "${MONGO_UID}:${MONGO_GID}" "${dir}/server.pem" 2>/dev/null; then
        echo "[mongo-tls] Could not chown ${dir}/server.pem to ${MONGO_UID}:${MONGO_GID} — run:"
        echo "[mongo-tls]   sudo chown ${MONGO_UID}:${MONGO_GID} ${dir}/server.pem"
        echo "[mongo-tls] mongod runs as that uid and cannot read the file otherwise."
    fi

    echo
    echo "[mongo-tls] Written to ${dir}:"
    # Not `|| true`. This is the only thing that reads back what was just
    # written, and a pair that cannot be parsed or is already inside the warning
    # window is not a successful issue — reporting it as one would leave the
    # operator moving on to mount it.
    if ! check "${dir}"; then
        echo "[mongo-tls] The certificate that was just written did not pass its own check." >&2
        return 1
    fi
    echo
    echo "[mongo-tls] Next: uncomment the mongo-tls mounts — ca.crt on mongodb,"
    echo "[mongo-tls] mongo-replset-init, bot and backup, and server.pem on mongodb."
    echo "[mongo-tls] ca.key is mounted nowhere. Then set — in this order, all in one edit —"
    echo "[mongo-tls]   MONGODB_CLIENT_TLS_ARGS=--tls --tlsCAFile /etc/mongo-tls/ca.crt"
    echo "[mongo-tls]   MONGODB_URI=...?tls=true&tlsCAFile=/etc/mongo-tls/ca.crt"
    echo "[mongo-tls]   MONGODB_TLS_ARGS=--tlsMode requireTLS --tlsCertificateKeyFile /etc/mongo-tls/server.pem --tlsCAFile /etc/mongo-tls/ca.crt --tlsAllowConnectionsWithoutCertificates"
    echo "[mongo-tls] and recreate the stack. See docs/SETUP_GUIDE.md."
}

MODE=issue
NEW_CA=no
if [ "${1:-}" = "--check" ]; then
    MODE=check
    shift
elif [ "${1:-}" = "--new-ca" ]; then
    # Deliberate, and never implicit: a new CA invalidates the ca.crt every
    # client holds, so it is a flag rather than something a renewal decides on
    # the operator behalf.
    NEW_CA=yes
    shift
elif [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
    sed -n "2,$(( $(grep -n '^set -euo pipefail' "$0" | cut -d: -f1) - 1 ))p" "$0" | sed 's/^# \{0,1\}//'
    exit 0
fi

DIR="${1:-./secrets/mongo-tls}"
[ $# -gt 0 ] && shift

if [ "${MODE}" = check ]; then
    check "${DIR}"
else
    issue "${DIR}" "$@"
fi
