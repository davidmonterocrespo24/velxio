#!/usr/bin/env bash
# Rebuild blob-probe.wasm, the one artifact the three vx_blob_* conformance
# suites run (vitest, the OSS worker pytest and the pro Linux-board pytest),
# with the same clang flags as the production chip compiler
# (velxio/backend/app/services/chip_compile.py), then refresh manifest.json.
#
# The tests check manifest.json against blob-probe.c and fail while the wasm is
# stale, so editing the C without running this is caught rather than silently
# testing the old binary.
#
#   WASI_SDK=/path/to/wasi-sdk ./build.sh      (default: ~/wasi-sdk, /opt/wasi-sdk)
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
front="$(cd "$here/../../../../.." && pwd)"
sdk_inc="$front/../backend/sdk"
clang=""
for c in "${WASI_SDK:-}" "$HOME/wasi-sdk" /opt/wasi-sdk; do
  if [ -n "$c" ] && [ -x "$c/bin/clang" ]; then clang="$c/bin/clang"; break; fi
done
[ -n "$clang" ] || { echo "wasi-sdk not found (set WASI_SDK)" >&2; exit 1; }

"$clang" --target=wasm32-unknown-wasip1 -O2 -nostartfiles \
  -Wl,--import-memory -Wl,--export-table -Wl,--no-entry \
  -Wl,--export=chip_setup -Wl,--allow-undefined \
  -I "$sdk_inc" "$here/blob-probe.c" -o "$here/blob-probe.wasm"

node -e '
const { createHash } = require("node:crypto");
const { readFileSync, writeFileSync } = require("node:fs");
const [here] = process.argv.slice(1);
const h = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
writeFileSync(
  `${here}/manifest.json`,
  JSON.stringify({ "blob-probe": { sourceSha256: h(`${here}/blob-probe.c`) } }, null, 2) + "\n",
);
' "$here"
echo "built: blob-probe.wasm"
