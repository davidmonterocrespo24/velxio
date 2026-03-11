# Roadmap

This document lists the features that are implemented, in progress, and planned for future releases of Velxio.

---

## ✅ Implemented

### Editor
- Monaco Editor with C++ syntax highlighting, autocomplete, and minimap
- Multi-file workspace — create, rename, delete, and switch between `.ino`, `.h`, `.cpp` files
- Unsaved-changes indicator on file tabs
- Resizable file explorer panel

### Compilation
- Arduino compilation via `arduino-cli` backend
- Multi-file sketch support
- Compilation console with full output, warnings, and errors

### Simulation — AVR (Uno / Nano / Mega)
- Real ATmega328p / ATmega2560 emulation at 16 MHz via avr8js
- Full GPIO: PORTB (8–13), PORTC (A0–A5), PORTD (0–7)
- Timer0/1/2 — `millis()`, `delay()`, `analogWrite()`
- USART — Serial transmit and receive
- ADC — `analogRead()` on A0–A5, voltage injection from potentiometers
- SPI — ILI9341 TFT display
- I2C (TWI) — virtual device bus

### Simulation — RP2040 (Raspberry Pi Pico)
- Real RP2040 emulation at 133 MHz via rp2040js
- UART0 serial output in Serial Monitor
- 12-bit ADC on GPIO 26–29

### Components
- 48+ wokwi-elements components
- Component picker with search and category filters
- Drag-and-drop repositioning
- Component rotation (90° increments)
- Property dialog (pin assignment, rotate, delete)

### Wire System
- Click-to-connect wire creation
- Orthogonal routing (no diagonal paths)
- 8 signal-type color codes
- Segment-based wire editing (drag segments)

### Serial Monitor
- Live serial output
- Auto baud-rate detection
- Send data to Arduino RX

### Library Manager
- Browse and install the full Arduino library index
- Live search, installed-tab, version display

### Auth & Projects
- Email/password and Google OAuth sign-in
- Project save, update, and delete
- Permanent project URLs (`/project/:id`)
- User profile page (`/:username`) with public projects

### Example Projects
- 8 built-in examples: Blink, Traffic Light, Button Control, Fade LED, Serial Hello World, RGB LED, Simon Says, LCD 20×4

### Deploy
- Single-container Docker image (GHCR + Docker Hub)
- GitHub Actions CI/CD pipeline

---

## 🔄 In Progress

- **Functional wire connections** — electrical signal routing and validation
- **Wire connection error handling** — detect short circuits and invalid connections

---

## 🗓 Planned

### Near-Term
- **Undo / redo** — for code edits and canvas changes
- **Export / import projects** as `.zip` files
- **More boards** — ESP32, Arduino Nano, Arduino Leonardo
- **Breadboard** — place components on a virtual breadboard with automatic wire routing

### Mid-Term
- **TypeDoc API documentation** — auto-generated from source code
- **GitHub Pages docs site** — automatic deployment on push to `main`
- **More sensor simulations** — HC-SR04 (ultrasonic), DHT22 (temperature/humidity), IR receiver
- **EEPROM emulation** — persistent read/write across simulation restarts
- **Oscilloscope component** — plot analog pin voltages over time

### Long-Term
- **Multiplayer** — share and co-edit simulations in real time
- **Embedded tutorial system** — step-by-step guided projects inside the editor
- **Custom component SDK** — define new components with a JSON/TypeScript API
- **Mobile / tablet support** — responsive layout for touch devices

---

## Contributing

Feature requests, bug reports, and pull requests are welcome at [github.com/davidmonterocrespo24/velxio](https://github.com/davidmonterocrespo24/velxio).

All contributors must sign a Contributor License Agreement (CLA); a CLA check runs automatically on pull requests.
