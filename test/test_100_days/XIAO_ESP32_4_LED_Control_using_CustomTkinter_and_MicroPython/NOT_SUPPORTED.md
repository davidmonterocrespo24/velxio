# XIAO_ESP32_4_LED_Control_using_CustomTkinter_&_MicroPython

## Status: NOT SUPPORTED by Velxio

This project cannot be emulated end-to-end inside Velxio in its current form. The source code has been copied into `source/` for reference, but no live test is wired up.

## Detected configuration

- **Board:** `xiao-esp32`
- **Features:** tkinter
- **Source files:** 2

## Blockers

- **`tkinter`** — CustomTkinter / Tkinter run on the host (desktop OS), not on the emulated MCU. Velxio does not host a Python desktop GUI.

## What would be needed to support this in Velxio

- Tkinter GUI is host-only. To emulate, port the GUI to the browser (e.g. as a React panel that talks to the MCU over the existing serial WebSocket) and keep only the MicroPython half on the emulated board.

## Files copied

- `source/gui_4led_control.py`
- `source/main.py`
