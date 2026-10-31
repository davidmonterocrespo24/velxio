# Building QEMU from source for Velxio

The Velxio docker image ships with prebuilt `libqemu-xtensa` and
`libqemu-riscv32` libraries so ESP32 / ESP32-S3 / ESP32-C3 simulation
works out of the box. If you'd rather not use the prebuilts —
whether for licensing reasons, audit requirements, or simply because
you prefer to compile what you run — this guide tells you how to get
the source they were built from and how to build it.

QEMU is **GPL-2.0**, and so is every line Velxio adds to it. The
complete corresponding source for the binaries we distribute is
available to anyone who receives those binaries, with no additional
conditions attached — see [Getting the source](#1-getting-the-source).

## Read this first: upstream will not build what Velxio runs

Velxio's ESP32 support does **not** come from an unmodified upstream
checkout, and building [`lcgamboa/qemu`](https://github.com/lcgamboa/qemu)
will not produce a drop-in replacement. Concretely:

- Upstream's `picsimlab-esp32` branch does contain
  `hw/xtensa/esp32s3.c`, but it registers Espressif's plain
  `-M esp32s3` machine. Velxio instantiates `esp32s3-picsimlab`, a
  variant that wires the host-side GPIO/SPI/I2C/UART callbacks the
  Python worker binds to. Upstream has no such machine, so a stock
  build starts and then fails to find the machine Velxio asks for.
- Several device models Velxio depends on exist only in our tree:
  `hw/ssi/esp32s3_gpspi.c` (the S3's GPSPI2 controller — the plain
  machine leaves it unimplemented, so SPI displays have no controller
  to talk to), `hw/i2c/esp32_ov2640.c`, `hw/misc/esp32_i2s_cam.c` and
  `hw/misc/velxio_camera_export.c` (the ESP32-CAM path).

So: build from the source archive described below, not from an
upstream clone. Earlier revisions of this document told you to check
out a specific upstream commit and claimed the result would match our
prebuilts byte-for-byte. Both claims were wrong, and the commit id
they named never existed. Sorry — that was our error, and it cost
people real build cycles.

## Audience

This guide assumes a Linux or macOS workstation with a working C
toolchain. Windows builds go through MSYS2 / MinGW — see
`build_libqemu-esp32-win.sh` and the `windows` job in
`.github/workflows/build-libqemu.yml` inside the source archive.

## What you'll produce

| File | Architecture | Used for |
|---|---|---|
| `libqemu-xtensa.so` | Xtensa LX6 / LX7 | ESP32, ESP32-S3, ESP32-CAM, Arduino Nano ESP32 |
| `libqemu-riscv32.so` | RISC-V RV32IMC | ESP32-C3, XIAO ESP32-C3 |

The Velxio backend `dlopen`s these at runtime through
`backend/app/services/qemu_runtime.py`. Drop the freshly built files
into `/app/lib/` inside the container (or the host path that mounts to
it) and Velxio will use them on the next simulation start.

## 1. Getting the source

The corresponding source is published as a tarball alongside the
binaries themselves, on the same download endpoint:

```bash
# List what your key can fetch — source archives are named
# qemu-source-<commit>, matching the commit each binary was built from.
curl "https://velxio.dev/api/pro/license/downloads?key=$VELXIO_LICENSE_KEY"

# Fetch one.
curl -O -J \
  "https://velxio.dev/api/pro/license/downloads/qemu-source-83a944ce?key=$VELXIO_LICENSE_KEY"
```

Free personal keys are at
[`velxio.dev/license/signup`](https://velxio.dev/license/signup). The
listing reports a `sha256` for each asset — check it.

The archive contains the full tree, the build scripts, the release CI
workflow, and a `README.VELXIO-SOURCE.md` recording which binaries it
corresponds to and what the tree adds over upstream. It is GPL-2.0:
yours to study, modify and redistribute under those terms.

If you received a Velxio binary and cannot reach the endpoint for any
reason, open an issue — you are entitled to the source and we will get
it to you.

## 2. Install build dependencies

**Debian / Ubuntu**:

```bash
sudo apt-get update
sudo apt-get install -y --no-install-recommends \
    build-essential git wget curl \
    python3-pip python3-setuptools \
    ninja-build pkg-config flex bison \
    libglib2.0-dev libgcrypt-dev libslirp-dev \
    libpixman-1-dev libfdt-dev zlib1g-dev jq
pip3 install meson==1.2.3 tomli
```

`tomli` is not optional on Python older than 3.11: QEMU 9.2's `mkvenv`
needs it, and `configure` dies with *"found no usable tomli"* without
it.

On glibc, iconv lives in libc and there is no separate library, but
QEMU's configure adds `-liconv` regardless. An empty stub satisfies
the linker:

```bash
LIBDIR=$(dpkg-architecture -q DEB_HOST_MULTIARCH)
sudo ar rcs /usr/lib/${LIBDIR}/libiconv.a
```

**macOS** (Apple Silicon):

```bash
brew install gnu-sed coreutils ninja pkg-config meson \
             glib pixman libgcrypt libslirp
python3 -m pip install --user --break-system-packages distlib
export PYTHONPATH="$(python3 -c 'import site; print(site.getusersitepackages())')"
export PATH="$(brew --prefix gnu-sed)/libexec/gnubin:$PATH"
export OBJC=clang OBJCXX=clang++
```

GNU `sed` must come first on `PATH` — the build script relies on GNU
`sed -i` semantics. Homebrew's Python does not bundle `distlib`, which
QEMU's `mkvenv.py` requires.

## 3. Build

Both libraries come out of one script — the same one the release CI
runs:

```bash
tar xzf velxio-qemu-src-<commit>.tar.gz
cd velxio-qemu-<commit>
bash build_libqemu-esp32.sh
```

Do not try to hand-roll the configure line. QEMU has no
`--enable-shared-lib` option (earlier revisions of this document
invented one); the library is produced by building `qemu-system-*`
normally and then relinking the same objects without `system_main`,
which is exactly what the script does. It also sets the
`-DESP32_PICSIMLAB_SOFT_CACHE=1` flag the ESP32 machines expect.

On macOS the script still writes `libqemu-*.so`; rename to `.dylib`.

Verify:

```bash
file build/libqemu-xtensa.so
# ELF 64-bit LSB shared object, x86-64, dynamically linked

ls -lh build/libqemu-xtensa.so build/libqemu-riscv32.so
# ~45-50 MB each on Linux x86_64
```

## 4. Drop the binaries into Velxio

The worker passes `-L <directory of the .so>` to QEMU, so the boot ROM
blobs must sit **beside** the library, not elsewhere:

```
/app/lib/libqemu-xtensa.so      /app/lib/esp32-v3-rom.bin
/app/lib/libqemu-riscv32.so     /app/lib/esp32-v3-rom-app.bin
                                /app/lib/esp32c3-rom.bin
                                /app/lib/esp32s3_rev0_rom.bin
```

If you self-host via the official docker image:

```bash
docker cp build/libqemu-xtensa.so   velxio:/app/lib/libqemu-xtensa.so
docker cp build/libqemu-riscv32.so  velxio:/app/lib/libqemu-riscv32.so
```

Workers load the library on every run, so no restart is needed — the
next simulation start picks it up. Running from source instead, copy
into `backend/app/lib/`.

You can also skip the container copy entirely: drop your `.so` files
plus the four ROM blobs into `prebuilt/qemu/` before
`docker compose build`, and the image build will use them instead of
downloading anything.

## 5. ESP32 ROM blobs

The QEMU build does not produce the boot ROM dumps Velxio also needs
(`esp32-v3-rom.bin`, `esp32-v3-rom-app.bin`, `esp32c3-rom.bin`,
`esp32s3_rev0_rom.bin`). Those come from Espressif's open-source
toolchain and are redistributable verbatim. The image already includes
them at `/app/lib/`; you only need to replace them if you're working
from a custom esp-idf version.

## 6. Troubleshooting

**`found no usable tomli`** — Python < 3.11 without `tomli`. See the
dependencies step.

**`No such file or directory: glib-2.0`** — apt missed
`libglib2.0-dev`.

**Linker error mentioning `-liconv` on Linux** — create the empty
`libiconv.a` stub described above.

**`a usable distlib could not be found` on macOS** — Homebrew Python
without `distlib`; install it and export `PYTHONPATH`.

**`sed: -i may not be used with stdin` or similar on macOS** — BSD
`sed` is ahead of GNU `sed` on `PATH`.

**The library is only a few hundred KB** — the relink step didn't run.
Read `build/ninja-link-*.log`, which the script keeps.

**Velxio starts the simulation and QEMU reports an unknown machine
(`esp32s3-picsimlab`, `esp32-picsimlab`, `esp32c3-picsimlab`)** — you
built from an upstream clone rather than the source archive. See the
warning at the top of this document.

## License notes

QEMU — including our modifications — is **GPL-2.0**. Velxio itself is
**AGPLv3**. The `dlopen` boundary keeps the two licenses orthogonal:
QEMU stays GPL'd, Velxio stays AGPL'd, neither contaminates the other.

If you redistribute the QEMU libraries, you owe your recipients the
corresponding source under GPL-2.0 (the archive above is exactly
that). If you deploy a modified Velxio over a network, you owe your
users the Velxio modifications under AGPLv3.

## Why use the prebuilts at all?

For most self-hosters the prebuilts are the path of least resistance —
already built, checksummed in their manifest, ready to drop in. The
build takes 15-30 minutes on a modern laptop and ~3 GB of disk.

Building from source matters when:

- You're auditing the supply chain for a regulated deployment.
- You need to patch QEMU — add a peripheral, fix a device model — and
  want to ship the patched library.
- You don't want third-party prebuilts on your machine.
- You're on a platform we don't ship a binary for (BSD, exotic libc).

All four are legitimate, and none of them require asking us first.
