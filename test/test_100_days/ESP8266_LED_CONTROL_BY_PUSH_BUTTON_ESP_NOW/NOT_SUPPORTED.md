# ESP8266_LED_CONTROL_BY_PUSH_BUTTON_ESP_NOW

## Status: NOT SUPPORTED by Velxio

This project cannot be emulated end-to-end inside Velxio in its current form. The source code has been copied into `source/` for reference, but no live test is wired up.

## Detected configuration

- **Board:** `esp8266`
- **Features:** wifi, esp_now
- **Source files:** 2

## Blockers

- **`esp8266`** — ESP8266 has no QEMU/firmware path in Velxio.
- **`esp_now`** — ESP-NOW (peer-to-peer 802.11) is not implemented in Velxio QEMU. WiFi NIC uses slirp user-mode networking, which only forwards TCP/UDP through the host stack — raw 802.11 management frames between two virtual ESP32s cannot be routed.

## What would be needed to support this in Velxio

- Add an ESP8266 backend: either a QEMU build that can run Tensilica L106 cores, or a soft-CPU emulator like `esp8266sim` invoked from `app.services.esp32_qemu_manager` with a new `kind="esp8266"` branch. Also requires MicroPython firmware for ESP8266 in `public/firmware/`.
- Implement ESP-NOW packet bridging between two ESP32 QEMU instances at the WiFi MAC layer. This is more than slirp can do; would need a virtual 802.11 hub similar to `mac80211_hwsim`.

## Files copied

- `source/receiver.py`
- `source/sender.py`
