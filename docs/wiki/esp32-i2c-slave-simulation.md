# ESP32 I2C Slave Simulation — Investigation, Root Causes & Fixes

> **Scope**: This document covers the full debugging journey and all fixes applied to make
> I2C sensor simulation work correctly in the lcgamboa QEMU ESP32 emulation layer used by Velxio.
> Specifically, it documents the work to make `Adafruit_MPU6050::begin()` and `Adafruit_BMP280::begin()`
> return `true` so that the serial monitor shows real sensor data instead of "MPU6050 not found!" /
> "BMP280 not found! Check wiring.".
> Target audience: future maintainers who need to understand *why* the I2C slave code is the way it is.

---

## Table of Contents

1. [Background — how I2C slaves plug into the QEMU emulation](#1-background)
2. [Root cause 1 — wrong I2C event constants](#2-root-cause-1--wrong-i2c-event-constants)
3. [Root cause 2 — wrong ACK return value convention](#3-root-cause-2--wrong-ack-return-value-convention)
4. [Root cause 3 — reg_ptr never set (WRITE events not firing)](#4-root-cause-3--reg_ptr-never-set)
5. [The picsimlab I2C protocol (ground truth)](#5-the-picsimlab-i2c-protocol-ground-truth)
6. [How write-then-read works in QEMU](#6-how-write-then-read-works-in-qemu)
7. [Final implementation of MPU6050Slave](#7-final-implementation-of-mpu6050slave)
8. [Other slaves fixed (BMP280, DS1307, DS3231)](#8-other-slaves-fixed)
9. [Root cause 4 — BMP280 wrong chip ID (0x60 vs 0x58)](#9-root-cause-4--bmp280-wrong-chip-id)
10. [Test suite](#10-test-suite)
11. [Debugging infrastructure added and later removed](#11-debugging-infrastructure)
12. [End-to-end verification](#12-end-to-end-verification)

---

## 1. Background

The Velxio ESP32 simulation runs on the [lcgamboa fork of QEMU](https://github.com/lcgamboa/qemu)
(`wokwi-libs/qemu-lcgamboa`), which exposes a set of C callback hooks called **picsimlab hooks**.
These allow Python code to respond to hardware events — GPIO changes, UART bytes, and I2C
transactions — without modifying QEMU itself.

The I2C slave machinery lives in two files:

| File | Purpose |
|---|---|
| `backend/app/services/esp32_i2c_slaves.py` | One Python class per I2C device (MPU6050, BMP280, DS1307, DS3231). Each class implements `handle_event(event: int) -> int`. |
| `backend/app/services/esp32_worker.py` | Registers `_on_i2c_event` as the QEMU I2C callback. Dispatches events to the correct slave by I2C address. |

When firmware calls `Wire.beginTransmission(addr)` / `Wire.write(reg)` / `Wire.endTransmission()` /
`Wire.requestFrom(addr, n)`, QEMU fires a sequence of events at the registered callback.

---

## 2. Root Cause 1 — Wrong I2C Event Constants

### What was wrong — event constants

The original constants in `esp32_i2c_slaves.py` were:

```python
# WRONG — do not use
I2C_STOP  = 0x00   # was actually START_RECV
I2C_START = 0x01   # correct label but wrong meaning assigned
I2C_READ  = 0x03   # was actually FINISH
_I2C_WRITE_CODES = (0x05, 0x06)  # 0x06 was actually READ
```

These were guessed without consulting the QEMU source and were wrong for three of the five event
types — causing every I2C transaction to be misinterpreted.

### How we found the ground truth

The picsimlab I2C C source lives at:

```
wokwi-libs/qemu-lcgamboa/hw/i2c/picsimlab_i2c.c
wokwi-libs/qemu-lcgamboa/include/hw/i2c/i2c.h
```

Reading `i2c.h` gives the QEMU `i2c_event` enum:

```c
typedef enum {
    I2C_START_RECV       = 0,  // firmware called requestFrom (read direction)
    I2C_START_SEND       = 1,  // firmware called beginTransmission (write direction)
    I2C_START_SEND_ASYNC = 2,
    I2C_FINISH           = 3,  // end of transaction (STOP or repeated-START)
    I2C_NACK             = 4,
} i2c_event;
```

Reading `picsimlab_i2c.c` gives the encoding for the Python `event` integer:

```c
// A byte written by firmware → (data << 8) | (I2C_NACK + 1)  =  (data << 8) | 5
picsimlab_i2c_tx(data):  event = (data << 8) | 0x05

// Firmware requesting a byte → I2C_NACK + 2  =  6
picsimlab_i2c_rx():      event = 0x06          // return value = byte to send back

// A bus event (start/finish/nack) → raw enum value (0–4)
picsimlab_i2c_ev(event): event = enum value
```

### Correct constants (current code)

```python
I2C_START_RECV = 0x00   # firmware called requestFrom
I2C_START_SEND = 0x01   # firmware called beginTransmission
I2C_FINISH     = 0x03   # end of transaction (STOP or repeated-START)
I2C_WRITE      = 0x05   # data byte written by firmware; data = (event >> 8) & 0xFF
I2C_READ       = 0x06   # firmware requesting a byte; return value = the byte
```

---

## 3. Root Cause 2 — Wrong ACK Return Value Convention

### What was wrong — ACK convention

All slave `handle_event` methods returned `1` for "device present / ACK" and `0` for "not present".
This is the **opposite** of what QEMU expects.

### QEMU ACK convention

From the QEMU I2C core (`hw/i2c/core.c`):

```
i2c_start_transfer() returns:
  0  → ACK  (device acknowledged, transfer proceeds)
  1  → NACK (device not present, transfer aborted immediately)
```

### Consequence of the bug

Every `START_SEND` (beginTransmission) returned `1` = NACK.
QEMU saw NACK on the very first event and **aborted the transfer**.
No subsequent WRITE events were ever delivered.
`detected()` always failed → `begin()` always returned `false`.

### Fix

Changed every ACK return from `1` to `0`:

```python
if op in (I2C_START_RECV, I2C_START_SEND):
    self.first_byte = True
    return 0   # 0 = ACK in QEMU convention
```

This single change was what made WRITE events start firing.

---

## 4. Root Cause 3 — reg_ptr Never Set

### What was wrong (earlier attempt)

Before root causes 1 & 2 were found, the symptom was: WRITE events never fired, so `reg_ptr`
was never updated from its default of `0`. Every READ returned `regs[0] = 0x00` instead of
`regs[0x75] = 0x68` (WHO_AM_I).

Multiple heuristic workarounds were attempted (counting WHO_AM_I reads, defaulting `reg_ptr`
to `0x75`, a `_first_read_done` flag, auto-advancing to `0x3B` after the first read). All of
these were band-aids on the wrong root cause.

### Why they are no longer needed

Once root causes 1 & 2 were fixed:

- WRITE events fire correctly for every `Wire.write(reg)` call.
- `reg_ptr` is set by the WRITE phase and preserved into the READ phase via RSTART.
- No heuristics are needed. The code is simple and correct.

---

## 5. The picsimlab I2C Protocol (Ground Truth)

### Event encoding summary

| Python `event` value | Meaning | data byte |
|---|---|---|
| `0x00` | START_RECV — firmware called `requestFrom` | — |
| `0x01` | START_SEND — firmware called `beginTransmission` | — |
| `0x02` | START_SEND_ASYNC | — |
| `0x03` | FINISH — STOP bit or repeated-START | — |
| `0x04` | NACK | — |
| `(data<<8)\|0x05` | WRITE — firmware wrote byte `data` | `(event >> 8) & 0xFF` |
| `0x06` | READ — firmware is reading; return value = byte | return byte |

### Return value convention

| Return value | Meaning |
|---|---|
| `0` | ACK — device is present, operation succeeded |
| non-zero | NACK — device absent or error |

**For READ events**, the return value is the data byte, not an ACK/NACK. QEMU uses the
return value directly as the byte to deliver to the firmware.

---

## 6. How Write-Then-Read Works in QEMU

The Adafruit BusIO `write_then_read` pattern (used by `MPU6050::begin()`, `getEvent()`, etc.)
maps to:

```
Wire.beginTransmission(addr)   → START_SEND (0x01)
Wire.write(reg)                → WRITE      (reg<<8)|0x05
Wire.endTransmission(false)    → FINISH     (0x03)   ← repeated-START, NOT a STOP
Wire.requestFrom(addr, n)      → START_RECV (0x00)
Wire.read() × n                → READ       (0x06) × n
                               → FINISH     (0x03)
```

**Critical**: `reg_ptr` must NOT be reset on FINISH when it is a repeated-START. The write
phase sets `reg_ptr` and the read phase (which starts immediately after) uses it. In the
implementation, `reg_ptr` is only reset implicitly — `first_byte` is reset on START so the
next WRITE byte becomes the new register pointer.

### `Adafruit_MPU6050::detected()` pattern

`detected()` only calls `endTransmission()` (no `requestFrom`):

```
START_SEND → FINISH
```

The slave must return `0` (ACK) on `START_SEND` for `detected()` to return `true`.

---

## 7. Final Implementation of MPU6050Slave

```python
I2C_START_RECV = 0x00
I2C_START_SEND = 0x01
I2C_FINISH     = 0x03
I2C_WRITE      = 0x05
I2C_READ       = 0x06

class MPU6050Slave:
    def __init__(self, addr: int = 0x68):
        self.addr = addr
        self.regs = bytearray(256)
        self.reg_ptr = 0
        self.first_byte = True

        # Register defaults
        self.regs[0x75] = 0x68   # WHO_AM_I
        self.regs[0x6B] = 0x00   # PWR_MGMT_1 — awake (SLEEP bit cleared)
        self.regs[0x3B] = 0x00   # ACCEL_XOUT_H
        self.regs[0x3C] = 0x00   # ACCEL_XOUT_L
        self.regs[0x3D] = 0x00   # ACCEL_YOUT_H
        self.regs[0x3E] = 0x00   # ACCEL_YOUT_L
        self.regs[0x3F] = 0x40   # ACCEL_ZOUT_H  (+1g, 16384 LSB/g at ±2g range)
        self.regs[0x40] = 0x00   # ACCEL_ZOUT_L
        self.regs[0x41] = 0x62   # TEMP_OUT_H    (25 °C = 0x6240 raw)
        self.regs[0x42] = 0x40   # TEMP_OUT_L
        self.regs[0x43] = 0x00   # GYRO_XOUT_H   (0 °/s)
        # ... GYRO Y/Z also 0x00

    def handle_event(self, event: int) -> int:
        op   = event & 0xFF
        data = (event >> 8) & 0xFF

        if op in (I2C_START_RECV, I2C_START_SEND):
            self.first_byte = True
            return 0                    # ACK

        elif op == I2C_WRITE:
            if self.first_byte:
                self.reg_ptr = data     # first WRITE byte = register address
                self.first_byte = False
            else:
                self.regs[self.reg_ptr] = data
                if self.reg_ptr == 0x6B:
                    self.regs[0x6B] &= 0x7F   # auto-clear DEVICE_RESET bit
                self.reg_ptr = (self.reg_ptr + 1) & 0xFF
            return 0                    # ACK

        elif op == I2C_READ:
            val = self.regs[self.reg_ptr]
            self.reg_ptr = (self.reg_ptr + 1) & 0xFF
            return val                  # data byte (not ACK/NACK)

        else:  # I2C_FINISH, I2C_NACK, unknown
            self.first_byte = True
            return 0
```

### Why `regs[0x6B] = 0x00` at init (not `0x40`)

The real MPU6050 powers up with `PWR_MGMT_1 = 0x40` (SLEEP bit set). The Adafruit library
writes `0x00` to wake it, then reads back the register in a reset-wait loop. To avoid needing
to implement the full reset-wait, we pre-set `regs[0x6B] = 0x00` so the device appears already
awake. The `auto-clear DEVICE_RESET` line in the WRITE handler is a belt-and-suspenders measure
in case firmware writes `0x80` (DEVICE_RESET).

---

## 8. Other Slaves Fixed

All I2C slaves had the same two bugs (wrong constants + wrong ACK return). They were all
updated to use the correct constants and `return 0` for ACK.

| Class | Address | Notable registers |
|---|---|---|
| `BMP280Slave` | 0x76 / 0x77 | `0xD0` = chip ID (`0x58`), calibration regs, temperature/pressure raw data |
| `DS1307Slave` | 0x68 | Timekeeping registers (seconds, minutes, hours, day, date, month, year) |
| `DS3231Slave` | 0x68 | Same layout as DS1307 plus temperature registers |
| `I2CWriteSink` | configurable | Accepts any WRITE silently (for LCD, OLED, etc.) |

---

## 9. Root Cause 4 — BMP280 Wrong Chip ID

### What was wrong — BMP280 chip ID

`BMP280Slave._init_calibration()` initialised register `0xD0` (chip ID) to `0x60`:

```python
self.regs[0xD0] = 0x60  # chip_id BMP280   ← WRONG
```

`0x60` is the chip ID of the **BME280** (the humidity-capable sibling). The real BMP280
production silicon returns **`0x58`**.

### Why it mattered

`Adafruit_BMP280::begin()` calls `Adafruit_I2CDevice::begin()`, which probes the I2C bus,
then reads register `0xD0` and compares it against the compile-time constant:

```cpp
#define BMP280_CHIPID (0x58)
// inside begin():
if (chip_id != BMP280_CHIPID && chip_id != BME280_CHIPID) return false;
```

With the slave returning `0x60`, the library matched the `BME280_CHIPID` branch — which only
works if `Adafruit_BME280` is used, not `Adafruit_BMP280`. In practice the example sketch uses
`Adafruit_BMP280`, so `begin()` returned `false` and the serial monitor printed:

```
BMP280 not found! Check wiring.
```

### Fix — chip ID 0x60 → 0x58

Changed `esp32_i2c_slaves.py` and `I2CBusManager.ts` (AVR/RP2040 path):

```python
# esp32_i2c_slaves.py
self.regs[0xD0] = 0x58  # chip_id BMP280 (production silicon; BME280 uses 0x60)
```

```typescript
// frontend/src/simulation/I2CBusManager.ts
r[0xD0] = 0x58;  // chip_id BMP280 (production silicon; BME280 uses 0x60)
```

The frontend unit test in `virtual-i2c-devices.test.ts` was updated accordingly:

```typescript
// Before
expect(dev.readByte()).toBe(0x60);
// After
expect(dev.readByte()).toBe(0x58);
```

---

## 10. Test Suite

File: `backend/test_esp32_i2c_slaves.py`

The test helper `i2c_read_seq` models the correct QEMU write-then-read sequence:

```python
def i2c_read_seq(slave, reg, n):
    slave.handle_event(I2C_START_SEND)        # write direction START → ACK
    slave.handle_event((reg << 8) | I2C_WRITE)  # set register pointer
    slave.handle_event(I2C_FINISH)            # repeated-START
    slave.handle_event(I2C_START_RECV)        # read direction START → ACK
    data = [slave.handle_event(I2C_READ) for _ in range(n)]
    slave.handle_event(I2C_FINISH)            # STOP
    return data
```

Key tests added for MPU6050:

| Test | What it verifies |
|---|---|
| `test_detected_pattern` | START_SEND → FINISH returns ACK (0) — `detected()` succeeds |
| `test_write_then_read_who_am_i` | Full write-then-read returns `0x68` from register `0x75` |
| `test_reg_ptr_preserved_across_rstart` | FINISH + START_RECV does not reset reg_ptr |
| `test_sequential_read_14_bytes` | Reading 14 bytes from 0x3B (accel+temp+gyro block) |
| `test_write_to_reg` | Writing to an arbitrary register updates regs[] correctly |
| `test_pwr_mgmt_reset_bit_autocleared` | Writing 0x80 to 0x6B auto-clears bit 7 |

Total test count: **54 tests, all passing**.

Run with:
```bash
cd backend
python test_esp32_i2c_slaves.py
```

---

## 10. Debugging Infrastructure

During debugging, temporary instrumentation was added and later cleaned up:

### `esp32_worker.py` — `_on_i2c_event` debug telemetry

A debug version emitted `i2c_debug` WebSocket messages with decoded op names for every event.
The op name map:

```python
_I2C_OP_NAME = {
    0x00: 'START_RECV', 0x01: 'START_SEND', 0x02: 'START_ASYNC',
    0x03: 'FINISH',     0x04: 'NACK',
    0x05: 'WRITE',      0x06: 'READ',
}
```

An `i2c_trace` WebSocket message was also added (and kept) to make I2C activity visible in
the serial monitor area for slave-handled events.

### `test_mpu6050_simulation.mjs` — Node.js end-to-end test

A standalone Node.js test that:
1. Connects to the backend WebSocket
2. Compiles and uploads the MPU6050 sketch
3. Waits for `MPU6050 ready!` in serial output
4. Confirms accelerometer/gyroscope data lines arrive

Configurable via `BACKEND_URL` env var or `--backend=<url>` CLI arg (default: `ws://localhost:8002`).

---

## 11. End-to-End Verification

After all fixes:

1. Load the **"ESP32: MPU-6050 Accelerometer"** example from the gallery.
2. Click **Compile**, then **Run**.
3. Open the Serial Monitor (115200 baud).
4. Expected output:
   ```
   MPU6050 ready!
   Accel X=0.00 Y=0.00 Z=9.81 m/s²
   Gyro  X=0.00 Y=0.00 Z=0.00 rad/s
   Temp: 25.0 C
   ---
   ```

The fix to compile the example in the frontend was separate: the Vite dev server proxy
in `frontend/vite.config.ts` must point to the correct backend port (default `8001`).
If Docker or another service occupies port 8001, stop it before starting the backend with:

```bash
cd backend
venv\Scripts\activate
uvicorn app.main:app --reload --port 8001
```

---

## Summary of All Changes

| File | Change |
|---|---|
| `backend/app/services/esp32_i2c_slaves.py` | Complete rewrite: correct constants, ACK=0, all slaves updated |
| `backend/app/services/esp32_worker.py` | Fixed `_I2C_OP_NAME` map; added `i2c_trace` emission |
| `backend/test_esp32_i2c_slaves.py` | Complete rewrite: correct event sequences, 54 tests |
| `backend/test_mpu6050_simulation.mjs` | Added `i2c_trace` handler; configurable backend URL |
| `frontend/vite.config.ts` | Proxy target must match the port where backend is listening |
