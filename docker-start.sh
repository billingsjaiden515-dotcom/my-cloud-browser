#!/bin/sh
# Start PulseAudio so Chromium has an audio output and FFmpeg can capture it.
# Creates a null sink so audio works in a headless container without hardware.

# Start PulseAudio daemon (system-wide so all processes share it)
pulseaudio --daemonize=yes --system=false --exit-idle-time=-1 \
  --log-target=stderr 2>/tmp/pulseaudio.log || {
  echo "[start] PulseAudio failed to start, audio will be unavailable"
  cat /tmp/pulseaudio.log 2>/dev/null
}

# Give PulseAudio a moment to start
sleep 1

# Create a null sink so Chromium has an output device (idempotent - only once,
# otherwise repeated starts leak sinks and orphan Chromium's audio output)
# Sink runs at 48 kHz to match the Opus/WebRTC clock (avoids a resample stage).
# A leftover 44.1 kHz sink is recreated before the app starts, so no audio is
# lost; leaked null sinks from older runs are cleaned up too.
if pactl list sinks 2>/dev/null | grep -A 15 'Name: cloud_sink$' | grep -q '48000Hz'; then
  echo "[start] Reusing existing 48 kHz cloud_sink"
else
  for mod in $(pactl list short modules 2>/dev/null | awk '$2 == "module-null-sink" { print $1 }'); do
    pactl unload-module "$mod" 2>/dev/null || true
  done
  pactl load-module module-null-sink sink_name=cloud_sink rate=48000 channels=2 \
    sink_properties=device.description=CloudBrowserSink 2>/dev/null || \
    echo "[start] Could not create null sink (PulseAudio may be unavailable)"
fi
pactl set-default-sink cloud_sink 2>/dev/null || true
pactl set-default-source cloud_sink.monitor 2>/dev/null || true
export PULSE_CAPTURE_SOURCE=cloud_sink.monitor

# Start the application
exec node dist-server/server/main.js