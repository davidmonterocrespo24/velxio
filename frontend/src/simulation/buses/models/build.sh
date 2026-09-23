#!/usr/bin/env bash
# Rebuild the portable bus device models, with the same clang flags as the
# production chip compiler (velxio/backend/app/services/chip_compile.py), then
# refresh manifest.json.
#
# These are not fixtures: the .wasm is the artifact every host runs (the tab,
# the QEMU worker, the Linux-board host), so a model is only as current as the
# last run of this script. The suites check manifest.json against the sources
# and fail while a .wasm is stale, which is how editing the C without
# rebuilding is caught instead of silently testing the old binary.
#
# The binary lands in public/bus-chips/, not next to the source: the browser
# fetches it by public path and hands the same bytes to the worker, and the pro
# responders of this phase publish theirs the same way
# (pro/frontend/public/bus-chips/).
#
#   WASI_SDK=/path/to/wasi-sdk ./build.sh      (default: ~/wasi-sdk, /opt/wasi-sdk)
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
front="$(cd "$here/../../../.." && pwd)"
sdk_inc="$front/../backend/sdk"
clang=""
for c in "${WASI_SDK:-}" "$HOME/wasi-sdk" /opt/wasi-sdk; do
  if [ -n "$c" ] && [ -x "$c/bin/clang" ]; then clang="$c/bin/clang"; break; fi
done
[ -n "$clang" ] || { echo "wasi-sdk not found (set WASI_SDK)" >&2; exit 1; }

out="$front/public/bus-chips"
mkdir -p "$out"
for name in microsd; do
  "$clang" --target=wasm32-unknown-wasip1 -O2 -nostartfiles \
    -Wl,--import-memory -Wl,--export-table -Wl,--no-entry \
    -Wl,--export=chip_setup -Wl,--allow-undefined \
    -I "$sdk_inc" "$here/$name.c" -o "$out/$name.wasm"
done

node -e '
const { createHash } = require("node:crypto");
const { readFileSync, writeFileSync } = require("node:fs");
const [here, ...names] = process.argv.slice(1);
const h = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const out = {};
for (const n of names) out[n] = { sourceSha256: h(`${here}/${n}.c`) };
writeFileSync(`${here}/manifest.json`, JSON.stringify(out, null, 2) + "\n");
' "$here" microsd
echo "built: $(ls "$out"/*.wasm | xargs -n1 basename | tr '\n' ' ')"
