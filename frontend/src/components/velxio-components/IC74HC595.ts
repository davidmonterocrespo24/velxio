/**
 * velxio-74hc595 — 8-bit Serial-to-Parallel Shift Register (SN74HC595)
 *
 * DIP-16 package custom element for use in Velxio/Wokwi simulations.
 */

class IC74HC595Element extends HTMLElement {
  private _values: number[] = [0, 0, 0, 0, 0, 0, 0, 0]; // Q0-Q7
  private _shadow: ShadowRoot;

  // ── Pin layout (DIP-16, matching wokwi-elements coordinate style) ─────────
  // Top row (y=3): pins 16→9, left to right
  // Bottom row (y=51): pins 1→8, left to right
  readonly pinInfo = [
    // Bottom row: pins 1-8 (Q1–Q7, GND)
    { name: 'Q1', number: 1, x: 8.1, y: 51.3, signals: [] },
    { name: 'Q2', number: 2, x: 17.7, y: 51.3, signals: [] },
    { name: 'Q3', number: 3, x: 27.3, y: 51.3, signals: [] },
    { name: 'Q4', number: 4, x: 36.9, y: 51.3, signals: [] },
    { name: 'Q5', number: 5, x: 46.5, y: 51.3, signals: [] },
    { name: 'Q6', number: 6, x: 56.1, y: 51.3, signals: [] },
    { name: 'Q7', number: 7, x: 65.7, y: 51.3, signals: [] },
    { name: 'GND', number: 8, x: 75.3, y: 51.3, signals: [] },
    // Top row: pins 9-16 (Q7S, MR, SHCP, STCP, OE, DS, Q0, VCC) right to left
    { name: 'Q7S', number: 9, x: 75.3, y: 3, signals: [] },
    { name: 'MR', number: 10, x: 65.7, y: 3, signals: [] },
    { name: 'SHCP', number: 11, x: 56.1, y: 3, signals: [] },
    { name: 'STCP', number: 12, x: 46.5, y: 3, signals: [] },
    { name: 'OE', number: 13, x: 36.9, y: 3, signals: [] },
    { name: 'DS', number: 14, x: 27.3, y: 3, signals: [] },
    { name: 'Q0', number: 15, x: 17.7, y: 3, signals: [] },
    { name: 'VCC', number: 16, x: 8.1, y: 3, signals: [] },
  ];

  constructor() {
    super();
    this._shadow = this.attachShadow({ mode: 'open' });
    this._render();
  }

  get values() {
    return this._values;
  }

  set values(v: number[]) {
    this._values = Array.isArray(v) ? [...v] : [0, 0, 0, 0, 0, 0, 0, 0];
    this._renderOutputDots();
  }

  private _render() {
    const PIN_X = [8.1, 17.7, 27.3, 36.9, 46.5, 56.1, 65.7, 75.3];
    const TOP_Y = 3;
    const BOT_Y = 51.3;
    const CHIP_Y1 = 9;
    const CHIP_H = 37;

    const topLabels = ['VCC', 'Q0', 'DS', 'OE', 'SCP', 'HCP', 'MR', 'Q7S'];
    const botLabels = ['Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6', 'Q7', 'GND'];

    const pinLines = PIN_X.map(
      (x) => `
      <line x1="${x}" y1="${TOP_Y}" x2="${x}" y2="${CHIP_Y1}" stroke="#aaa" stroke-width="1.5"/>
      <circle cx="${x}" cy="${TOP_Y}" r="2" fill="#aaa"/>
      <line x1="${x}" y1="${BOT_Y}" x2="${x}" y2="${CHIP_Y1 + CHIP_H}" stroke="#aaa" stroke-width="1.5"/>
      <circle cx="${x}" cy="${BOT_Y}" r="2" fill="#aaa"/>
    `,
    ).join('');

    const topText = PIN_X.map(
      (x, i) => `
      <text x="${x}" y="${CHIP_Y1 + 7}" text-anchor="middle" font-size="3.5" fill="#0ff">${topLabels[i]}</text>
    `,
    ).join('');

    const botText = PIN_X.map(
      (x, i) => `
      <text x="${x}" y="${CHIP_Y1 + CHIP_H - 3}" text-anchor="middle" font-size="3.5" fill="#0ff">${botLabels[i]}</text>
    `,
    ).join('');

    const outputDots = PIN_X.map(
      (x, i) => `
      <circle id="dot-q${i + 1}" cx="${x}" cy="${BOT_Y - 6}" r="2" fill="#333" opacity="0.6"/>
    `,
    ).join('');

    this._shadow.innerHTML = `
      <style>
        :host { display: inline-block; }
        svg { overflow: visible; }
      </style>
      <svg width="84" height="55" viewBox="0 0 84 55" xmlns="http://www.w3.org/2000/svg">
        ${pinLines}
        <!-- Chip body -->
        <rect x="5" y="${CHIP_Y1}" width="74" height="${CHIP_H}" rx="2" fill="#1a1a2e" stroke="#555" stroke-width="0.8"/>
        <!-- Notch (pin 1 indicator) -->
        <ellipse cx="5" cy="${CHIP_Y1 + CHIP_H / 2}" rx="3" ry="4" fill="#111" stroke="#555" stroke-width="0.5"/>
        <!-- Chip label -->
        <text x="42" y="${CHIP_Y1 + 14}" text-anchor="middle" font-size="6" font-weight="bold" fill="#eee" font-family="monospace">74HC595</text>
        <!-- Pin labels top -->
        ${topText}
        <!-- Pin labels bottom -->
        ${botText}
        <!-- Q1-Q7 output state dots (bottom side, animated) -->
        ${outputDots}
        <!-- Q0 dot on top side -->
        <circle id="dot-q0" cx="${PIN_X[1]}" cy="${CHIP_Y1 + 6}" r="2" fill="#333" opacity="0.6"/>
      </svg>
    `;
  }

  private _renderOutputDots() {
    if (!this._shadow) return;
    // Update Q1-Q7 output dots (bottom, indices 1-7 of values)
    for (let i = 1; i <= 7; i++) {
      const dot = this._shadow.getElementById(`dot-q${i}`) as SVGCircleElement | null;
      if (dot) {
        dot.setAttribute('fill', this._values[i] ? '#00ff88' : '#333');
        dot.setAttribute('opacity', this._values[i] ? '1' : '0.5');
      }
    }
    // Q0 on top side
    const dotQ0 = this._shadow.getElementById('dot-q0') as SVGCircleElement | null;
    if (dotQ0) {
      dotQ0.setAttribute('fill', this._values[0] ? '#00ff88' : '#333');
      dotQ0.setAttribute('opacity', this._values[0] ? '1' : '0.5');
    }
  }
}

if (!customElements.get('velxio-74hc595')) {
  customElements.define('velxio-74hc595', IC74HC595Element);
}

export { IC74HC595Element };
