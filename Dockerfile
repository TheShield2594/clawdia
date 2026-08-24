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
FROM node:24-alpine AS build

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
FROM node:24-alpine

# Shared libraries canvas links against at runtime (the -dev headers and the
# compiler are deliberately left behind in the build stage), plus the DejaVu
# fonts that utils/shopBanner.js and utils/cardGenerator.js register by path.
RUN apk add --no-cache \
    cairo \
    jpeg \
    pango \
    giflib \
    pixman \
    freetype \
    ttf-dejavu \
    font-noto-emoji \
    tini

WORKDIR /app

COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node . .

USER node

ENV NODE_ENV=production

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
HEALTHCHECK --interval=30s --timeout=10s --retries=3 --start-period=90s \
    CMD node -e "require('http').get('http://127.0.0.1:' + (process.env.DASHBOARD_PORT || 3000) + '/health', r => { let b=''; r.on('data', d => b += d); r.on('end', () => { try { process.exit(JSON.parse(b).status === 'unhealthy' ? 1 : 0); } catch { process.exit(1); } }); }).on('error', () => process.exit(1))"

# tini as PID 1 reaps zombies and forwards signals. Exec'ing node directly
# (rather than `npm start`) means SIGTERM reaches the process that installed
# the SIGTERM handler in src/index.js, so the graceful shutdown there actually
# runs and compose's stop_grace_period is honoured instead of a hard SIGKILL.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/index.js"]
