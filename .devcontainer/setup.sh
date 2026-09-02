#!/usr/bin/env bash
# One-time setup for the Linux (GitHub Codespaces / Debian-family) environment.
# Installs Chrome/Chromium, FFmpeg, PulseAudio and builds the project.
# This keeps the APPLICATION code portable: this is only dev-environment setup.

set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

echo "[setup] Installing system packages (chromium, ffmpeg, pulseaudio, fonts)..."
sudo apt-get update
sudo apt-get install -y --no-install-recommends \
  chromium \
  ffmpeg \
  pulseaudio \
  pulseaudio-utils \
  fonts-liberation \
  ca-certificates

echo "[setup] Installing npm dependencies..."
npm install

echo "[setup] Building frontend (dist/) and backend (dist-server/)..."
npm run build
npm run build:server

echo "[setup] Done."
echo "[setup] Next step: run  npm run dev   and open the forwarded port 5000."