FROM node:22-alpine

# Install dependencies for canvas and voice
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
    g++ \
    ffmpeg \
    ttf-dejavu

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY . .

# Drop to the unprivileged `node` user shipped with the base image.
RUN chown -R node:node /app
USER node

EXPOSE 3000

CMD ["npm", "start"]