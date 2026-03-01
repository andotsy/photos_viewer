# ── Stage 1: build native addons ──────────────────────────────────────
FROM node:22-alpine AS build

# build-base + python3 needed for better-sqlite3 native compilation
RUN apk add --no-cache build-base python3

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

# ── Stage 2: runtime (no compilers) ──────────────────────────────────
FROM node:22-alpine

WORKDIR /app

# Copy only the compiled node_modules and app source
COPY --from=build /app/node_modules ./node_modules
COPY package*.json ./
COPY server.js ./
COPY public/ ./public/

# Default: expects the .photoslibrary mounted at /media
ENV PHOTOS_LIB_PATH=/media
ENV PORT=3000
ENV VIPS_WARNING=0

EXPOSE 3000

CMD ["node", "server.js"]
