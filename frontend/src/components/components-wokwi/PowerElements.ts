/**
 * PowerElements.ts — Custom Web Components for power-supply parts.
 *
 * Includes:
 *   wokwi-reg-7805   / -7812  / -7905   / -lm317  — linear voltage regulators
 *   wokwi-battery-9v / -aa / -coin-cell              — discrete battery cells
 *   wokwi-signal-generator                            — benchtop AC / DC source
 *
 * Regulator pin layout (72 × 48 px): VIN(0, 24)  GND(36, 48)  VOUT(72, 24)
 *                           LM317:    VIN(0, 24)  ADJ(36, 48)  VOUT(72, 24)
 * Battery    (48 × 64 px):  +(24, 0)  −(24, 64)
 * SigGen     (80 × 64 px):  SIG(80, 32)  GND(80, 48)
 */

const FILL   = '#eaefea';
const STROKE = '#2a2a2a';
const LEAD   = '#555555';
const LABEL  = '#333333';
const RED    = '#b03a2e';
const BLACK  = '#1a1a1a';
const STYLE  = ':host{display:inline-block;line-height:0}';

// ─── Linear regulator (TO-220 style) ──────────────────────────────────────────

function regulatorSvg(label: string, middlePinLabel: string): string {
  return `
    <style>${STYLE}</style>
    <svg width="72" height="56" xmlns="http://www.w3.org/2000/svg">
      <!-- Leads -->
      <line x1="0"  y1="24" x2="18" y2="24" stroke="${LEAD}" stroke-width="2"/>
      <line x1="36" y1="40" x2="36" y2="56" stroke="${LEAD}" stroke-width="2"/>
      <line x1="54" y1="24" x2="72" y2="24" stroke="${LEAD}" stroke-width="2"/>
      <!-- Body (rectangular TO-220) -->
      <rect x="18" y="8" width="36" height="32" rx="3" fill="${FILL}" stroke="${STROKE}" stroke-width="1.5"/>
      <!-- Heatsink tab on top -->
      <rect x="22" y="2" width="28" height="6" fill="${STROKE}"/>
      <!-- Pin labels -->
      <text x="2"  y="20" font-family="sans-serif" font-size="6" fill="${LABEL}">VIN</text>
      <text x="56" y="20" font-family="sans-serif" font-size="6" fill="${LABEL}">VOUT</text>
      <text x="32" y="54" font-family="sans-serif" font-size="6" fill="${LABEL}">${middlePinLabel}</text>
      <!-- Part number -->
      <text x="36" y="28" text-anchor="middle" font-family="sans-serif" font-size="9" fill="${LABEL}" font-weight="bold">${label}</text>
    </svg>`;
}

function makeRegulatorClass(label: string, middlePinName: 'GND' | 'ADJ') {
  return class extends HTMLElement {
    readonly pinInfo = [
      { name: 'VIN',  x: 0,  y: 24, number: 1, signals: [] as string[] },
      { name: middlePinName, x: 36, y: 56, number: 2, signals: [] as string[] },
      { name: 'VOUT', x: 72, y: 24, number: 3, signals: [] as string[] },
    ];
    constructor() {
      super();
      this.attachShadow({ mode: 'open' }).innerHTML = regulatorSvg(label, middlePinName);
    }
  };
}

const Reg7805  = makeRegulatorClass('7805',  'GND');
const Reg7812  = makeRegulatorClass('7812',  'GND');
const Reg7905  = makeRegulatorClass('7905',  'GND');
const RegLM317 = makeRegulatorClass('LM317', 'ADJ');

// ─── Battery ──────────────────────────────────────────────────────────────────

function batterySvg(label: string, color: string): string {
  return `
    <style>${STYLE}</style>
    <svg width="48" height="72" xmlns="http://www.w3.org/2000/svg">
      <!-- + terminal lead -->
      <line x1="24" y1="0" x2="24" y2="8" stroke="${LEAD}" stroke-width="2"/>
      <!-- Body (rounded rectangle) -->
      <rect x="8" y="8" width="32" height="56" rx="3" fill="${color}" stroke="${STROKE}" stroke-width="1.5"/>
      <!-- Top cap (positive) -->
      <rect x="18" y="4" width="12" height="6" fill="${BLACK}" stroke="${STROKE}" stroke-width="1"/>
      <!-- − terminal lead -->
      <line x1="24" y1="64" x2="24" y2="72" stroke="${LEAD}" stroke-width="2"/>
      <!-- + / − markers -->
      <text x="24" y="22" text-anchor="middle" font-family="sans-serif" font-size="12" fill="white" font-weight="bold">+</text>
      <text x="24" y="56" text-anchor="middle" font-family="sans-serif" font-size="14" fill="white" font-weight="bold">−</text>
      <!-- Label -->
      <text x="24" y="42" text-anchor="middle" font-family="sans-serif" font-size="8" fill="white" font-weight="bold">${label}</text>
    </svg>`;
}

function makeBatteryClass(label: string, color: string) {
  return class extends HTMLElement {
    readonly pinInfo = [
      { name: '+', x: 24, y: 0,  number: 1, signals: [] as string[] },
      { name: '−', x: 24, y: 72, number: 2, signals: [] as string[] },
    ];
    constructor() {
      super();
      this.attachShadow({ mode: 'open' }).innerHTML = batterySvg(label, color);
    }
  };
}

const Battery9V   = makeBatteryClass('9V',   RED);
const BatteryAA   = makeBatteryClass('AA',   '#336699');
const BatteryCoin = makeBatteryClass('3V',   '#666');

// ─── Signal generator (benchtop instrument) ───────────────────────────────────

class SignalGeneratorElement extends HTMLElement {
  readonly pinInfo = [
    { name: 'SIG', x: 80, y: 24, number: 1, signals: [] as string[] },
    { name: 'GND', x: 80, y: 48, number: 2, signals: [] as string[] },
  ];
  constructor() {
    super();
    this.attachShadow({ mode: 'open' }).innerHTML = `
      <style>${STYLE}</style>
      <svg width="80" height="64" xmlns="http://www.w3.org/2000/svg">
        <!-- Body -->
        <rect x="0" y="0" width="64" height="64" rx="4" fill="#1a1a2e" stroke="${STROKE}" stroke-width="1.5"/>
        <!-- Screen -->
        <rect x="6" y="6" width="52" height="28" fill="#0a3a0a"/>
        <!-- Sine waveform -->
        <path d="M10,20 Q16,8 22,20 T34,20 T46,20 T58,20" fill="none" stroke="#5af55a" stroke-width="1.5"/>
        <!-- Knobs -->
        <circle cx="14" cy="48" r="6" fill="#444" stroke="${STROKE}" stroke-width="1"/>
        <circle cx="32" cy="48" r="6" fill="#444" stroke="${STROKE}" stroke-width="1"/>
        <circle cx="50" cy="48" r="6" fill="#444" stroke="${STROKE}" stroke-width="1"/>
        <!-- Output leads -->
        <line x1="64" y1="24" x2="80" y2="24" stroke="${LEAD}" stroke-width="2"/>
        <line x1="64" y1="48" x2="80" y2="48" stroke="${LEAD}" stroke-width="2"/>
        <text x="66" y="20" font-family="sans-serif" font-size="6" fill="${LABEL}">SIG</text>
        <text x="66" y="44" font-family="sans-serif" font-size="6" fill="${LABEL}">GND</text>
      </svg>`;
  }
}

function def(tag: string, cls: CustomElementConstructor) {
  if (!customElements.get(tag)) customElements.define(tag, cls);
}

def('wokwi-reg-7805',  Reg7805);
def('wokwi-reg-7812',  Reg7812);
def('wokwi-reg-7905',  Reg7905);
def('wokwi-reg-lm317', RegLM317);
def('wokwi-battery-9v',         Battery9V);
def('wokwi-battery-aa',         BatteryAA);
def('wokwi-battery-coin-cell',  BatteryCoin);
def('wokwi-signal-generator',   SignalGeneratorElement);

export {};
