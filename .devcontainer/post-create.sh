#!/bin/bash
set -e

cd /workspaces/velxio

echo "==> Fixing ownership for mounted volumes..."
# Fix ownership of directories that are mounted as volumes
sudo chown -R vscode:vscode /workspaces/velxio/frontend/node_modules 2>/dev/null || true
sudo chown -R vscode:vscode /workspaces/velxio/wokwi-libs/avr8js/node_modules 2>/dev/null || true
sudo chown -R vscode:vscode /workspaces/velxio/wokwi-libs/rp2040js/node_modules 2>/dev/null || true
sudo chown -R vscode:vscode /workspaces/velxio/wokwi-libs/wokwi-elements/node_modules 2>/dev/null || true
sudo chown -R vscode:vscode /home/vscode/.arduino15 2>/dev/null || true

echo "==> Installing arduino-cli..."
if ! command -v arduino-cli &> /dev/null; then
    curl -fsSL https://raw.githubusercontent.com/arduino/arduino-cli/master/install.sh | sudo BINDIR=/usr/local/bin sh
fi

echo "==> Installing Arduino cores (this may take a few minutes)..."
sudo arduino-cli core update-index
if ! sudo arduino-cli core list | grep -q "arduino:avr"; then
    sudo arduino-cli core install arduino:avr
fi

# Add RP2040 board manager (guard against duplicates)
if ! sudo arduino-cli config get board_manager.additional_urls | grep -q "rp2040"; then
    sudo arduino-cli config add board_manager.additional_urls https://github.com/earlephilhower/arduino-pico/releases/download/global/package_rp2040_index.json
fi
if ! sudo arduino-cli core list | grep -q "rp2040:rp2040"; then
    sudo arduino-cli core install rp2040:rp2040
fi

echo "==> Setting up Python virtual environment (base layer)..."
(cd /workspaces/velxio/backend
python3 -m venv venv
./venv/bin/pip install wheel setuptools
./venv/bin/pip install -r requirements.txt) &

echo "==> Installing frontend dependencies..."
(cd /workspaces/velxio/frontend
HUSKY=0 npm install) &

echo "==> Building wokwi-libs..."
# Local wokwi-libs are cloned from GitHub instead of using npm packages.
# This allows us to modify the emulators and components for Velxio-specific behavior.
# Build outputs go to dist/ directories and are resolved via Vite aliases.
(cd /workspaces/velxio/wokwi-libs/avr8js
HUSKY=0 npm install
npm run build) &

(cd /workspaces/velxio/wokwi-libs/rp2040js
HUSKY=0 npm install
npm run build) &

(cd /workspaces/velxio/wokwi-libs/wokwi-elements
HUSKY=0 npm install
npm run build) &

wait  # Wait for all background jobs to complete

echo "==> Dev environment ready!"
echo ""
echo "To start development:"
echo "  Backend:  cd backend && source venv/bin/activate && uvicorn app.main:app --reload --port 8001"
echo "  Frontend: cd frontend && npm run dev"
