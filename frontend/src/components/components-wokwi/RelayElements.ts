/**
 * RelayElements.ts — Custom Web Components for electromechanical relays.
 *
 * Tag defined:
 *   wokwi-relay — 5-pin SPDT relay (COIL+, COIL-, COM, NO, NC)
 *
 * Pin layout (CSS pixels, 96 × 96):
 *   COIL+ (0,  16)   COIL- (0,  80)
 *   COM   (96, 48)
 *   NO    (96, 16)   NC    (96, 80)
 */

const FILL   = '#f8f4ee';
const STROKE = '#2a2a2a';
const LEAD   = '#555555';
const COIL_LINE = '#8a5a00';
const LABEL  = '#333333';
const STYLE  = ':host{display:inline-block;line-height:0}';

class RelayElement extends HTMLElement {
  readonly pinInfo = [
    { name: 'COIL+', x: 0,  y: 16, number: 1, signals: [] as string[] },
    { name: 'COIL-', x: 0,  y: 80, number: 2, signals: [] as string[] },
    { name: 'NO',    x: 96, y: 16, number: 3, signals: [] as string[] },
    { name: 'COM',   x: 96, y: 48, number: 4, signals: [] as string[] },
    { name: 'NC',    x: 96, y: 80, number: 5, signals: [] as string[] },
  ];
  constructor() {
    super();
    this.attachShadow({ mode: 'open' }).innerHTML = `
      <style>${STYLE}</style>
      <svg width="96" height="96" xmlns="http://www.w3.org/2000/svg">
        <!-- Outer package -->
        <rect x="10" y="8" width="76" height="80" rx="4" fill="${FILL}" stroke="${STROKE}" stroke-width="1.5"/>
        <!-- Coil leads -->
        <line x1="0" y1="16" x2="18" y2="16" stroke="${LEAD}" stroke-width="2"/>
        <line x1="0" y1="80" x2="18" y2="80" stroke="${LEAD}" stroke-width="2"/>
        <!-- Coil (represented as a vertical winding) -->
        <line x1="22" y1="16" x2="22" y2="80" stroke="${COIL_LINE}" stroke-width="1.5"/>
        <circle cx="22" cy="24" r="3" fill="none" stroke="${COIL_LINE}" stroke-width="1.5"/>
        <circle cx="22" cy="34" r="3" fill="none" stroke="${COIL_LINE}" stroke-width="1.5"/>
        <circle cx="22" cy="44" r="3" fill="none" stroke="${COIL_LINE}" stroke-width="1.5"/>
        <circle cx="22" cy="54" r="3" fill="none" stroke="${COIL_LINE}" stroke-width="1.5"/>
        <circle cx="22" cy="64" r="3" fill="none" stroke="${COIL_LINE}" stroke-width="1.5"/>
        <circle cx="22" cy="74" r="3" fill="none" stroke="${COIL_LINE}" stroke-width="1.5"/>
        <!-- Armature pivot at COM -->
        <line x1="60" y1="48" x2="80" y2="48" stroke="${LEAD}" stroke-width="2"/>
        <!-- NC lead (rest position, connected to COM) -->
        <line x1="60" y1="48" x2="72" y2="76" stroke="${STROKE}" stroke-width="2" stroke-dasharray="2,2"/>
        <line x1="72" y1="76" x2="86" y2="80" stroke="${STROKE}" stroke-width="2" stroke-dasharray="2,2"/>
        <line x1="86" y1="80" x2="96" y2="80" stroke="${LEAD}" stroke-width="2"/>
        <!-- NO lead (activated position) -->
        <line x1="72" y1="20" x2="86" y2="16" stroke="${STROKE}" stroke-width="2"/>
        <line x1="86" y1="16" x2="96" y2="16" stroke="${LEAD}" stroke-width="2"/>
        <!-- Labels -->
        <text x="2"  y="12" font-family="sans-serif" font-size="6" fill="${LABEL}">C+</text>
        <text x="2"  y="76" font-family="sans-serif" font-size="6" fill="${LABEL}">C−</text>
        <text x="82" y="12" font-family="sans-serif" font-size="6" fill="${LABEL}">NO</text>
        <text x="82" y="44" font-family="sans-serif" font-size="6" fill="${LABEL}">COM</text>
        <text x="82" y="76" font-family="sans-serif" font-size="6" fill="${LABEL}">NC</text>
        <!-- Label -->
        <text x="48" y="54" text-anchor="middle" font-family="sans-serif" font-size="9" fill="${LABEL}" font-weight="bold">RELAY</text>
      </svg>`;
  }
}

if (!customElements.get('wokwi-relay')) customElements.define('wokwi-relay', RelayElement);

// ─── Optocouplers (DIP-4 package: LED + phototransistor) ─────────────────────

function optoSvg(label: string): string {
  return `
    <style>${STYLE}</style>
    <svg width="80" height="64" xmlns="http://www.w3.org/2000/svg">
      <!-- Package -->
      <rect x="10" y="8" width="60" height="48" rx="3" fill="${FILL}" stroke="${STROKE}" stroke-width="1.5"/>
      <!-- Divider showing galvanic isolation -->
      <line x1="40" y1="8" x2="40" y2="56" stroke="${STROKE}" stroke-width="0.8" stroke-dasharray="2,2"/>
      <!-- LED symbol (left) -->
      <polygon points="18,22 18,38 30,30" fill="${FILL}" stroke="${STROKE}" stroke-width="1.2"/>
      <line x1="30" y1="22" x2="30" y2="38" stroke="${STROKE}" stroke-width="1.5"/>
      <!-- Light arrows -->
      <line x1="26" y1="26" x2="34" y2="30" stroke="#e1a500" stroke-width="1"/>
      <line x1="26" y1="34" x2="34" y2="30" stroke="#e1a500" stroke-width="1"/>
      <!-- Phototransistor (right) — simplified NPN -->
      <line x1="46" y1="20" x2="46" y2="40" stroke="${STROKE}" stroke-width="2"/>
      <line x1="46" y1="25" x2="58" y2="18" stroke="${STROKE}" stroke-width="1.2"/>
      <line x1="46" y1="35" x2="58" y2="42" stroke="${STROKE}" stroke-width="1.2"/>
      <polygon points="54,40 58,42 56,36" fill="${STROKE}"/>
      <!-- Leads -->
      <line x1="0"  y1="16" x2="10" y2="16" stroke="${LEAD}" stroke-width="2"/>
      <line x1="0"  y1="48" x2="10" y2="48" stroke="${LEAD}" stroke-width="2"/>
      <line x1="70" y1="16" x2="80" y2="16" stroke="${LEAD}" stroke-width="2"/>
      <line x1="70" y1="48" x2="80" y2="48" stroke="${LEAD}" stroke-width="2"/>
      <text x="2"  y="12" font-family="sans-serif" font-size="6" fill="${LABEL}">AN</text>
      <text x="2"  y="44" font-family="sans-serif" font-size="6" fill="${LABEL}">CAT</text>
      <text x="66" y="12" font-family="sans-serif" font-size="6" fill="${LABEL}">COL</text>
      <text x="64" y="44" font-family="sans-serif" font-size="6" fill="${LABEL}">EMIT</text>
      <text x="40" y="62" text-anchor="middle" font-family="sans-serif" font-size="7" fill="${LABEL}" font-weight="bold">${label}</text>
    </svg>`;
}

function makeOptoClass(label: string) {
  return class extends HTMLElement {
    readonly pinInfo = [
      { name: 'AN',   x: 0,  y: 16, number: 1, signals: [] as string[] },
      { name: 'CAT',  x: 0,  y: 48, number: 2, signals: [] as string[] },
      { name: 'COL',  x: 80, y: 16, number: 3, signals: [] as string[] },
      { name: 'EMIT', x: 80, y: 48, number: 4, signals: [] as string[] },
    ];
    constructor() {
      super();
      this.attachShadow({ mode: 'open' }).innerHTML = optoSvg(label);
    }
  };
}

const Opto4N25  = makeOptoClass('4N25');
const OptoPC817 = makeOptoClass('PC817');

if (!customElements.get('wokwi-opto-4n25'))  customElements.define('wokwi-opto-4n25',  Opto4N25);
if (!customElements.get('wokwi-opto-pc817')) customElements.define('wokwi-opto-pc817', OptoPC817);

// ─── L293D dual H-bridge motor driver (DIP-16) ──────────────────────────────

class L293DElement extends HTMLElement {
  // 16-pin DIP. Pin map (datasheet):
  //  1=EN1, 2=IN1, 3=OUT1, 4=GND, 5=GND, 6=OUT2, 7=IN2, 8=VCC2
  //  9=EN2, 10=IN3, 11=OUT3, 12=GND, 13=GND, 14=OUT4, 15=IN4, 16=VCC1
  readonly pinInfo = [
    { name: 'EN1',   x: 0,   y: 12, number: 1,  signals: [] as string[] },
    { name: 'IN1',   x: 0,   y: 20, number: 2,  signals: [] as string[] },
    { name: 'OUT1',  x: 0,   y: 28, number: 3,  signals: [] as string[] },
    { name: 'GND.1', x: 0,   y: 36, number: 4,  signals: [] as string[] },
    { name: 'GND.2', x: 0,   y: 44, number: 5,  signals: [] as string[] },
    { name: 'OUT2',  x: 0,   y: 52, number: 6,  signals: [] as string[] },
    { name: 'IN2',   x: 0,   y: 60, number: 7,  signals: [] as string[] },
    { name: 'VCC2',  x: 0,   y: 68, number: 8,  signals: [] as string[] },
    { name: 'EN2',   x: 100, y: 68, number: 9,  signals: [] as string[] },
    { name: 'IN3',   x: 100, y: 60, number: 10, signals: [] as string[] },
    { name: 'OUT3',  x: 100, y: 52, number: 11, signals: [] as string[] },
    { name: 'GND.3', x: 100, y: 44, number: 12, signals: [] as string[] },
    { name: 'GND.4', x: 100, y: 36, number: 13, signals: [] as string[] },
    { name: 'OUT4',  x: 100, y: 28, number: 14, signals: [] as string[] },
    { name: 'IN4',   x: 100, y: 20, number: 15, signals: [] as string[] },
    { name: 'VCC1',  x: 100, y: 12, number: 16, signals: [] as string[] },
  ];
  constructor() {
    super();
    this.attachShadow({ mode: 'open' }).innerHTML = `
      <style>${STYLE}</style>
      <svg width="100" height="80" xmlns="http://www.w3.org/2000/svg">
        <rect x="10" y="4" width="80" height="72" rx="4" fill="#1f2937" stroke="#eef3fa" stroke-width="1"/>
        <circle cx="18" cy="12" r="2" fill="#eef3fa"/>
        <!-- Pin ticks -->
        ${this.pinInfo
          .map(p => {
            const isLeft = p.x === 0;
            const x2 = isLeft ? 10 : 90;
            const x1 = isLeft ? 0 : 100;
            return `<line x1="${x1}" y1="${p.y}" x2="${x2}" y2="${p.y}" stroke="#bbb" stroke-width="1.5"/>`;
          })
          .join('')}
        <text x="50" y="44" text-anchor="middle" font-family="sans-serif" font-size="10" fill="#e5e7eb" font-weight="bold">L293D</text>
      </svg>`;
  }
}

if (!customElements.get('wokwi-motor-driver-l293d')) {
  customElements.define('wokwi-motor-driver-l293d', L293DElement);
}

export {};
