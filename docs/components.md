# Components Reference

Velxio ships with **48+ interactive electronic components** powered by [wokwi-elements](https://github.com/wokwi/wokwi-elements). All components can be placed on the simulation canvas, connected with wires, and interact with your Arduino sketch in real time.

---

## Adding Components

1. Click the **+** button on the simulation canvas.
2. Use **search** or browse by **category** in the component picker.
3. Click a component to place it on the canvas.
4. **Drag** to reposition; click to open the **Property Dialog** (pin roles, Arduino pin assignment, rotate, delete).

---

## Connecting Components

1. Click a **pin** on any component — a wire starts from that pin.
2. Click a **destination pin** to complete the connection.
3. Wires are **color-coded** by signal type:

| Color | Signal type |
|-------|-------------|
| 🔴 Red | VCC (power) |
| ⚫ Black | GND (ground) |
| 🔵 Blue | Analog |
| 🟢 Green | Digital |
| 🟣 Purple | PWM |
| 🟡 Gold | I2C (SDA/SCL) |
| 🟠 Orange | SPI (MOSI/MISO/SCK) |
| 🩵 Cyan | USART (TX/RX) |

---

## Component Categories

### Output

| Component | Description |
|-----------|-------------|
| LED | Single LED with configurable color |
| RGB LED | Three-color LED (red, green, blue channels) |
| 7-Segment Display | Single digit numeric display |
| LCD 16×2 | 2-line character LCD (I2C or parallel) |
| LCD 20×4 | 4-line character LCD |
| ILI9341 TFT | 240×320 color TFT display (SPI) |
| Buzzer | Passive piezo buzzer |
| NeoPixel | Individually addressable RGB LED strip |

### Input

| Component | Description |
|-----------|-------------|
| Push Button | Momentary push button |
| Slide Switch | SPDT slide switch |
| Potentiometer | Analog voltage divider (ADC input) |
| Rotary Encoder | Incremental rotary encoder |
| Keypad 4×4 | 16-button matrix keypad |
| Joystick | Dual-axis analog joystick |

### Sensors

| Component | Description |
|-----------|-------------|
| HC-SR04 | Ultrasonic distance sensor |
| DHT22 | Temperature and humidity sensor |
| PIR Motion | Passive infrared motion sensor |
| NTC Thermistor | Analog temperature sensor |
| Photoresistor | Light-dependent resistor (LDR) |
| IR Receiver | 38 kHz infrared receiver |

### Passive Components

| Component | Description |
|-----------|-------------|
| Resistor | Standard resistor (configurable value) |
| Capacitor | Electrolytic capacitor |
| Inductor | Coil inductor |

### Communication

| Component | Description |
|-----------|-------------|
| I2C EEPROM | 24Cxx series EEPROM (I2C) |
| SPI Flash | 25-series SPI NOR flash |
| RFID (RC522) | SPI RFID reader/writer |

### Power & Connectors

| Component | Description |
|-----------|-------------|
| Power Rail | VCC / GND bus bar |
| Terminal Block | 2-pin screw terminal |

---

## Component Properties

Each component has a **Property Dialog** accessible by clicking it on the canvas:

| Property | Description |
|----------|-------------|
| Arduino Pin | The digital or analog pin this component is connected to |
| Color | Visual color (LEDs, wires) |
| Value | Component value (e.g., resistance in Ω) |
| Rotation | Rotate in 90° increments |
| Delete | Remove the component from the canvas |

---

## Adding Custom Components

See [Architecture: Component System](./emulator.md#component-system) for details on registering new wokwi-elements components in the simulation.
