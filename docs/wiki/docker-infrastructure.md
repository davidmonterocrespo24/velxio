# Velxio Docker Infrastructure

Complete documentation of the Docker build system, CI/CD pipelines, multi-architecture support, and deployment configuration for the Velxio project.

---

## Table of Contents

1. [Overview](#overview)
2. [Architecture Diagram](#architecture-diagram)
3. [Dockerfile.standalone — Multi-Stage Build](#dockerfilestandalone--multi-stage-build)
   - [Stage 0: qemu-provider](#stage-0-qemu-provider)
   - [Stage 0.5: espidf-builder](#stage-05-espidf-builder)
   - [Stage 1: frontend-builder](#stage-1-frontend-builder)
   - [Stage 2: Final Production Image](#stage-2-final-production-image)
4. [Multi-Architecture Support (amd64 + arm64)](#multi-architecture-support-amd64--arm64)
   - [How TARGETARCH Works](#how-targetarch-works)
   - [Architecture-Specific Binaries](#architecture-specific-binaries)
   - [ESP-IDF on ARM64](#esp-idf-on-arm64)
5. [QEMU ESP32 Build Pipeline](#qemu-esp32-build-pipeline)
   - [build-libqemu.yml Workflow](#build-libqemuyml-workflow)
   - [Matrix Strategy](#matrix-strategy)
   - [libiconv Stub Workaround](#libiconv-stub-workaround)
   - [Artifact Upload to GitHub Release](#artifact-upload-to-github-release)
6. [Docker Publish CI/CD Pipeline](#docker-publish-cicd-pipeline)
   - [docker-publish.yml Workflow](#docker-publishyml-workflow)
   - [Multi-Platform Build with Buildx](#multi-platform-build-with-buildx)
   - [Registry Configuration (GHCR + Docker Hub)](#registry-configuration-ghcr--docker-hub)
   - [Build Caching with GitHub Actions Cache](#build-caching-with-github-actions-cache)
   - [SEO Ping and Docker Hub Description](#seo-ping-and-docker-hub-description)
7. [Entrypoint Script](#entrypoint-script)
   - [arduino-cli Initialization](#arduino-cli-initialization)
   - [ESP-IDF Environment Sourcing](#esp-idf-environment-sourcing)
   - [Service Startup](#service-startup)
8. [Nginx Reverse Proxy](#nginx-reverse-proxy)
   - [API Proxy Configuration](#api-proxy-configuration)
   - [WebSocket Support](#websocket-support)
   - [SPA Routing](#spa-routing)
   - [Static Asset Caching](#static-asset-caching)
   - [SEO Configuration](#seo-configuration)
   - [Gzip Compression](#gzip-compression)
   - [Security Headers](#security-headers)
9. [Docker Compose](#docker-compose)
   - [Development (docker-compose.yml)](#development-docker-composeyml)
   - [Production deployment](#production-deployment)
   - [Environment Variables](#environment-variables)
   - [Volumes](#volumes)
   - [Health Checks](#health-checks)
10. [Environment Variables Reference](#environment-variables-reference)
11. [Quick Start Guide](#quick-start-guide)
12. [Troubleshooting](#troubleshooting)

---

## Overview

Velxio uses a **multi-stage Docker build** (`Dockerfile.standalone`) that produces a single, self-contained image capable of:

- Serving the React frontend via Nginx
- Running the FastAPI backend via Uvicorn
- Compiling Arduino sketches using `arduino-cli` (AVR, RP2040)
- Compiling ESP32 sketches using **ESP-IDF 4.4.7** with Arduino-as-component
- Emulating ESP32 (Xtensa) and ESP32-C3 (RISC-V) via **pre-built QEMU shared libraries**
- Running on both **x86_64 (amd64)** and **Apple Silicon / ARM64** hosts

The image is published to two registries:
- **GitHub Container Registry (GHCR):** `ghcr.io/davidmonterocrespo24/velxio`
- **Docker Hub:** `docker.io/<username>/velxio`

---

## Architecture Diagram

```
┌──────────────────────────────────────────────────────────────────┐
│                     Dockerfile.standalone                        │
│                                                                  │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────────────┐  │
│  │ Stage 0      │  │ Stage 0.5    │  │ Stage 1               │  │
│  │ qemu-provider│  │ espidf-builder│  │ frontend-builder      │  │
│  │              │  │              │  │                       │  │
│  │ Downloads    │  │ Clones       │  │ Clones third-party     │  │
│  │ libqemu-*.so │  │ ESP-IDF 4.4.7│  │ from GitHub           │  │
│  │ + ROM .bin   │  │ + toolchains │  │ Builds avr8js,        │  │
│  │ per TARGETARCH│  │ + Arduino    │  │ rp2040js, wokwi-elems │  │
│  │              │  │   component  │  │ Builds React frontend │  │
│  └──────┬───────┘  └──────┬───────┘  └───────────┬───────────┘  │
│         │                 │                       │              │
│         ▼                 ▼                       ▼              │
│  ┌──────────────────────────────────────────────────────────────┐│
│  │ Stage 2: Final Image (python:3.12-slim)                     ││
│  │                                                              ││
│  │  /app/lib/          ← QEMU .so + ROM files                  ││
│  │  /opt/esp-idf/      ← ESP-IDF framework                     ││
│  │  /root/.espressif/  ← Cross-compiler toolchains              ││
│  │  /opt/arduino-esp32/← Arduino component                      ││
│  │  /usr/share/nginx/html/ ← Built frontend                    ││
│  │  /app/app/          ← FastAPI backend                        ││
│  │  /app/entrypoint.sh ← Startup script                        ││
│  └──────────────────────────────────────────────────────────────┘│
└──────────────────────────────────────────────────────────────────┘
```

---

## Dockerfile.standalone — Multi-Stage Build

The Dockerfile uses **4 stages** to minimize final image size while building all dependencies.

### Stage 0: qemu-provider

**Base image:** `ubuntu:22.04`

**Purpose:** Downloads pre-built QEMU shared libraries (`.so`) and ESP32 ROM binary files from a GitHub Release. These are the QEMU emulation libraries built from the `qemu-lcgamboa` fork that enable ESP32 and ESP32-C3 simulation.

```dockerfile
FROM ubuntu:22.04 AS qemu-provider

ARG TARGETARCH
ARG QEMU_RELEASE_URL=https://github.com/davidmonterocrespo24/velxio/releases/download/qemu-prebuilt
```

**Key details:**

- `TARGETARCH` is automatically injected by Docker Buildx. It resolves to `amd64` or `arm64` depending on the target platform.
- The stage first checks for local prebuilt files in `prebuilt/qemu/`. If present, those are used (useful for local development). If not present, the files are downloaded from the GitHub Release.
- **Architecture-specific files** (different binary per CPU architecture):
  - `libqemu-xtensa-${TARGETARCH}.so` → saved as `libqemu-xtensa.so`
  - `libqemu-riscv32-${TARGETARCH}.so` → saved as `libqemu-riscv32.so`
- **Architecture-independent files** (same binary for all architectures):
  - `esp32-v3-rom.bin` — ESP32 boot ROM
  - `esp32-v3-rom-app.bin` — ESP32 application ROM
  - `esp32c3-rom.bin` — ESP32-C3 boot ROM

The renaming from `libqemu-xtensa-amd64.so` to `libqemu-xtensa.so` means the backend code needs no architecture-aware logic — it always loads `libqemu-xtensa.so` regardless of host architecture.

### Stage 0.5: espidf-builder

**Base image:** `ubuntu:22.04`

**Purpose:** Installs the full ESP-IDF 4.4.7 development framework with cross-compiler toolchains for ESP32 (Xtensa) and ESP32-C3 (RISC-V), plus Arduino-as-component for full Arduino API support.

```dockerfile
FROM ubuntu:22.04 AS espidf-builder

# Install ESP-IDF 4.4.7 (matches Arduino ESP32 core 2.0.17 / lcgamboa QEMU ROM)
RUN git clone -b v4.4.7 --recursive --depth=1 --shallow-submodules \
    https://github.com/espressif/esp-idf.git /opt/esp-idf

# Install toolchains for esp32 (Xtensa) and esp32c3 (RISC-V) only
RUN ./install.sh esp32,esp32c3

# Arduino-as-component for full Arduino API support in ESP-IDF builds
RUN git clone --branch 2.0.17 --depth=1 --recursive --shallow-submodules \
    https://github.com/espressif/arduino-esp32.git /opt/arduino-esp32
```

**Key details:**

- **ESP-IDF version 4.4.7** is pinned because it matches the QEMU ROM binaries built from the lcgamboa fork. Newer ESP-IDF versions (5.x) are **not compatible** with the ROM images.
- **Arduino ESP32 core 2.0.17** matches IDF 4.4.x. The 3.x series uses IDF 5.x and is incompatible.
- `install.sh esp32,esp32c3` downloads only the Xtensa and RISC-V toolchains (not ESP32-S2, S3, etc.) to reduce image size.
- ESP-IDF's `install.sh` **auto-detects host architecture** and downloads the correct native toolchain (x86_64 or aarch64). No special handling needed for ARM64.
- The `.git` directory, docs, and examples are removed after installation to reduce size. Downloaded `.tar.*` archives in `.espressif` are also cleaned up.

**Important note on ARM64 builds:** When Docker Buildx builds the arm64 variant on an amd64 CI runner, it uses QEMU user-mode emulation. This makes the ESP-IDF stage **very slow** (~30-60 minutes) but works correctly. The GitHub Actions cache (`cache-from: type=gha`) ensures this only happens once.

### Stage 1: frontend-builder

**Base image:** `node:20`

**Purpose:** Builds the frontend React application and all third-party dependencies.

```dockerfile
FROM node:20 AS frontend-builder

# Clone third-party fresh from upstream (avoids stale submodule pointers)
RUN git clone --depth=1 https://github.com/wokwi/avr8js.git third-party/avr8js \
 && git clone --depth=1 https://github.com/wokwi/rp2040js.git third-party/rp2040js \
 && git clone --depth=1 https://github.com/wokwi/wokwi-elements.git third-party/wokwi-elements \
 && git clone --depth=1 https://github.com/wokwi/wokwi-boards.git third-party/wokwi-boards
```

**Why clone instead of COPY?**

The git submodule pointers in this repo for `rp2040js` and `wokwi-elements` are stale — they point to very old commits that predate `package.json`. Cloning fresh from GitHub HEAD ensures we get working, up-to-date versions. This is also why the GitHub Actions workflow does **not** use `submodules: recursive` in the checkout step.

**Build order:**
1. `avr8js` — `npm install && npm run build`
2. `rp2040js` — `npm install && npm run build`
3. `wokwi-elements` — `npm install && npm run build`
4. Frontend — `npm install && npm run build:docker`

**`build:docker` vs `build`:** The `build:docker` script runs `vite build` only (no `tsc -b` type-checking). This is intentional because there are known pre-existing TypeScript errors (wokwi-elements JSX custom element types, `@monaco-editor/react` compatibility with React 19) that don't affect runtime behavior.

### Stage 2: Final Production Image

**Base image:** `python:3.12-slim`

**Purpose:** The final, deployable image that contains everything needed to run Velxio.

**System packages installed:**
- `curl`, `ca-certificates` — HTTP requests, SSL
- `nginx` — Reverse proxy / static file server
- `libglib2.0-0`, `libgcrypt20`, `libslirp0`, `libpixman-1-0`, `libfdt1` — Runtime dependencies for QEMU shared libraries
- `cmake`, `ninja-build` — Required by ESP-IDF builds
- `libusb-1.0-0` — Required by ESP-IDF
- `git` — Required by ESP-IDF component management
- `packaging` (Python) — Required by ESP-IDF Python tools

**Installed tools:**
- `arduino-cli` — Downloaded and installed into `/usr/local/bin`
- Python dependencies from `backend/requirements.txt`
- ESP-IDF Python dependencies (with `esp-windows-curses` filtered out)

**Files copied from builder stages:**
| Source | Destination | Purpose |
|--------|-------------|---------|
| `frontend-builder:/app/frontend/dist` | `/usr/share/nginx/html` | Built frontend assets |
| `qemu-provider:/qemu/` | `/app/lib/` | QEMU .so + ROM files |
| `espidf-builder:/opt/esp-idf` | `/opt/esp-idf` | ESP-IDF framework |
| `espidf-builder:/root/.espressif` | `/root/.espressif` | Cross-compiler toolchains |
| `espidf-builder:/opt/arduino-esp32` | `/opt/arduino-esp32` | Arduino component for ESP-IDF |

**Environment variables set in the image:**
```dockerfile
ENV QEMU_ESP32_LIB=/app/lib/libqemu-xtensa.so
ENV QEMU_RISCV32_LIB=/app/lib/libqemu-riscv32.so
ENV IDF_PATH=/opt/esp-idf
ENV IDF_TOOLS_PATH=/root/.espressif
ENV ARDUINO_ESP32_PATH=/opt/arduino-esp32
```

**Entrypoint:** `/app/entrypoint.sh` (with CRLF→LF conversion for Windows compatibility)

**Exposed port:** `80` (Nginx)

---

## Multi-Architecture Support (amd64 + arm64)

### How TARGETARCH Works

Docker Buildx automatically injects the `TARGETARCH` build argument when building multi-platform images. Its value depends on the target platform:

| Platform | TARGETARCH |
|----------|-----------|
| `linux/amd64` (x86_64, Intel/AMD) | `amd64` |
| `linux/arm64` (aarch64, Apple Silicon, AWS Graviton) | `arm64` |

This is used in Stage 0 (qemu-provider) to download the correct architecture-specific QEMU shared library:

```dockerfile
ARG TARGETARCH
# Downloads libqemu-xtensa-amd64.so or libqemu-xtensa-arm64.so
# and saves it as libqemu-xtensa.so
curl -fSL -o "$f" "${QEMU_RELEASE_URL}/${base}-${TARGETARCH}.so"
```

### Architecture-Specific Binaries

The following files differ per architecture:

| File | amd64 | arm64 |
|------|-------|-------|
| `libqemu-xtensa.so` | Built on x86_64 Ubuntu 20.04 | Built on aarch64 Ubuntu 22.04 |
| `libqemu-riscv32.so` | Built on x86_64 Ubuntu 20.04 | Built on aarch64 Ubuntu 22.04 |

The following files are **architecture-independent** (same binary for both):

| File | Description |
|------|-------------|
| `esp32-v3-rom.bin` | ESP32 boot ROM |
| `esp32-v3-rom-app.bin` | ESP32 application ROM |
| `esp32c3-rom.bin` | ESP32-C3 boot ROM |

### ESP-IDF on ARM64

ESP-IDF's `install.sh` automatically detects the host architecture and downloads native toolchains:
- On amd64: downloads `xtensa-esp32-elf-*-linux-amd64.tar.gz`
- On arm64: downloads `xtensa-esp32-elf-*-linux-arm64.tar.gz`

No special handling is needed in the Dockerfile. However, when Buildx is building the arm64 image on an amd64 runner (which is the case in GitHub Actions), it uses QEMU user-mode emulation to run the arm64 container. This makes:
- `install.sh` very slow (downloading + extracting under emulation)
- `pip install` slow
- The overall arm64 build significantly longer than amd64

The GitHub Actions cache (`cache-from: type=gha, cache-to: type=gha,mode=max`) ensures that once the arm64 layers are built, they are cached and reused on subsequent builds.

---

## QEMU ESP32 Build Pipeline

### build-libqemu.yml Workflow

**Location:** `third-party/qemu-lcgamboa/.github/workflows/build-libqemu.yml`

**Triggers:**
- Push to the `picsimlab-esp32` branch
- Manual dispatch (`workflow_dispatch`)

This workflow compiles the QEMU shared libraries from the lcgamboa fork (a modified QEMU with ESP32/ESP32-C3 machine emulation) and uploads them as GitHub Release assets to the main Velxio repository.

### Matrix Strategy

The workflow uses a matrix strategy to build natively on two different architectures:

```yaml
strategy:
  matrix:
    include:
      - runner: ubuntu-22.04
        arch: amd64
        container: ubuntu:20.04
      - runner: ubuntu-24.04-arm
        arch: arm64
        container: ubuntu:22.04
```

**Why different containers?**

- **amd64** uses `ubuntu:20.04` for maximum glibc compatibility (glibc 2.31). The resulting `.so` will work on any Linux with glibc >= 2.31.
- **arm64** uses `ubuntu:22.04` because GitHub's `ubuntu-24.04-arm` runners are relatively new and `ubuntu:20.04` arm64 images have occasional package availability issues. glibc 2.35 is used, which is still compatible with the final Docker image (Debian Bookworm, glibc 2.36).

**Why native ARM64 runners?**

QEMU itself is a large C project. Cross-compiling or building under QEMU user-mode emulation would be extremely slow (hours). Using GitHub's native `ubuntu-24.04-arm` runners gives native ARM64 build speed (~15-20 minutes).

### libiconv Stub Workaround

QEMU's configure script adds `-liconv` to the linker flags. On Linux, iconv is part of glibc — there is no separate `libiconv` package. To satisfy the linker without installing a non-existent library:

```bash
LIBDIR=$(dpkg-architecture -q DEB_HOST_MULTIARCH 2>/dev/null || echo "$(uname -m)-linux-gnu")
ar rcs /usr/lib/${LIBDIR}/libiconv.a
```

This creates an empty static archive `libiconv.a` in the architecture-correct library directory. The linker finds it, sees no symbols (none are needed since glibc provides iconv), and is satisfied.

The `dpkg-architecture` command returns the multiarch triplet (e.g., `x86_64-linux-gnu` or `aarch64-linux-gnu`), ensuring the stub is placed in the correct directory for each architecture.

### Artifact Upload to GitHub Release

The workflow has two jobs:

1. **`build`** (runs on both amd64 and arm64):
   - Compiles `libqemu-xtensa.so` and `libqemu-riscv32.so`
   - Renames with architecture suffix: `libqemu-xtensa-amd64.so`, `libqemu-xtensa-arm64.so`
   - ROM files are only collected from the amd64 job (they're architecture-independent)
   - Uploads as GitHub Actions artifacts

2. **`upload-release`** (runs after both build jobs complete):
   - Downloads both artifact archives
   - Uploads all files to the `qemu-prebuilt` tag on the `davidmonterocrespo24/velxio` repository
   - Uses `--clobber` to overwrite existing files if the release already exists
   - Requires the `VELXIO_RELEASE_TOKEN` secret (a PAT with `contents:write` on the velxio repo)

**Release structure at `github.com/davidmonterocrespo24/velxio/releases/tag/qemu-prebuilt`:**
```
libqemu-xtensa-amd64.so
libqemu-xtensa-arm64.so
libqemu-riscv32-amd64.so
libqemu-riscv32-arm64.so
esp32-v3-rom.bin
esp32-v3-rom-app.bin
esp32c3-rom.bin
```

---

## Docker Publish CI/CD Pipeline

### docker-publish.yml Workflow

**Location:** `.github/workflows/docker-publish.yml`

**Trigger:** Push to the `master` branch.

This workflow builds the multi-platform Docker image and publishes it to both GHCR and Docker Hub.

### Multi-Platform Build with Buildx

The workflow sets up Docker Buildx with QEMU support for cross-platform building:

```yaml
- name: Set up QEMU (for multi-arch builds)
  uses: docker/setup-qemu-action@v3

- name: Set up Docker Buildx
  uses: docker/setup-buildx-action@v3

- name: Build and push Docker image
  uses: docker/build-push-action@v6
  with:
    context: .
    file: Dockerfile.standalone
    platforms: linux/amd64,linux/arm64
    push: true
    tags: ${{ steps.meta.outputs.tags }}
    labels: ${{ steps.meta.outputs.labels }}
    build-args: |
      ESPIDF_IMAGE=ghcr.io/davidmonterocrespo24/velxio-espidf-toolchain:latest
    cache-from: type=gha
    cache-to: type=gha,mode=max
```

**How multi-platform build works:**

1. Buildx creates two parallel build contexts — one for `linux/amd64` and one for `linux/arm64`
2. For the native architecture (amd64 on GitHub's runners), Docker runs natively
3. For the foreign architecture (arm64 on amd64 runners), Docker uses QEMU user-mode emulation via `setup-qemu-action`
4. Each stage in the Dockerfile is built separately for each architecture
5. The resulting images are combined into a **multi-arch manifest** and pushed as a single tag

When a user runs `docker pull ghcr.io/davidmonterocrespo24/velxio:master`, Docker automatically selects the correct architecture variant.

### Registry Configuration (GHCR + Docker Hub)

The workflow pushes to two registries simultaneously:

**GitHub Container Registry (GHCR):**
```yaml
- name: Log in to GHCR
  uses: docker/login-action@v3
  with:
    registry: ghcr.io
    username: ${{ github.actor }}
    password: ${{ secrets.GITHUB_TOKEN }}
```
- Uses the automatic `GITHUB_TOKEN` — no extra secrets needed
- Image: `ghcr.io/davidmonterocrespo24/velxio`

**Docker Hub:**
```yaml
- name: Log in to Docker Hub
  uses: docker/login-action@v3
  with:
    username: ${{ secrets.DOCKERHUB_USERNAME }}
    password: ${{ secrets.DOCKERHUB_TOKEN }}
```
- Requires `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` secrets
- Image: `docker.io/<username>/velxio`

The `docker/metadata-action` generates tags for both registries:
```yaml
images: |
  ghcr.io/${{ env.IMAGE_NAME }}
  docker.io/${{ secrets.DOCKERHUB_USERNAME }}/velxio
```

### Build Caching with GitHub Actions Cache

```yaml
cache-from: type=gha
cache-to: type=gha,mode=max
```

This uses GitHub Actions' built-in cache backend for Docker layer caching:
- `type=gha` — GitHub Actions cache (up to 10GB per repo)
- `mode=max` — Cache all layers, not just the final stage

This is critical for ARM64 builds because the ESP-IDF stage is very slow under QEMU emulation. Once cached, subsequent builds skip the heavy stages entirely.

### SEO Ping and Docker Hub Description

After a successful build:

```yaml
- name: Ping search engines with sitemap
  run: |
    curl -s "https://www.google.com/ping?sitemap=https%3A%2F%2Fvelxio.dev%2Fsitemap.xml"
    curl -s "https://www.bing.com/ping?sitemap=https%3A%2F%2Fvelxio.dev%2Fsitemap.xml"

- name: Update Docker Hub description
  uses: peter-evans/dockerhub-description@v4
  with:
    repository: ${{ secrets.DOCKERHUB_USERNAME }}/velxio
    short-description: "Local, open-source Arduino emulator..."
    readme-filepath: ./README.md
```

The Docker Hub description is automatically updated from the repository's `README.md` on every push.

---

## Entrypoint Script

**Location:** `docker/entrypoint.sh`

The entrypoint script runs when the container starts. It initializes development tools and launches the application services.

### arduino-cli Initialization

```bash
# First-time setup: create config and add board manager URLs
if [ ! -f /root/.arduino15/arduino-cli.yaml ]; then
    arduino-cli config init
    arduino-cli config add board_manager.additional_urls \
        https://github.com/earlephilhower/arduino-pico/releases/download/global/package_rp2040_index.json
    arduino-cli config add board_manager.additional_urls \
        https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json
fi

# Install board cores
arduino-cli core update-index
arduino-cli core install arduino:avr       # Arduino Uno, Mega, Nano
arduino-cli core install rp2040:rp2040     # Raspberry Pi Pico
```

**Persistence:** The `/root/.arduino15` directory is mounted as a Docker volume (`arduino-libs`). This means:
- First boot: downloads and installs board cores (~500MB) — takes a few minutes
- Subsequent boots: skips installation, starts immediately

### ESP-IDF Environment Sourcing

```bash
if [ -f /opt/esp-idf/export.sh ]; then
    . /opt/esp-idf/export.sh
    echo "ESP-IDF $(cat /opt/esp-idf/version.txt) ready"
else
    # Fallback to arduino-cli ESP32 core
    arduino-cli core install esp32:esp32@2.0.17
fi
```

ESP-IDF's `export.sh` adds the cross-compiler toolchains to `$PATH` and sets up the build environment. Without sourcing this script, ESP32 compilation would fail.

**Version pinning:** The fallback installs `esp32:esp32@2.0.17` specifically. This is critical because:
- Version 2.0.17 uses IDF 4.4.x internally, matching the QEMU ROM binaries
- Version 3.x uses IDF 5.x, which is **incompatible** with the QEMU ROM images
- Using the wrong version causes boot failures in emulation

### Service Startup

```bash
# Start FastAPI backend on port 8001 (background)
uvicorn app.main:app --host 127.0.0.1 --port 8001 &

# Wait for backend to initialize
sleep 2

# Start Nginx on port 80 (foreground — keeps container alive)
exec nginx -g "daemon off;"
```

The backend binds to `127.0.0.1:8001` (localhost only — not exposed to the network). Nginx on port 80 is the only externally-accessible service and proxies API requests to the backend.

Using `exec nginx` replaces the shell process with Nginx, making it PID 1. This ensures proper signal handling — when Docker sends SIGTERM (on `docker stop`), Nginx receives it directly and shuts down gracefully.

---

## Nginx Reverse Proxy

**Location:** `docker/nginx.conf`

### API Proxy Configuration

```nginx
location /api/ {
    proxy_pass http://127.0.0.1:8001/api/;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 300s;     # 5 minutes — compilation can be slow
    proxy_connect_timeout 75s;
}
```

All `/api/*` requests are proxied to the FastAPI backend. The 300-second read timeout accommodates ESP32 compilation, which can take several minutes (especially on first build when ESP-IDF initializes the build cache).

### WebSocket Support

```nginx
location /api/simulation/ws/ {
    proxy_pass http://127.0.0.1:8001/api/simulation/ws/;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 86400s;   # 24 hours
    proxy_send_timeout 86400s;
}
```

WebSocket connections are used for real-time ESP32 simulation communication. The 24-hour timeout ensures long-running simulation sessions aren't terminated. This location block **must come before** the generic `/api/` block so Nginx matches it with higher priority.

### SPA Routing

```nginx
location / {
    try_files $uri $uri/ /index.html;
}
```

This is the standard single-page application (SPA) routing pattern. For any URL that doesn't match a static file or another location block, Nginx serves `index.html` and lets React Router handle the routing client-side.

### Static Asset Caching

```nginx
# Content-hash assets (JS, CSS, fonts) — immutable, cache forever
location ~* \.(js|css|woff|woff2|ttf|eot)$ {
    expires 1y;
    add_header Cache-Control "public, immutable";
}

# Images — cache for 30 days
location ~* \.(png|jpg|jpeg|gif|ico|svg|webp)$ {
    expires 30d;
    add_header Cache-Control "public";
}
```

Vite generates content-hashed filenames (e.g., `index-a1b2c3.js`), so JS/CSS files can be cached indefinitely — when the content changes, the hash changes and a new URL is used.

### SEO Configuration

```nginx
# Never cache sitemap/robots — crawlers always get the latest
location = /sitemap.xml {
    try_files $uri =404;
    add_header Cache-Control "no-cache, must-revalidate";
}

location = /robots.txt {
    try_files $uri =404;
    add_header Cache-Control "no-cache, must-revalidate";
}
```

### Gzip Compression

```nginx
gzip on;
gzip_vary on;
gzip_min_length 1024;
gzip_proxied any;
gzip_types text/plain text/css text/xml text/javascript
           application/javascript application/json
           application/xml application/rss+xml;
```

Gzip is enabled for text-based content types. The `gzip_min_length 1024` prevents compressing very small responses where compression overhead would exceed savings.

### Security Headers

```nginx
add_header X-Frame-Options "SAMEORIGIN" always;
add_header X-Content-Type-Options "nosniff" always;
add_header X-XSS-Protection "1; mode=block" always;
add_header Referrer-Policy "strict-origin-when-cross-origin" always;
```

- **X-Frame-Options:** Prevents the site from being embedded in iframes on other domains (clickjacking protection)
- **X-Content-Type-Options:** Prevents browsers from MIME-sniffing responses
- **X-XSS-Protection:** Enables browser's built-in XSS filter
- **Referrer-Policy:** Limits referrer information sent to other sites

---

## Docker Compose

### Development (docker-compose.yml)

**Location:** `docker-compose.yml`

```yaml
services:
  velxio:
    build:
      context: .
      dockerfile: Dockerfile.standalone
    container_name: velxio-dev
    restart: unless-stopped
    ports:
      - "3080:80"
    env_file:
      - ./backend/.env
    environment:
      - DATABASE_URL=sqlite+aiosqlite:////app/data/velxio.db
      - DATA_DIR=/app/data
      - IDF_PATH=/opt/esp-idf
      - IDF_TOOLS_PATH=/root/.espressif
      - ARDUINO_ESP32_PATH=/opt/arduino-esp32
    volumes:
      - ./data:/app/data
      - arduino-libs:/root/.arduino15
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost/health"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 90s

volumes:
  arduino-libs:
```

**Usage:**
```bash
docker compose up --build       # Build and start
docker compose up -d            # Start in background (detached)
docker compose down             # Stop and remove
docker compose logs -f velxio   # Follow logs
```

**Access:** `http://localhost:3080`

### Production deployment

Production-only configuration (host nginx with HTTPS, deploy/backup scripts,
pinned upstream commit) lives in a separate repo:
**[github.com/velxio/velxio-prod](https://github.com/velxio/velxio-prod)**.

For self-hosters who don't need the velxio.dev-specific bits, the easiest
approach is the prebuilt image from the registry:

```bash
# Pull and run the pre-built image
docker run -d \
  --name velxio \
  -p 3080:80 \
  -v velxio-data:/app/data \
  -v arduino-libs:/root/.arduino15 \
  ghcr.io/davidmonterocrespo24/velxio:master
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | `sqlite+aiosqlite:////app/data/velxio.db` | SQLAlchemy async database URL |
| `DATA_DIR` | `/app/data` | Directory for persistent data (SQLite DB) |
| `IDF_PATH` | `/opt/esp-idf` | ESP-IDF framework path |
| `IDF_TOOLS_PATH` | `/root/.espressif` | ESP-IDF cross-compiler toolchains |
| `ARDUINO_ESP32_PATH` | `/opt/arduino-esp32` | Arduino-as-component for ESP-IDF |
| `QEMU_ESP32_LIB` | `/app/lib/libqemu-xtensa.so` | Path to Xtensa QEMU library |
| `QEMU_RISCV32_LIB` | `/app/lib/libqemu-riscv32.so` | Path to RISC-V QEMU library |
| `SECRET_KEY` | (from `.env`) | JWT signing key |
| `GOOGLE_CLIENT_ID` | (from `.env`) | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | (from `.env`) | Google OAuth client secret |

### Volumes

| Volume | Mount Point | Purpose |
|--------|-------------|---------|
| `./data` (bind mount) | `/app/data` | SQLite database file (`velxio.db`) |
| `arduino-libs` (named volume) | `/root/.arduino15` | arduino-cli config, board cores, libraries |

The bind mount for `./data` allows easy database backup and inspection from the host. The named volume for `arduino-libs` persists board core installations across container restarts.

### Health Checks

```yaml
healthcheck:
  test: ["CMD", "curl", "-f", "http://localhost/health"]
  interval: 30s
  timeout: 10s
  retries: 3
  start_period: 90s
```

- **`start_period: 90s`** — Gives the container 90 seconds to start before health checks begin counting failures. This accounts for first-boot arduino-cli core installation which can take over a minute.
- The `/health` endpoint is proxied by Nginx to FastAPI's `/health` endpoint, verifying both services are running.

---

## Environment Variables Reference

### Set in Dockerfile (build-time)

| Variable | Value | Set In |
|----------|-------|--------|
| `QEMU_ESP32_LIB` | `/app/lib/libqemu-xtensa.so` | Stage 2 |
| `QEMU_RISCV32_LIB` | `/app/lib/libqemu-riscv32.so` | Stage 2 |
| `IDF_PATH` | `/opt/esp-idf` | Stage 2 |
| `IDF_TOOLS_PATH` | `/root/.espressif` | Stage 2 |
| `ARDUINO_ESP32_PATH` | `/opt/arduino-esp32` | Stage 2 |

### Set at runtime (docker-compose / docker run)

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | SQLAlchemy async connection string |
| `DATA_DIR` | Yes | Data directory path |
| `SECRET_KEY` | Yes | JWT token signing key |
| `GOOGLE_CLIENT_ID` | No | For Google OAuth |
| `GOOGLE_CLIENT_SECRET` | No | For Google OAuth |

### Build arguments

| Arg | Default | Description |
|-----|---------|-------------|
| `TARGETARCH` | (auto-injected by Buildx) | Target architecture: `amd64` or `arm64` |
| `QEMU_RELEASE_URL` | `https://github.com/davidmonterocrespo24/velxio/releases/download/qemu-prebuilt` | URL prefix for QEMU binary downloads |
| `ESPIDF_IMAGE` | (unused, legacy) | Was used for external ESP-IDF image reference |

---

## Quick Start Guide

### Run from registry (recommended)

```bash
# Pull and run (auto-selects amd64 or arm64)
docker run -d \
  --name velxio \
  -p 3080:80 \
  -v velxio-data:/app/data \
  -v velxio-arduino:/root/.arduino15 \
  ghcr.io/davidmonterocrespo24/velxio:master

# Open in browser
open http://localhost:3080

# First boot takes ~2 minutes (downloading arduino board cores)
# Check progress:
docker logs -f velxio
```

### Build locally

```bash
# Clone the repository
git clone https://github.com/davidmonterocrespo24/velxio.git
cd velxio

# Build and run with docker compose
docker compose up --build

# Or build just the image
docker build -f Dockerfile.standalone -t velxio .
docker run -d -p 3080:80 velxio
```

### Build for a specific architecture

```bash
# Build for ARM64 only (e.g., on Apple Silicon)
docker buildx build \
  --platform linux/arm64 \
  -f Dockerfile.standalone \
  -t velxio:arm64 \
  --load .

# Build for both architectures (requires push to registry)
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -f Dockerfile.standalone \
  -t ghcr.io/user/velxio:latest \
  --push .
```

---

## Troubleshooting

### "no matching manifest for linux/arm64/v8"

**Problem:** Running `docker pull` on Apple Silicon Mac fails because the image was built for amd64 only.

**Solution:** The multi-platform build was added in the `docker-publish.yml` workflow with `platforms: linux/amd64,linux/arm64`. Ensure:
1. The `build-libqemu.yml` workflow has run successfully for both architectures (check that `libqemu-xtensa-arm64.so` exists in the `qemu-prebuilt` release)
2. The `docker-publish.yml` workflow has run after the QEMU ARM64 binaries were uploaded
3. The `docker/setup-qemu-action@v3` step is present in the workflow

### CRLF line ending issues in entrypoint.sh

**Problem:** When developing on Windows, `entrypoint.sh` may have CRLF line endings, causing `/bin/bash^M: bad interpreter`.

**Solution:** The Dockerfile includes a fix:
```dockerfile
RUN sed -i 's/\r$//' /app/entrypoint.sh && chmod +x /app/entrypoint.sh
```

This strips carriage returns from the file inside the container. No git configuration changes needed.

### ESP-IDF compilation fails with "command not found"

**Problem:** ESP-IDF cross-compilers (`xtensa-esp32-elf-gcc`) not found when compiling ESP32 sketches.

**Cause:** `export.sh` was not sourced, so the toolchains aren't in `$PATH`.

**Solution:** The entrypoint script sources ESP-IDF on startup:
```bash
. /opt/esp-idf/export.sh
```

If running manually inside the container, source it yourself:
```bash
docker exec -it velxio bash
source /opt/esp-idf/export.sh
```

### QEMU .so fails to load (missing shared libraries)

**Problem:** `ctypes.cdll.LoadLibrary` fails with missing dependencies.

**Cause:** The final image is missing runtime dependencies for the QEMU shared library.

**Solution:** The following packages are installed in Stage 2:
```
libglib2.0-0 libgcrypt20 libslirp0 libpixman-1-0 libfdt1
```

To debug which dependencies are missing:
```bash
docker exec -it velxio bash
ldd /app/lib/libqemu-xtensa.so
# Look for "not found" entries
```

### First boot is very slow

**Problem:** Container takes several minutes to become ready on first start.

**Cause:** The entrypoint script downloads and installs arduino-cli board cores:
- `arduino:avr` — ~150MB
- `rp2040:rp2040` — ~300MB

**Solution:** This is expected on first boot. The `arduino-libs` volume persists these installations, so subsequent starts are fast. Use the health check's `start_period: 90s` to give the container enough time.

### Build cache invalidation

**Problem:** Docker rebuild downloads everything from scratch despite no code changes.

**Cause:** The `COPY` instruction invalidates the cache if any file in the context changes.

**Solution:** The Dockerfile is structured to maximize cache reuse:
1. System packages (rarely change) — cached
2. `requirements.txt` copy + `pip install` — only invalidated when dependencies change
3. Application code copy — invalidated on every push

For the GitHub Actions cache:
```yaml
cache-from: type=gha
cache-to: type=gha,mode=max
```

The `mode=max` caches all intermediate layers, not just the final layer. This is important for the ESP-IDF stage which is very slow to build from scratch.

### Docker Hub token permissions

**Problem:** `docker-publish.yml` fails at the Docker Hub login step.

**Solution:** Create a Docker Hub access token:
1. Go to Docker Hub → Account Settings → Security → New Access Token
2. Set permissions to Read & Write
3. Add as GitHub repository secrets:
   - `DOCKERHUB_USERNAME` — Your Docker Hub username
   - `DOCKERHUB_TOKEN` — The access token

### QEMU build fails for ARM64

**Problem:** The `build-libqemu.yml` workflow fails on the `ubuntu-24.04-arm` runner.

**Possible causes:**
1. **Runner not available:** GitHub's ARM64 runners (`ubuntu-24.04-arm`) require a GitHub plan that supports them. Check your repository's Actions settings.
2. **Package differences:** The ARM64 container uses `ubuntu:22.04` which may have slightly different package versions. Check the build logs for missing dependencies.
3. **libiconv stub path:** The `dpkg-architecture` command must be available. It's part of `dpkg-dev` which may need to be installed explicitly in the container.

### WebSocket connection drops

**Problem:** ESP32 simulation WebSocket disconnects after a period of inactivity.

**Cause:** Default Nginx proxy timeouts.

**Solution:** The Nginx config sets 24-hour timeouts for WebSocket connections:
```nginx
proxy_read_timeout 86400s;
proxy_send_timeout 86400s;
```

If issues persist, check if there's a load balancer or CDN in front of Nginx that has its own timeout settings.

### Compilation timeout

**Problem:** Arduino compilation requests time out.

**Cause:** The default Nginx `proxy_read_timeout` may be too short for ESP32 compilation, which involves the full ESP-IDF build system.

**Solution:** The Nginx config sets a 5-minute timeout for API requests:
```nginx
proxy_read_timeout 300s;
```

For ESP32 first-time compilation (cold build cache), this may still not be enough. The ESP-IDF build system caches intermediate results, so subsequent compilations are much faster.

---

## File Reference

| File | Description |
|------|-------------|
| `Dockerfile.standalone` | Multi-stage Docker build (4 stages) |
| `.github/workflows/docker-publish.yml` | CI/CD: builds + pushes multi-arch image |
| `third-party/qemu-lcgamboa/.github/workflows/build-libqemu.yml` | CI/CD: builds QEMU .so for amd64 + arm64 |
| `docker/entrypoint.sh` | Container startup script |
| `docker/nginx.conf` | Nginx reverse proxy configuration |
| `docker-compose.yml` | Self-hosting compose file (production at github.com/velxio/velxio-prod) |
| `prebuilt/qemu/` | Local QEMU prebuilt files (optional, for dev) |
| `backend/.env` | Backend environment variables (not committed) |
