# Velxio — Introduction

**Velxio** is a fully local, open-source Arduino emulator that runs entirely in your browser.

Write Arduino C++ code, compile it with a real `arduino-cli` backend, and simulate it using true AVR8 / RP2040 CPU emulation — with 48+ interactive electronic components, all without installing any software on your machine.

---

## Why Velxio?

- **No installation required** — everything runs in the browser.
- **Real emulation** — not a simplified model, but accurate AVR8 / RP2040 CPU emulation.
- **Interactive components** — LEDs, buttons, potentiometers, displays, sensors, and more.
- **Open-source** — inspect, modify, and self-host it yourself.

---

## Supported Boards

| Board | CPU | Emulator |
|-------|-----|----------|
| Arduino Uno | ATmega328p @ 16 MHz | avr8js |
| Arduino Nano | ATmega328p @ 16 MHz | avr8js |
| Arduino Mega | ATmega2560 @ 16 MHz | avr8js |
| Raspberry Pi Pico | RP2040 @ 133 MHz | rp2040js |

---

## Quick Links

- [Getting Started](./getting-started.md)
- [Emulator Architecture](./emulator.md)
- [Components Reference](./components.md)
- [Roadmap](./roadmap.md)
- [Live Demo](https://velxio.dev)
- [GitHub Repository](https://github.com/davidmonterocrespo24/velxio)
