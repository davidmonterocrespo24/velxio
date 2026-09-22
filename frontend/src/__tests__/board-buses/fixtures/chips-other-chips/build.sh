#!/usr/bin/env bash
# Rebuild the chips-other fixture chips (C -> WASM) with wasi-sdk.
# Same flags as the backend chip compiler (backend/app/services/chip_compile.py);
# the header is the OSS SDK one (backend/sdk/velxio-chip.h).
#   WASI_SDK=/path/to/wasi-sdk ./build.sh
# pulse-counter.c is the gallery example (only the comment punctuation differs)
# (frontend/src/components/customChips/examples/pulse-counter.c).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
sdk="${WASI_SDK:-$HOME/wasi-sdk}"
inc="$here/../../../../../../backend/sdk"
for src in "$here"/*.c; do
  out="${src%.c}.wasm"
  "$sdk/bin/clang" --target=wasm32-unknown-wasip1 -O2 -nostartfiles \
    -Wl,--import-memory -Wl,--export-table -Wl,--no-entry \
    -Wl,--export=chip_setup -Wl,--allow-undefined \
    -I"$inc" "$src" -o "$out"
  echo "built $(basename "$out") ($(wc -c < "$out") bytes)"
done
