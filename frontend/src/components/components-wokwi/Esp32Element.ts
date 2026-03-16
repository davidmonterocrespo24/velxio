/**
 * ESP32 Web Components
 *
 * Uses the official wokwi-boards SVG assets for realistic board rendering.
 * Pin positions are derived from board.json definitions (mm × 5 px/mm).
 *
 * Supports three variants via the `board-kind` attribute:
 *   - esp32        → ESP32 DevKit V1      (141 × 265 px)
 *   - esp32-s3     → ESP32-S3 DevKitC-1   (128 × 350 px)
 *   - esp32-c3     → ESP32-C3 DevKitM-1   (127 × 215 px)
 */

import esp32SvgUrl          from '../../../../wokwi-libs/wokwi-boards/boards/esp32-devkit-v1/board.svg?url';
import esp32S3SvgUrl         from '../../../../wokwi-libs/wokwi-boards/boards/esp32-s3-devkitc-1/board.svg?url';
import esp32C3SvgUrl         from '../../../../wokwi-libs/wokwi-boards/boards/esp32-c3-devkitm-1/board.svg?url';
import esp32DevkitCV4SvgUrl  from '../../../../wokwi-libs/wokwi-boards/boards/esp32-devkit-c-v4/board.svg?url';
import esp32CamSvgUrl        from '../../../../wokwi-libs/wokwi-boards/boards/esp32-cam/board.svg?url';
import wemosLolin32SvgUrl    from '../../../../wokwi-libs/wokwi-boards/boards/wemos-lolin32-lite/board.svg?url';
import xiaoEsp32S3SvgUrl     from '../../../../wokwi-libs/wokwi-boards/boards/xiao-esp32-s3/board.svg?url';
import arduinoNanoEsp32SvgUrl from '../../../../wokwi-libs/wokwi-boards/boards/arduino-nano-esp32/board.svg?url';
import xiaoEsp32C3SvgUrl     from '../../../../wokwi-libs/wokwi-boards/boards/xiao-esp32-c3/board.svg?url';
import aitewinC3SvgUrl       from '../../../../wokwi-libs/wokwi-boards/boards/aitewinrobot-esp32c3-supermini/board.svg?url';

// ─── Pin positions (mm × 5 px/mm, from board.json) ───────────────────────────

// ESP32 DevKit V1: 28.2 mm × 53 mm → 141 × 265 px
// Left col: x = 1.27 mm → 6 px  |  Right col: x = 26.8 mm → 134 px
const PINS_ESP32 = [
  { name: 'EN',   x:   6, y:  29 },
  { name: 'VN',   x:   6, y:  42 },
  { name: 'VP',   x:   6, y:  54 },
  { name: '34',   x:   6, y:  67 },
  { name: '35',   x:   6, y:  80 },
  { name: '32',   x:   6, y:  93 },
  { name: '33',   x:   6, y: 105 },
  { name: '25',   x:   6, y: 118 },
  { name: '26',   x:   6, y: 131 },
  { name: '27',   x:   6, y: 143 },
  { name: '14',   x:   6, y: 156 },
  { name: '12',   x:   6, y: 169 },
  { name: '13',   x:   6, y: 181 },
  { name: 'GND',  x:   6, y: 194 },
  { name: 'VIN',  x:   6, y: 207 },
  { name: '3V3',  x: 134, y: 207 },
  { name: 'GND2', x: 134, y: 194 },
  { name: '15',   x: 134, y: 181 },
  { name: '2',    x: 134, y: 169 },
  { name: '4',    x: 134, y: 156 },
  { name: 'RX2',  x: 134, y: 143 },
  { name: 'TX2',  x: 134, y: 131 },
  { name: '5',    x: 134, y: 118 },
  { name: '18',   x: 134, y: 105 },
  { name: '19',   x: 134, y:  93 },
  { name: '21',   x: 134, y:  80 },
  { name: 'RX0',  x: 134, y:  67 },
  { name: 'TX0',  x: 134, y:  54 },
  { name: '22',   x: 134, y:  42 },
  { name: '23',   x: 134, y:  29 },
];

// ESP32-S3 DevKitC-1: 25.527 mm × 70.057 mm → 128 × 350 px
// Left col: x = 1.343 mm → 7 px  |  Right col: x = 24.19 mm → 121 px
const PINS_ESP32_S3 = [
  { name: '3V3.1', x:   7, y:  38 },
  { name: '3V3.2', x:   7, y:  51 },
  { name: 'RST',   x:   7, y:  64 },
  { name: '4',     x:   7, y:  76 },
  { name: '5',     x:   7, y:  89 },
  { name: '6',     x:   7, y: 102 },
  { name: '7',     x:   7, y: 115 },
  { name: '15',    x:   7, y: 127 },
  { name: '16',    x:   7, y: 140 },
  { name: '17',    x:   7, y: 153 },
  { name: '18',    x:   7, y: 166 },
  { name: '8',     x:   7, y: 178 },
  { name: '3',     x:   7, y: 191 },
  { name: '46',    x:   7, y: 203 },
  { name: '9',     x:   7, y: 216 },
  { name: '10',    x:   7, y: 229 },
  { name: '11',    x:   7, y: 242 },
  { name: '12',    x:   7, y: 254 },
  { name: '13',    x:   7, y: 267 },
  { name: '14',    x:   7, y: 280 },
  { name: '5V',    x:   7, y: 292 },
  { name: 'GND.1', x:   7, y: 305 },
  { name: 'GND.2', x: 121, y:  38 },
  { name: 'TX',    x: 121, y:  51 },
  { name: 'RX',    x: 121, y:  64 },
  { name: '1',     x: 121, y:  76 },
  { name: '2',     x: 121, y:  89 },
  { name: '42',    x: 121, y: 102 },
  { name: '41',    x: 121, y: 115 },
  { name: '40',    x: 121, y: 127 },
  { name: '39',    x: 121, y: 140 },
  { name: '38',    x: 121, y: 153 },
  { name: '37',    x: 121, y: 166 },
  { name: '36',    x: 121, y: 178 },
  { name: '35',    x: 121, y: 191 },
  { name: '0',     x: 121, y: 203 },
  { name: '45',    x: 121, y: 216 },
  { name: '48',    x: 121, y: 229 },
  { name: '47',    x: 121, y: 242 },
  { name: '21',    x: 121, y: 254 },
  { name: '20',    x: 121, y: 267 },
  { name: '19',    x: 121, y: 280 },
  { name: 'GND.3', x: 121, y: 292 },
  { name: 'GND.4', x: 121, y: 305 },
];

// ESP32-C3 DevKitM-1: 25.4 mm × 42.91 mm → 127 × 215 px
// Left col: x = 1 mm → 5 px  |  Right col: x = 24.2 mm → 121 px
const PINS_ESP32_C3 = [
  { name: 'GND.1',  x:   5, y:  26 },
  { name: '3V3.1',  x:   5, y:  39 },
  { name: '3V3.2',  x:   5, y:  51 },
  { name: '2',      x:   5, y:  64 },
  { name: '3',      x:   5, y:  77 },
  { name: 'GND.2',  x:   5, y:  89 },
  { name: 'RST',    x:   5, y: 102 },
  { name: 'GND.3',  x:   5, y: 115 },
  { name: '0',      x:   5, y: 127 },
  { name: '1',      x:   5, y: 140 },
  { name: '10',     x:   5, y: 153 },
  { name: 'GND.4',  x:   5, y: 166 },
  { name: '5V.1',   x:   5, y: 178 },
  { name: '5V.2',   x:   5, y: 191 },
  { name: 'GND.5',  x:   5, y: 204 },
  { name: 'GND.6',  x: 121, y: 204 },
  { name: '19',     x: 121, y: 191 },
  { name: '18',     x: 121, y: 178 },
  { name: 'GND.7',  x: 121, y: 166 },
  { name: '4',      x: 121, y: 153 },
  { name: '5',      x: 121, y: 140 },
  { name: '6',      x: 121, y: 127 },
  { name: '7',      x: 121, y: 115 },
  { name: 'GND.8',  x: 121, y: 102 },
  { name: '8',      x: 121, y:  89 },
  { name: '9',      x: 121, y:  77 },
  { name: 'GND.9',  x: 121, y:  64 },
  { name: 'RX',     x: 121, y:  51 },
  { name: 'TX',     x: 121, y:  39 },
  { name: 'GND.10', x: 121, y:  26 },
];

// ESP32 DevKit C V4: 27.9 mm × 56.628 mm → 140 × 283 px
// Left col: x = 1.22 mm → 6 px  |  Right col: x = 26.66 mm → 133 px
const PINS_ESP32_DEVKIT_C_V4 = [
  { name: '3V3',   x:   6, y:  38 },
  { name: 'EN',    x:   6, y:  51 },
  { name: 'VP',    x:   6, y:  64 },
  { name: 'VN',    x:   6, y:  76 },
  { name: '34',    x:   6, y:  89 },
  { name: '35',    x:   6, y: 102 },
  { name: '32',    x:   6, y: 114 },
  { name: '33',    x:   6, y: 127 },
  { name: '25',    x:   6, y: 140 },
  { name: '26',    x:   6, y: 152 },
  { name: '27',    x:   6, y: 165 },
  { name: '14',    x:   6, y: 178 },
  { name: '12',    x:   6, y: 191 },
  { name: 'GND.1', x:   6, y: 203 },
  { name: '13',    x:   6, y: 216 },
  { name: 'D2',    x:   6, y: 229 },
  { name: 'D3',    x:   6, y: 241 },
  { name: 'CMD',   x:   6, y: 254 },
  { name: '5V',    x:   6, y: 267 },
  { name: 'GND.2', x: 133, y:  38 },
  { name: '23',    x: 133, y:  51 },
  { name: '22',    x: 133, y:  64 },
  { name: 'TX',    x: 133, y:  76 },
  { name: 'RX',    x: 133, y:  89 },
  { name: '21',    x: 133, y: 102 },
  { name: 'GND.3', x: 133, y: 114 },
  { name: '19',    x: 133, y: 127 },
  { name: '18',    x: 133, y: 140 },
  { name: '5',     x: 133, y: 152 },
  { name: '17',    x: 133, y: 165 },
  { name: '16',    x: 133, y: 178 },
  { name: '4',     x: 133, y: 191 },
  { name: '0',     x: 133, y: 203 },
  { name: '2',     x: 133, y: 216 },
  { name: '15',    x: 133, y: 229 },
  { name: 'D1',    x: 133, y: 241 },
  { name: 'D0',    x: 133, y: 254 },
  { name: 'CLK',   x: 133, y: 267 },
];

// ESP32-CAM: 27.2 mm × 40.42 mm → 136 × 202 px
// Left col: x = 1.9 mm → 10 px  |  Right col: x = 24.76 mm → 124 px
const PINS_ESP32_CAM = [
  { name: '5V.1',  x:  10, y:  25 },
  { name: 'GND.1', x:  10, y:  37 },
  { name: '12',    x:  10, y:  50 },
  { name: '13',    x:  10, y:  63 },
  { name: '15',    x:  10, y:  76 },
  { name: '14',    x:  10, y:  88 },
  { name: '2',     x:  10, y: 101 },
  { name: '4',     x:  10, y: 114 },
  { name: '3V3',   x: 124, y:  25 },
  { name: '16',    x: 124, y:  37 },
  { name: '0',     x: 124, y:  50 },
  { name: 'GND.2', x: 124, y:  63 },
  { name: 'VCC',   x: 124, y:  76 },
  { name: 'RX',    x: 124, y:  88 },
  { name: 'TX',    x: 124, y: 101 },
  { name: 'GND.3', x: 124, y: 114 },
];

// Wemos Lolin32 Lite: 25.6 mm × 50 mm → 128 × 250 px
// Left col: x = 1.4 mm → 7 px  |  Right col: x = 24.26 mm → 121 px
const PINS_WEMOS_LOLIN32 = [
  { name: 'VP',      x:   7, y:  37 },
  { name: 'VN',      x:   7, y:  50 },
  { name: 'EN',      x:   7, y:  62 },
  { name: 'GPIO34',  x:   7, y:  75 },
  { name: 'GPIO35',  x:   7, y:  88 },
  { name: 'GPIO32',  x:   7, y: 100 },
  { name: 'GPIO33',  x:   7, y: 113 },
  { name: 'GPIO25',  x:   7, y: 126 },
  { name: 'GPIO26',  x:   7, y: 139 },
  { name: 'GPIO27',  x:   7, y: 151 },
  { name: 'GPIO14',  x:   7, y: 164 },
  { name: 'GPIO12',  x:   7, y: 177 },
  { name: 'GND',     x:   7, y: 189 },
  { name: 'GPIO13',  x: 121, y: 189 },
  { name: 'GPIO15',  x: 121, y: 177 },
  { name: 'GPIO2',   x: 121, y: 164 },
  { name: 'GPIO0',   x: 121, y: 151 },
  { name: 'GPIO4',   x: 121, y: 139 },
  { name: 'GPIO16',  x: 121, y: 126 },
  { name: 'GPIO17',  x: 121, y: 113 },
  { name: 'GPIO5',   x: 121, y: 100 },
  { name: 'GPIO18',  x: 121, y:  88 },
  { name: 'GPIO23',  x: 121, y:  75 },
  { name: 'GPIO19',  x: 121, y:  62 },
  { name: 'GPIO22',  x: 121, y:  50 },
  { name: '3V',      x: 121, y:  37 },
];

// Seeed XIAO ESP32-S3: 18.1 mm × 23.4 mm → 91 × 117 px
// Left col: x = 1.43 mm → 7 px  |  Right col: x = 16.51 mm → 83 px
const PINS_XIAO_ESP32_S3 = [
  { name: 'D0',  x:  7, y:  25 },
  { name: 'D1',  x:  7, y:  37 },
  { name: 'D2',  x:  7, y:  50 },
  { name: 'D3',  x:  7, y:  63 },
  { name: 'D4',  x:  7, y:  75 },
  { name: 'D5',  x:  7, y:  88 },
  { name: 'D6',  x:  7, y: 101 },
  { name: 'D7',  x: 83, y: 101 },
  { name: 'D8',  x: 83, y:  88 },
  { name: 'D9',  x: 83, y:  75 },
  { name: 'D10', x: 83, y:  63 },
  { name: '3V3', x: 83, y:  50 },
  { name: 'GND', x: 83, y:  37 },
  { name: '5V',  x: 83, y:  25 },
];

// Arduino Nano ESP32: 43.3 mm × 18.05 mm → 217 × 90 px  (horizontal layout)
// Top row: y = 1.5 mm → 8 px  |  Bottom row: y = 16.74 mm → 84 px
const PINS_ARDUINO_NANO_ESP32 = [
  { name: 'D12',  x:  24, y:  8 },
  { name: 'D11',  x:  37, y:  8 },
  { name: 'D10',  x:  49, y:  8 },
  { name: 'D9',   x:  62, y:  8 },
  { name: 'D8',   x:  75, y:  8 },
  { name: 'D7',   x:  88, y:  8 },
  { name: 'D6',   x: 100, y:  8 },
  { name: 'D5',   x: 113, y:  8 },
  { name: 'D4',   x: 126, y:  8 },
  { name: 'D3',   x: 138, y:  8 },
  { name: 'D2',   x: 151, y:  8 },
  { name: 'GND.1',x: 164, y:  8 },
  { name: 'RST',  x: 176, y:  8 },
  { name: 'RX0',  x: 189, y:  8 },
  { name: 'TX1',  x: 202, y:  8 },
  { name: 'D13',  x:  24, y: 84 },
  { name: '3V3',  x:  37, y: 84 },
  { name: 'B0',   x:  49, y: 84 },
  { name: 'A0',   x:  62, y: 84 },
  { name: 'A1',   x:  75, y: 84 },
  { name: 'A2',   x:  88, y: 84 },
  { name: 'A3',   x: 100, y: 84 },
  { name: 'A4',   x: 113, y: 84 },
  { name: 'A5',   x: 126, y: 84 },
  { name: 'A6',   x: 138, y: 84 },
  { name: 'A7',   x: 151, y: 84 },
  { name: 'VBUS', x: 164, y: 84 },
  { name: 'B1',   x: 176, y: 84 },
  { name: 'GND.2',x: 189, y: 84 },
  { name: 'VIN',  x: 202, y: 84 },
];

// Seeed XIAO ESP32-C3: 18.1 mm × 23.4 mm → 91 × 117 px (same form as XIAO ESP32-S3)
const PINS_XIAO_ESP32_C3 = PINS_XIAO_ESP32_S3;

// Aitewinrobot ESP32-C3 SuperMini: 18.0 mm × 24.576 mm → 90 × 123 px
// Left col: x = 1.46 mm → 7 px  |  Right col: x = 16.70 mm → 84 px
const PINS_AITEWIN_C3 = [
  { name: '5',   x:  7, y:  16 },
  { name: '6',   x:  7, y:  29 },
  { name: '7',   x:  7, y:  42 },
  { name: '8',   x:  7, y:  54 },
  { name: '9',   x:  7, y:  67 },
  { name: '10',  x:  7, y:  80 },
  { name: 'RX',  x:  7, y:  92 },
  { name: 'TX',  x:  7, y: 105 },
  { name: '5V',  x: 84, y:  16 },
  { name: 'GND', x: 84, y:  29 },
  { name: '3V3', x: 84, y:  42 },
  { name: '4',   x: 84, y:  54 },
  { name: '3',   x: 84, y:  67 },
  { name: '2',   x: 84, y:  80 },
  { name: '1',   x: 84, y:  92 },
  { name: '0',   x: 84, y: 105 },
];

// ─── Board config by variant ──────────────────────────────────────────────────

interface BoardConfig {
  svgUrl: string;
  w: number;
  h: number;
  pins: { name: string; x: number; y: number }[];
}

const BOARD_CONFIGS: Record<string, BoardConfig> = {
  'esp32':                       { svgUrl: esp32SvgUrl,           w: 141, h: 265, pins: PINS_ESP32             },
  'esp32-s3':                    { svgUrl: esp32S3SvgUrl,         w: 128, h: 350, pins: PINS_ESP32_S3          },
  'esp32-c3':                    { svgUrl: esp32C3SvgUrl,         w: 127, h: 215, pins: PINS_ESP32_C3          },
  'esp32-devkit-c-v4':           { svgUrl: esp32DevkitCV4SvgUrl,  w: 140, h: 283, pins: PINS_ESP32_DEVKIT_C_V4 },
  'esp32-cam':                   { svgUrl: esp32CamSvgUrl,        w: 136, h: 202, pins: PINS_ESP32_CAM         },
  'wemos-lolin32-lite':          { svgUrl: wemosLolin32SvgUrl,    w: 128, h: 250, pins: PINS_WEMOS_LOLIN32     },
  'xiao-esp32-s3':               { svgUrl: xiaoEsp32S3SvgUrl,     w:  91, h: 117, pins: PINS_XIAO_ESP32_S3    },
  'arduino-nano-esp32':          { svgUrl: arduinoNanoEsp32SvgUrl,w: 217, h:  90, pins: PINS_ARDUINO_NANO_ESP32},
  'xiao-esp32-c3':               { svgUrl: xiaoEsp32C3SvgUrl,     w:  91, h: 117, pins: PINS_XIAO_ESP32_C3    },
  'aitewinrobot-esp32c3-supermini': { svgUrl: aitewinC3SvgUrl,    w:  90, h: 123, pins: PINS_AITEWIN_C3       },
};

// ─── Custom element ───────────────────────────────────────────────────────────

class Esp32Element extends HTMLElement {
  static get observedAttributes() { return ['board-kind']; }

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
  }

  connectedCallback() { this.render(); }
  attributeChangedCallback() { this.render(); }

  private get config(): BoardConfig {
    const kind = this.getAttribute('board-kind') ?? 'esp32';
    return BOARD_CONFIGS[kind] ?? BOARD_CONFIGS['esp32'];
  }

  get pinInfo() {
    return this.config.pins;
  }

  private render() {
    if (!this.shadowRoot) return;
    const { svgUrl, w, h } = this.config;
    this.shadowRoot.innerHTML = `
      <style>
        :host { display: inline-block; line-height: 0; }
        img   { display: block; }
      </style>
      <img
        src="${svgUrl}"
        width="${w}"
        height="${h}"
        draggable="false"
        alt="ESP32 board"
      />
    `;
  }
}

if (!customElements.get('wokwi-esp32')) {
  customElements.define('wokwi-esp32', Esp32Element);
}
