# RFID_Attendance_Logger

## Status: NOT SUPPORTED by Velxio

This project cannot be emulated end-to-end inside Velxio in its current form. The source code has been copied into `source/` for reference, but no live test is wired up.

## Detected configuration

- **Board:** `esp8266`
- **Features:** wifi, rfid, ota
- **Source files:** 2

## Blockers

- **`esp8266`** — ESP8266 has no QEMU/firmware path in Velxio.

## What would be needed to support this in Velxio

- Add an ESP8266 backend: either a QEMU build that can run Tensilica L106 cores, or a soft-CPU emulator like `esp8266sim` invoked from `app.services.esp32_qemu_manager` with a new `kind="esp8266"` branch. Also requires MicroPython firmware for ESP8266 in `public/firmware/`.

## Files copied

- `source/main.py`
- `source/mfrc522.py`
