#!/bin/bash
set -e

# Get the workspace root (devcontainer sets this as pwd, but we can also derive it from script location)
WORKSPACE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$WORKSPACE_ROOT"

# Get current user dynamically
CURRENT_USER=$(whoami)

echo "==> Fixing ownership for mounted volumes..."
for d in frontend/node_modules wokwi-libs/avr8js/node_modules wokwi-libs/rp2040js/node_modules wokwi-libs/wokwi-elements/node_modules "$HOME/.arduino15"; do
    sudo chown -R "$CURRENT_USER:$CURRENT_USER" "$d" 2>/dev/null || true
done

echo "==> Cloning wokwi-libs (shallow, faster than submodules)..."
# Only clone the 3 libs we actually use (avr8js, rp2040js, wokwi-elements)
# Shallow clone with --depth=1 is much faster than recursive submodule init
for lib in avr8js rp2040js wokwi-elements; do
    if [ ! -d "wokwi-libs/$lib/.git" ]; then
        rm -rf "wokwi-libs/$lib"
        git clone --depth=1 "https://github.com/wokwi/$lib.git" "wokwi-libs/$lib"
    else
        echo "  -> wokwi-libs/$lib already exists, skipping clone"
    fi
done

echo "==> Installing arduino-cli (user-local)..."
if ! command -v arduino-cli &> /dev/null; then
    mkdir -p "$HOME/.local/bin"
    curl -fsSL https://raw.githubusercontent.com/arduino/arduino-cli/master/install.sh | BINDIR="$HOME/.local/bin" sh
    export PATH="$HOME/.local/bin:$PATH"
fi

echo "==> Installing Arduino cores (this may take a few minutes)..."
arduino-cli core update-index
if ! arduino-cli core list | grep -q "arduino:avr"; then
    arduino-cli core install arduino:avr
fi

# Add RP2040 board manager (guard against duplicates)
if ! arduino-cli config get board_manager.additional_urls | grep -q "rp2040"; then
    arduino-cli config add board_manager.additional_urls https://github.com/earlephilhower/arduino-pico/releases/download/global/package_rp2040_index.json
fi
if ! arduino-cli core list | grep -q "rp2040:rp2040"; then
    arduino-cli core install rp2040:rp2040
fi

# Note: ESP32 emulation (QEMU lcgamboa) is NOT installed by this script.
# It requires platform-specific builds (MSYS2 on Windows, 15-30 min compile time)
# and generates 40-60 MB libraries that are excluded from git.
# - Docker images include pre-built QEMU libs automatically
# - Development without ESP32 emulation works fine (AVR/RP2040 only)
# - For full ESP32 support, see: docs/ESP32_EMULATION.md
# - Backend auto-detects and falls back to UART-only mode if libs are missing

echo "==> Setting up Python virtual environment (base layer)..."
(cd backend
python3 -m venv venv
./venv/bin/pip install wheel setuptools
./venv/bin/pip install -r requirements.txt) &
BACKEND_PID=$!

echo "==> Installing frontend dependencies..."
(cd frontend
HUSKY=0 npm install) &
FRONTEND_PID=$!

echo "==> Building wokwi-libs in parallel (avr8js, rp2040js, wokwi-elements)..."
# Local wokwi-libs are cloned from GitHub instead of using npm packages.
# This allows us to modify the emulators and components for Velxio-specific behavior.
# Build outputs go to dist/ directories and are resolved via Vite aliases.
(cd wokwi-libs/avr8js
HUSKY=0 npm install
npm run build) &
AVR_PID=$!

(cd wokwi-libs/rp2040js
HUSKY=0 npm install
npm run build) &
RP2040_PID=$!

(cd wokwi-libs/wokwi-elements
HUSKY=0 npm install
npm run build) &
ELEMENTS_PID=$!

echo "  -> Waiting for all parallel builds to complete..."
wait $BACKEND_PID && echo "  ✓ Backend deps installed"
wait $FRONTEND_PID && echo "  ✓ Frontend deps installed"
wait $AVR_PID && echo "  ✓ avr8js built"
wait $RP2040_PID && echo "  ✓ rp2040js built"
wait $ELEMENTS_PID && echo "  ✓ wokwi-elements built"

echo "==> Dev environment ready!"
echo ""
echo "To start development:"
echo "  Backend:  cd backend && source venv/bin/activate && uvicorn app.main:app --reload --port 8001"
echo "  Frontend: cd frontend && npm run dev"
echo ""
echo "Note: AVR/RP2040 emulation is ready. For ESP32 emulation (QEMU), see docs/ESP32_EMULATION.md"
