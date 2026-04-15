/**
 * DiodeElements.ts — Custom Web Components for diode packages.
 *
 * Covers the entire diode family used by the SPICE mapper:
 *   wokwi-diode           — generic diode (DIN 41866 symbol)
 *   wokwi-diode-1n4148    — small-signal silicon
 *   wokwi-diode-1n4007    — 1 kV rectifier
 *   wokwi-zener-1n4733    — 5.1 V Zener (Z-shaped cathode)
 *   wokwi-diode-1n5817    — Schottky 20 V (S-shaped cathode)
 *   wokwi-diode-1n5819    — Schottky 40 V
 *   wokwi-photodiode      — light-sensitive (with incoming arrows)
 *
 * All diodes share the same pin layout (72 × 32 px):
 *   A  (0, 16)  — anode
 *   C  (72, 16) — cathode
 */

const STROKE = '#2a2a2a';
const LEAD   = '#555555';
const FILL   = '#f4f0e8';
const LABEL  = '#333333';
const STYLE  = ':host{display:inline-block;line-height:0}';

function diodePinInfo() {
  return [
    { name: 'A', x: 0,  y: 16, number: 1, signals: [] as string[] },
    { name: 'C', x: 72, y: 16, number: 2, signals: [] as string[] },
  ];
}

function diodeSvg(opts: {
  cathodeShape?: 'normal' | 'zener' | 'schottky';
  showLightArrows?: boolean;
  label: string;
}): string {
  const { cathodeShape = 'normal', showLightArrows = false, label } = opts;

  // Triangle pointing right, apex at x=38, base x=24 (top 6, bottom 26)
  // Cathode line at x=40
  let cathode: string;
  switch (cathodeShape) {
    case 'zener':
      // Z-shape: short bent segments at top and bottom
      cathode = `
        <line x1="40" y1="6"  x2="40" y2="26" stroke="${STROKE}" stroke-width="2"/>
        <line x1="40" y1="6"  x2="34" y2="4"  stroke="${STROKE}" stroke-width="2"/>
        <line x1="40" y1="26" x2="46" y2="28" stroke="${STROKE}" stroke-width="2"/>`;
      break;
    case 'schottky':
      // S-shape: small hooks at both ends (looks like an "S" on its side)
      cathode = `
        <line x1="40" y1="6"  x2="40" y2="26" stroke="${STROKE}" stroke-width="2"/>
        <line x1="36" y1="4"  x2="40" y2="4"  stroke="${STROKE}" stroke-width="2"/>
        <line x1="36" y1="4"  x2="36" y2="8"  stroke="${STROKE}" stroke-width="2"/>
        <line x1="40" y1="28" x2="44" y2="28" stroke="${STROKE}" stroke-width="2"/>
        <line x1="44" y1="24" x2="44" y2="28" stroke="${STROKE}" stroke-width="2"/>`;
      break;
    default:
      cathode = `<line x1="40" y1="6" x2="40" y2="26" stroke="${STROKE}" stroke-width="2"/>`;
  }

  const lightArrows = showLightArrows
    ? `
        <line x1="12" y1="4"  x2="26" y2="10" stroke="#e1a500" stroke-width="1.5"/>
        <polygon points="22,6 27,10 22,12" fill="#e1a500"/>
        <line x1="8"  y1="8"  x2="22" y2="14" stroke="#e1a500" stroke-width="1.5"/>
        <polygon points="18,10 23,14 18,16" fill="#e1a500"/>`
    : '';

  return `
    <style>${STYLE}</style>
    <svg width="72" height="40" xmlns="http://www.w3.org/2000/svg">
      <!-- Leads -->
      <line x1="0"  y1="16" x2="24" y2="16" stroke="${LEAD}" stroke-width="2"/>
      <line x1="40" y1="16" x2="72" y2="16" stroke="${LEAD}" stroke-width="2"/>
      <!-- Triangle (anode side) -->
      <polygon points="24,6 24,26 40,16" fill="${FILL}" stroke="${STROKE}" stroke-width="1.5"/>
      <!-- Cathode marker -->
      ${cathode}
      ${lightArrows}
      <!-- Pin labels -->
      <text x="2"  y="14" font-family="sans-serif" font-size="6" fill="${LABEL}">A</text>
      <text x="62" y="14" font-family="sans-serif" font-size="6" fill="${LABEL}">C</text>
      <!-- Part number -->
      <text x="36" y="38" text-anchor="middle" font-family="sans-serif" font-size="7" fill="${LABEL}" font-weight="bold">${label}</text>
    </svg>`;
}

function makeDiodeClass(label: string, shape: 'normal' | 'zener' | 'schottky', light = false) {
  return class extends HTMLElement {
    readonly pinInfo = diodePinInfo();
    constructor() {
      super();
      this.attachShadow({ mode: 'open' }).innerHTML = diodeSvg({ cathodeShape: shape, showLightArrows: light, label });
    }
  };
}

const Diode       = makeDiodeClass('D',      'normal');
const Diode1N4148 = makeDiodeClass('1N4148', 'normal');
const Diode1N4007 = makeDiodeClass('1N4007', 'normal');
const Zener1N4733 = makeDiodeClass('1N4733', 'zener');
const Diode1N5817 = makeDiodeClass('1N5817', 'schottky');
const Diode1N5819 = makeDiodeClass('1N5819', 'schottky');
const Photodiode  = makeDiodeClass('PHOTO',  'normal', true);

function def(tag: string, cls: CustomElementConstructor) {
  if (!customElements.get(tag)) customElements.define(tag, cls);
}

def('wokwi-diode',         Diode);
def('wokwi-diode-1n4148',  Diode1N4148);
def('wokwi-diode-1n4007',  Diode1N4007);
def('wokwi-zener-1n4733',  Zener1N4733);
def('wokwi-diode-1n5817',  Diode1N5817);
def('wokwi-diode-1n5819',  Diode1N5819);
def('wokwi-photodiode',    Photodiode);

export {};
