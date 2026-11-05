/**
 * Absolute-maximum supply-voltage ratings for components/boards that have a
 * rated input voltage. The circuit verifier reads the solved voltage across
 * each part's supply pin (vs its ground pin) and warns — non-blocking — when
 * it exceeds the datasheet absolute maximum. This is the classic "fed too much
 * voltage" mistake: a 3.3 V module or sensor wired straight to a 9 V battery.
 *
 * Per-PIN thresholds (not one per part): a board's 3V3 pin tolerates far less
 * than its VIN pin, so each supply pin carries its own absMax. The first
 * supply pin that is actually wired AND has a solved voltage is checked; a
 * pin that isn't wired (or whose net is floating) is skipped. Ground is the
 * first wired gnd pin, falling back to circuit ground (net "0").
 *
 * Thresholds are ABSOLUTE maximums chosen to NOT fire on normal 3.3 V / 5 V
 * use (e.g. a 3V3 pin warns above ~3.6 V, a 5 V/VIN pin above ~6 V) so a
 * warning means real hardware would likely be damaged. Adding a part here is
 * safe — an unknown metadataId / boardKind is simply not checked.
 */
export interface SupplyPin {
  /** Exact pin name as used in wiring (case-sensitive). */
  name: string;
  /** Absolute-maximum voltage on this pin (vs ground) before damage, volts. */
  absMaxVoltage: number;
}

export interface ComponentRating {
  /** Human label used in the warning message. */
  label: string;
  /** Supply pins with their individual absolute-max ratings. */
  supplyPins: SupplyPin[];
  /** Ground reference pin name(s); falls back to circuit ground if none wired. */
  gndPins: string[];
}

// Keyed by component metadataId OR board boardKind (both are checked).
export const COMPONENT_RATINGS: Record<string, ComponentRating> = {
  // ── Peripheral modules (loads) — the high-value cases ──────────────────────
  ssd1306: {
    label: 'SSD1306 OLED',
    supplyPins: [
      { name: '3V3', absMaxVoltage: 3.6 },
      { name: 'VIN', absMaxVoltage: 6 },
      // Alias: some variants / saved projects label the supply pin VCC
      // (regulator input, same tolerance as VIN).
      { name: 'VCC', absMaxVoltage: 6 },
    ],
    gndPins: ['GND'],
  },
  // 4-pin I2C-only module (GND/VCC/SCL/SDA, see Ssd1306I2cElement.ts) — same
  // panel as ssd1306, supply comes in on the single VCC pin.
  'ssd1306-i2c-4pin': {
    label: 'SSD1306 OLED (I2C)',
    supplyPins: [{ name: 'VCC', absMaxVoltage: 6 }],
    gndPins: ['GND'],
  },
  ili9341: { label: 'ILI9341 display', supplyPins: [{ name: 'VCC', absMaxVoltage: 6 }], gndPins: ['GND'] },
  dht22: { label: 'DHT22 sensor', supplyPins: [{ name: 'VCC', absMaxVoltage: 6 }], gndPins: ['GND'] },
  dht11: { label: 'DHT11 sensor', supplyPins: [{ name: 'VCC', absMaxVoltage: 5.5 }], gndPins: ['GND'] },
  bmp280: { label: 'BMP280 sensor', supplyPins: [{ name: 'VCC', absMaxVoltage: 6 }], gndPins: ['GND'] },
  'hc-sr04': { label: 'HC-SR04 sensor', supplyPins: [{ name: 'VCC', absMaxVoltage: 6 }], gndPins: ['GND'] },
  mpu6050: { label: 'MPU6050 IMU', supplyPins: [{ name: 'VCC', absMaxVoltage: 6 }], gndPins: ['GND'] },
  servo: { label: 'servo motor', supplyPins: [{ name: 'V+', absMaxVoltage: 7.2 }], gndPins: ['GND'] },
  neopixel: { label: 'NeoPixel', supplyPins: [{ name: 'VDD', absMaxVoltage: 6 }], gndPins: ['VSS', 'GND'] },
  // Op-amps: the supply across V+ and V- (V- unwired is circuit ground), from
  // the datasheets' absolute maximum ratings: 32 V single supply for the
  // LM358 / LM324, ±18 V (36 V) for the LM741 and TL072.
  'opamp-lm358': { label: 'LM358 op-amp', supplyPins: [{ name: 'V+', absMaxVoltage: 32 }], gndPins: ['V-'] },
  'opamp-lm324': { label: 'LM324 op-amp', supplyPins: [{ name: 'V+', absMaxVoltage: 32 }], gndPins: ['V-'] },
  'opamp-lm741': { label: 'LM741 op-amp', supplyPins: [{ name: 'V+', absMaxVoltage: 36 }], gndPins: ['V-'] },
  'opamp-tl072': { label: 'TL072 op-amp', supplyPins: [{ name: 'V+', absMaxVoltage: 36 }], gndPins: ['V-'] },

  // ── Boards (checked against their own supply pins) ─────────────────────────
  // Each board self-drives its VCC rail to its logic voltage, so normal use
  // sits below these thresholds and never warns; only genuine over-drive does.
  esp32: {
    label: 'ESP32',
    supplyPins: [
      { name: '3V3', absMaxVoltage: 3.6 },
      { name: 'VIN', absMaxVoltage: 6 },
    ],
    gndPins: ['GND', 'GND.1', 'GND.2'],
  },
  'raspberry-pi-pico': {
    label: 'Raspberry Pi Pico',
    supplyPins: [
      { name: '3V3', absMaxVoltage: 3.6 },
      { name: 'VBUS', absMaxVoltage: 5.5 },
      { name: 'VSYS', absMaxVoltage: 5.5 },
    ],
    gndPins: ['GND.1', 'GND.2', 'GND.3', 'GND.4', 'GND'],
  },
  'pi-pico-w': {
    label: 'Raspberry Pi Pico W',
    supplyPins: [
      { name: '3V3', absMaxVoltage: 3.6 },
      { name: 'VBUS', absMaxVoltage: 5.5 },
      { name: 'VSYS', absMaxVoltage: 5.5 },
    ],
    gndPins: ['GND.1', 'GND.2', 'GND.3', 'GND.4', 'GND'],
  },
  attiny85: { label: 'ATtiny85', supplyPins: [{ name: 'VCC', absMaxVoltage: 6 }], gndPins: ['GND'] },
  'arduino-uno': {
    label: 'Arduino Uno',
    supplyPins: [
      { name: '5V', absMaxVoltage: 6 },
      { name: '3.3V', absMaxVoltage: 3.6 },
    ],
    gndPins: ['GND.1', 'GND.2', 'GND.3', 'GND'],
  },
  'arduino-nano': {
    label: 'Arduino Nano',
    supplyPins: [
      { name: '5V', absMaxVoltage: 6 },
      { name: '3V3', absMaxVoltage: 3.6 },
    ],
    gndPins: ['GND.1', 'GND.2', 'GND'],
  },
  'arduino-mega': {
    label: 'Arduino Mega',
    supplyPins: [
      { name: '5V', absMaxVoltage: 6 },
      { name: '3.3V', absMaxVoltage: 3.6 },
    ],
    gndPins: ['GND.1', 'GND.2', 'GND.3', 'GND.4', 'GND'],
  },
};
