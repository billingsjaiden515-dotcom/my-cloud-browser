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

# Create a null sink so Chromium has an output device
pactl load-module module-null-sink sink_name=cloud_sink \
  sink_properties=device.description=CloudBrowserSink 2>/dev/null || \
  echo "[start] Could not create null sink (PulseAudio may be unavailable)"

# Start the application
exec node dist-server/server/main.js