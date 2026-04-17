# MicroPython on ESP32 (QEMU) — Root Causes & Fixes

> **Scope**: This document covers every bug encountered when adding MicroPython simulation
> support for ESP32 boards in Velxio's QEMU-based emulation layer, the root cause of each
> bug, and exactly how it was fixed.  
> **Target audience**: future maintainers who need to understand *why* the injection pipeline
> is built the way it is.

---

## Table of Contents

1. [Architecture overview](#1-architecture-overview)
2. [Bug #1 — Invalid flash image header](#2-bug-1--invalid-flash-image-header)
3. [Bug #2 — Flash size mismatch](#3-bug-2--flash-size-mismatch)
4. [Bug #3 — QEMU IO-thread lock assertion on UART receive](#4-bug-3--qemu-io-thread-lock-assertion-on-uart-receive)
5. [Bug #4 — REPL prompt stuck in UART buffer](#5-bug-4--repl-prompt-stuck-in-uart-buffer)
6. [Bug #5 — Code injected before raw REPL mode confirmed](#6-bug-5--code-injected-before-raw-repl-mode-confirmed)
7. [Bug #6 — UART RX FIFO overflow truncates injected code](#7-bug-6--uart-rx-fifo-overflow-truncates-injected-code)
8. [Complete injection flow after all fixes](#8-complete-injection-flow-after-all-fixes)
9. [File map — what lives where](#9-file-map)
10. [End-to-end test](#10-end-to-end-test)

---

## 1. Architecture overview

MicroPython simulation works differently from Arduino simulation:

| Aspect | Arduino (C++) | MicroPython |
|---|---|---|
| Compilation | Backend compiles `.ino` via `arduino-cli` → `.bin` | No compilation — MicroPython firmware is a pre-built interpreter |
| Firmware source | `micropython.org/resources/firmware/ESP32_GENERIC-*.bin` (downloaded / cached in IndexedDB) | Same |
| Code delivery | Binary flashed at boot | Python source injected into the running REPL after boot via raw REPL protocol |
| GPIO | `gpio_change` events from QEMU worker | Same |

The full pipeline:

```
User's .py file
      │
      ▼
Esp32MicroPythonLoader.ts
  • Download firmware from micropython.org (or IndexedDB cache)
  • Place .bin at flash offset 0x1000
  • Pad flash image to 4 MB with 0xFF
  • Base64-encode the 4 MB image
      │
      ▼
useSimulatorStore.loadMicroPythonProgram()
  • Calls esp32Bridge.loadFirmware(b64)
  • Calls esp32Bridge.setPendingMicroPythonCode(userCode)
      │
      ▼
Esp32Bridge.connect()
  → WebSocket to backend → start_esp32 { board, firmware_b64 }
      │
      ▼
Backend: esp32_lib_manager → esp32_worker subprocess
  • Writes firmware to temp file
  • Starts QEMU with -drive file=<temp>.bin,if=mtd
      │
      ▼
QEMU boots MicroPython
  • Serial output flows back to Esp32Bridge via WebSocket
      │
      ▼
Esp32Bridge — 4-stage REPL injection state machine
  Stage 1: see "Type help()" banner → send \r to flush UART buffer
  Stage 2: see ">>>"              → send Ctrl+A (enter raw REPL)
  Stage 3: see "raw REPL"         → send code in 64-byte chunks + Ctrl+D
  Stage 4: done
```

---

## 2. Bug #1 — Invalid flash image header

### Symptom

```
invalid header: 0x7266204c
invalid header: 0x7266204c
invalid header: 0x7266204c
... (infinite loop)
```

### Root cause

The MicroPython `.bin` file was placed at flash offset `0x0` in the image passed to QEMU.

The ESP32 ROM bootloader reads its 2nd-stage bootloader from flash address **`0x1000`**, not `0x0`. Placing the firmware at `0x0` meant that when the ROM accessed `flash[0x1000]`, it found bytes from the middle of the MicroPython binary (e.g. `0x4C 0x20 0x66 0x72` = `"L fr"`) instead of the expected `0xE9` magic byte that identifies an ESP32 image.

The decode of `0x7266204c` is the ASCII string `"rf L"` — bytes 0x1000–0x1003 of the raw `.bin` when placed at offset 0.

### Fix

`Esp32MicroPythonLoader.ts` — `padToFlashSize()` now places the firmware at the correct offset per chip variant:

```typescript
// ESP32 (LX6): 2nd-stage bootloader must be at flash offset 0x1000
// ESP32-S3 / ESP32-C3: combined image starts at 0x0
const flashOffset = variant === 'esp32' ? 0x1000 : 0x0;

const padded = new Uint8Array(target).fill(0xFF);
padded.set(firmware, flashOffset);
```

**Verification**: `padded[0x1000]` must equal `0xE9` (ESP32 image magic byte).

---

## 3. Bug #2 — Flash size mismatch

### Symptom

```
E (3303) spi_flash: Detected size(2048k) smaller than the size in the binary image header(4096k). Probe failed.
Traceback (most recent call last):
  File "_boot.py", line 11, in <module>
  ...
OSError: (-24579, 'ESP_ERR_FLASH_NOT_INITIALISED')
```

### Root cause

MicroPython for ESP32 is built with `CONFIG_ESPTOOLPY_FLASHSIZE_4MB`, so its image header declares a 4 MB flash requirement. We were padding the flash image to only 2 MB (the minimum size that's ≥ the raw `.bin` length of ~1.5 MB). QEMU accepted the 2 MB image, but the MicroPython SPI flash driver read the header, compared against the actual image size, and aborted with `ESP_ERR_FLASH_NOT_INITIALISED`.

### Fix

Add a per-variant minimum flash size in `padToFlashSize()`:

```typescript
// ESP32 firmware declares 4 MB in its header — must match
const MIN_BYTES = variant === 'esp32' ? 4 * 1024 * 1024 : 2 * 1024 * 1024;
const target = VALID_BYTES.find(
  size => size >= Math.max(firmware.length + flashOffset, MIN_BYTES)
);
```

This ensures the flash image is always exactly 4 MB for ESP32 (LX6), regardless of firmware binary size.

---

## 4. Bug #3 — QEMU IO-thread lock assertion on UART receive

### Symptom

```
ERROR:../accel/tcg/tcg-accel-ops.c:83:tcg_handle_interrupt:
  assertion failed: (qemu_mutex_iothread_locked())
```
QEMU process crashed immediately after the first UART byte was injected.

### Root cause

`qemu_picsimlab_uart_receive()` injects a UART-RX interrupt into the guest CPU. The TCG accelerator requires the **QEMU IO-thread lock** to be held at the point of interrupt injection — this is the global lock that serialises all QEMU device accesses.

The `esp32_worker.py` command loop runs in a plain Python thread (stdin reader). That thread does not hold the QEMU IO-thread lock, so the assertion fires.

### Fix

`esp32_worker.py` — acquire the IO-thread lock before every `uart_receive` call and release it in a `finally` block:

```python
# Resolve lock/unlock functions once after loading the DLL
_lock_iothread   = lib.qemu_mutex_lock_iothread_impl
_lock_iothread.argtypes = [ctypes.c_char_p, ctypes.c_int]
_unlock_iothread = lib.qemu_mutex_unlock_iothread

# ... in the command loop:
elif c == 'uart_send':
    data = base64.b64decode(cmd['data'])
    buf  = (ctypes.c_uint8 * len(data))(*data)
    _lock_iothread(b'esp32_worker.py', 0)
    try:
        lib.qemu_picsimlab_uart_receive(int(cmd.get('uart', 0)), buf, len(data))
    finally:
        _unlock_iothread()
```

Both functions are exported from `libqemu-xtensa.dll`:
- `qemu_mutex_lock_iothread_impl(const char *file, int line)`
- `qemu_mutex_unlock_iothread(void)`

---

## 5. Bug #4 — REPL prompt stuck in UART buffer

### Symptom

MicroPython booted successfully (`"MicroPython v1.20.0 on 2023-04-26"` appeared in serial),
but `">>>"` never arrived at the frontend — code injection never started, and the test timed out.

### Root cause

The `_UartBuffer` class in `esp32_lib_manager.py` flushes accumulated bytes to the WebSocket only on `\n`, `\r`, `.`, or when the buffer reaches 256 bytes. The MicroPython REPL prompt `>>> ` is exactly 4 bytes with **no trailing newline**. It sat in the buffer indefinitely, never being dispatched to the frontend.

### Fix

After seeing the `"Type "help()""` banner line, send a `\r` byte to UART0. MicroPython responds by printing another `>>> ` prompt — that response is terminated by `\r`, which triggers the UART buffer flush.

**`Esp32Bridge.ts`** — Stage 1 of the injection state machine:

```typescript
if (this._replState === 'idle' && this._serialBuffer.includes('Type "help()"')) {
  this._replState = 'banner_seen';
  setTimeout(() => {
    this._send({ type: 'esp32_serial_input', data: { bytes: [0x0D] } }); // \r
  }, 800);
}
```

The 800 ms delay gives MicroPython time to complete its VFS initialisation before we send input.

---

## 6. Bug #5 — Code injected before raw REPL mode confirmed

### Symptom

The injected code appeared verbatim in the serial output, followed by a syntax error or
being echoed line-by-line — the classic sign that the REPL interpreted it as normal interactive input instead of compiling a complete script:

```
>>> from machine import Pin
>>> import time
>>>
  File "<stdin>", line 1
    # En muchos ESP32...
    ^
SyntaxError
```

### Root cause

The original injection sequence used a fixed timer:

```typescript
// ❌ Old approach — race condition
this.sendSerialBytes([0x01]);       // Ctrl+A
setTimeout(() => {
  sendCodeBytes();                  // code sent after 500ms blind delay
  this.sendSerialBytes([0x04]);     // Ctrl+D
}, 500);
```

On a loaded host the `qemu_picsimlab_uart_receive` IO cycle takes longer than 500 ms. `Ctrl+A` hadn't been processed by MicroPython yet when the code bytes arrived. The normal REPL received them and echoed/executed them line-by-line.

### Fix

A **4-stage state machine** that waits for confirmed serial output at each step before advancing:

```
idle
 │  see "Type help()" → send \r after 800ms
 ▼
banner_seen
 │  see ">>>" → send Ctrl+A after 200ms
 ▼
prompt_seen
 │  see "raw REPL; CTRL-B to exit" → send code after 200ms
 ▼
raw_repl_entered
 │  send code in 64-byte chunks + Ctrl+D
 ▼
idle (done)
```

**`Esp32Bridge.ts`** — the state machine in `case 'serial_output'`:

```typescript
// Stage 2: ">>>" → Ctrl+A
if (this._replState === 'banner_seen' && this._serialBuffer.includes('>>>')) {
  this._replState = 'prompt_seen';
  setTimeout(() => this._send({ type: 'esp32_serial_input', data: { bytes: [0x01] } }), 200);
}

// Stage 3: raw REPL confirmed → send code
if (this._replState === 'prompt_seen' && this._serialBuffer.includes('raw REPL')) {
  this._replState = 'raw_repl_entered';
  setTimeout(() => this._sendCodeInRawRepl(code), 200);
}
```

MicroPython prints `"raw REPL; CTRL-B to exit\r\n"` exactly once when `Ctrl+A` succeeds — this is the definitive confirmation that raw REPL mode is active.

---

## 7. Bug #6 — UART RX FIFO overflow truncates injected code

### Symptom

```
>OKTraceback (most recent call last):
  File "<stdin>", line 8, in <module>
NameError: name 'ti' isn't defined
```

The LED turned on but never turned off (`led.value(1)` ran, `time.sleep(1)` was cut short to `ti`).

### Root cause

The ESP32 UART RX FIFO is **128 bytes** in hardware — and QEMU emulates this faithfully. When `qemu_picsimlab_uart_receive()` is called with more than 128 bytes at once, the FIFO overflows and the excess bytes are **silently discarded**.

The user's LED blink code with its Spanish comment was ~244 bytes. The first 128 bytes were received successfully (up to `    ti` — the first two characters of `time.sleep(1)` on line 8). The remaining 116 bytes were dropped. MicroPython compiled the truncated source and failed at line 8 with `NameError: name 'ti'`.

```
Bytes 0–127:  "from machine import Pin\nimport time\n\n# ... comment ...\nled = Pin(4, Pin.OUT)\n\nwhile True:\n    led.value(1)\n    ti"
                                                                                                                        ^^^^ truncated here
Bytes 128–243: "me.sleep(1)\n\n    led.value(0)\n    time.sleep(1)\n"  ← ALL DROPPED
```

### Fix

Send code in **≤64-byte chunks** with a **150 ms gap** between each, giving QEMU time to drain the FIFO before the next chunk arrives:

```typescript
// esp32_worker.py: UART RX FIFO = 128 bytes. Keep chunks ≤64 bytes
// so there is always headroom even if QEMU hasn't fully drained yet.
const CHUNK_SIZE     = 64;
const CHUNK_DELAY_MS = 150;

const sendChunk = () => {
  if (offset >= codeBytes.length) {
    setTimeout(() => this.sendSerialBytes([0x04]), 300); // Ctrl+D after FIFO drains
    return;
  }
  this.sendSerialBytes(codeBytes.slice(offset, offset + CHUNK_SIZE));
  offset += CHUNK_SIZE;
  setTimeout(sendChunk, CHUNK_DELAY_MS);
};
sendChunk();
```

For a 244-byte script this adds ~600 ms of injection time — imperceptible in a simulation context.

---

## 8. Complete injection flow after all fixes

```
[Frontend] Esp32MicroPythonLoader.ts
  1. Download .bin from micropython.org (or IndexedDB cache)
  2. Place .bin at flash[0x1000]               ← Bug #1 fix
  3. Pad to exactly 4 MB                       ← Bug #2 fix
  4. Base64-encode → send as firmware_b64

[Backend] esp32_worker.py
  5. Write flash image to temp file
  6. Launch QEMU: -drive file=<tmp>.bin,if=mtd
  7. QEMU boots → ROM reads 2nd-stage from 0x1000 ✓
  8. MicroPython VFS mounts on SPI flash ✓

[Frontend] Esp32Bridge.ts — REPL injection state machine
  Stage 1: "Type help()" in serial
           → wait 800ms → send \r                ← Bug #4 fix
  Stage 2: ">>>" in serial
           → wait 200ms → send Ctrl+A (0x01)
  Stage 3: "raw REPL; CTRL-B to exit" in serial  ← Bug #5 fix
           → wait 200ms → start chunked send
  Code delivery: 64-byte chunks, 150ms apart      ← Bug #6 fix
  When all bytes sent: wait 300ms → send Ctrl+D

[Backend] esp32_worker.py — uart_send command
  9. Acquire qemu_mutex_lock_iothread_impl()      ← Bug #3 fix
  10. Call qemu_picsimlab_uart_receive()
  11. Release qemu_mutex_unlock_iothread()

[QEMU] MicroPython compiles and executes script
  → GPIO changes → gpio_change events → frontend LED updates
```

---

## 9. File map — what lives where

| File | Responsibility |
|---|---|
| `frontend/src/simulation/Esp32MicroPythonLoader.ts` | Download firmware, build flash image (offset + padding), base64 encode |
| `frontend/src/simulation/Esp32Bridge.ts` | WebSocket bridge; 4-stage REPL injection state machine; code sanitization; chunked send |
| `frontend/src/store/useSimulatorStore.ts` | Calls `loadMicroPythonProgram()` → sets firmware + pending code on bridge; always stops before re-starting |
| `frontend/src/components/editor/EditorToolbar.tsx` | Stops current session before re-run to prevent double `start_esp32` |
| `backend/app/services/esp32_worker.py` | QEMU worker subprocess; IO-thread lock around `uart_receive`; `qemu_system_shutdown_request` for clean stop |
| `backend/app/services/esp32_lib_manager.py` | Manages worker processes; routes `uart_send` commands; `_UartBuffer` byte accumulator |
| `test/backend/e2e/test_micropython_esp32.mjs` | End-to-end test: downloads firmware, builds flash image, runs simulation, injects code, verifies output |

---

## 10. End-to-end test

`test/backend/e2e/test_micropython_esp32.mjs` validates the full pipeline:

```bash
# Requires backend running on :8001
node test/backend/e2e/test_micropython_esp32.mjs --timeout=60
```

**What it checks:**

| Check | Validates |
|---|---|
| Magic byte `0xE9` at flash offset `0x1000` | Bug #1 fix |
| No "smaller than binary image header" in serial | Bug #2 fix |
| No `OSError: ESP_ERR_FLASH_NOT_INITIALISED` | Bug #2 fix |
| `"MicroPython v1.20.0"` banner appears | QEMU boots cleanly |
| `">>>"` prompt received | Bug #4 fix (UART flush) |
| `"raw REPL; CTRL-B to exit"` received | Bug #5 fix (raw REPL confirmed) |
| `"velxio_micropython_ok"` in output | Injection works end-to-end |
| `"math_check:42"` in output (`6*7=42`) | Code runs without truncation (Bug #6 fix) |

Expected output on success:

```
[OK] Magic byte 0xE9 confirmed at flash offset 0x1000
[OK] MicroPython booted: MicroPython v1.20.0 on 2023-04-26; ESP32 module with ESP32
[OK] Stage 2: >>> seen → sending Ctrl+A
[OK] Stage 3: raw REPL confirmed → sending code in 64-byte chunks
[OK] Output marker "velxio_micropython_ok" received ✓
[OK] Math check "6*7=42" confirmed ✓
[OK] ALL CHECKS PASSED ✓
```

---

## Additional notes

### Non-ASCII in comments (MicroPython tokenizer limitation)

MicroPython v1.20 on ESP32 uses a **byte-oriented tokenizer** that does not handle UTF-8 multi-byte sequences in source code. Characters like `á` (`\xC3\xA1`) or `ú` (`\xC3\xBA`) in comments produce `SyntaxError` at an unrelated line because the tokenizer misinterprets the continuation byte.

`Esp32Bridge._sanitizeForRepl()` replaces non-ASCII characters in comments with `?` before injection:

```typescript
// Line comments: # ... → replace non-ASCII
s = s.replace(/^([ \t]*#.*)$/gm, line => line.replace(/[^\x00-\x7F]/g, '?'));
// Inline comments
s = s.replace(/([ \t]+#.*)$/gm, c => c.replace(/[^\x00-\x7F]/g, '?'));
```

This only affects comment text — identifiers and string literals are untouched.

### Why Ctrl+E (raw-paste mode) was not used

MicroPython has a faster injection protocol called **raw-paste mode** (`Ctrl+E`). It uses a flow-control handshake: the host sends 256 bytes, waits for a `\x01` ACK token from the device, then sends the next 256 bytes.

We do not implement this handshake — it requires a bidirectional byte-level protocol on top of the existing WebSocket/UART path. The simple **raw REPL** (`Ctrl+A` / code / `Ctrl+D`) is sufficient and avoids that complexity.

### QEMU stop — `blk_exp_close_all_type` assertion

Calling `qemu_cleanup()` directly from the Python command-loop thread triggers:

```
ERROR:../block/export/export.c:302:blk_exp_close_all_type:
  assertion failed: (in_aio_context_home_thread(qemu_get_aio_context()))
```

Block device teardown must happen on the QEMU AIO context home thread. The fix is to call `qemu_system_shutdown_request(3)` instead — this posts a shutdown event to the QEMU main loop, which processes it on the correct thread.
