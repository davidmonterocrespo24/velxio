/**
 * OpAmpElements.ts — Custom Web Components for operational amplifier packages.
 *
 * Each op-amp is drawn as the classic triangle schematic symbol with:
 *   - IN+ (non-inverting input) on the left upper
 *   - IN- (inverting input)     on the left lower
 *   - OUT                       on the right tip
 *   - V+ / V- (supply)          on top and bottom of the triangle, real
 *                               part numbers only
 *
 * Tags defined:
 *   wokwi-opamp-ideal   — generic ideal op-amp (already used by Velxio)
 *   wokwi-opamp-lm358   — dual rail-to-rail, single supply
 *   wokwi-opamp-lm741   — single, conventional
 *   wokwi-opamp-tl072   — dual, JFET input (audio)
 *   wokwi-opamp-lm324   — quad, rail-to-rail output
 *
 * Pin layout (CSS pixels, 80 × 76):
 *   IN+  (0, 12)   IN-  (0, 52)   OUT  (80, 32)   V+  (40, 0)   V-  (40, 64)
 *
 * The supply pins are what a real op-amp is powered from: an LM358 on a
 * 15 V supply swings its output to about 13.5 V, one on the board's 3.3 V
 * rail stops near 2 V. Left unwired they fall back to the board's logic
 * rail and ground, which is what every op-amp was before the pins existed
 * (see componentToSpice.ts). The ideal op-amp has no supply and no rails.
 * IN+, IN- and OUT keep their places so circuits drawn before stay wired.
 */

const FILL = '#eef3fa';
const STROKE = '#2a2a2a';
const LEAD = '#555555';
const LABEL = '#333333';
const STYLE = ':host{display:inline-block;line-height:0}';

function opampPinInfo(supply: boolean) {
  const pins = [
    { name: 'IN+', x: 0, y: 12, number: 1, signals: [] as string[] },
    { name: 'IN-', x: 0, y: 52, number: 2, signals: [] as string[] },
    { name: 'OUT', x: 80, y: 32, number: 3, signals: [] as string[] },
  ];
  if (supply) {
    pins.push(
      { name: 'V+', x: 40, y: 0, number: 4, signals: [] as string[] },
      { name: 'V-', x: 40, y: 64, number: 5, signals: [] as string[] },
    );
  }
  return pins;
}

function opampSvg(label: string, supply: boolean): string {
  // The triangle's top and bottom edges cross x = 40 at y = 18 and y = 46.
  const supplyLeads = supply
    ? `
      <line x1="40" y1="0"  x2="40" y2="18" stroke="${LEAD}" stroke-width="2"/>
      <line x1="40" y1="46" x2="40" y2="64" stroke="${LEAD}" stroke-width="2"/>
      <text x="43" y="7"  font-family="sans-serif" font-size="6" fill="${LABEL}">V+</text>
      <text x="43" y="63" font-family="sans-serif" font-size="6" fill="${LABEL}">V−</text>`
    : '';
  return `
    <style>${STYLE}</style>
    <svg width="80" height="76" xmlns="http://www.w3.org/2000/svg">
      <!-- Input leads -->
      <line x1="0"  y1="12" x2="18" y2="12" stroke="${LEAD}" stroke-width="2"/>
      <line x1="0"  y1="52" x2="18" y2="52" stroke="${LEAD}" stroke-width="2"/>
      <!-- Output lead -->
      <line x1="62" y1="32" x2="80" y2="32" stroke="${LEAD}" stroke-width="2"/>${supplyLeads}
      <!-- Triangle body -->
      <polygon points="18,4 18,60 62,32" fill="${FILL}" stroke="${STROKE}" stroke-width="1.5"/>
      <!-- + and − signs inside -->
      <text x="24" y="16" font-family="sans-serif" font-size="10" fill="${STROKE}" font-weight="bold">+</text>
      <text x="24" y="56" font-family="sans-serif" font-size="12" fill="${STROKE}" font-weight="bold">−</text>
      <!-- Pin labels -->
      <text x="2"  y="10" font-family="sans-serif" font-size="6" fill="${LABEL}">IN+</text>
      <text x="2"  y="50" font-family="sans-serif" font-size="6" fill="${LABEL}">IN-</text>
      <text x="64" y="28" font-family="sans-serif" font-size="6" fill="${LABEL}">OUT</text>
      <!-- Part number -->
      <text x="${supply ? 62 : 40}" y="74" text-anchor="middle" font-family="sans-serif" font-size="7" fill="${LABEL}" font-weight="bold">${label}</text>
    </svg>`;
}

function makeOpampClass(label: string, supply: boolean) {
  return class extends HTMLElement {
    readonly pinInfo = opampPinInfo(supply);
    constructor() {
      super();
      this.attachShadow({ mode: 'open' }).innerHTML = opampSvg(label, supply);
    }
  };
}

const OpAmpIdeal = makeOpampClass('IDEAL', false);
const OpAmpLM358 = makeOpampClass('LM358', true);
const OpAmpLM741 = makeOpampClass('LM741', true);
const OpAmpTL072 = makeOpampClass('TL072', true);
const OpAmpLM324 = makeOpampClass('LM324', true);

function def(tag: string, cls: CustomElementConstructor) {
  if (!customElements.get(tag)) customElements.define(tag, cls);
}

def('wokwi-opamp-ideal', OpAmpIdeal);
def('wokwi-opamp-lm358', OpAmpLM358);
def('wokwi-opamp-lm741', OpAmpLM741);
def('wokwi-opamp-tl072', OpAmpTL072);
def('wokwi-opamp-lm324', OpAmpLM324);

export {};
