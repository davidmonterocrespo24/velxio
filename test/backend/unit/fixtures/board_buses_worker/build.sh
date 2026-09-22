#!/usr/bin/env bash
# Rebuild the chip WASM fixtures of test_board_buses_repro_worker.py with the
# same clang flags as the production chip compiler
# (backend/app/services/chip_compile.py).
#
#   WASI_SDK=/path/to/wasi-sdk ./build.sh      (default: ~/wasi-sdk, /opt/wasi-sdk)
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
sdk_inc="$(cd "$here/../../../../../backend/sdk" && pwd)"
clang=""
for c in "${WASI_SDK:-}" "$HOME/wasi-sdk" /opt/wasi-sdk; do
  if [ -n "$c" ] && [ -x "$c/bin/clang" ]; then clang="$c/bin/clang"; break; fi
done
[ -n "$clang" ] || { echo "wasi-sdk not found (set WASI_SDK)" >&2; exit 1; }

for name in spi-probe i2c-probe; do
  "$clang" --target=wasm32-unknown-wasip1 -O2 -nostartfiles \
    -Wl,--import-memory -Wl,--export-table -Wl,--no-entry \
    -Wl,--export=chip_setup -Wl,--allow-undefined \
    -I "$sdk_inc" "$here/$name.c" -o "$here/$name.wasm"
done
echo "built: spi-probe.wasm i2c-probe.wasm"
