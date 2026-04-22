/**
 * LogicICElements.ts — Custom Web Components for 74HC logic IC packages.
 *
 * All ICs use a DIP-14 visual (7 pins each side, Vcc top-right, GND bottom-left
 * on pin 7). Generated gate-per-package mappers in componentToSpice.ts emit
 * B-sources that reference pins by name (1A, 1B, 1Y, ... 4Y, VCC, GND).
 *
 * Tags defined:
 *   wokwi-ic-74hc00  — quad 2-input NAND
 *   wokwi-ic-74hc02  — quad 2-input NOR
 *   wokwi-ic-74hc04  — hex inverter
 *   wokwi-ic-74hc08  — quad 2-input AND
 *   wokwi-ic-74hc14  — hex Schmitt inverter
 *   wokwi-ic-74hc32  — quad 2-input OR
 *   wokwi-ic-74hc86  — quad 2-input XOR
 */

const FILL = '#1f2937';
const ACCENT = '#eef3fa';
const LEAD = '#bbbbbb';
const LABEL = '#e5e7eb';
const STYLE = ':host{display:inline-block;line-height:0}';

// DIP-14 layout: 7 pins per side, 8 px vertical spacing, pin 1 at top-left
// Width 80, height 8·7 + 16 = 72
const DIP14_W = 80;
const DIP14_H = 72;

type Pin = { name: string; x: number; y: number; number: number; signals: string[] };

function dip14Pins(names: string[]): Pin[] {
  // Convention: [pin1, pin2, ... pin7, pin8, ... pin14]
  // Pin 1 = top-left. Count down the left side (pins 1-7), then up the right
  // side (pin 8 at bottom-right through pin 14 at top-right).
  const pins: Pin[] = [];
  for (let i = 0; i < 14; i++) {
    let x: number, y: number;
    if (i < 7) {
      // Left side
      x = 0;
      y = 12 + i * 8;
    } else {
      // Right side, going UP (pin 8 at bottom)
      x = DIP14_W;
      y = 12 + (13 - i) * 8;
    }
    pins.push({ name: names[i] ?? `P${i + 1}`, x, y, number: i + 1, signals: [] });
  }
  return pins;
}

function dip14Svg(label: string, pinLabels: string[]): string {
  // Left and right label columns
  let leftLabels = '';
  let rightLabels = '';
  for (let i = 0; i < 7; i++) {
    const y = 12 + i * 8;
    leftLabels += `<text x="4" y="${y + 2}" font-family="sans-serif" font-size="4" fill="${LABEL}">${pinLabels[i] ?? ''}</text>`;
  }
  for (let i = 7; i < 14; i++) {
    const y = 12 + (13 - i) * 8;
    rightLabels += `<text x="${DIP14_W - 12}" y="${y + 2}" font-family="sans-serif" font-size="4" fill="${LABEL}">${pinLabels[i] ?? ''}</text>`;
  }
  // Pin ticks
  let pinTicks = '';
  for (let i = 0; i < 7; i++) {
    const y = 12 + i * 8;
    pinTicks += `<line x1="0" y1="${y}" x2="8" y2="${y}" stroke="${LEAD}" stroke-width="1.5"/>`;
    pinTicks += `<line x1="${DIP14_W - 8}" y1="${y}" x2="${DIP14_W}" y2="${y}" stroke="${LEAD}" stroke-width="1.5"/>`;
  }
  return `
    <style>${STYLE}</style>
    <svg width="${DIP14_W}" height="${DIP14_H}" xmlns="http://www.w3.org/2000/svg">
      <rect x="8" y="6" width="${DIP14_W - 16}" height="${DIP14_H - 12}" rx="3" fill="${FILL}" stroke="${ACCENT}" stroke-width="1"/>
      <!-- Pin 1 indicator (notch on left side of the package) -->
      <circle cx="14" cy="12" r="2" fill="${ACCENT}"/>
      ${pinTicks}
      ${leftLabels}
      ${rightLabels}
      <text x="${DIP14_W / 2}" y="${DIP14_H / 2 + 2}" text-anchor="middle" font-family="sans-serif" font-size="9" fill="${LABEL}" font-weight="bold">${label}</text>
    </svg>`;
}

// Quad 2-input gate pinout: 1A 1B 1Y 2A 2B 2Y GND | 3Y 3A 3B 4Y 4A 4B VCC
const QUAD_2IN_PINS = [
  '1A',
  '1B',
  '1Y',
  '2A',
  '2B',
  '2Y',
  'GND',
  '3Y',
  '3A',
  '3B',
  '4Y',
  '4A',
  '4B',
  'VCC',
];

// Hex inverter pinout: 1A 1Y 2A 2Y 3A 3Y GND | 4Y 4A 5Y 5A 6Y 6A VCC
const HEX_INV_PINS = [
  '1A',
  '1Y',
  '2A',
  '2Y',
  '3A',
  '3Y',
  'GND',
  '4Y',
  '4A',
  '5Y',
  '5A',
  '6Y',
  '6A',
  'VCC',
];

function makeIcClass(label: string, pinNames: string[]) {
  return class extends HTMLElement {
    readonly pinInfo = dip14Pins(pinNames);
    constructor() {
      super();
      this.attachShadow({ mode: 'open' }).innerHTML = dip14Svg(label, pinNames);
    }
  };
}

const Ic74HC00 = makeIcClass('74HC00', QUAD_2IN_PINS);
const Ic74HC02 = makeIcClass('74HC02', QUAD_2IN_PINS);
const Ic74HC04 = makeIcClass('74HC04', HEX_INV_PINS);
const Ic74HC08 = makeIcClass('74HC08', QUAD_2IN_PINS);
const Ic74HC14 = makeIcClass('74HC14', HEX_INV_PINS);
const Ic74HC32 = makeIcClass('74HC32', QUAD_2IN_PINS);
const Ic74HC86 = makeIcClass('74HC86', QUAD_2IN_PINS);

function def(tag: string, cls: CustomElementConstructor) {
  if (!customElements.get(tag)) customElements.define(tag, cls);
}

def('wokwi-ic-74hc00', Ic74HC00);
def('wokwi-ic-74hc02', Ic74HC02);
def('wokwi-ic-74hc04', Ic74HC04);
def('wokwi-ic-74hc08', Ic74HC08);
def('wokwi-ic-74hc14', Ic74HC14);
def('wokwi-ic-74hc32', Ic74HC32);
def('wokwi-ic-74hc86', Ic74HC86);

export {};
