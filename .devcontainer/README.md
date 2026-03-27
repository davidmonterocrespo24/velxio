# DevContainer for Velxio

This devcontainer provides a ready-to-use development environment for Velxio with:

- Python 3.12 + FastAPI backend setup
- Node.js 20 + React/Vite frontend setup
- arduino-cli with AVR and RP2040 cores
- Built wokwi-libs (avr8js, rp2040js, wokwi-elements)
- Persistent volumes for node_modules and arduino cache

## What's Included

### Automatically Installed
- **Arduino AVR** — Arduino Uno, Nano, Mega emulation
- **RP2040** — Raspberry Pi Pico / Pico W emulation
- **Frontend tooling** — TypeScript, ESLint, Tailwind CSS
- **Backend tooling** — Python virtual environment with all dependencies

### Not Included (Manual Setup)
- **ESP32 Emulation (QEMU)** — Requires platform-specific compilation

## Why ESP32 QEMU is Manual

ESP32 emulation requires building QEMU from the lcgamboa fork, which:
- Takes 15-30 minutes to compile
- Requires platform-specific tools (MSYS2 on Windows, build-essential on Linux)
- Generates 40-60 MB libraries excluded from git
- Is optional — AVR and RP2040 work without it

**For Docker users:** ESP32 emulation is pre-built and included in the official image.

**For development:** If you need ESP32 emulation, see [docs/ESP32_EMULATION.md](../docs/ESP32_EMULATION.md)

## Getting Started

1. Open this repository in VS Code with the Dev Containers extension
2. VS Code will automatically build and start the devcontainer
3. Wait for `post-create.sh` to complete (~5-6 minutes)
4. Start the backend: `cd backend && source venv/bin/activate && uvicorn app.main:app --reload --port 8001`
5. Start the frontend: `cd frontend && npm run dev`
6. Open http://localhost:5173

## Optimization Notes

- **Shallow clones** — wokwi-libs use `--depth=1` for faster setup (not recursive submodules)
- **Parallel builds** — Backend, frontend, and wokwi-libs build concurrently
- **Volume mounts** — node_modules and arduino cache persist between rebuilds
- **User-local tools** — arduino-cli installs to `~/.local/bin` (no sudo required)

## Ports Forwarded

- **5173** — Frontend (Vite dev server)
- **8001** — Backend (FastAPI)

## Troubleshooting

### Builds are slow
First-time setup takes 5-6 minutes. Subsequent container starts use `post-start.sh` which only syncs dependencies (~30 seconds).

### Permission errors on volumes
The `post-create.sh` script fixes ownership automatically. If you still see errors, rebuild the container.

### Arduino cores missing
Check that arduino-cli is in PATH:
```bash
arduino-cli version
arduino-cli core list  # should show arduino:avr and rp2040:rp2040
```

## Related Documentation

- [Getting Started](../docs/getting-started.md) — Manual setup instructions
- [ESP32 Emulation](../docs/ESP32_EMULATION.md) — Full ESP32 setup guide
- [Architecture](../docs/ARCHITECTURE.md) — Project architecture overview
