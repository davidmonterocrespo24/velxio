# ESP_NOW_HOME_AUTOMATION

## Status: NOT SUPPORTED by Velxio

This project cannot be emulated end-to-end inside Velxio in its current form. The source code has been copied into `source/` for reference, but no live test is wired up.

## Detected configuration

- **Board:** `esp32`
- **Features:** wifi, esp_now
- **Source files:** 2

## Blockers

- **`esp_now`** — ESP-NOW (peer-to-peer 802.11) is not implemented in Velxio QEMU. WiFi NIC uses slirp user-mode networking, which only forwards TCP/UDP through the host stack — raw 802.11 management frames between two virtual ESP32s cannot be routed.

## What would be needed to support this in Velxio

- Implement ESP-NOW packet bridging between two ESP32 QEMU instances at the WiFi MAC layer. This is more than slirp can do; would need a virtual 802.11 hub similar to `mac80211_hwsim`.

## Files copied

- `source/receiver.py`
- `source/sender.py`
