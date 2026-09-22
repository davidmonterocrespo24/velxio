#!/usr/bin/env bash
# Rebuild the RP2040 repro chips with the backend's chip compile flags
# (backend/app/services/chip_compile.py). WASI_SDK defaults to ~/wasi-sdk.
set -euo pipefail
cd "$(dirname "$0")"
SDK="${WASI_SDK:-$HOME/wasi-sdk}"
INC="$(cd ../../../../../../backend/sdk && pwd)"
for c in spi-id i2c-beef uart-pong; do
  "$SDK/bin/clang" --target=wasm32-unknown-wasip1 -O2 -nostartfiles \
    -Wl,--import-memory -Wl,--export-table -Wl,--no-entry \
    -Wl,--export=chip_setup -Wl,--allow-undefined \
    -I "$INC" "$c.c" -o "$c.wasm"
done
