# Voice_Activated_LED_Control_System

## Status: NOT SUPPORTED by Velxio

This project cannot be emulated end-to-end inside Velxio in its current form. The source code has been copied into `source/` for reference, but no live test is wired up.

## Detected configuration

- **Board:** `unknown`
- **Features:** pyfirmata
- **Source files:** 1

## Blockers

- **`pyfirmata`** — Project drives an Arduino from the host via pyfirmata over a real USB serial port. There is no MCU sketch in this folder for Velxio to compile and run — only host-side desktop Python.

## What would be needed to support this in Velxio


## Files copied

- `source/voice_led_control.py`
