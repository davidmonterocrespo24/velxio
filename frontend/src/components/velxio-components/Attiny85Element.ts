/**
 * ATtiny85 — Web Component (DIP-8 package, Digispark-style)
 *
 * Exposes the standard `pinInfo` array used by the wire system to position
 * wire endpoints on real pins instead of the component corner.
 *
 * Pin layout (DIP-8):
 *   Left side (top to bottom):  PB5 (RST), PB3, PB4, GND
 *   Right side (top to bottom): VCC, PB2, PB1, PB0
 *
 * The visual layout matches the older React component
 * (`Attiny85.tsx` → `Attiny85`), but here we own the DOM so wires can read
 * `element.pinInfo`. The `led1` attribute mirrors the PB1 (Digispark LED)
 * pin state.
 */

// DIP-8 dimensions (must match BoardOnCanvas BOARD_SIZE = 160 × 100)
const W = 160;
const H = 100;
const BX = 30; // chip body left
const BY = 10; // chip body top
const BW = 100; // chip body width
const BH = 80; // chip body height
const PIN_W = 28; // pin stub length

// Vertical pin centres
const PIN_STARTS_Y = [BY + 10, BY + 30, BY + 50, BY + 70];

const PIN_LABELS_LEFT = ['PB5', 'PB3', 'PB4', 'GND'];
const PIN_LABELS_RIGHT = ['VCC', 'PB2', 'PB1', 'PB0'];

/**
 * Pin tip coordinates (where wires must attach), in SVG pixels relative to
 * the element's top-left corner. The wire system reads these via the
 * `pinInfo` property on the rendered DOM element.
 */
const PIN_INFO: ReadonlyArray<{ name: string; x: number; y: number; description?: string }> = [
  // Left column — pin tip = BX - PIN_W
  { name: 'PB5', x: BX - PIN_W, y: PIN_STARTS_Y[0], description: 'PB5 / RST' },
  { name: 'PB3', x: BX - PIN_W, y: PIN_STARTS_Y[1] },
  { name: 'PB4', x: BX - PIN_W, y: PIN_STARTS_Y[2] },
  { name: 'GND', x: BX - PIN_W, y: PIN_STARTS_Y[3] },
  // Right column — pin tip = BX + BW + PIN_W
  { name: 'VCC', x: BX + BW + PIN_W, y: PIN_STARTS_Y[0] },
  { name: 'PB2', x: BX + BW + PIN_W, y: PIN_STARTS_Y[1] },
  { name: 'PB1', x: BX + BW + PIN_W, y: PIN_STARTS_Y[2], description: 'PB1 / built-in LED' },
  { name: 'PB0', x: BX + BW + PIN_W, y: PIN_STARTS_Y[3] },
];

class Attiny85Element extends HTMLElement {
  static get observedAttributes(): string[] {
    return ['led1'];
  }

  private _led1 = false;

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
  }

  connectedCallback() {
    this.render();
  }

  attributeChangedCallback(name: string, _old: string | null, value: string | null) {
    if (name === 'led1') {
      this._led1 = value !== null && value !== 'false';
      this.updateLed();
    }
  }

  /** Wires use this to find pin coordinates. */
  get pinInfo() {
    return PIN_INFO;
  }

  /** Property setter so React's `useEffect` path can drive the LED. */
  set led1(v: boolean) {
    this._led1 = !!v;
    this.updateLed();
  }
  get led1(): boolean {
    return this._led1;
  }

  private updateLed() {
    const led = this.shadowRoot?.getElementById('attiny-led1') as unknown as SVGElement | null;
    if (!led) return;
    if (this._led1) {
      led.setAttribute('fill', '#ffee44');
      led.setAttribute('stroke', '#ffcc00');
      led.style.filter = 'drop-shadow(0 0 4px #ffcc00)';
    } else {
      led.setAttribute('fill', '#333');
      led.setAttribute('stroke', '#555');
      led.style.filter = 'none';
    }
  }

  private render() {
    if (!this.shadowRoot) return;

    // Build pin stubs + labels
    const leftStubs = PIN_STARTS_Y.map(
      (py) => `<line x1="${BX}" y1="${py}" x2="${BX - PIN_W}" y2="${py}"
                     stroke="#aaa" stroke-width="3" stroke-linecap="round" />`,
    ).join('');
    const rightStubs = PIN_STARTS_Y.map(
      (py) => `<line x1="${BX + BW}" y1="${py}" x2="${BX + BW + PIN_W}" y2="${py}"
                     stroke="#aaa" stroke-width="3" stroke-linecap="round" />`,
    ).join('');
    const leftLabels = PIN_LABELS_LEFT.map(
      (label, i) =>
        `<text x="${BX - PIN_W - 2}" y="${PIN_STARTS_Y[i] + 4}" font-size="7"
               font-family="monospace" text-anchor="end"
               fill="${label === 'GND' ? '#888' : '#aac'}">${label === 'PB5' ? 'PB5/RST' : label}</text>`,
    ).join('');
    const rightLabels = PIN_LABELS_RIGHT.map(
      (label, i) =>
        `<text x="${BX + BW + PIN_W + 14}" y="${PIN_STARTS_Y[i] + 4}" font-size="7"
               font-family="monospace" text-anchor="start"
               fill="${label === 'VCC' ? '#888' : label === 'PB1' ? '#ffdd88' : '#aac'}">${label}</text>`,
    ).join('');

    // Built-in LED on PB1 (right side, 3rd from top → PIN_STARTS_Y[2])
    const ledFill = this._led1 ? '#ffee44' : '#333';
    const ledStroke = this._led1 ? '#ffcc00' : '#555';
    const ledFilter = this._led1 ? 'drop-shadow(0 0 4px #ffcc00)' : 'none';

    this.shadowRoot.innerHTML = `
      <style>
        :host { display: inline-block; line-height: 0; }
        svg   { display: block; overflow: visible; }
      </style>
      <svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
        <!-- Pin stubs -->
        ${leftStubs}
        ${rightStubs}

        <!-- IC body -->
        <rect x="${BX}" y="${BY}" width="${BW}" height="${BH}" rx="4" ry="4"
              fill="#1a1a2e" stroke="#4a4a7a" stroke-width="1.5" />

        <!-- Orientation notch -->
        <path d="M${BX + BW / 2 - 7} ${BY} A7 7 0 0 1 ${BX + BW / 2 + 7} ${BY}"
              fill="none" stroke="#4a4a7a" stroke-width="1.5" />

        <!-- Pin 1 dot (bottom-left of body → PB5/RST corner) -->
        <circle cx="${BX + 8}" cy="${BY + BH - 8}" r="2.5" fill="#7a7aaa" />

        <!-- Chip label -->
        <text x="${BX + BW / 2}" y="${BY + BH / 2 - 8}" font-size="10" font-weight="bold"
              font-family="monospace" fill="#c8c8f0" text-anchor="middle">ATtiny85</text>
        <text x="${BX + BW / 2}" y="${BY + BH / 2 + 8}" font-size="8"
              font-family="monospace" fill="#7a7aaa" text-anchor="middle">8-bit AVR</text>

        <!-- Built-in LED on PB1 -->
        <circle id="attiny-led1"
                cx="${BX + BW + PIN_W + 6}" cy="${PIN_STARTS_Y[2]}" r="5"
                fill="${ledFill}" stroke="${ledStroke}" stroke-width="1"
                style="filter: ${ledFilter};" />

        <!-- Labels -->
        ${leftLabels}
        ${rightLabels}
      </svg>
    `;
  }
}

if (!customElements.get('velxio-attiny85')) {
  customElements.define('velxio-attiny85', Attiny85Element);
}

export {};
