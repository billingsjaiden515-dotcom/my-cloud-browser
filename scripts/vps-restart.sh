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

# ── Tor Browser ─────────────────────────────────────────────────────────
# Not a selectable browser yet: this only provisions the binary so the launch
# path can be tested. Wiring it into the switcher is deliberately a separate
# change.
#
# Version pinned deliberately. A version-less URL does not exist for Tor
# Browser, and the 14.5 path in the original spec 404s -- current releases are
# 15.0.24 (stable) and 16.0.x (alpha). Verified live:
#   https://www.torproject.org/dist/torbrowser/15.0.24/
#     tor-browser-linux-x86_64-15.0.24.tar.xz  -> HTTP 200, 137930492 bytes
#     tor-browser-linux-x86_64-15.0.24.tar.xz.asc also available
# x86_64 is the ONLY linux build published for 15.0.24, so a non-x86_64 host
# cannot get Tor Browser at all and is skipped rather than left half-installed.
if [ ! -d "/root/tor-browser" ]; then
  TOR_ARCH=$(uname -m)
  if [ "$TOR_ARCH" = "x86_64" ]; then
    echo "  installing Tor Browser 15.0.24 (x86_64)..."
    TOR_TARBALL=/tmp/tor-browser.tar.xz
    if curl -fsSLo "$TOR_TARBALL" \
      "https://www.torproject.org/dist/torbrowser/15.0.24/tor-browser-linux-x86_64-15.0.24.tar.xz"; then
      # Guard on a non-empty download: without this a failed curl would leave
      # an empty/partial file and `tar -xf` would still create the directory,
      # making a broken install look installed (the `[ ! -d ]` guard above
      # would then skip every future attempt).
      if [ -s "$TOR_TARBALL" ]; then
        mkdir -p /root/tor-browser
        if tar -xf "$TOR_TARBALL" -C /root/tor-browser --strip-components=1; then
          echo "  Tor Browser extracted to /root/tor-browser"
        else
          echo "  WARNING: tar extraction failed for Tor Browser"
          rm -rf /root/tor-browser
        fi
      else
        echo "  WARNING: Tor Browser download was empty — skipping"
      fi
      rm -f "$TOR_TARBALL"
    else
      echo "  WARNING: could not download Tor Browser — skipping"
    fi
  else
    echo "  Tor Browser install skipped: unsupported arch $TOR_ARCH (no x86_64 build published)"
  fi
fi

# Report whether Tor Browser is present, and its version.
#
# The version is read from application.ini rather than by running
# `start-tor-browser --version`. That flag does NOT exist: the launcher's
# argument loop has no `--version` case, so it falls through to `*)  # No more
# options` -> break -> and the script proceeds to BOOTSTRAP TOR. A "version
# check" would therefore start a Tor connection (and block) on every restart.
# application.ini reports the same underlying build safely.
if [ -f /root/tor-browser/Browser/application.ini ]; then
  TOR_VER=$(grep -m1 '^Version=' /root/tor-browser/Browser/application.ini 2>/dev/null | cut -d= -f2)
  TOR_NAME=$(grep -m1 '^Name=' /root/tor-browser/Browser/application.ini 2>/dev/null | cut -d= -f2)
  echo "  Tor Browser installed: ${TOR_NAME:-Firefox} ${TOR_VER:-unknown} (package 15.0.24)"
else
  echo "  Tor Browser NOT installed (no application.ini under /root/tor-browser/Browser)"
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
# openbox is started the same way Xvfb is -- detached from this script -- so it
# must be swept with it. Two openbox instances both claiming :99 leaves focus
# routing ambiguous, and a stale one survives every restart as an orphan.
pkill -9 -x openbox 2>/dev/null || true
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
# not. openbox is the smallest thing that establishes focus and routes key
# events, and it draws nothing, so it does not appear in the captured frame.
if ! command -v openbox >/dev/null 2>&1; then
  echo "Installing openbox..."
  apt-get update -qq >/dev/null 2>&1 || true
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq openbox >/tmp/openbox-install.log 2>&1 || true
fi

if command -v openbox >/dev/null 2>&1; then
  echo "Starting openbox..."
  DISPLAY=:99 openbox >/tmp/openbox.log 2>&1 &
  sleep 1
  # Verify rather than assume, and use `pgrep -f` rather than `pgrep -x`:
  # -x matches the process NAME, which Linux truncates to 15 characters, so it
  # can report a running WM as absent. -f matches the full command line and is
  # what actually proves the WM is alive on this display.
  if pgrep -f "openbox" >/dev/null 2>&1; then
    echo "  openbox running (pid $(pgrep -f 'openbox' | tr '\n' ' '))"
  else
    echo "WARNING: openbox failed to start - keyboard focus may not work"
    echo "  /tmp/openbox.log:"; tail -5 /tmp/openbox.log 2>/dev/null
  fi
else
  echo "WARNING: openbox not installed - keyboard focus will not work"
  echo "  install log:"; tail -5 /tmp/openbox-install.log 2>/dev/null
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
