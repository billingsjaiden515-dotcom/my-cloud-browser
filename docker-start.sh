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
if pactl list short sinks 2>/dev/null | grep -q "[[:space:]]cloud_sink[[:space:]]"; then
  echo "[start] Reusing existing cloud_sink"
else
  pactl load-module module-null-sink sink_name=cloud_sink \
    sink_properties=device.description=CloudBrowserSink 2>/dev/null || \
    echo "[start] Could not create null sink (PulseAudio may be unavailable)"
fi
pactl set-default-sink cloud_sink 2>/dev/null || true
pactl set-default-source cloud_sink.monitor 2>/dev/null || true
export PULSE_CAPTURE_SOURCE=cloud_sink.monitor

# Start the application
exec node dist-server/server/main.js