# Electrical Simulation — User Guide

Velxio can now simulate **real electrical behaviour** of your circuits alongside the Arduino/ESP32/RP2040 sketch you are running. Voltages are computed by a full SPICE engine (ngspice) running in your browser.

## Enabling it

Click the **⚡ Electrical** button in the editor toolbar.

The first time you enable electrical simulation, your browser downloads the ngspice engine (~39 MB). This happens once per browser; after that, activation is instant. The download is completely client-side — nothing is sent to our servers.

Once active, the button turns orange and a small overlay appears in the top-left of the canvas showing "N nets • solved in X ms".

## What it does

With electrical simulation ON:

- **Wires are electrically conductive.** Voltages flow through them according to the components they touch.
- **Resistors actually resist.** A 220 Ω in series with an LED affects brightness.
- **LEDs have real V–I curves.** A red LED drops ~2.0 V, a blue LED ~3.1 V. Over-driven LEDs light up proportionally brighter (until they would burn out in real life — no, we don't simulate destruction!).
- **Potentiometers are real voltage dividers.** Turning the knob changes the voltage at the wiper.
- **Thermistors (NTC) follow the β-model.** The temperature slider changes the resistance.
- **`analogRead(A0)` returns the real voltage** that your Arduino sketch would measure — computed by ngspice, not a guess.
- **PWM pins drive the filter.** If you `analogWrite(9, 128)` and connect pin 9 to an RC filter, the filtered output will hit 2.5 V (= 50 % duty × 5 V).

## Components that work with electrical simulation

**Pasivos:** resistencias (con cualquier valor), capacitores, inductores, potenciómetros, termistores NTC, fotoresistencias, pulsadores, switches, interruptores deslizables.

**Semiconductores:** diodos (1N4148, 1N4007, Schottky), zeners (1N4733, 1N4742), LEDs (rojo, verde, amarillo, azul, blanco), transistores BJT (2N2222, 2N3055, BC547), MOSFETs (2N7000, IRF540), op-amps (modelo ideal).

**Instrumentos de medición:**
- **Voltímetro** — conéctalo entre dos nodos para leer la diferencia de voltaje.
- **Amperímetro** — conéctalo en serie para leer la corriente.

Más componentes se añaden regularmente. La lista autoritativa es `frontend/src/simulation/spice/componentToSpice.ts`.

## Components that are ignored by the solver

These keep working with their own simulation logic but do **not** participate in the electrical solve:

- LCDs (1602, SSD1306, ST7789, etc.)
- NeoPixel strips and matrices
- Digital I²C sensors (MPU6050, BMP280, DHT22, DS18B20)
- Servos, stepper motors, DC motors (modelled as simple coil resistance)
- Rotary encoders
- Displays and sound generators

Wires connecting to these components still render and still carry digital signals, but their electrical effects on other components are not computed.

## Troubleshooting

### "Circuit did not converge"

Most common causes:

1. **Floating node** — a node with only capacitors and no DC path to ground. The solver tries to auto-fix this with a 100 MΩ pull-down, but complex topologies may still fail.
2. **Short circuit** — e.g., a wire directly from VCC to GND with no resistor.
3. **LED with no series resistor** — while a real LED would burn out, ngspice may still solve it with high current. If not, add a resistor.

### "Slow solve (> 200 ms)"

Some circuits, especially those with many non-linear devices (BJTs / MOSFETs), can take a while. Tips:

- Remove redundant components.
- Use simpler models (e.g., op-amp ideal instead of LM358 macromodel) if absolute accuracy isn't required.

### The ⚡ button isn't showing

Electrical simulation may have been disabled at build time via `VITE_ELECTRICAL_SIM=false`. This is an ops/admin-level flag; ask your Velxio deployer.

## Performance

| Scenario | Solve time |
|---|---|
| Simple circuit (< 10 components) | 5–30 ms |
| Medium circuit (10–30 components) | 30–150 ms |
| Complex with non-linear (BJT, MOSFET) | 150–500 ms |

Solves are debounced 50 ms so interactive edits feel instant.

## Privacy & bundle size

- The ngspice engine is loaded **lazily, client-side only**. Nothing about your circuit is sent to our servers.
- Once downloaded, the engine is cached by your browser. Subsequent uses are free.
- If you are on a metered connection, you can keep the ⚡ button off. Everything else about Velxio still works exactly as before.

## Advanced: inspecting the netlist

Developers can inspect the netlist submitted to ngspice. In the DevTools console:

```js
useElectricalStore.getState().submittedNetlist
```

Returns the full SPICE netlist for the last solve — useful for debugging convergence issues or verifying the component mapping.
