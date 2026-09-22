#!/usr/bin/env bash
# Production-style single-port startup (works on any Linux VPS without Docker).
# Builds the frontend + backend if needed, starts PulseAudio (best effort), then
# runs the compiled server which serves BOTH the built UI and the API/WebSocket
# on ONE port (default 3001, override with PORT).
#
# This is the command to use when moving the same code to a standalone VPS.

set -euo pipefail

cd "$(dirname "$0")/.."

echo "[start] Building frontend + backend..."
npm run build
npm run build:server

# Best-effort PulseAudio for audio capture.
if command -v pulseaudio >/dev/null 2>&1; then
  echo "[start] Starting PulseAudio..."
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
  echo "[start] PulseAudio not found - audio capture will be unavailable (video still works)"
fi

export PORT="${PORT:-3001}"
echo "[start] Cloud Browser listening on http://0.0.0.0:${PORT}"
exec node dist-server/server/main.js