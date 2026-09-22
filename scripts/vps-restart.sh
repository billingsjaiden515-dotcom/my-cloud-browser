#!/bin/bash
# Cloud Browser - VPS Restart Script
# Quick restart without full redeployment

cd /root/my-cloud-browser

echo "=== Restarting Cloud Browser ==="

# Kill existing processes
echo "Stopping existing processes..."
pkill -f "node.*main" 2>/dev/null || true
pkill -f "chromium" 2>/dev/null || true
pkill Xvfb 2>/dev/null || true
sleep 2

# Remove stale X lock file (important!)
rm -f /tmp/.X99-lock

# Pull latest changes
echo "Updating code..."
git pull

# Rebuild
echo "Rebuilding..."
npm run build
npx tsc -p tsconfig.server.json

# Start Xvfb with larger display for headful Chromium
echo "Starting Xvfb..."
Xvfb :99 -screen 0 1920x1080x24 &
sleep 1

# Verify Xvfb
if ! xdpyinfo -display :99 >/dev/null 2>&1; then
  echo "ERROR: Xvfb failed to start!"
  echo "Try: rm -f /tmp/.X99-lock && Xvfb :99 -screen 0 1920x1080x24 &"
  exit 1
fi

# Configure PulseAudio with a virtual null sink so headful Chromium has an
# output device, then capture that sink's monitor with FFmpeg.
# Idempotent on purpose: re-loading module-null-sink on every restart leaks
# sinks and leaves Chromium playing into a sink nobody is monitoring.
echo "Configuring PulseAudio virtual sink..."
if ! pgrep -x pulseaudio >/dev/null 2>&1; then
  pulseaudio --start --exit-idle-time=-1 --log-target=stderr >/tmp/pulseaudio.log 2>&1 || true
  sleep 1
fi
if command -v pactl >/dev/null 2>&1; then
  # Sink must run at 48 kHz: Opus/WebRTC use a 48 kHz clock, so a native
  # 48 kHz sink avoids a resample stage (CPU headroom on a 2-vCore VPS) and
  # removes one source of timeline drift. A sink left over from an older run
  # at 44.1 kHz is recreated. This runs before the server starts, so no audio
  # is lost, and it also cleans up sinks leaked by previous unconditional
  # load-module calls.
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


# Start server
echo "Starting server..."
export DISPLAY=:99
export PORT=3001
nohup node dist-server/server/main.js > server.log 2>&1 &
sleep 3

# Verify
if curl -s http://localhost:3001/api/session/status >/dev/null 2>&1; then
  echo ""
  echo "=== Restart Successful! ==="
  echo "Access at: http://$(curl -s ifconfig.me):3001/"
else
  echo "ERROR: Server failed to start. Check server.log:"
  tail -20 server.log
fi
