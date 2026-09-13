#!/bin/bash
# Cloud Browser - VPS Deployment Script
# For Contabo/Netcup/any Debian VPS
# Run as root: bash scripts/vps-deploy.sh

set -e

echo "=== Cloud Browser VPS Deploy ==="

# Step 1: Install dependencies
echo "[1/6] Installing dependencies..."
apt update && apt install -y \
  git curl \
  chromium ffmpeg xdotool \
  libnss3 libatk-bridge2.0-0 libdrm2 libxkbcommon0 \
  libxcomposite1 libxdamage1 libxrandr2 libgbm1 \
  libpango-1.0-0 libcairo2 libasound2 libatk1.0-0 \
  libxshmfence1 libgtk-3-0 xvfb

# Step 2: Install Node.js 22
echo "[2/6] Installing Node.js 22..."
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs

# Step 3: Clone or update repo
echo "[3/6] Setting up repository..."
if [ -d "/root/my-cloud-browser" ]; then
  cd /root/my-cloud-browser
  git reset --hard origin/main
  git pull
else
  cd /root
  git clone https://github.com/billingsjaiden515-dotcom/my-cloud-browser.git
  cd my-cloud-browser
fi

# Step 4: Install npm dependencies and build
echo "[4/6] Building application..."
npm install
npm run build
npx tsc -p tsconfig.server.json

# Step 5: Setup firewall
echo "[5/6] Configuring firewall..."
iptables -A INPUT -p tcp --dport 3001 -j ACCEPT 2>/dev/null || true
iptables -A INPUT -p udp --dport 1024:65535 -j ACCEPT 2>/dev/null || true

# Step 6: Start Xvfb and server
echo "[6/6] Starting services..."
# Kill any existing processes
pkill -f "node.*main" 2>/dev/null || true
pkill -f "chromium" 2>/dev/null || true
pkill Xvfb 2>/dev/null || true
sleep 2

# Remove stale lock file
rm -f /tmp/.X99-lock

# Start Xvfb with larger display to fit headful Chromium window with decorations
Xvfb :99 -screen 0 1920x1080x24 &
sleep 1

# Verify Xvfb started
if ! xdpyinfo -display :99 >/dev/null 2>&1; then
  echo "ERROR: Xvfb failed to start!"
  exit 1
fi
echo "Xvfb started on :99"

# Start the server
export DISPLAY=:99
export PORT=3001
nohup node dist-server/server/main.js > server.log 2>&1 &
sleep 3

# Verify server started
if curl -s http://localhost:3001/api/session/status >/dev/null 2>&1; then
  echo ""
  echo "=== Deployment Successful! ==="
  echo "Access the app at: http://$(curl -s ifconfig.me):3001/"
  echo ""
  echo "To restart later, run: bash scripts/vps-restart.sh"
  echo "To view logs, run: tail -f server.log"
else
  echo "ERROR: Server failed to start. Check server.log"
  tail -20 server.log
fi
