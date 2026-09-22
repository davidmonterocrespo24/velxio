#!/usr/bin/env bash
# Rebuild the chip WASM fixtures of board-buses-repro-chips-spi.test.ts with the
# same clang flags as the production chip compiler
# (velxio/backend/app/services/chip_compile.py), then refresh manifest.json.
#
# The gallery chips are built from their gallery sources, never from a copy, so
# a fix to a gallery chip reaches the test only through this script. The test
# checks manifest.json against the sources and fails while a fixture is stale.
#
#   WASI_SDK=/path/to/wasi-sdk ./build.sh      (default: ~/wasi-sdk, /opt/wasi-sdk)
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
front="$(cd "$here/../../../../.." && pwd)"
sdk_inc="$front/../backend/sdk"
gallery="$front/src/components/customChips/examples"
clang=""
for c in "${WASI_SDK:-}" "$HOME/wasi-sdk" /opt/wasi-sdk; do
  if [ -n "$c" ] && [ -x "$c/bin/clang" ]; then clang="$c/bin/clang"; break; fi
done
[ -n "$clang" ] || { echo "wasi-sdk not found (set WASI_SDK)" >&2; exit 1; }

build() { # <source.c> <out.wasm>
  "$clang" --target=wasm32-unknown-wasip1 -O2 -nostartfiles \
    -Wl,--import-memory -Wl,--export-table -Wl,--no-entry \
    -Wl,--export=chip_setup -Wl,--allow-undefined \
    -I "$sdk_inc" "$1" -o "$2"
}

build "$here/spi-probe.c" "$here/spi-probe.wasm"
build "$here/spi-dual.c" "$here/spi-dual.wasm"
for g in sn74hc595 mcp3008 eeprom-24c01; do
  build "$gallery/$g.c" "$here/$g.wasm"
done

node -e '
const { createHash } = require("node:crypto");
const { readFileSync, writeFileSync } = require("node:fs");
const [here, gallery] = process.argv.slice(1);
const h = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const src = {
  "spi-probe": `${here}/spi-probe.c`,
  "spi-dual": `${here}/spi-dual.c`,
  sn74hc595: `${gallery}/sn74hc595.c`,
  mcp3008: `${gallery}/mcp3008.c`,
  "eeprom-24c01": `${gallery}/eeprom-24c01.c`,
};
const out = {};
for (const [k, p] of Object.entries(src)) out[k] = { sourceSha256: h(p) };
writeFileSync(`${here}/manifest.json`, JSON.stringify(out, null, 2) + "\n");
' "$here" "$gallery"
echo "built: $(ls "$here"/*.wasm | xargs -n1 basename | tr '\n' ' ')"
