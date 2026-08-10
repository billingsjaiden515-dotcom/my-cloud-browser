# Cloud Browser — Render-compatible image
# Provides Node, Chromium, and FFmpeg in one container.

FROM node:20-bookworm-slim

# Chromium runtime shared libraries + FFmpeg (with libvpx for VP8)
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    ffmpeg \
    pulseaudio \
    pulseaudio-utils \
    fonts-liberation \
    libnss3 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libasound2 \
    libpango-1.0-0 \
    libcairo2 \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies first (better layer caching)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev || npm install --omit=dev

# Build the frontend and compile the server (needs dev deps for Vite/tsc)
COPY . .
RUN npm install && npm run build && npm run build:server && npm prune --omit=dev

# Chromium is installed at /usr/bin/chromium in this image
ENV CHROMIUM_PATH=/usr/bin/chromium
ENV NODE_ENV=production

EXPOSE 3001

# Render injects PORT; fall back to 3001
CMD ["node", "dist-server/server/main.js"]
