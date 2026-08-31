# ---- build stage -------------------------------------------------------------
# `canvas` has no prebuilt binary for this platform/ABI, so it compiles from
# source and needs a full toolchain plus cairo/pango headers. None of that
# belongs in the runtime image, so the compile happens here and only the
# resulting node_modules is carried forward.
# The tag major must stay in step with .nvmrc and package.json `engines`: CI
# installs and tests on the .nvmrc version, so a Dockerfile on a different major
# ships a runtime nothing ever tested. tests/nodeVersionAlignment.test.js fails
# the build if the three drift apart. 24 is the active LTS line; move all three
# together when 26 reaches LTS.
#
# The `@sha256:` suffix is what makes the build reproducible (#644). `node:24-alpine`
# on its own is a moving target — it is re-published whenever the 24 line gets a
# patch or Alpine gets a rebuild — so the same Dockerfile, the same commit and the
# same `docker build` produce a different runtime depending on the day, and a
# rebuild to roll back a regression can quietly carry a *newer* base than the
# image it is replacing. The tag is kept alongside the digest because it is the
# only human-readable half; the digest is what Docker actually resolves.
# Dependabot's `docker` ecosystem (.github/dependabot.yml) raises the bump, and
# tests/imagePinning.test.js fails if any reference here or in either stack file
# loses its digest.
FROM node:24-alpine@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf AS build

RUN apk add --no-cache \
    cairo-dev \
    jpeg-dev \
    pango-dev \
    giflib-dev \
    pixman-dev \
    pangomm-dev \
    libjpeg-turbo-dev \
    freetype-dev \
    python3 \
    make \
    g++

WORKDIR /app

COPY package*.json ./
# --omit=dev replaces the deprecated --only=production (removed in npm v12).
RUN npm ci --omit=dev && npm cache clean --force

# ---- runtime stage -----------------------------------------------------------
# Same major as the build stage and as .nvmrc — see the note above.
FROM node:24-alpine@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf

# Shared libraries canvas links against at runtime (the -dev headers and the
# compiler are deliberately left behind in the build stage), plus the DejaVu
# fonts that utils/shopBanner.js and utils/cardGenerator.js register by path.
#
# `apk upgrade` first, and it is not redundant with the digest-pinned base. The
# pin (#644) fixes the starting point, which is what makes a rebuild
# reproducible; it does not make that starting point *current*. `node:24-alpine`
# is rebuilt on upstream's schedule, not Alpine's, so between rebuilds the base
# carries OS packages with published fixes already sitting in Alpine's repo —
# the image scan in CI found exactly that (giflib and openssl, both fixed
# upstream, neither yet in a node:24-alpine rebuild). Upgrading here takes the
# fixes without waiting, and costs no more determinism than the `apk add` below
# already does: both resolve against whatever Alpine is serving at build time.
RUN apk upgrade --no-cache && apk add --no-cache \
    cairo \
    jpeg \
    pango \
    giflib \
    pixman \
    freetype \
    ttf-dejavu \
    font-noto-emoji \
    tini

# npm ships inside the Node base image and this one never runs it: the build
# stage does the install, and the runtime entrypoint is `node src/index.js`
# under tini — nothing in either stack file shells out to npm, and the
# healthchecks are `node -e`. It is several megabytes of dependency tree that
# exists only to be scanned: every Node-ecosystem finding in the first scan of
# this image (brace-expansion, ip-address, tar) came from
# /usr/local/lib/node_modules/npm and none of it was reachable from anything
# this container does. Deleting it removes the findings by removing the code,
# which is the only honest way to clear a CVE you are not going to patch.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

WORKDIR /app

COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node . .

USER node

ENV NODE_ENV=production

# 3000 is the container-side port, and it is a constant rather than something
# DASHBOARD_PORT is expected to move (#650). EXPOSE is image metadata — it
# publishes nothing and binds nothing — so it cannot follow a value that is only
# known at `docker run` time, and a build argument would only be right for
# whoever remembered to pass it. The fix is therefore to hold the convention
# rather than to parameterize it: both stack files map a chosen *host* port onto
# this one and leave DASHBOARD_PORT at its 3000 default, which is what the
# healthcheck below then resolves.
#
# This is the line that made #641 possible — the image healthcheck probed a
# hardcoded 3000 while portainer-stack.yml was read as running the container on
# 7001, and the mismatch was masked by the stack overriding the check.
# tests/dashboardPortAlignment.test.js now fails if this number, either stack
# file's container-side port, or the DASHBOARD_PORT default in either of them
# stops agreeing with the others.
EXPOSE 3000

# Declared on the image itself, not only in compose, so `docker run` and any
# orchestrator that reads image metadata can report health without repeating
# this. /health returns 503 when MongoDB is down; the unauthenticated payload is
# just {status, uptime}, which is all this needs to parse.
# start-period matches compose: migrations run before the port opens.
#
# The port is read from DASHBOARD_PORT rather than hardcoded. Baked in as 3000
# it silently failed forever on any deploy that moved the port — which is how
# portainer-stack.yml came to run on 7001 with an image healthcheck probing
# 3000, masked only because the stack overrode the check (#641).
#
# BOT_GATEWAY_PORT comes first because it is what says the dashboard has been
# split out (#876): in that deployment this container serves the gateway facade
# and nothing else, and /health on that port is the only HTTP it answers. The
# dashboard container runs the same image with neither variable set, so it falls
# through to DASHBOARD_PORT exactly as before.
HEALTHCHECK --interval=30s --timeout=10s --retries=3 --start-period=90s \
    CMD node -e "require('http').get('http://127.0.0.1:' + (process.env.BOT_GATEWAY_PORT || process.env.DASHBOARD_PORT || 3000) + '/health', r => { let b=''; r.on('data', d => b += d); r.on('end', () => { try { process.exit(JSON.parse(b).status === 'unhealthy' ? 1 : 0); } catch { process.exit(1); } }); }).on('error', () => process.exit(1))"

# tini as PID 1 reaps zombies and forwards signals. Exec'ing node directly
# (rather than `npm start`) means SIGTERM reaches the process that installed
# the SIGTERM handler in src/index.js, so the graceful shutdown there actually
# runs and compose's stop_grace_period is honoured instead of a hard SIGKILL.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/index.js"]
