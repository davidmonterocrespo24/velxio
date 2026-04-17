# MicroPython Implementation — Technical Summary

> Issue #3 — Full MicroPython support for RP2040, ESP32, ESP32-S3, and ESP32-C3 boards.
> Branch: `feature/micropython-rp2040`

---

## Overview

Velxio supports MicroPython across **15 board variants** using two distinct execution strategies:

| Strategy | Boards | Execution | Serial |
|----------|--------|-----------|--------|
| **Browser-side** (rp2040js) | Raspberry Pi Pico, Pico W | In-browser at 125 MHz | USBCDC |
| **QEMU backend** (WebSocket) | ESP32, ESP32-S3, ESP32-C3 (13 variants) | Remote `qemu-system-xtensa` / `qemu-system-riscv32` | UART via WebSocket |

### Supported Boards

```
RP2040 (browser):       raspberry-pi-pico, pi-pico-w
ESP32 Xtensa (QEMU):    esp32, esp32-devkit-c-v4, esp32-cam, wemos-lolin32-lite
ESP32-S3 Xtensa (QEMU): esp32-s3, xiao-esp32-s3, arduino-nano-esp32
ESP32-C3 RISC-V (QEMU): esp32-c3, xiao-esp32-c3, aitewinrobot-esp32c3-supermini
```

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  User clicks "Run" with MicroPython mode                    │
│                                                             │
│  EditorToolbar.handleRun()                                  │
│    └── loadMicroPythonProgram(boardId, pyFiles)             │
│          ├── RP2040?  → sim.loadMicroPython(files)          │
│          │               ├── getFirmware()    [IndexedDB/remote/bundled]
│          │               ├── loadUF2()        [parse UF2 → flash]
│          │               ├── loadUserFiles()  [LittleFS → flash]
│          │               └── USBCDC serial    [REPL via USB CDC]
│          │                                                  │
│          └── ESP32?   → getEsp32Firmware()                  │
│                          ├── base64 encode                  │
│                          ├── bridge.loadFirmware(b64)       │
│                          └── bridge.setPendingMicroPythonCode()
│                               └── on ">>>" detected:       │
│                                    _injectCodeViaRawPaste() │
│                                    \x01 → \x05 → code → \x04
└─────────────────────────────────────────────────────────────┘
```

---

## Phase 1: RP2040 MicroPython (Browser-Side)

### Files Created/Modified

| File | Action |
|------|--------|
| `frontend/src/simulation/MicroPythonLoader.ts` | **Created** — UF2 parser, LittleFS builder, firmware cache |
| `frontend/src/simulation/RP2040Simulator.ts` | Modified — `loadMicroPython()`, USBCDC serial, `micropythonMode` |
| `frontend/src/types/board.ts` | Modified — `LanguageMode` type, `BOARD_SUPPORTS_MICROPYTHON` set |
| `frontend/src/store/useSimulatorStore.ts` | Modified — `loadMicroPythonProgram`, `setBoardLanguageMode` |
| `frontend/src/store/useEditorStore.ts` | Modified — `DEFAULT_MICROPYTHON_CONTENT`, `createFileGroup` overload |
| `frontend/src/components/editor/EditorToolbar.tsx` | Modified — language selector, MicroPython compile/run flow |
| `frontend/src/components/simulator/SerialMonitor.tsx` | Modified — Ctrl+C/D, REPL label |
| `frontend/public/firmware/micropython-rp2040.uf2` | **Created** — bundled fallback (638 KB) |

### UF2 Firmware Loading

MicroPython for RP2040 uses UF2 format (USB Flashing Format). Each block is 512 bytes:

```
Offset  Field
0       Magic 0 (0x0a324655)
4       Magic 1 (0x9e5d5157)
12      Flash address (little-endian)
32      Payload data (256 bytes)
```

Constants:
```typescript
FLASH_START_ADDRESS      = 0x10000000  // RP2040 XIP flash base
MICROPYTHON_FS_FLASH_START = 0xa0000   // LittleFS starts at 640KB
MICROPYTHON_FS_BLOCK_SIZE  = 4096
MICROPYTHON_FS_BLOCK_COUNT = 352       // 1.4 MB filesystem
```

### LittleFS Filesystem

User files (e.g., `main.py`) are written into a LittleFS image in memory using the `littlefs` WASM package:

1. Create backing buffer: `352 × 4096 = 1,441,792 bytes`
2. Register 4 WASM callbacks via `addFunction()`:
   - `flashRead(cfg, block, off, buffer, size)` — reads from JS buffer
   - `flashProg(cfg, block, off, buffer, size)` — writes to JS buffer
   - `flashErase(cfg, block)` — no-op
   - `flashSync()` — no-op
3. Format and mount: `_lfs_format()` → `_lfs_mount()`
4. Write files: `cwrap('lfs_write_file')` for each user file
5. Unmount and copy into flash at offset `0xa0000`

### USBCDC Serial (not UART)

MicroPython on RP2040 uses USB CDC for the REPL, not UART0:

```typescript
// In RP2040Simulator.loadMicroPython():
this.usbCDC = new USBCDC(rp2040.usbCtrl);
this.usbCDC.onDeviceConnected = () => this.usbCDC.sendSerialByte('\r'.charCodeAt(0));
this.usbCDC.onSerialData = (value) => { /* forward to SerialMonitor */ };

// Serial write routes through USBCDC when micropythonMode is true:
serialWrite(text: string): void {
  if (this.micropythonMode && this.usbCDC) {
    for (const ch of text) this.usbCDC.sendSerialByte(ch.charCodeAt(0));
  } else {
    this.rp2040?.uart[0].feedByte(...);
  }
}
```

### Firmware Caching Strategy

All firmware uses a 3-tier loading strategy:

1. **IndexedDB cache** — instant load via `idb-keyval`
2. **Remote download** — from `micropython.org` with streaming progress
3. **Bundled fallback** — from `/firmware/` (Vite public directory)

Cache key: `micropython-rp2040-uf2-v1.20.0`

---

## Phase 2: ESP32/ESP32-S3 MicroPython (QEMU Backend)

### Files Created/Modified

| File | Action |
|------|--------|
| `frontend/src/simulation/Esp32MicroPythonLoader.ts` | **Created** — firmware download/cache for ESP32 variants |
| `frontend/src/simulation/Esp32Bridge.ts` | Modified — `setPendingMicroPythonCode()`, raw-paste injection |
| `frontend/src/store/useSimulatorStore.ts` | Modified — ESP32 path in `loadMicroPythonProgram` |
| `frontend/src/store/useEditorStore.ts` | Modified — `DEFAULT_ESP32_MICROPYTHON_CONTENT` |
| `frontend/src/components/simulator/SerialMonitor.tsx` | Modified — generic Ctrl+C/D for all boards |
| `frontend/public/firmware/micropython-esp32.bin` | **Created** — bundled fallback (1.5 MB) |
| `frontend/public/firmware/micropython-esp32s3.bin` | **Created** — bundled fallback (1.4 MB) |

### Firmware Variants

```typescript
FIRMWARE_MAP = {
  'esp32':    { remote: '.../ESP32_GENERIC-20230426-v1.20.0.bin',    cacheKey: 'micropython-esp32-v1.20.0'    },
  'esp32-s3': { remote: '.../ESP32_GENERIC_S3-20230426-v1.20.0.bin', cacheKey: 'micropython-esp32s3-v1.20.0'  },
  'esp32-c3': { remote: '.../ESP32_GENERIC_C3-20230426-v1.20.0.bin', cacheKey: 'micropython-esp32c3-v1.20.0'  },
}
```

Board kind → firmware variant mapping:
```
esp32, esp32-devkit-c-v4, esp32-cam, wemos-lolin32-lite      → 'esp32'
esp32-s3, xiao-esp32-s3, arduino-nano-esp32                  → 'esp32-s3'
esp32-c3, xiao-esp32-c3, aitewinrobot-esp32c3-supermini      → 'esp32-c3'
```

### Raw-Paste REPL Protocol

Unlike RP2040 (which loads files into LittleFS), ESP32 boards inject user code into the MicroPython REPL after boot using the **raw-paste protocol**:

```
Step 1: Wait for ">>>" in serial output (REPL ready)
Step 2: Send \x01 (Ctrl+A) — enter raw REPL mode
Step 3: Send \x05 (Ctrl+E) — enter raw-paste mode
Step 4: Send code bytes in 256-byte chunks (10ms between chunks)
Step 5: Send \x04 (Ctrl+D) — execute the code
```

Implementation in `Esp32Bridge`:

```typescript
// State fields
private _pendingMicroPythonCode: string | null = null;
private _serialBuffer = '';
micropythonMode = false;

// In serial_output handler — detect REPL prompt
if (this._pendingMicroPythonCode && this._serialBuffer.includes('>>>')) {
  this._injectCodeViaRawPaste(this._pendingMicroPythonCode);
  this._pendingMicroPythonCode = null;
}

// Timing: 500ms initial delay → 100ms after Ctrl+A → 100ms after Ctrl+E
//         → 10ms between 256-byte chunks → 50ms before Ctrl+D
```

### WebSocket Protocol Flow

```
Frontend                          Backend (QEMU)
   │                                   │
   │ start_esp32 { firmware_b64, board }
   │──────────────────────────────────→│
   │                                   │ QEMU boots MicroPython
   │                                   │
   │ serial_output { data: ">>>" }     │
   │←──────────────────────────────────│
   │                                   │
   │ esp32_serial_input { bytes: [0x01] }  ← Ctrl+A (raw REPL)
   │──────────────────────────────────→│
   │                                   │
   │ esp32_serial_input { bytes: [0x05] }  ← Ctrl+E (raw-paste)
   │──────────────────────────────────→│
   │                                   │
   │ esp32_serial_input { bytes: [...code...] }  ← code chunks
   │──────────────────────────────────→│
   │                                   │
   │ esp32_serial_input { bytes: [0x04] }  ← Ctrl+D (execute)
   │──────────────────────────────────→│
   │                                   │
   │ serial_output { data: "...output..." }
   │←──────────────────────────────────│
```

---

## Phase 3: ESP32-C3 MicroPython

### Files Modified

| File | Action |
|------|--------|
| `frontend/src/types/board.ts` | Modified — added C3 boards to `BOARD_SUPPORTS_MICROPYTHON`, fixed comments |
| `frontend/src/simulation/Esp32MicroPythonLoader.ts` | Modified — added `esp32-c3` firmware variant |
| `frontend/public/firmware/micropython-esp32c3.bin` | **Created** — bundled fallback (1.4 MB) |

### Key Finding

ESP32-C3 boards were documented as "browser emulation (Esp32C3Simulator)" in the type definitions, but the actual runtime code routes them through `Esp32Bridge` (QEMU backend) — the `Esp32C3Simulator` is dead code. This was corrected.

The `isEsp32Kind()` function in `useSimulatorStore.ts` already included C3 boards, so the QEMU bridge infrastructure was already wired up. Only the MicroPython-specific additions were needed.

---

## Store Integration

### `loadMicroPythonProgram(boardId, files)`

```typescript
// In useSimulatorStore.ts
async loadMicroPythonProgram(boardId, files) {
  if (isEsp32Kind(board.boardKind)) {
    // ESP32 path: firmware → QEMU bridge → raw-paste injection
    const firmware = await getEsp32Firmware(board.boardKind);
    const b64 = uint8ArrayToBase64(firmware);
    esp32Bridge.loadFirmware(b64);
    esp32Bridge.setPendingMicroPythonCode(mainFile.content);
  } else {
    // RP2040 path: firmware + LittleFS in browser
    await sim.loadMicroPython(files);
  }
  // Mark as loaded
  board.compiledProgram = 'micropython-loaded';
}
```

### `setBoardLanguageMode(boardId, mode)`

When toggling between Arduino and MicroPython:
1. Stops any running simulation
2. Clears `compiledProgram`
3. Deletes old file group
4. Creates new file group with appropriate defaults:
   - RP2040 MicroPython → `main.py` with `Pin(25)` blink
   - ESP32 MicroPython → `main.py` with `Pin(2)` blink
   - Arduino → `sketch.ino` with default Arduino code

---

## UI Integration

### Language Mode Selector

Appears in `EditorToolbar` next to the board name pill when `BOARD_SUPPORTS_MICROPYTHON.has(boardKind)`:

```
[Arduino C++ ▼]  ↔  [MicroPython ▼]
```

Changing the selector:
- Switches `languageMode` on the `BoardInstance`
- Replaces editor files with language-appropriate defaults
- Updates compile button text: "Compile (Ctrl+B)" → "Load MicroPython"

### Serial Monitor

- **REPL label**: Shows "MicroPython REPL" in magenta when in MicroPython mode
- **Baud rate**: Hidden in MicroPython mode (REPL has no baud rate)
- **Ctrl+C**: Sends `\x03` (keyboard interrupt) — works for both RP2040 and ESP32
- **Ctrl+D**: Sends `\x04` (soft reset) — works for both RP2040 and ESP32
- **Placeholder**: "Type Python expression... (Ctrl+C to interrupt)"

### Run Button Behavior

For MicroPython boards, the Run button:
1. If firmware not yet loaded → auto-loads firmware first, then starts
2. If already loaded → starts simulation directly
3. Enabled even without `compiledProgram` (unlike Arduino mode)

---

## Firmware Files

| File | Size | Board | Version |
|------|------|-------|---------|
| `micropython-rp2040.uf2` | 638 KB | RP2040 | v1.20.0 (2023-04-26) |
| `micropython-esp32.bin` | 1.5 MB | ESP32 Xtensa | v1.20.0 (2023-04-26) |
| `micropython-esp32s3.bin` | 1.4 MB | ESP32-S3 Xtensa | v1.20.0 (2023-04-26) |
| `micropython-esp32c3.bin` | 1.4 MB | ESP32-C3 RISC-V | v1.20.0 (2023-04-26) |

All firmware uses MicroPython **v1.20.0** (stable release, 2023-04-26).

Firmware source: `https://micropython.org/resources/firmware/`

---

## Dependencies Added

| Package | Version | Purpose |
|---------|---------|---------|
| `littlefs` | 0.1.0 | LittleFS WASM for creating filesystem images (RP2040) |
| `idb-keyval` | 6.x | IndexedDB key-value wrapper for firmware caching |

---

## Git History

```
990ae4b feat: add MicroPython support for RP2040 boards (Pico / Pico W)
7c9fd0b feat: add MicroPython support for ESP32/ESP32-S3 boards via QEMU bridge
0bc4c03 feat: add MicroPython support for ESP32-C3 (RISC-V) boards
```

| Commit | Files Changed | Lines Added | Lines Removed |
|--------|:------------:|:-----------:|:------------:|
| `990ae4b` (RP2040) | 12 | +587 | -38 |
| `7c9fd0b` (ESP32/S3) | 8 | +296 | -33 |
| `0bc4c03` (ESP32-C3) | 3 | +16 | -4 |
| **Total** | **23** | **+899** | **-75** |
