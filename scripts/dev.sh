#!/usr/bin/env bash
# Start the full Cloud Browser stack for development.
# Best effort: start PulseAudio (for audio capture) if available, then run
# the backend (tsx watch, port 3001) + Vite dev server (port 5000) together.
#
# Ports:
#   5000 - Frontend (Vite dev server; proxies /api and /signal to 3001)
#   3001 - Backend API + WebSocket signaling
#
# NOTE: WebRTC media requires UDP. GitHub Codespaces only forwards TCP ports,
# so in Codespaces you must either set a TURN server (see README) or accept
# that the media leg cannot connect. On a VPS with a public IP / 1:1 NAT,
# host candidates work without TURN.

set -euo pipefail

# 1. Start PulseAudio if the binary is present (Linux desktop/container).
if command -v pulseaudio >/dev/null 2>&1; then
  echo "[dev] Starting PulseAudio..."
  pulseaudio --daemonize=yes --system=false --exit-idle-time=-1 \
    --log-target=stderr >/tmp/pulseaudio.log 2>&1 || true
  sleep 1
  if command -v pactl >/dev/null 2>&1; then
    pactl load-module module-null-sink sink_name=cloud_sink \
      sink_properties=device.description=CloudBrowserSink >/dev/null 2>&1 || true
  fi
else
  echo "[dev] PulseAudio not found - audio capture will be unavailable (video still works)"
fi

# 2. Run backend + frontend together.
# Server runs under tsx (handles TS compilation + .js import specifiers).
export PORT="${PORT:-3001}"
# Enable werift ICE debug logging to diagnose TURN allocation failures
export DEBUG="${DEBUG:-werift-ice}"
exec npx concurrently \
  --names "server,vite" \
  --prefix-colors "cyan,green" \
  "npx tsx watch server/main.ts" \
  "npx vite --port 5000 --host 0.0.0.0"