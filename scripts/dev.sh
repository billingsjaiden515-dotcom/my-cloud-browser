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
    # Idempotent: creating the sink twice leaks sinks and orphans Chromium audio.
    # Sink runs at 48 kHz to match Opus/WebRTC (avoids a resample stage).
    # A leftover 44.1 kHz sink is recreated before the server starts, so no
    # audio is lost; leaked null sinks from older runs are cleaned up too.
    if pactl list sinks 2>/dev/null | grep -A 15 'Name: cloud_sink$' | grep -q '48000Hz'; then
      : # existing sink is already 48 kHz
    else
      for mod in $(pactl list short modules 2>/dev/null | awk '$2 == "module-null-sink" { print $1 }'); do
        pactl unload-module "$mod" >/dev/null 2>&1 || true
      done
      pactl load-module module-null-sink sink_name=cloud_sink rate=48000 channels=2 \
        sink_properties=device.description=CloudBrowserSink >/dev/null 2>&1 || true
    fi
    pactl set-default-sink cloud_sink >/dev/null 2>&1 || true
    pactl set-default-source cloud_sink.monitor >/dev/null 2>&1 || true
  fi
  export PULSE_CAPTURE_SOURCE=cloud_sink.monitor
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