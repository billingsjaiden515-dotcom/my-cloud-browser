#!/bin/bash
# ============================================================
# Cloud Browser WebRTC - Deployment Script for Netcup VPS 500 G12
# Target: Ubuntu 22.04/24.04 LTS
# ============================================================

set -e

echo "============================================"
echo " Cloud Browser WebRTC - VPS Deployment"
echo "============================================"
echo ""

# ------------------------------------------------------------
# 1. System Update
# ------------------------------------------------------------
echo "[1/8] Updating system packages..."
sudo apt update && sudo apt upgrade -y

# ------------------------------------------------------------
# 2. Install Node.js 22.x LTS (required by puppeteer-core)
# ------------------------------------------------------------
echo "[2/8] Installing Node.js 22.x..."
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
echo "Node.js installed: $(node --version)"

# ------------------------------------------------------------
# 3. Install Chromium Browser
# ------------------------------------------------------------
echo "[3/8] Installing Chromium..."
if apt-cache show chromium &>/dev/null; then
    sudo apt install -y chromium
elif apt-cache show chromium-browser &>/dev/null; then
    sudo apt install -y chromium-browser
else
    echo "ERROR: Neither chromium nor chromium-browser package found"
    exit 1
fi

# ------------------------------------------------------------
# 4. Install FFmpeg
# ------------------------------------------------------------
echo "[4/8] Installing FFmpeg..."
sudo apt install -y ffmpeg

# ------------------------------------------------------------
# 5. Install Chromium Runtime Dependencies
# ------------------------------------------------------------
echo "[5/8] Installing Chromium runtime libraries..."
sudo apt install -y \
    libnss3 \
    libatk-bridge2.0-0 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libgbm1 \
    libpango-1.0-0 \
    libcairo2 \
    libasound2 \
    libatk1.0-0 \
    libxshmfence1 \
    libgtk-3-0 \
    libx11-xcb1

# ------------------------------------------------------------
# 6. Install PulseAudio (for audio capture)
# ------------------------------------------------------------
echo "[6/8] Installing PulseAudio..."
sudo apt install -y pulseaudio pulseaudio-utils

# ------------------------------------------------------------
# 7. Clone Repository
# ------------------------------------------------------------
echo "[7/8] Cloning repository..."
cd ~
if [ -d "my-cloud-browser" ]; then
    echo "Directory exists, pulling latest..."
    cd my-cloud-browser
    git pull origin main
else
    git clone https://github.com/billingsjaiden515-dotcom/my-cloud-browser.git
    cd my-cloud-browser
fi

# Install dependencies
echo "Installing npm dependencies..."
npm install

# Build frontend
echo "Building frontend..."
npm run build

# ------------------------------------------------------------
# 8. Configure Firewall
# ------------------------------------------------------------
echo "[8/8] Configuring firewall..."
sudo apt install -y ufw
sudo ufw allow 22/tcp      # SSH
sudo ufw allow 80/tcp      # HTTP (optional)
sudo ufw allow 443/tcp     # HTTPS (optional)
sudo ufw allow 3001/tcp    # Cloud Browser backend + WebSocket
sudo ufw allow 1024:65535/udp  # WebRTC media (ICE)

# Enable firewall if not already enabled
sudo ufw --force enable

echo ""
echo "============================================"
echo " Deployment Complete!"
echo "============================================"
echo ""
echo "To start the server:"
echo "  cd ~/my-cloud-browser"
echo "  npm run dev"
echo ""
echo "Then open in your browser:"
echo "  http://$(curl -s ifconfig.me):3001"
echo ""
echo "To run in background (recommended):"
echo "  npm install -g pm2"
echo "  pm2 start npm --name cloud-browser -- run dev"
echo "  pm2 save"
echo "  pm2 startup"
echo ""
