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
  printf 'root soft nofile 65536
root hard nofile 65536
' >> /etc/security/limits.conf
fi

echo "=== Restarting Cloud Browser ==="

# ── ICE / TURN configuration ─────────────────────────────────────────────
# WEBRTC_ICE_SERVERS carries TURN credentials, so it must NOT live in this
# script or anywhere tracked by git. Read it from an untracked file instead,
# created once on the VPS:
#
#   /root/my-cloud-browser/.env.ice
#
# Format: shell variable assignments. WEBRTC_ICE_SERVERS is a JSON array; wrap
# it in single quotes so the shell does not mangle the double quotes:
#
#   WEBRTC_ICE_SERVERS='[
#     {"urls":"stun:stun.cloudflare.com:3478"},
#     {"urls":"turns:turn.cloudflare.com:443?transport=tcp","username":"...","credential":"..."},
#     {"urls":"turn:turn.cloudflare.com:3478?transport=tcp","username":"...","credential":"..."},
#     {"urls":"turn:turn.cloudflare.com:3478?transport=udp","username":"...","credential":"..."}
#   ]'
#
# ORDER MATTERS. werift uses only the FIRST turn:/turns: entry (the rest are
# parsed and discarded), so the turns:...:443 entry must come first -- TLS on
# 443 is the most likely to be permitted by a restrictive school firewall. See
# getConfiguredIceServers() in server/webrtc-streamer.ts.
#
# `set -a` exports every variable the file assigns; without it the values
# would be set in this shell but not inherited by the node process.
#
# If the file is absent, no ICE servers are configured and the app falls back
# to host candidates only -- the previous behaviour, which is correct on a VPS
# with a public IP.
ICE_ENV_FILE="/root/my-cloud-browser/.env.ice"
if [ -f "$ICE_ENV_FILE" ]; then
  echo "  loading ICE server config from $ICE_ENV_FILE"
  set -a
  # shellcheck disable=SC1090  # path is resolved at runtime, not known to shellcheck
  . "$ICE_ENV_FILE"
  set +a
  # Confirm the value reached this shell and looks like a JSON array, without
  # printing the credentials themselves.
  if [ -n "${WEBRTC_ICE_SERVERS:-}" ]; then
    case "$WEBRTC_ICE_SERVERS" in
      \[*) echo "  WEBRTC_ICE_SERVERS loaded (JSON array, ${#WEBRTC_ICE_SERVERS} bytes)" ;;
      *)  echo "  WARNING: WEBRTC_ICE_SERVERS is set but does not start with '[' -- expected a JSON array" ;;
    esac
    else
      echo "  no ICE config at $ICE_ENV_FILE — using host candidates only"
    fi
else
  echo "  no ICE config at $ICE_ENV_FILE — using host candidates only"
fi

# ── Window manager: NONE ──────────────────────────────────────────────────
# No window manager is launched. Chromium is started with a fixed geometry
# and no WM means no titlebar, no compositing, no double-buffering CPU cost.
# Input is handled entirely via CDP (puppeteer) — see Chromium launch args.
# If xdotool was previously used for clicks, it is no longer needed.

# ── Xvfb: fixed maximum canvas, never changed ─────────────────────────────
# Xvfb is started once at 1920x1200x24. The capture region is the full
# display and never resized. Chromium window size is set independently via
# --window-size below; the two are unrelated.
if ! pgrep -f "Xvfb.*:99" >/dev/null 2>&1; then
  echo "  starting Xvfb..."
  Xvfb :99 -screen 0 1920x1200x24 &
  sleep 1
  # Verify Xvfb started
  if ! pgrep -f "Xvfb.*:99" >/dev/null 2>&1; then
    echo "ERROR: Xvfb failed to start!"
    exit 1
  fi
  echo "  Xvfb started on :99"
else
  echo "  Xvfb already running"
fi

# ── Compositor: deliberately disabled ─────────────────────────────────────
# No window manager = no compositor = no CPU double-buffering. Chromium
# runs full-screen with --kiosk-mode or --window-size and manages its own
# rendering. No xfwm4, no openbox.

# ── Launch Chromium ───────────────────────────────────────────────────────
# Fixed window size and position. No --enable-automation (keeps the
# "controlled by automated test software" bar from appearing).
echo "  launching Chromium..."
# Use the first available browser from the dropdown order.
BROWSER="chromium"
export DISPLAY=:99

# Chromium args:
# --remote-debugging-port=9222  -> CDP over WebSocket for server control
# --window-position=0,0         -> place at top-left (no titlebar/WM needed)
# --window-size=1280,720        -> fixed internal canvas size (16:10 ratio)
# --disable-infobars          -> remove "managed by" banner
# --no-sandbox                -> required for many VPS environments
# --disable-dev-shm-usage     -> avoid OOM in /dev/shm
# --disable-gpu               -> software fallback (helps on some VPS GPUs)
# --no-zygote                 -> simpler launch path
# --single-process            -> simpler launch path (no child processes)
# --aggressive-dom-flushing   -> keep memory low
# --disable-animations        -> slight CPU savings
# --disable-threaded-scrolling -> slightly more CPU but simpler
# --disable-compositing-mode-animations -> slight CPU savings
# --disable-background-timer-throttling -> keep CPU awake if needed
# --disable-renderer-backgrounding -> keep renderer alive
# --disable-features=Translate -> simple i18n
# --memory-pressure-off -> keep memory allocated

ExecStartCmd=(
  "$BROWSER"
  "--remote-debugging-port=9222"
  "--window-position=0,0"
  "--window-size=1280,720"
  "--disable-infobars"
  "--no-sandbox"
  "--disable-dev-shm-usage"
  "--disable-gpu"
  "--no-zygote"
  "--single-process"
  "--aggressive-dom-flushing"
  "--disable-animations"
  "--disable-threaded-scrolling"
  "--disable-compositing-mode-animations"
  "--disable-background-timer-throttling"
  "--disable-renderer-backgrounding"
  "--disable-features=Translate"
  "--memory-pressure-off"
)

# shellcheck disable=SC2086  # intentional quoting of array
"$ExecStartCmd[@]" &>/tmp/chromium-launch.log &

# Give Chromium time to start
sleep 5

# Quick health check: is the debug port listening?
if curl -s http://localhost:9222/json/version >/dev/null 2>&1; then
  echo "  Chromium CDP port open on :9222"
else
  echo "  WARNING: Chromium CDP port not responding after 5s"
  # Don't exit — Chromium may still be functional
fi

echo "  Chromium launched with args: $BROWSER --remote-debugging-port=9222 --window-position=0,0 --window-size=1280,720"

# ── PulseAudio: capture-only sink ─────────────────────────────────────────
# Set up a null sink named 'cloud_sink' for PulseAudio capture. This is
# optional and idempotent; if it already exists the `pactl` commands are
# no-ops suppressed by `|| true`.
echo "  setting up PulseAudio capture sink..."
pactl load-module module-null-sink sink_name=cloud_sink rate=48000 channels=2 >/dev/null 2>&1 || true
pactl set-default-sink cloud_sink >/dev/null 2>&1 || true
pactl set-default-source cloud_sink.monitor >/dev/null 2>&1 || true
export PULSE_CAPTURE_SOURCE=cloud_sink.monitor

# ── Record the new server's process group ─────────────────────────────────
# So the NEXT run can kill it in one shot instead of chasing individual PIDs.
NODE_PID=$(pgrep -f "node.*dist-server/server/main.js" 2>/dev/null | head -1 || true)
if [ -n "$NODE_PID" ]; then
  CUR_PGID=$(ps -o pgid= -p "$NODE_PID" 2>/dev/null | tr -d ' ')
  if [ -n "$CUR_PGID" ]; then
    echo "$CUR_PGID" > /tmp/cloud-browser-server.pgid
    echo "  recorded process group $CUR_PGID for pid $NODE_PID"
  fi
fi

# ── Verify ────────────────────────────────────────────────────────────────
echo ""
if curl -s http://localhost:3001/api/session/status >/dev/null 2>&1; then
  echo ""
  echo "=== Restart Successful! ==="
  echo "Access at: http://$(curl -s ifconfig.me):3001/"
else
  echo "ERROR: Server failed to start. Check server.log:"
  tail -20 server.log
fi
