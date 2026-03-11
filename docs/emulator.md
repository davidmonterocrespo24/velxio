# Emulator Architecture

Velxio uses **real CPU emulation** rather than a simplified model. This document describes how each layer of the simulation works.

---

## High-Level Data Flow

```
User Code (Monaco Editor)
        │
        ▼
   Zustand Store (useEditorStore)
        │
        ▼
  FastAPI Backend ──► arduino-cli subprocess ──► .hex / .uf2 file
        │
        ▼
  AVRSimulator / RP2040Simulator
        │ loadHex()
        ▼
  CPU execution loop (~60 FPS via requestAnimationFrame)
        │
        ▼
  Port listeners (PORTB / PORTC / PORTD)
        │
        ▼
  PinManager ──► Component state updates ──► React re-renders
```

---

## AVR8 Emulation (Arduino Uno / Nano / Mega)

The AVR backend uses **[avr8js](https://github.com/wokwi/avr8js)**, which implements a complete ATmega328p / ATmega2560 processor.

### Execution Loop

Each animation frame executes approximately 267,000 CPU cycles (16 MHz ÷ 60 FPS):

```typescript
avrInstruction(cpu);  // decode and execute one AVR instruction
cpu.tick();           // advance peripheral timers and counters
```

### Supported Peripherals

| Peripheral | Details |
|-----------|---------|
| GPIO | PORTB (pins 8–13), PORTC (A0–A5), PORTD (pins 0–7) |
| Timer0 / Timer1 / Timer2 | `millis()`, `delay()`, PWM via `analogWrite()` |
| USART | Full transmit and receive — powers the Serial Monitor |
| ADC | 10-bit, 5 V reference on pins A0–A5 |
| SPI | Hardware SPI (enables ILI9341, SD card, etc.) |
| I2C (TWI) | Hardware I2C with virtual device bus |

### Pin Mapping

| Arduino Pin | AVR Port | Bit |
|-------------|----------|-----|
| 0–7 | PORTD | 0–7 |
| 8–13 | PORTB | 0–5 |
| A0–A5 | PORTC | 0–5 |

---

## RP2040 Emulation (Raspberry Pi Pico)

The RP2040 backend uses **[rp2040js](https://github.com/wokwi/rp2040js)**.

### Features

- Real RP2040 emulation at 133 MHz
- UART0 serial output displayed in the Serial Monitor
- 12-bit ADC on GPIO 26–29 (A0–A3) with 3.3 V reference

### Compilation

Pico sketches are compiled with the [arduino-pico](https://github.com/earlephilhower/arduino-pico) core via `arduino-cli`. The Serial redirect patch is applied only to `sketch.ino` to route `Serial.print()` output to UART0.

---

## HEX File Format

Arduino compilation produces **Intel HEX** format. The parser in `hexParser.ts`:

1. Reads lines starting with `:`
2. Extracts the address, record type, and data bytes
3. Returns a `Uint8Array` of program bytes
4. `AVRSimulator` converts this to a `Uint16Array` (16-bit words, little-endian) and loads it into the CPU's program memory

---

## Component System

Components are rendered using **[wokwi-elements](https://github.com/wokwi/wokwi-elements)** — a library of Web Components for electronic parts.

### Component Registration

1. The component is rendered on the `SimulatorCanvas`.
2. A pin-change callback is registered in `PinManager`.
3. The callback updates component state in the Zustand store.
4. React re-renders the component with the updated state.

### Wire Routing

Wires use **orthogonal routing** (no diagonal paths). Each wire stores:

```typescript
{
  id: string
  start: { componentId, pinName, x, y }
  end:   { componentId, pinName, x, y }
  color: string          // e.g. 'red' for VCC
  signalType: 'digital' | 'analog' | 'power-vcc' | 'power-gnd'
}
```

Wire positions update automatically when components are moved.

---

## Key Source Files

| File | Purpose |
|------|---------|
| `frontend/src/simulation/AVRSimulator.ts` | AVR8 CPU emulator wrapper |
| `frontend/src/simulation/PinManager.ts` | Maps Arduino pins to UI components |
| `frontend/src/utils/hexParser.ts` | Intel HEX parser |
| `frontend/src/components/simulator/SimulatorCanvas.tsx` | Canvas rendering |
| `backend/app/services/arduino_cli.py` | arduino-cli wrapper |
| `backend/app/api/routes/compile.py` | Compilation API endpoint |
