/**
 * ESP32 Web Components
 *
 * Uses board SVG assets for realistic rendering.
 * Pin positions are in mm × 5 px/mm.
 *
 * The on-board LEDs are drawn as overlays on the picture (ONBOARD_LED_FOOTPRINTS
 * below) and lit through the `onboardLeds` property the React wrapper sets.
 *
 * Supports three variants via the `board-kind` attribute:
 *   - esp32        → ESP32 DevKit V1      (141 × 265 px)
 *   - esp32-s3     → ESP32-S3 DevKitC-1   (128 × 350 px)
 *   - esp32-c3     → ESP32-C3 DevKitM-1   (127 × 215 px)
 */

// Board SVG assets are served from frontend/public/boards/ as static URLs.
// No Vite import resolution needed — these resolve at runtime against the
// static asset root.
const esp32SvgUrl = '/boards/esp32-devkit-v1.svg';
const esp32S3SvgUrl = '/boards/esp32-s3.svg';
const esp32C3SvgUrl = '/boards/esp32-c3.svg';
const esp32DevkitCV4SvgUrl = '/boards/esp32-devkit-c-v4.svg';
const esp32CamSvgUrl = '/boards/esp32-cam.svg';
const wemosLolin32SvgUrl = '/boards/wemos-lolin32-lite.svg';
const xiaoEsp32S3SvgUrl = '/boards/xiao-esp32-s3.svg';
const arduinoNanoEsp32SvgUrl = '/boards/arduino-nano-esp32.svg';
const xiaoEsp32C3SvgUrl = '/boards/xiao-esp32-c3.svg';
const aitewinC3SvgUrl = '/boards/esp32c3-supermini.svg';

// ─── Pin positions (mm × 5 px/mm, from board.json) ───────────────────────────

// ESP32 DevKit V1: 28.2 mm × 53 mm → 141 × 265 px
// Left col: x = 1.27 mm → 6 px  |  Right col: x = 26.8 mm → 134 px
const PINS_ESP32 = [
  { name: 'EN', x: 6, y: 29 },
  { name: 'VN', x: 6, y: 42 },
  { name: 'VP', x: 6, y: 54 },
  { name: '34', x: 6, y: 67 },
  { name: '35', x: 6, y: 80 },
  { name: '32', x: 6, y: 93 },
  { name: '33', x: 6, y: 105 },
  { name: '25', x: 6, y: 118 },
  { name: '26', x: 6, y: 131 },
  { name: '27', x: 6, y: 143 },
  { name: '14', x: 6, y: 156 },
  { name: '12', x: 6, y: 169 },
  { name: '13', x: 6, y: 181 },
  { name: 'GND', x: 6, y: 194 },
  { name: 'VIN', x: 6, y: 207 },
  { name: '3V3', x: 134, y: 207 },
  { name: 'GND2', x: 134, y: 194 },
  { name: '15', x: 134, y: 181 },
  { name: '2', x: 134, y: 169 },
  { name: '4', x: 134, y: 156 },
  { name: 'RX2', x: 134, y: 143 },
  // RX2 is the silkscreen label for GPIO 16. Sketches that wire to pin
  // '16' (e.g. ledcAttach(16, …) or any example referencing GPIO 16)
  // must land on this same coordinate, otherwise pinPositionCalculator
  // can't resolve the wire endpoint and the wire visually floats off
  // the board. Same story for TX2 / 17 below.
  { name: '16', x: 134, y: 143 },
  { name: 'TX2', x: 134, y: 131 },
  { name: '17', x: 134, y: 131 },
  { name: '5', x: 134, y: 118 },
  { name: '18', x: 134, y: 105 },
  { name: '19', x: 134, y: 93 },
  { name: '21', x: 134, y: 80 },
  { name: 'RX0', x: 134, y: 67 },
  { name: 'TX0', x: 134, y: 54 },
  { name: '22', x: 134, y: 42 },
  { name: '23', x: 134, y: 29 },
];

// ESP32-S3 DevKitC-1: 25.527 mm × 70.057 mm → 128 × 350 px
// Left col: x = 1.343 mm → 7 px  |  Right col: x = 24.19 mm → 121 px
const PINS_ESP32_S3 = [
  { name: '3V3.1', x: 7, y: 38 },
  { name: '3V3.2', x: 7, y: 51 },
  { name: 'RST', x: 7, y: 64 },
  { name: '4', x: 7, y: 76 },
  { name: '5', x: 7, y: 89 },
  { name: '6', x: 7, y: 102 },
  { name: '7', x: 7, y: 115 },
  { name: '15', x: 7, y: 127 },
  { name: '16', x: 7, y: 140 },
  { name: '17', x: 7, y: 153 },
  { name: '18', x: 7, y: 166 },
  { name: '8', x: 7, y: 178 },
  { name: '3', x: 7, y: 191 },
  { name: '46', x: 7, y: 203 },
  { name: '9', x: 7, y: 216 },
  { name: '10', x: 7, y: 229 },
  { name: '11', x: 7, y: 242 },
  { name: '12', x: 7, y: 254 },
  { name: '13', x: 7, y: 267 },
  { name: '14', x: 7, y: 280 },
  { name: '5V', x: 7, y: 292 },
  { name: 'GND.1', x: 7, y: 305 },
  { name: 'GND.2', x: 121, y: 38 },
  { name: 'TX', x: 121, y: 51 },
  { name: 'RX', x: 121, y: 64 },
  { name: '1', x: 121, y: 76 },
  { name: '2', x: 121, y: 89 },
  { name: '42', x: 121, y: 102 },
  { name: '41', x: 121, y: 115 },
  { name: '40', x: 121, y: 127 },
  { name: '39', x: 121, y: 140 },
  { name: '38', x: 121, y: 153 },
  { name: '37', x: 121, y: 166 },
  { name: '36', x: 121, y: 178 },
  { name: '35', x: 121, y: 191 },
  { name: '0', x: 121, y: 203 },
  { name: '45', x: 121, y: 216 },
  { name: '48', x: 121, y: 229 },
  { name: '47', x: 121, y: 242 },
  { name: '21', x: 121, y: 254 },
  { name: '20', x: 121, y: 267 },
  { name: '19', x: 121, y: 280 },
  { name: 'GND.3', x: 121, y: 292 },
  { name: 'GND.4', x: 121, y: 305 },
];

// ESP32-C3 DevKitM-1: 25.4 mm × 42.91 mm → 127 × 215 px
// Left col: x = 1 mm → 5 px  |  Right col: x = 24.2 mm → 121 px
const PINS_ESP32_C3 = [
  { name: 'GND.1', x: 5, y: 26 },
  { name: '3V3.1', x: 5, y: 39 },
  { name: '3V3.2', x: 5, y: 51 },
  { name: '2', x: 5, y: 64 },
  { name: '3', x: 5, y: 77 },
  { name: 'GND.2', x: 5, y: 89 },
  { name: 'RST', x: 5, y: 102 },
  { name: 'GND.3', x: 5, y: 115 },
  { name: '0', x: 5, y: 127 },
  { name: '1', x: 5, y: 140 },
  { name: '10', x: 5, y: 153 },
  { name: 'GND.4', x: 5, y: 166 },
  { name: '5V.1', x: 5, y: 178 },
  { name: '5V.2', x: 5, y: 191 },
  { name: 'GND.5', x: 5, y: 204 },
  { name: 'GND.6', x: 121, y: 204 },
  { name: '19', x: 121, y: 191 },
  { name: '18', x: 121, y: 178 },
  { name: 'GND.7', x: 121, y: 166 },
  { name: '4', x: 121, y: 153 },
  { name: '5', x: 121, y: 140 },
  { name: '6', x: 121, y: 127 },
  { name: '7', x: 121, y: 115 },
  { name: 'GND.8', x: 121, y: 102 },
  { name: '8', x: 121, y: 89 },
  { name: '9', x: 121, y: 77 },
  { name: 'GND.9', x: 121, y: 64 },
  { name: 'RX', x: 121, y: 51 },
  { name: 'TX', x: 121, y: 39 },
  { name: 'GND.10', x: 121, y: 26 },
];

// ESP32 DevKit C V4: 27.9 mm × 56.628 mm → 140 × 283 px
// Left col: x = 1.22 mm → 6 px  |  Right col: x = 26.66 mm → 133 px
const PINS_ESP32_DEVKIT_C_V4 = [
  { name: '3V3', x: 6, y: 38 },
  { name: 'EN', x: 6, y: 51 },
  { name: 'VP', x: 6, y: 64 },
  { name: 'VN', x: 6, y: 76 },
  { name: '34', x: 6, y: 89 },
  { name: '35', x: 6, y: 102 },
  { name: '32', x: 6, y: 114 },
  { name: '33', x: 6, y: 127 },
  { name: '25', x: 6, y: 140 },
  { name: '26', x: 6, y: 152 },
  { name: '27', x: 6, y: 165 },
  { name: '14', x: 6, y: 178 },
  { name: '12', x: 6, y: 191 },
  { name: 'GND.1', x: 6, y: 203 },
  { name: '13', x: 6, y: 216 },
  { name: 'D2', x: 6, y: 229 },
  { name: 'D3', x: 6, y: 241 },
  { name: 'CMD', x: 6, y: 254 },
  { name: '5V', x: 6, y: 267 },
  { name: 'GND.2', x: 133, y: 38 },
  { name: '23', x: 133, y: 51 },
  { name: '22', x: 133, y: 64 },
  { name: 'TX', x: 133, y: 76 },
  { name: 'RX', x: 133, y: 89 },
  { name: '21', x: 133, y: 102 },
  { name: 'GND.3', x: 133, y: 114 },
  { name: '19', x: 133, y: 127 },
  { name: '18', x: 133, y: 140 },
  { name: '5', x: 133, y: 152 },
  { name: '17', x: 133, y: 165 },
  { name: '16', x: 133, y: 178 },
  { name: '4', x: 133, y: 191 },
  { name: '0', x: 133, y: 203 },
  { name: '2', x: 133, y: 216 },
  { name: '15', x: 133, y: 229 },
  { name: 'D1', x: 133, y: 241 },
  { name: 'D0', x: 133, y: 254 },
  { name: 'CLK', x: 133, y: 267 },
];

// ESP32-CAM: 27.2 mm × 40.42 mm → 136 × 202 px
// Left col: x = 1.9 mm → 10 px  |  Right col: x = 24.76 mm → 124 px
const PINS_ESP32_CAM = [
  { name: '5V.1', x: 10, y: 25 },
  { name: 'GND.1', x: 10, y: 37 },
  { name: '12', x: 10, y: 50 },
  { name: '13', x: 10, y: 63 },
  { name: '15', x: 10, y: 76 },
  { name: '14', x: 10, y: 88 },
  { name: '2', x: 10, y: 101 },
  { name: '4', x: 10, y: 114 },
  { name: '3V3', x: 124, y: 25 },
  { name: '16', x: 124, y: 37 },
  { name: '0', x: 124, y: 50 },
  { name: 'GND.2', x: 124, y: 63 },
  { name: 'VCC', x: 124, y: 76 },
  { name: 'RX', x: 124, y: 88 },
  { name: 'TX', x: 124, y: 101 },
  { name: 'GND.3', x: 124, y: 114 },
];

// Wemos Lolin32 Lite: 25.6 mm × 50 mm → 128 × 250 px
// Left col: x = 1.4 mm → 7 px  |  Right col: x = 24.26 mm → 121 px
const PINS_WEMOS_LOLIN32 = [
  { name: 'VP', x: 7, y: 37 },
  { name: 'VN', x: 7, y: 50 },
  { name: 'EN', x: 7, y: 62 },
  { name: 'GPIO34', x: 7, y: 75 },
  { name: 'GPIO35', x: 7, y: 88 },
  { name: 'GPIO32', x: 7, y: 100 },
  { name: 'GPIO33', x: 7, y: 113 },
  { name: 'GPIO25', x: 7, y: 126 },
  { name: 'GPIO26', x: 7, y: 139 },
  { name: 'GPIO27', x: 7, y: 151 },
  { name: 'GPIO14', x: 7, y: 164 },
  { name: 'GPIO12', x: 7, y: 177 },
  { name: 'GND', x: 7, y: 189 },
  { name: 'GPIO13', x: 121, y: 189 },
  { name: 'GPIO15', x: 121, y: 177 },
  { name: 'GPIO2', x: 121, y: 164 },
  { name: 'GPIO0', x: 121, y: 151 },
  { name: 'GPIO4', x: 121, y: 139 },
  { name: 'GPIO16', x: 121, y: 126 },
  { name: 'GPIO17', x: 121, y: 113 },
  { name: 'GPIO5', x: 121, y: 100 },
  { name: 'GPIO18', x: 121, y: 88 },
  { name: 'GPIO23', x: 121, y: 75 },
  { name: 'GPIO19', x: 121, y: 62 },
  { name: 'GPIO22', x: 121, y: 50 },
  { name: '3V', x: 121, y: 37 },
];

// Seeed XIAO ESP32-S3: 18.1 mm × 23.4 mm → 91 × 117 px
// Left col: x = 1.43 mm → 7 px  |  Right col: x = 16.51 mm → 83 px
const PINS_XIAO_ESP32_S3 = [
  { name: 'D0', x: 7, y: 25 },
  { name: 'D1', x: 7, y: 37 },
  { name: 'D2', x: 7, y: 50 },
  { name: 'D3', x: 7, y: 63 },
  { name: 'D4', x: 7, y: 75 },
  { name: 'D5', x: 7, y: 88 },
  { name: 'D6', x: 7, y: 101 },
  { name: 'D7', x: 83, y: 101 },
  { name: 'D8', x: 83, y: 88 },
  { name: 'D9', x: 83, y: 75 },
  { name: 'D10', x: 83, y: 63 },
  { name: '3V3', x: 83, y: 50 },
  { name: 'GND', x: 83, y: 37 },
  { name: '5V', x: 83, y: 25 },
];

// Arduino Nano ESP32: 43.3 mm × 18.05 mm → 217 × 90 px  (horizontal layout)
// Top row: y = 1.5 mm → 8 px  |  Bottom row: y = 16.74 mm → 84 px
const PINS_ARDUINO_NANO_ESP32 = [
  { name: 'D12', x: 24, y: 8 },
  { name: 'D11', x: 37, y: 8 },
  { name: 'D10', x: 49, y: 8 },
  { name: 'D9', x: 62, y: 8 },
  { name: 'D8', x: 75, y: 8 },
  { name: 'D7', x: 88, y: 8 },
  { name: 'D6', x: 100, y: 8 },
  { name: 'D5', x: 113, y: 8 },
  { name: 'D4', x: 126, y: 8 },
  { name: 'D3', x: 138, y: 8 },
  { name: 'D2', x: 151, y: 8 },
  { name: 'GND.1', x: 164, y: 8 },
  { name: 'RST', x: 176, y: 8 },
  { name: 'RX0', x: 189, y: 8 },
  { name: 'TX1', x: 202, y: 8 },
  { name: 'D13', x: 24, y: 84 },
  { name: '3V3', x: 37, y: 84 },
  { name: 'B0', x: 49, y: 84 },
  { name: 'A0', x: 62, y: 84 },
  { name: 'A1', x: 75, y: 84 },
  { name: 'A2', x: 88, y: 84 },
  { name: 'A3', x: 100, y: 84 },
  { name: 'A4', x: 113, y: 84 },
  { name: 'A5', x: 126, y: 84 },
  { name: 'A6', x: 138, y: 84 },
  { name: 'A7', x: 151, y: 84 },
  { name: 'VBUS', x: 164, y: 84 },
  { name: 'B1', x: 176, y: 84 },
  { name: 'GND.2', x: 189, y: 84 },
  { name: 'VIN', x: 202, y: 84 },
];

// Seeed XIAO ESP32-C3: 18.1 mm × 23.4 mm → 91 × 117 px (same form as XIAO ESP32-S3)
const PINS_XIAO_ESP32_C3 = PINS_XIAO_ESP32_S3;

// Aitewinrobot ESP32-C3 SuperMini: 18.0 mm × 24.576 mm → 90 × 123 px
// Left col: x = 1.46 mm → 7 px  |  Right col: x = 16.70 mm → 84 px
const PINS_AITEWIN_C3 = [
  { name: '5', x: 7, y: 16 },
  { name: '6', x: 7, y: 29 },
  { name: '7', x: 7, y: 42 },
  { name: '8', x: 7, y: 54 },
  { name: '9', x: 7, y: 67 },
  { name: '10', x: 7, y: 80 },
  { name: 'RX', x: 7, y: 92 },
  { name: 'TX', x: 7, y: 105 },
  { name: '5V', x: 84, y: 16 },
  { name: 'GND', x: 84, y: 29 },
  { name: '3V3', x: 84, y: 42 },
  { name: '4', x: 84, y: 54 },
  { name: '3', x: 84, y: 67 },
  { name: '2', x: 84, y: 80 },
  { name: '1', x: 84, y: 92 },
  { name: '0', x: 84, y: 105 },
];

// ─── ADC pin map: GPIO → { adc bank, channel within bank, qemu chn index } ──────
// chn is the index passed to qemu_picsimlab_set_apin():
//   0-7  → ADC1 channels 0-7  (GPIO 36,37,38,39,32,33,34,35)
//   8-17 → ADC2 channels 0-9  (GPIO 4,0,2,15,13,12,14,27,25,26)
export const ESP32_ADC_PIN_MAP: Record<number, { adc: 1 | 2; ch: number; chn: number }> = {
  36: { adc: 1, ch: 0, chn: 0 },
  37: { adc: 1, ch: 1, chn: 1 },
  38: { adc: 1, ch: 2, chn: 2 },
  39: { adc: 1, ch: 3, chn: 3 },
  32: { adc: 1, ch: 4, chn: 4 },
  33: { adc: 1, ch: 5, chn: 5 },
  34: { adc: 1, ch: 6, chn: 6 },
  35: { adc: 1, ch: 7, chn: 7 },
  4: { adc: 2, ch: 0, chn: 8 },
  0: { adc: 2, ch: 1, chn: 9 },
  2: { adc: 2, ch: 2, chn: 10 },
  15: { adc: 2, ch: 3, chn: 11 },
  13: { adc: 2, ch: 4, chn: 12 },
  12: { adc: 2, ch: 5, chn: 13 },
  14: { adc: 2, ch: 6, chn: 14 },
  27: { adc: 2, ch: 7, chn: 15 },
  25: { adc: 2, ch: 8, chn: 16 },
  26: { adc: 2, ch: 9, chn: 17 },
};

// ─── ADC pin map per CHIP ──────────────────────────────────────────────────────
// The map above is the CLASSIC ESP32's, and it was being applied to every board in
// the family. That is wrong twice over, and the second way is the nasty one:
//
//   * ESP32-S3: its ADC pins are GPIO1..20, none of which appear above, so the
//     lookup returned undefined and the potentiometer's listener was never even
//     attached — the knob did nothing at all.
//   * ESP32-C3/C6: GPIO0 IS in the classic map, as ADC2_CH1 → chn 9. But on those
//     chips GPIO0 is ADC1_CH0, and their engines take a plain ADC1 channel index
//     (0..4). So the value was pushed to channel 9, out of range, silently dropped
//     while the firmware read channel 0. A wrong answer instead of no answer.
//
// `chn` is what reaches the bridge's setAdc(): the flat qemu index on the classic
// ESP32, and the ADC1 channel index on the RISC-V parts and the S3 (whose engines
// expose setChannel/setAdcChannel over ADC1).
export type AdcPinInfo = { adc: 1 | 2; ch: number; chn: number };

/** ESP32-C3 / C6: ADC1 channels 0..4 are GPIO0..4 (ADC2 is not modelled). */
const RISCV_C_ADC_PIN_MAP: Record<number, AdcPinInfo> = {
  0: { adc: 1, ch: 0, chn: 0 },
  1: { adc: 1, ch: 1, chn: 1 },
  2: { adc: 1, ch: 2, chn: 2 },
  3: { adc: 1, ch: 3, chn: 3 },
  4: { adc: 1, ch: 4, chn: 4 },
};

/** ESP32-S3: ADC1 channels 0..9 are GPIO1..10. (ADC2 = GPIO11..20 shares the same
 *  channel indices in the engine, so it is left out rather than aliased wrongly.) */
const ESP32S3_ADC_PIN_MAP: Record<number, AdcPinInfo> = Object.fromEntries(
  Array.from({ length: 10 }, (_, ch) => [ch + 1, { adc: 1 as const, ch, chn: ch }]),
);

/** The ADC map for a board kind. Unknown kinds fall back to the classic ESP32. */
export function adcPinMapFor(boardKind: string): Record<number, AdcPinInfo> {
  if (boardKind.includes('c3') || boardKind.includes('c6')) return RISCV_C_ADC_PIN_MAP;
  if (boardKind.includes('s3')) return ESP32S3_ADC_PIN_MAP;
  return ESP32_ADC_PIN_MAP;
}

// ─── On-board LED footprints ──────────────────────────────────────────────────

/**
 * Where an LED of BOARD_ONBOARD_LEDS (types/board.ts) sits on the picture, in
 * element px (5 px/mm), and how it glows. Keyed by the same LED id; a test
 * keeps the two tables in step.
 *
 * Every centre was measured on the SVG the element draws (a flood fill of the
 * LED body at 10x, not the eye), except the XIAO ESP32S3's: its SVG draws
 * the B button and no LED, so that one is placed where Seeed's front pinout
 * picture has USER_LED, right of the B button. `size` is the lit dot's
 * diameter, about the LED body; the glow is drawn around it.
 */
interface LedFootprint {
  x: number;
  y: number;
  size: number;
  /** The LED's colour; an RGB LED takes it from the pixel instead. */
  color?: string;
}

const LED_BLUE = '#58a6ff';

const ONBOARD_LED_FOOTPRINTS: Record<string, Record<string, LedFootprint>> = {
  // The right of the two LED bodies below the module (wokwi's element draws
  // its led1 there and ledPower on the left one).
  esp32: { led: { x: 94.5, y: 149, size: 8, color: LED_BLUE } },
  // The big white flash LED bottom right ("- +" marks), the small LED1 body
  // bottom left.
  'esp32-cam': {
    flash: { x: 120, y: 156.3, size: 14, color: '#fff6d5' },
    led: { x: 22.1, y: 155.2, size: 7, color: '#ff3b30' },
  },
  // The rect in the SVG's own "led" layer, next to the 22 pad.
  'wemos-lolin32-lite': { led: { x: 105.8, y: 43, size: 8, color: LED_BLUE } },
  // The 5050 body under the "RGB" silk.
  'esp32-s3': { rgb: { x: 37.9, y: 200.1, size: 12 } },
  'xiao-esp32-s3': { led: { x: 82.5, y: 15, size: 6, color: '#ffb020' } },
  // The 0603 at the corner by the D13 pad (Arduino's top view puts
  // LED_BUILTIN at that corner of the USB-C), the 5050 dome right of the
  // connector for the RGB.
  'arduino-nano-esp32': {
    led: { x: 12.3, y: 68, size: 6, color: '#ffc400' },
    rgb: { x: 58.5, y: 40.8, size: 10 },
  },
  // The 5050 body under the "GPIO8" silk.
  'esp32-c3': { rgb: { x: 96.5, y: 106.6, size: 12 } },
  // The body titled "IO8 LED" in the SVG.
  'aitewinrobot-esp32c3-supermini': { led: { x: 68, y: 64.3, size: 6, color: LED_BLUE } },
};

/** The LED ids this element can draw for a kind (for the table test). */
export function esp32LedFootprintIds(boardKind: string): string[] {
  return Object.keys(ONBOARD_LED_FOOTPRINTS[boardKind] ?? {});
}

/** Lit or not for a single-colour LED, the colour for an RGB one. */
export type OnboardLedVisual = boolean | { r: number; g: number; b: number };

// ─── Board config by variant ──────────────────────────────────────────────────

interface BoardConfig {
  svgUrl: string;
  w: number;
  h: number;
  pins: { name: string; x: number; y: number }[];
}

const BOARD_CONFIGS: Record<string, BoardConfig> = {
  esp32: { svgUrl: esp32SvgUrl, w: 141, h: 265, pins: PINS_ESP32 },
  'esp32-s3': { svgUrl: esp32S3SvgUrl, w: 128, h: 350, pins: PINS_ESP32_S3 },
  'esp32-c3': { svgUrl: esp32C3SvgUrl, w: 127, h: 215, pins: PINS_ESP32_C3 },
  'esp32-devkit-c-v4': {
    svgUrl: esp32DevkitCV4SvgUrl,
    w: 140,
    h: 283,
    pins: PINS_ESP32_DEVKIT_C_V4,
  },
  'esp32-cam': { svgUrl: esp32CamSvgUrl, w: 136, h: 202, pins: PINS_ESP32_CAM },
  'wemos-lolin32-lite': { svgUrl: wemosLolin32SvgUrl, w: 128, h: 250, pins: PINS_WEMOS_LOLIN32 },
  'xiao-esp32-s3': { svgUrl: xiaoEsp32S3SvgUrl, w: 91, h: 117, pins: PINS_XIAO_ESP32_S3 },
  'arduino-nano-esp32': {
    svgUrl: arduinoNanoEsp32SvgUrl,
    w: 217,
    h: 90,
    pins: PINS_ARDUINO_NANO_ESP32,
  },
  'xiao-esp32-c3': { svgUrl: xiaoEsp32C3SvgUrl, w: 91, h: 117, pins: PINS_XIAO_ESP32_C3 },
  'aitewinrobot-esp32c3-supermini': {
    svgUrl: aitewinC3SvgUrl,
    w: 90,
    h: 123,
    pins: PINS_AITEWIN_C3,
  },
};

// ─── Custom element ───────────────────────────────────────────────────────────

class Esp32Element extends HTMLElement {
  static get observedAttributes() {
    return ['board-kind'];
  }

  private _leds: Record<string, OnboardLedVisual> = {};

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
  }

  connectedCallback() {
    this.render();
  }
  attributeChangedCallback() {
    this.render();
  }

  private get config(): BoardConfig {
    const kind = this.getAttribute('board-kind') ?? 'esp32';
    return BOARD_CONFIGS[kind] ?? BOARD_CONFIGS['esp32'];
  }

  private get kind(): string {
    const kind = this.getAttribute('board-kind') ?? 'esp32';
    return BOARD_CONFIGS[kind] ? kind : 'esp32';
  }

  get pinInfo() {
    return this.config.pins;
  }

  /**
   * The on-board LEDs' visual state, keyed by LED id (BOARD_ONBOARD_LEDS):
   * true/false for a single-colour LED, {r,g,b} for an RGB one. The canvas
   * applies the board's polarity before it gets here, so `true` always means
   * "lit". Set by the React wrapper (Esp32.tsx) the way the Arduino wrappers
   * set led13; an id this kind has no footprint for is ignored.
   */
  set onboardLeds(v: Record<string, OnboardLedVisual> | undefined) {
    this._leds = v ?? {};
    this.applyLeds();
  }
  get onboardLeds(): Record<string, OnboardLedVisual> {
    return this._leds;
  }

  private applyLeds() {
    const footprints = ONBOARD_LED_FOOTPRINTS[this.kind];
    if (!footprints || !this.shadowRoot) return;
    for (const [id, fp] of Object.entries(footprints)) {
      const el = this.shadowRoot.getElementById(`led-${id}`);
      if (!el) continue;
      const visual = this._leds[id];
      const color = ledVisualColor(visual, fp.color);
      if (!color) {
        el.style.opacity = '0';
        continue;
      }
      // A white-hot core inside the LED's colour and a halo around the
      // body: at the zoom people work at (0.5 to 1) the body alone is a few
      // px and reads as "slightly different grey", the halo is what says
      // lit. The halo never shrinks below an 8 px body's, so a 0603 (the
      // SuperMini's, the XIAO's) glows as wide as the DevKit V1's.
      const glow = Math.max(8, fp.size);
      el.style.background = `radial-gradient(circle, #ffffff 0%, ${color} 45%, ${color} 100%)`;
      el.style.boxShadow = `0 0 ${glow}px ${Math.round(glow / 2)}px ${color}`;
      el.style.opacity = '1';
    }
  }

  private render() {
    if (!this.shadowRoot) return;
    const { svgUrl, w, h } = this.config;
    const footprints = ONBOARD_LED_FOOTPRINTS[this.kind] ?? {};
    const ledDivs = Object.entries(footprints)
      .map(
        ([id, fp]) =>
          `<div id="led-${id}" data-onboard-led="${id}" style="position:absolute;` +
          `left:${fp.x - fp.size / 2}px;top:${fp.y - fp.size / 2}px;` +
          `width:${fp.size}px;height:${fp.size}px;border-radius:50%;` +
          `opacity:0;transition:opacity 40ms linear;pointer-events:none;"></div>`,
      )
      .join('');
    this.shadowRoot.innerHTML = `
      <style>
        :host { display: inline-block; line-height: 0; position: relative; }
        img   { display: block; }
      </style>
      <img
        src="${svgUrl}"
        width="${w}"
        height="${h}"
        draggable="false"
        alt="ESP32 board"
      />
      ${ledDivs}
    `;
    // A re-render (board-kind change) rebuilds the dots dark; put back what
    // the wrapper last set.
    this.applyLeds();
  }
}

/**
 * The CSS colour a visual lights the LED with, or null for dark. An RGB
 * value is normalised to full brightness: an addressable LED driven at the
 * core's default RGB_BRIGHTNESS (64 of 255) is plainly lit on a bench, and a
 * dot at 25% alpha on the canvas would not be.
 */
export function ledVisualColor(
  visual: OnboardLedVisual | undefined,
  own: string | undefined,
): string | null {
  if (visual === undefined || visual === false) return null;
  if (visual === true) return own ?? '#ffffff';
  const m = Math.max(visual.r, visual.g, visual.b);
  if (m <= 0) return null;
  const k = 255 / m;
  const c = (v: number) => Math.min(255, Math.round(v * k));
  return `rgb(${c(visual.r)}, ${c(visual.g)}, ${c(visual.b)})`;
}

if (!customElements.get('velxio-esp32')) {
  customElements.define('velxio-esp32', Esp32Element);
}
