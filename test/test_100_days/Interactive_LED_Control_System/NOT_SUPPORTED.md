# Interactive_LED_Control_System

## Status: NOT SUPPORTED by Velxio

This project cannot be emulated end-to-end inside Velxio in its current form. The source code has been copied into `source/` for reference, but no live test is wired up.

## Detected configuration

- **Board:** `unknown`
- **Features:** pyfirmata, tkinter
- **Source files:** 1

## Blockers

- **`tkinter`** — CustomTkinter / Tkinter run on the host (desktop OS), not on the emulated MCU. Velxio does not host a Python desktop GUI.
- **`pyfirmata`** — Project drives an Arduino from the host via pyfirmata over a real USB serial port. There is no MCU sketch in this folder for Velxio to compile and run — only host-side desktop Python.

## What would be needed to support this in Velxio

- Tkinter GUI is host-only. To emulate, port the GUI to the browser (e.g. as a React panel that talks to the MCU over the existing serial WebSocket) and keep only the MicroPython half on the emulated board.

## Files copied

- `source/rgb_led_control.py`
