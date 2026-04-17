#!/usr/bin/env bash
# Build both libqemu-xtensa.dll and libqemu-riscv32.dll with slirp (WiFi)
# and copy them to backend/app/services/.
#
# Run from MSYS2 MINGW64 shell:
#   cd /e/Hardware/wokwi_clon
#   bash build_qemu_all.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"
QEMU_DIR="${REPO_ROOT}/wokwi-libs/qemu-lcgamboa"
BACKEND_SERVICES="${REPO_ROOT}/backend/app/services"

echo "=== Building QEMU ESP32 DLLs (Xtensa + RISC-V) with slirp ==="
echo "  QEMU source: ${QEMU_DIR}"
echo "  Output dir:  ${BACKEND_SERVICES}"
echo ""

cd "${QEMU_DIR}"

# Step 1: Build both targets
echo "--- Running build script ---"
bash build_libqemu-esp32-win.sh

# Step 2: Copy DLLs to backend
echo ""
echo "=== Copying DLLs to backend ==="

if [ -f build/libqemu-xtensa.dll ]; then
    cp build/libqemu-xtensa.dll "${BACKEND_SERVICES}/"
    echo "  Copied libqemu-xtensa.dll ($(du -h build/libqemu-xtensa.dll | cut -f1))"
else
    echo "  WARNING: libqemu-xtensa.dll not found!"
fi

if [ -f build/libqemu-riscv32.dll ]; then
    cp build/libqemu-riscv32.dll "${BACKEND_SERVICES}/"
    echo "  Copied libqemu-riscv32.dll ($(du -h build/libqemu-riscv32.dll | cut -f1))"
else
    echo "  WARNING: libqemu-riscv32.dll not found!"
fi

# Step 3: Verify slirp in both DLLs
echo ""
echo "=== Verifying slirp support ==="

for dll in libqemu-xtensa.dll libqemu-riscv32.dll; do
    path="${BACKEND_SERVICES}/${dll}"
    if [ -f "$path" ]; then
        if objdump -p "$path" 2>/dev/null | grep -q "libslirp"; then
            echo "  ${dll}: slirp OK"
        else
            echo "  ${dll}: WARNING - slirp NOT found!"
        fi
    fi
done

# Step 4: Verify picsimlab exports
echo ""
echo "=== Verifying picsimlab exports ==="

for dll in libqemu-xtensa.dll libqemu-riscv32.dll; do
    path="${BACKEND_SERVICES}/${dll}"
    if [ -f "$path" ]; then
        count=$(objdump -p "$path" 2>/dev/null | grep -c "picsimlab" || true)
        echo "  ${dll}: ${count} picsimlab exports"
    fi
done

echo ""
echo "=== Done ==="
