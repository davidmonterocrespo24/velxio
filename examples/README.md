# Velxio examples

Ready-to-run sketches that exercise specific Velxio features end-to-end.
Each subdirectory ships:

- `*.ino` — the sketch (paste into Velxio's editor)
- `diagram.json` — wiring layout (parts + connections, Wokwi-compatible format)
- `libraries.txt` — Arduino libraries to install via Library Manager
- `README.md` — wiring picture, run instructions, what to expect

## Index

| Folder | Board | Demonstrates |
|--------|-------|--------------|
| [`esp32-cam-lcd-preview/`](esp32-cam-lcd-preview/) | ESP32-CAM + ILI9341 | Live webcam preview decoded with `jpg2rgb565` and rendered to a 320×240 SPI TFT |

## Adding a new example

1. Create a folder named after the demo (e.g. `arduino-uno-pong-rgb/`).
2. Drop in the four files above.
3. Wire `diagram.json` using the velxio/wokwi part types — see existing
   examples for naming. Velxio-specific boards use the `velxio-` prefix
   (`velxio-esp32-cam`); generic Wokwi parts use `wokwi-` (`wokwi-ili9341`,
   `wokwi-led`, etc.).
4. Add a row to the table above.

If your example needs more than the standard libraries, list every
required library in `libraries.txt` (one per line, `#` for comments).
