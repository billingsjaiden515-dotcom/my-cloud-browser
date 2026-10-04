#!/bin/bash
# Cloud Browser - VPS Restart Script
# Quick restart without full redeployment

cd /root/my-cloud-browser

# Raise the file-descriptor limit for this shell and every child process.
# Chromium opens 300+ concurrent sockets on modern sites (YouTube, etc.) and
# crashes with ERR_INSUFFICIENT_RESOURCES above the default 1024 limit.
# The fallback chain means: try 65536, if that fails try the hard limit, if that
# fails just continue with whatever the shell has. Never abort the restart
# because of this.
ulimit -n 65536 2>/dev/null || ulimit -n "$(ulimit -Hn)" 2>/dev/null || true
echo "  ulimit -n = $(ulimit -n)"

# Ensure the fd limit is set for future login sessions (persists across reboots).
# Idempotent: only append if the entry isn't already there.
if ! grep -q "^root soft nofile 65536" /etc/security/limits.conf 2>/dev/null; then
  echo "  installing limits.conf entry for nofile=65536"
  printf 'root soft nofile 65536\nroot hard nofile 65536\n' >> /etc/security/limits.conf
fi

echo "=== Restarting Cloud Browser ==="

# ── Optional browsers ─────────────────────────────────────────────────────
# Both are idempotent: the `command -v` guard means a restart never re-adds the
# apt repo or re-downloads. Each block ends in `|| true` so a failed install
# degrades to "that option shows as unavailable in the dropdown" rather than
# aborting the restart and taking the whole server down with it.
if ! command -v firefox-esr >/dev/null 2>&1 && ! command -v firefox >/dev/null 2>&1; then
  echo "  installing firefox-esr..."
  DEBIAN_FRONTEND=noninteractive apt-get update -qq \
    && apt-get install -y firefox-esr >/dev/null 2>&1 || true
fi

# Brave is NOT in Debian/Ubuntu's repos -- it ships its own apt repository, so
# the GPG key and the sources.list.d entry have to be added before installing.
# Both writes are inside the same guard, so re-running is a no-op.
if ! command -v brave-browser >/dev/null 2>&1; then
  echo "  installing brave-browser..."
  curl -fsSLo /usr/share/keyrings/brave-browser-archive-keyring.gpg \
    https://brave-browser-apt-release.s3.brave.com/brave-browser-archive-keyring.gpg || true
  echo "deb [signed-by=/usr/share/keyrings/brave-browser-archive-keyring.gpg] https://brave-browser-apt-release.s3.brave.com/ stable main" \
    > /etc/apt/sources.list.d/brave-browser-release.list
  DEBIAN_FRONTEND=noninteractive apt-get update -qq \
    && apt-get install -y brave-browser >/dev/null 2>&1 || true
fi

# Vivaldi publishes NO apt repository -- only a .deb per release. The URL is
# version-less and always serves the current stable build (verified: HTTP 200,
# no redirect), so it is re-fetched on every restart unless VIVALDI_SKIP is
# set. Set VIVALDI_SKIP=1 to make this a one-shot install that is never
# refreshed; otherwise `command -v` alone would mean Vivaldi NEVER updates,
# because the binary name is always the same.
#
# Left as a plain .deb install: enabling Vivaldi's apt repo would need another
# GPG key, and a stale-but-working install is better than a restart that fails
# on an unreachable third-party repo.
if [ "${VIVALDI_SKIP:-0}" != "1" ] && ! command -v vivaldi-stable >/dev/null 2>&1; then
  echo "  installing vivaldi-stable..."
  VIVALDI_DEB=/tmp/vivaldi-stable_amd64.deb
  if curl -fsSLo "$VIVALDI_DEB" "https://downloads.vivaldi.com/stable/vivaldi-stable_amd64.deb"; then
    DEBIAN_FRONTEND=noninteractive apt-get update -qq \
      && apt-get install -y "$VIVALDI_DEB" >/dev/null 2>&1 || true
  else
    echo "  WARNING: could not download vivaldi-stable .deb — skipping"
  fi
  rm -f "$VIVALDI_DEB"
fi

# ── cloudflared (Cloudflare Tunnel client) ──────────────────────────────
# NOT YET USED by any service: this only provisions the binary so tunnel
# access can be set up and tested. Starting a tunnel needs a named tunnel
# token/credentials, which are not in this script.
#
# cloudflared is not in the Debian/Ubuntu repos, so it installs from
# Cloudflare's own GitHub release .deb. Unlike the browsers below, it is NOT
# required for the app to run: TURN itself uses Cloudflare's hosted service
# (stun.cloudflare.com / turn.cloudflare.com) purely via WEBRTC_ICE_SERVERS,
# with no cloudflared process involved. cloudflared is for exposing/tunnelling
# the HTTP port, which is a separate concern.
if ! command -v cloudflared >/dev/null 2>&1; then
  echo "  installing cloudflared..."
  CLOUDFLARED_DEB=/tmp/cloudflared.deb
  # `releases/latest/download/...` always resolves to the newest release and
  # needs no version pinning here (verified: HTTP 200, application/octet-stream).
  if curl -fsSLo "$CLOUDFLARED_DEB" \
    "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb"; then
    # Same guard as the Tor block: a failed curl would leave an empty file and
    # apt would then fail confusingly.
    if [ -s "$CLOUDFLARED_DEB" ]; then
      DEBIAN_FRONTEND=noninteractive apt-get update -qq >/dev/null 2>&1 || true
      DEBIAN_FRONTEND=noninteractive apt-get install -y "$CLOUDFLARED_DEB" >/dev/null 2>&1 || true
    else
      echo "  WARNING: cloudflared download was empty — skipping"
    fi
  else
    echo "  WARNING: could not download cloudflared — skipping"
  fi
  rm -f "$CLOUDFLARED_DEB"
fi

if command -v cloudflared >/dev/null 2>&1; then
  echo "  cloudflared installed: $(cloudflared --version 2>&1 | head -1)"
else
  echo "  cloudflared NOT installed (tunnel access will not be available)"
fi

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
# xfwm4 is started the same way Xvfb is -- detached from this script -- so it
# must be swept with it. Two xfwm4 instances both claiming :99 leaves focus
# routing ambiguous, and a stale one survives every restart as an orphan.
pkill -9 -x xfwm4 2>/dev/null || true
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

# Start a minimal window manager.
#
# Xvfb alone provides a display but NO window manager, and without a WM nothing
# ever receives X11 input focus: the X server has no notion of an active window,
# so `xdotool key`/`type` have no focus target and the keystrokes are discarded.
# Mouse clicks are unaffected, which is why clicking works while typing does
# not. A WM is what establishes focus and routes key events.
#
# We use xfwm4 (XFCE's window manager) with its compositor enabled, rather than
# openbox. openbox has no compositor, and Tor Browser's rendering engine
# (CompositorBridgeChild) crashes without one under Xvfb:
#   CompositorBridgeChild receives IPC close with reason=AbnormalShutdown
# xfwm4's compositor provides the rendering context Firefox-family browsers
# (including Tor Browser) require. This adds ~5-10% CPU cost compared to
# openbox.
if ! command -v xfwm4 >/dev/null 2>&1; then
  echo "Installing xfwm4..."
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq xfwm4 >/tmp/xfwm4-install.log 2>&1 || true
fi

if ! command -v xfwm4 >/dev/null 2>&1; then
  echo "ERROR: xfwm4 failed to install"
else
  echo "Starting xfwm4 (with compositor)..."
  DISPLAY=:99 xfwm4 --compositor=on >/tmp/xfwm4.log 2>&1 &
  sleep 1
  # Verify rather than assume, and use `pgrep -f` rather than `pgrep -x`:
  # -x matches the process NAME, which Linux truncates to 15 characters, so it
  # can report a running WM as absent. -f matches the full command line and is
  # what actually proves the WM is alive on this display.
  if pgrep -f "xfwm4" >/dev/null 2>&1; then
    echo "  xfwm4 running (pid $(pgrep -f 'xfwm4' | tr '\n' ' '))"
  else
    echo "WARNING: xfwm4 failed to start — keyboard focus may not work"
  fi
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
