#!/bin/bash
set -e

# Ensure arduino-cli config and board manager URLs are set up
if [ ! -f /root/.arduino15/arduino-cli.yaml ]; then
    echo "📦 Initializing arduino-cli config..."
    arduino-cli config init 2>/dev/null || true
    arduino-cli config add board_manager.additional_urls \
        https://github.com/earlephilhower/arduino-pico/releases/download/global/package_rp2040_index.json 2>/dev/null || true
    arduino-cli config add board_manager.additional_urls \
        https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json 2>/dev/null || true
fi

# Install missing cores.
# ESP32 core MUST be 2.0.17 (IDF 4.4.x) — newer 3.x is incompatible with QEMU ROM bins.
arduino-cli core update-index 2>/dev/null || true
arduino-cli core install arduino:avr 2>/dev/null || true
arduino-cli core install rp2040:rp2040 2>/dev/null || true

# ESP32 compilation now uses ESP-IDF instead of arduino-cli.
# arduino-cli ESP32 core is no longer needed for QEMU-compatible builds.
# If ESP-IDF is not available, fall back to arduino-cli ESP32 core.
if [ -f /opt/esp-idf/export.sh ]; then
    echo "🔧 Sourcing ESP-IDF environment..."
    . /opt/esp-idf/export.sh || true
    echo "✅ ESP-IDF $(cat /opt/esp-idf/version.txt 2>/dev/null || echo 'unknown') ready"
else
    echo "⚠️  ESP-IDF not found — falling back to arduino-cli for ESP32"
    ESP32_VER=$(arduino-cli core list 2>/dev/null | grep esp32:esp32 | awk '{print $2}')
    if [ -z "$ESP32_VER" ]; then
        echo "📦 Installing ESP32 core 2.0.17..."
        arduino-cli core install esp32:esp32@2.0.17
    elif [[ "$ESP32_VER" != 2.0.17 ]]; then
        echo "⚠️  ESP32 core is $ESP32_VER, need 2.0.17 — reinstalling..."
        arduino-cli core install esp32:esp32@2.0.17
    fi
fi

# Start FastAPI backend in the background on port 8001
echo "🚀 Starting Velxio Backend..."
uvicorn app.main:app --host 127.0.0.1 --port 8001 &
UVICORN_PID=$!

# Wait for backend to be healthy before starting nginx
sleep 2

# Start Nginx in the background (not exec — we need to monitor both)
echo "🌐 Starting Nginx Web Server on port 80..."
nginx -g "daemon off;" &
NGINX_PID=$!

# Exit as soon as either process dies so Docker can restart the container.
# wait -n requires bash 4.3+ (standard on Debian Bullseye / Ubuntu 20.04+).
wait -n $UVICORN_PID $NGINX_PID
EXIT_CODE=$?

echo "⚠️  A process exited (code $EXIT_CODE) — shutting down container"
kill $UVICORN_PID $NGINX_PID 2>/dev/null || true
wait $UVICORN_PID $NGINX_PID 2>/dev/null || true
exit $EXIT_CODE
