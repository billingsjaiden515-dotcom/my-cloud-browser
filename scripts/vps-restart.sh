#!/bin/bash
# Cloud Browser - VPS Restart Script
# Quick restart without full redeployment

cd /root/my-cloud-browser

echo "=== Restarting Cloud Browser ==="

# Stop the previous run.
#
# Order matters. Ask node to shut down GRACEFULLY first so the teardown in
# main.ts actually runs and kills Chromium + the three ffmpeg processes itself;
# a bare pkill -9 here would skip that teardown entirely. Then force-kill what
# ignores it, and sweep the child programs explicitly.
#
# ffmpeg MUST be swept explicitly: children are spawned detached (their own
# process groups), so killing node's group does not reach them, and if node was
# OOM-killed they are already re-parented to init. That is the leak that let
# processes accumulate for days until the OOM killer fired.
echo "Stopping existing processes..."
pkill -TERM -f "node.*main" 2>/dev/null || true
for _ in $(seq 1 20); do
  pgrep -f "node.*main" >/dev/null 2>&1 || break
  sleep 0.5
done

# Kill the whole process group of the previous run if we recorded it, so
# anything not covered by the name patterns below is still reached in one shot.
PGID_FILE=/tmp/cloud-browser-server.pgid
if [ -f "$PGID_FILE" ]; then
  PREV_PGID=$(cat "$PGID_FILE" 2>/dev/null || true)
  if [ -n "${PREV_PGID:-}" ] && [ "$PREV_PGID" -gt 1 ] 2>/dev/null; then
    echo "  killing previous process group $PREV_PGID"
    kill -9 -"$PREV_PGID" 2>/dev/null || true
  fi
  rm -f "$PGID_FILE"
fi

pkill -9 -f "node.*main" 2>/dev/null || true
pkill -9 -f "chromium" 2>/dev/null || true
pkill -9 -f "ffmpeg" 2>/dev/null || true
pkill -9 -f "Xvfb" 2>/dev/null || true
sleep 2

# Verify instead of assuming: a surviving process here is a leak, so say so.
LEFTOVER=$(pgrep -af "chromium|ffmpeg|Xvfb" 2>/dev/null || true)
if [ -n "$LEFTOVER" ]; then
  echo "WARNING: still alive after cleanup:"
  echo "$LEFTOVER"
else
  echo "Cleanup verified: no chromium/ffmpeg/Xvfb remaining"
fi

# Remove stale X lock file (important!)
rm -f /tmp/.X99-lock

# Pull latest changes
echo "Updating code..."
git pull

# Install the EXTERNAL reaper and its systemd timer.
#
# Placement is deliberate and matters twice over:
#   * AFTER `git pull`, so the units installed are the current ones.
#   * BEFORE Xvfb starts: at this point the previous server is dead and no
#     display exists yet, so the immediate sweep clears leftovers from earlier
#     runs without touching a display. If it ran after Xvfb started it would
#     find no node process and kill the display we just launched -- while the
#     script still printed "Restart Successful!".
# It must live outside node at all: if the server is OOM-killed, its own
# in-process reaper cannot run and the children it spawned keep burning CPU and
# RAM until the next OOM.
echo "Installing orphan reaper + timer..."
if [ -f scripts/cloud-browser-reaper.sh ]; then
  install -m 0755 scripts/cloud-browser-reaper.sh /usr/local/bin/cloud-browser-reaper.sh
fi
if command -v systemctl >/dev/null 2>&1 && [ -f scripts/cloud-browser-reaper.timer ]; then
  install -m 0644 scripts/cloud-browser-reaper.service /etc/systemd/system/cloud-browser-reaper.service
  install -m 0644 scripts/cloud-browser-reaper.timer /etc/systemd/system/cloud-browser-reaper.timer
  systemctl daemon-reload >/dev/null 2>&1 || true
  systemctl enable --now cloud-browser-reaper.timer >/dev/null 2>&1 || true
  TIMER_LINE=$(systemctl list-timers cloud-browser-reaper.timer --no-legend 2>/dev/null | head -1)
  echo "  timer: ${TIMER_LINE:-ENABLE_FAILED}"
  systemctl start cloud-browser-reaper.service >/dev/null 2>&1 || true
  echo "  initial sweep run (verify: journalctl -u cloud-browser-reaper -n 20)"
elif [ -x /usr/local/bin/cloud-browser-reaper.sh ]; then
  echo "  WARNING: systemctl unavailable — timer NOT installed, running a one-shot sweep"
  /usr/local/bin/cloud-browser-reaper.sh
else
  echo "  WARNING: reaper script missing (scripts/cloud-browser-reaper.sh not found)"
fi

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

# Record the new server's process group so the NEXT run can kill it in one
# shot instead of chasing individual PIDs.
NODE_PID=$(pgrep -f "node.*dist-server/server/main.js" 2>/dev/null | head -1 || true)
if [ -n "$NODE_PID" ]; then
  CUR_PGID=$(ps -o pgid= -p "$NODE_PID" 2>/dev/null | tr -d ' ')
  if [ -n "$CUR_PGID" ]; then
    echo "$CUR_PGID" > /tmp/cloud-browser-server.pgid
    echo "  recorded process group $CUR_PGID for pid $NODE_PID"
  fi
fi

# Verify
if curl -s http://localhost:3001/api/session/status >/dev/null 2>&1; then
  echo ""
  echo "=== Restart Successful! ==="
  echo "Access at: http://$(curl -s ifconfig.me):3001/"
else
  echo "ERROR: Server failed to start. Check server.log:"
  tail -20 server.log
fi
