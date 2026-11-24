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

# ── Window manager: OpenBox ───────────────────────────────────────────────
# OpenBox is launched to manage window placement and provide a titlebar.
# Chromium is started with a fixed geometry; the window manager ensures
# proper placement and enables window-level input (clicks, etc.).
# and no WM means no titlebar, no compositing, no double-buffering CPU cost.
# Input is handled entirely via CDP (puppeteer) — see Chromium launch args.
# If xdotool was previously used for clicks, it is no longer needed.

# ── Xvfb: fixed maximum canvas, never changed ─────────────────────────────
# Xvfb is started once at 1920x1080x24. The capture region is the full
# display and never resized. Chromium window size is set independently via
# --window-size below; the two are unrelated.
if ! pgrep -f "Xvfb.*:99" >/dev/null 2>&1; then
  echo "  starting Xvfb..."
  Xvfb :99 -screen 0 1920x1080x24 &
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

# Start OpenBox window manager (needed for window management, titlebars,
# click handling, and to prevent the "black screen" issue where Chromium
# without a WM can fail to render properly in headful mode under Xvfb)
openbox &

DISPLAY=:99 node dist-server/server/main.js &
