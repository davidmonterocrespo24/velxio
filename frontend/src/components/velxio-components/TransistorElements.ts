/**
 * TransistorElements.ts — Custom Web Components for BJT and MOSFET packages.
 *
 * These elements do NOT exist in wokwi-elements — they are Velxio-specific
 * parts used by the SPICE electrical-mode simulator. Each element is a thin
 * SVG schematic symbol with 3 pins (collector/base/emitter for BJT,
 * drain/gate/source for MOSFET).
 *
 * Tags defined:
 *   wokwi-bjt-2n2222   — NPN general purpose
 *   wokwi-bjt-bc547    — NPN small signal
 *   wokwi-bjt-2n3055   — NPN power (flipped package style not rendered — same symbol)
 *   wokwi-bjt-2n3906   — PNP general purpose
 *   wokwi-bjt-bc557    — PNP small signal
 *   wokwi-mosfet-2n7000    — NMOS logic-level
 *   wokwi-mosfet-irf540    — NMOS power
 *   wokwi-mosfet-irf9540   — PMOS power
 *   wokwi-mosfet-fqp27p06  — PMOS logic-level
 *
 * Pin layout (CSS pixels):
 *   BJT    (72 × 72): C(60, 0)  B(0, 36)  E(60, 72)
 *   MOSFET (72 × 72): D(60, 0)  G(0, 36)  S(60, 72)
 */

// ─── Shared colours ───────────────────────────────────────────────────────────
// Tuned for the dark (#1a1a1a) simulator canvas — symbols must read as
// light schematic strokes, not dark-on-dark.
const STROKE = '#e6e6e6'; // primary symbol strokes (base bar, channel)
const LEAD = '#b8b8b8'; // pin leads
const LABEL = '#d0d0d0'; // pin letters / part number
const BODY = '#7a7a7a'; // optional body-circle outline
const STYLE = ':host{display:inline-block;line-height:0}';

function threePinInfo(pins: Array<{ name: string; x: number; y: number; number: number }>) {
  return pins.map((p) => ({ ...p, signals: [] as string[] }));
}

// ─── BJT symbol (NPN / PNP) ───────────────────────────────────────────────────
// Canvas 72×72.
// Base lead: (0,36) → (22,36)
// Vertical "base line": (22,14) → (22,58)
// Collector lead: (22,24) → (46,24) → (46,6) → (60,6) → (60,0) [pin C]
// Emitter lead:  (22,48) → (46,48) → (46,66) → (60,66) → (60,72) [pin E]
// Arrow on emitter lead segment (46..56, y=50..56) — NPN points outward, PNP inward.

function bjtSvg(arrowDir: 'npn' | 'pnp', text: string): string {
  // Symmetric triangle arrowhead on the horizontal emitter line at y=48.
  // NPN points OUT (rightward, away from base); PNP points IN (leftward, toward base).
  const arrowhead =
    arrowDir === 'npn'
      ? `<polygon points="44,48 36,44 36,52" fill="${STROKE}"/>`
      : `<polygon points="22,48 30,44 30,52" fill="${STROKE}"/>`;

  return `
    <style>${STYLE}</style>
    <svg width="72" height="72" xmlns="http://www.w3.org/2000/svg">
      <!-- Body circle (clean outline, no fill — TO-92 hint) -->
      <circle cx="34" cy="36" r="22" fill="none" stroke="${BODY}" stroke-width="1.2"/>
      <!-- Base lead + bar -->
      <line x1="0"  y1="36" x2="22" y2="36" stroke="${LEAD}"   stroke-width="2"/>
      <line x1="22" y1="14" x2="22" y2="58" stroke="${STROKE}" stroke-width="3"/>
      <!-- Collector side -->
      <line x1="22" y1="24" x2="46" y2="24" stroke="${STROKE}" stroke-width="2"/>
      <line x1="46" y1="24" x2="46" y2="6"  stroke="${LEAD}"   stroke-width="2"/>
      <line x1="46" y1="6"  x2="60" y2="6"  stroke="${LEAD}"   stroke-width="2"/>
      <line x1="60" y1="0"  x2="60" y2="6"  stroke="${LEAD}"   stroke-width="2"/>
      <!-- Emitter side -->
      <line x1="22" y1="48" x2="46" y2="48" stroke="${STROKE}" stroke-width="2"/>
      <line x1="46" y1="48" x2="46" y2="66" stroke="${LEAD}"   stroke-width="2"/>
      <line x1="46" y1="66" x2="60" y2="66" stroke="${LEAD}"   stroke-width="2"/>
      <line x1="60" y1="66" x2="60" y2="72" stroke="${LEAD}"   stroke-width="2"/>
      ${arrowhead}
      <!-- Pin labels -->
      <text x="50" y="14" font-family="sans-serif" font-size="8" fill="${LABEL}">C</text>
      <text x="2"  y="32" font-family="sans-serif" font-size="8" fill="${LABEL}">B</text>
      <text x="50" y="64" font-family="sans-serif" font-size="8" fill="${LABEL}">E</text>
      <!-- Part number -->
      <text x="36" y="78" text-anchor="middle" font-family="sans-serif" font-size="7" fill="${LABEL}" font-weight="bold">${text}</text>
    </svg>`;
}

function makeBjtClass(label: string, polarity: 'npn' | 'pnp') {
  return class extends HTMLElement {
    readonly pinInfo = threePinInfo([
      { name: 'C', x: 60, y: 0, number: 1 },
      { name: 'B', x: 0, y: 36, number: 2 },
      { name: 'E', x: 60, y: 72, number: 3 },
    ]);
    constructor() {
      super();
      this.attachShadow({ mode: 'open' }).innerHTML = bjtSvg(polarity, label);
    }
  };
}

// ─── MOSFET symbol (NMOS / PMOS) ──────────────────────────────────────────────
// Canvas 72×72.
// Gate lead: (0,36) → (18,36); gate plate: (18,22) → (18,50) (thicker line)
// Channel line (offset from gate to show MOS isolation): (24,22) → (24,50)
// Drain lead: (24,22) → (46,22) → (46,6) → (60,6) → (60,0)
// Source lead: (24,50) → (46,50) → (46,66) → (60,66) → (60,72)
// Arrow at substrate connection: for NMOS points FROM substrate into channel;
// for PMOS points FROM channel OUT toward substrate.

function mosfetSvg(polarity: 'nmos' | 'pmos', text: string): string {
  // Symmetric arrowhead between gate plate and channel.
  // NMOS: arrow points INTO the channel (rightward).
  // PMOS: arrow points AWAY from channel (leftward).
  const arrow =
    polarity === 'nmos'
      ? `<polygon points="24,36 18,32 18,40" fill="${STROKE}"/>`
      : `<polygon points="18,36 24,32 24,40" fill="${STROKE}"/>`;

  return `
    <style>${STYLE}</style>
    <svg width="72" height="72" xmlns="http://www.w3.org/2000/svg">
      <!-- Body circle (clean outline only) -->
      <circle cx="34" cy="36" r="22" fill="none" stroke="${BODY}" stroke-width="1.2"/>
      <!-- Gate lead and gate plate -->
      <line x1="0"  y1="36" x2="16" y2="36" stroke="${LEAD}"   stroke-width="2"/>
      <line x1="16" y1="22" x2="16" y2="50" stroke="${STROKE}" stroke-width="3"/>
      <!-- Channel line with breaks (enhancement-mode hint) -->
      <line x1="24" y1="22" x2="24" y2="28" stroke="${STROKE}" stroke-width="2"/>
      <line x1="24" y1="32" x2="24" y2="40" stroke="${STROKE}" stroke-width="2"/>
      <line x1="24" y1="44" x2="24" y2="50" stroke="${STROKE}" stroke-width="2"/>
      <!-- Drain side -->
      <line x1="24" y1="22" x2="46" y2="22" stroke="${STROKE}" stroke-width="2"/>
      <line x1="46" y1="22" x2="46" y2="6"  stroke="${LEAD}"   stroke-width="2"/>
      <line x1="46" y1="6"  x2="60" y2="6"  stroke="${LEAD}"   stroke-width="2"/>
      <line x1="60" y1="0"  x2="60" y2="6"  stroke="${LEAD}"   stroke-width="2"/>
      <!-- Source side -->
      <line x1="24" y1="50" x2="46" y2="50" stroke="${STROKE}" stroke-width="2"/>
      <line x1="46" y1="50" x2="46" y2="66" stroke="${LEAD}"   stroke-width="2"/>
      <line x1="46" y1="66" x2="60" y2="66" stroke="${LEAD}"   stroke-width="2"/>
      <line x1="60" y1="66" x2="60" y2="72" stroke="${LEAD}"   stroke-width="2"/>
      ${arrow}
      <!-- Pin labels -->
      <text x="50" y="14" font-family="sans-serif" font-size="8" fill="${LABEL}">D</text>
      <text x="2"  y="32" font-family="sans-serif" font-size="8" fill="${LABEL}">G</text>
      <text x="50" y="64" font-family="sans-serif" font-size="8" fill="${LABEL}">S</text>
      <!-- Part number -->
      <text x="36" y="78" text-anchor="middle" font-family="sans-serif" font-size="7" fill="${LABEL}" font-weight="bold">${text}</text>
    </svg>`;
}

function makeMosfetClass(label: string, polarity: 'nmos' | 'pmos') {
  return class extends HTMLElement {
    readonly pinInfo = threePinInfo([
      { name: 'D', x: 60, y: 0, number: 1 },
      { name: 'G', x: 0, y: 36, number: 2 },
      { name: 'S', x: 60, y: 72, number: 3 },
    ]);
    constructor() {
      super();
      this.attachShadow({ mode: 'open' }).innerHTML = mosfetSvg(polarity, label);
    }
  };
}

// ─── Concrete classes per part number ─────────────────────────────────────────
const Bjt2N2222 = makeBjtClass('2N2222', 'npn');
const BjtBC547 = makeBjtClass('BC547', 'npn');
const Bjt2N3055 = makeBjtClass('2N3055', 'npn');
const Bjt2N3906 = makeBjtClass('2N3906', 'pnp');
const BjtBC557 = makeBjtClass('BC557', 'pnp');

const Mosfet2N7000 = makeMosfetClass('2N7000', 'nmos');
const MosfetIRF540 = makeMosfetClass('IRF540', 'nmos');
const MosfetIRF9540 = makeMosfetClass('IRF9540', 'pmos');
const MosfetFQP27P06 = makeMosfetClass('FQP27P06', 'pmos');

// ─── Register custom elements ─────────────────────────────────────────────────
function def(tag: string, cls: CustomElementConstructor) {
  if (!customElements.get(tag)) customElements.define(tag, cls);
}

def('wokwi-bjt-2n2222', Bjt2N2222);
def('wokwi-bjt-bc547', BjtBC547);
def('wokwi-bjt-2n3055', Bjt2N3055);
def('wokwi-bjt-2n3906', Bjt2N3906);
def('wokwi-bjt-bc557', BjtBC557);

def('wokwi-mosfet-2n7000', Mosfet2N7000);
def('wokwi-mosfet-irf540', MosfetIRF540);
def('wokwi-mosfet-irf9540', MosfetIRF9540);
def('wokwi-mosfet-fqp27p06', MosfetFQP27P06);

// Mark as a module (side-effect import)
export {};
