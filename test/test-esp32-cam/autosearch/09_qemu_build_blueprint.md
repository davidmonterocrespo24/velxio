# 09 — QEMU build & distribution blueprint

How a Phase-2 patch to `wokwi-libs/qemu-lcgamboa/` actually reaches a
running container in production. Read this before writing any C in
`hw/misc/`.

## Where the binary comes from today

Production gets `libqemu-xtensa.so` from a **GitHub Release**, not from
the source tree. The download is wired in `Dockerfile.standalone:11-23`:

```dockerfile
ARG QEMU_RELEASE_URL=https://github.com/davidmonterocrespo24/velxio/releases/download/qemu-prebuilt
…
curl -fSL -o "libqemu-xtensa.so" \
     "${QEMU_RELEASE_URL}/libqemu-xtensa-${TARGETARCH}.so"
```

So whoever publishes the binaries (currently David, GitHub release tag
`qemu-prebuilt`) is the gatekeeper. The Docker build itself never
compiles QEMU.

The asset names already encode arch: `libqemu-xtensa-amd64.so`,
`libqemu-xtensa-arm64.so`, …

## Build scripts that exist

```
wokwi-libs/qemu-lcgamboa/
├── build_libqemu-esp32.sh        # Linux/macOS — host nproc, bash
└── build_libqemu-esp32-win.sh    # MSYS2 MINGW64 — produces .dll
```

Both scripts:

1. `./configure --target-list=xtensa-softmmu,riscv32-softmmu` with
   `--enable-tcg --enable-system --enable-slirp --enable-gcrypt`.
2. `make -j$(nproc)` to build everything QEMU normally builds.
3. **Hack the Ninja link command** to drop `softmmu_main.c.o` and add
   `-shared`, producing a `.so` (Linux) / `.dll` (Win) instead of
   the executable.
4. The resulting library is copied next to the backend.

The Linux build builds the architecture you're on. Cross-compile
matrix:

| Target arch       | How                                          |
|-------------------|----------------------------------------------|
| linux/amd64       | Run `build_libqemu-esp32.sh` on x86_64 Linux |
| linux/arm64       | Run on arm64 Linux (or qemu-user-static)     |
| windows/amd64     | Run `build_libqemu-esp32-win.sh` in MSYS2    |
| darwin/amd64,arm64 | Optional — Mac host, same Linux script      |

In practice we only need amd64 + arm64 Linux (Docker production) plus
Windows for the desktop tier.

## Where Phase-2 changes go

A new C source file, drop-in:

```
wokwi-libs/qemu-lcgamboa/
├── hw/i2c/
│   └── esp32_ov2640.c        # NEW — SCCB device, 7-bit addr 0x30
├── hw/misc/
│   └── esp32_i2s_cam.c       # NEW — replaces esp32_unimp at I2S0
├── hw/xtensa/
│   └── esp32_picsimlab.c     # MODIFIED — wires the two devices
└── include/hw/i2c/
    └── esp32_ov2640.h        # NEW — public header
```

Plus updates to:
- `hw/i2c/meson.build` — add `esp32_ov2640.c` to the i2c group.
- `hw/misc/meson.build` — add `esp32_i2s_cam.c`.
- `hw/xtensa/meson.build` — already references esp32_picsimlab.c.

Touch **only** new files where possible. The picsimlab.c diff is the
single existing-file change and should be a 5-10 line addition near
where I2S0 is currently mapped as unimp (line 750).

## Build smoke test (does the library still load?)

After every rebuild:

```bash
# Linux
python -c "
import ctypes
lib = ctypes.CDLL('./build/libqemu-xtensa.so')
print('symbols:', sum(1 for _ in iter(lib.__getattr__, None)))
"

# A more useful smoke test — does picsimlab init succeed?
file build/libqemu-xtensa.so          # must say 'shared object, dynamically linked'
nm -D build/libqemu-xtensa.so | grep esp32_  # should list the new devices' init fns
```

The CI matrix needs:

- A Linux runner with `mingw-w64-x86_64-*` packages OR a separate
  Windows runner.
- `~3 GB` disk, `~10 min` per arch on a 4-core runner.

## Distribution flow proposal

Once the library is rebuilt:

1. Tag the `wokwi-libs/qemu-lcgamboa/` commit (in a fork, or a
   submodule pointer in this repo).
2. CI workflow `.github/workflows/qemu-publish.yml` (NEW) builds the
   matrix and uploads to the existing `qemu-prebuilt` GitHub Release
   under new asset names: `libqemu-xtensa-camera-vN-${TARGETARCH}.so`.
3. Bump `QEMU_RELEASE_URL` (or the explicit asset names) in
   `Dockerfile.standalone`.
4. Next `docker compose build velxio` pulls the new artifact.
5. Smoke test: a fresh container runs the camera_init.ino sketch and
   the live test reports `got frame: N bytes`.

## Local dev cycle (no Docker)

For iteration speed during Phase 2:

```bash
# 1. one-time
cd wokwi-libs/qemu-lcgamboa
./configure --target-list=xtensa-softmmu --extra-cflags="-fPIC -DESP32_PICSIMLAB_SOFT_CACHE=1" --disable-werror --enable-tcg --enable-system --enable-debug
make -j$(nproc)

# 2. iterate (fast, <30 s)
# … edit hw/i2c/esp32_ov2640.c …
ninja -C build qemu-system-xtensa
bash -c "$(./repackage_dynlib.sh)"     # the same ninja-rsp dance

# 3. point the backend at the local build
ln -sf $(pwd)/build/libqemu-xtensa.so /path/to/backend/app/services/libqemu-xtensa.so

# 4. restart backend, re-run live tests
```

We want to ship a `repackage_dynlib.sh` helper that wraps the ninja
.rsp manipulation from the existing build scripts (steps 4-5). Today
that logic is duplicated inline; extracting it cuts the iteration
loop in half.

## Risks

1. **Missing sources for QEMU configure**. The local fork ships with
   sources for the chosen `--target-list` only. If a contributor
   accidentally needs `arm-softmmu` etc., reconfigure is needed.
2. **MSYS2 environment fragility**. The Windows build script has a
   `meson.build` patch step (line 35-40) that's specific to a
   pre-existing meson-build text. If lcgamboa rebases meson, this
   sed will silently no-op. Add a strict assertion.
3. **Per-arch artifact size**. ~30 MB each, three artifacts, GH
   Release size limit is 2 GB → fine for years.
4. **TCG vs KVM**. We use TCG (interpreter). KVM doesn't help us
   because the Xtensa target wouldn't use it anyway.

## What this autosearch concludes

The build infrastructure is already in place; we don't need to invent
anything new for Phase 2 distribution. We just have to:

- Add three files (`esp32_ov2640.{c,h}`, `esp32_i2s_cam.c`).
- Modify one file (`esp32_picsimlab.c`) by ~10 lines.
- Run one of two existing scripts.
- Upload to GitHub Releases under new asset names.
- Bump the URL in Dockerfile.

Total Phase-4 (build/CI) effort: ~1 week, mostly CI plumbing.
