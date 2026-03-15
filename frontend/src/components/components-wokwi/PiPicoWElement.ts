/**
 * Raspberry Pi Pico W Web Component
 *
 * Uses the official wokwi-boards SVG for the Pi Pico W.
 * Dimensions: 20.9 mm × 52.75 mm → 105 × 264 px (× 5 px/mm)
 */

import piPicoWSvgUrl from '../../../../wokwi-libs/wokwi-boards/boards/pi-pico-w/board.svg?url';

// Pi Pico W pins: 1.6 mm → x=8 (left), 19.3 mm → x=97 (right)
const PINS_PI_PICO_W = [
  { name: 'GP0',      x:  8, y:  17 },
  { name: 'GP1',      x:  8, y:  30 },
  { name: 'GND.1',    x:  8, y:  42 },
  { name: 'GP2',      x:  8, y:  55 },
  { name: 'GP3',      x:  8, y:  68 },
  { name: 'GP4',      x:  8, y:  81 },
  { name: 'GP5',      x:  8, y:  93 },
  { name: 'GND.2',    x:  8, y: 106 },
  { name: 'GP6',      x:  8, y: 119 },
  { name: 'GP7',      x:  8, y: 131 },
  { name: 'GP8',      x:  8, y: 144 },
  { name: 'GP9',      x:  8, y: 157 },
  { name: 'GND.3',    x:  8, y: 169 },
  { name: 'GP10',     x:  8, y: 182 },
  { name: 'GP11',     x:  8, y: 195 },
  { name: 'GP12',     x:  8, y: 207 },
  { name: 'GP13',     x:  8, y: 220 },
  { name: 'GND.4',    x:  8, y: 233 },
  { name: 'GP14',     x:  8, y: 246 },
  { name: 'GP15',     x:  8, y: 258 },
  { name: 'GP16',     x: 97, y: 258 },
  { name: 'GP17',     x: 97, y: 246 },
  { name: 'GND.5',    x: 97, y: 233 },
  { name: 'GP18',     x: 97, y: 220 },
  { name: 'GP19',     x: 97, y: 207 },
  { name: 'GP20',     x: 97, y: 195 },
  { name: 'GP21',     x: 97, y: 182 },
  { name: 'GND.6',    x: 97, y: 169 },
  { name: 'GP22',     x: 97, y: 157 },
  { name: 'RUN',      x: 97, y: 144 },
  { name: 'GP26',     x: 97, y: 131 },
  { name: 'GP27',     x: 97, y: 119 },
  { name: 'GND.7',    x: 97, y: 106 },
  { name: 'GP28',     x: 97, y:  93 },
  { name: 'ADC_VREF', x: 97, y:  81 },
  { name: '3V3',      x: 97, y:  68 },
  { name: '3V3_EN',   x: 97, y:  55 },
  { name: 'GND.8',    x: 97, y:  42 },
  { name: 'VSYS',     x: 97, y:  30 },
  { name: 'VBUS',     x: 97, y:  17 },
];

class PiPicoWElement extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
  }

  connectedCallback() { this.render(); }

  get pinInfo() { return PINS_PI_PICO_W; }

  private render() {
    if (!this.shadowRoot) return;
    this.shadowRoot.innerHTML = `
      <style>
        :host { display: inline-block; line-height: 0; }
        img   { display: block; }
      </style>
      <img
        src="${piPicoWSvgUrl}"
        width="105"
        height="264"
        draggable="false"
        alt="Raspberry Pi Pico W"
      />
    `;
  }
}

if (!customElements.get('wokwi-pi-pico-w')) {
  customElements.define('wokwi-pi-pico-w', PiPicoWElement);
}
