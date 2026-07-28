# ---- build stage -------------------------------------------------------------
# `canvas` has no prebuilt binary for this platform/ABI, so it compiles from
# source and needs a full toolchain plus cairo/pango headers. None of that
# belongs in the runtime image, so the compile happens here and only the
# resulting node_modules is carried forward.
FROM node:22-alpine AS build

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
FROM node:22-alpine

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

# tini as PID 1 reaps zombies and forwards signals. Exec'ing node directly
# (rather than `npm start`) means SIGTERM reaches the process that installed
# the SIGTERM handler in src/index.js, so the graceful shutdown there actually
# runs and compose's stop_grace_period is honoured instead of a hard SIGKILL.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/index.js"]
