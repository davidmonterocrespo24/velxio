---
brand: Generic tactile switch
buy: https://www.amazon.com/s?k=tactile+pushbutton+momentary+switch
---
Momentary tactile pushbutton. Bridges its two contact pairs while held, then
springs open. A real button bounces for a few milliseconds on press and
release; Velxio's switches cleanly, once per press, so debounce code is never
exercised here. Keep it anyway: on hardware, debounce in code or with an RC.

| Pin | Role |
| --- | --- |
| 1.l / 1.r | one internal contact |
| 2.l / 2.r | the other contact (bridged to the first when pressed) |

- Pair with a **pull-up** or **pull-down** so the pin has a defined idle level.
- On AVR use the internal pull-up: `pinMode(pin, INPUT_PULLUP)`.

**Tip:** `pin → button → GND` with `INPUT_PULLUP` reads LOW when pressed.
