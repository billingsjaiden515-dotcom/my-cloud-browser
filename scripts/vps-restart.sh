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

# Start Xvfb
echo "Starting Xvfb..."
Xvfb :99 -screen 0 1280x800x24 &
sleep 1

# Verify Xvfb
if ! xdpyinfo -display :99 >/dev/null 2>&1; then
  echo "ERROR: Xvfb failed to start!"
  echo "Try: rm -f /tmp/.X99-lock && Xvfb :99 -screen 0 1280x800x24 &"
  exit 1
fi

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
