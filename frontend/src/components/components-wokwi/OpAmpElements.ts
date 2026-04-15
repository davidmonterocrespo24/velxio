/**
 * OpAmpElements.ts — Custom Web Components for operational amplifier packages.
 *
 * Each op-amp is drawn as the classic triangle schematic symbol with:
 *   - IN+ (non-inverting input) on the left upper
 *   - IN- (inverting input)     on the left lower
 *   - OUT                       on the right tip
 *
 * Tags defined:
 *   wokwi-opamp-ideal   — generic ideal op-amp (already used by Velxio)
 *   wokwi-opamp-lm358   — dual rail-to-rail, single supply
 *   wokwi-opamp-lm741   — single, conventional
 *   wokwi-opamp-tl072   — dual, JFET input (audio)
 *   wokwi-opamp-lm324   — quad, rail-to-rail output
 *
 * Pin layout (CSS pixels, 80 × 64):
 *   IN+  (0, 12)   IN-  (0, 52)   OUT  (80, 32)
 */

const FILL   = '#eef3fa';
const STROKE = '#2a2a2a';
const LEAD   = '#555555';
const LABEL  = '#333333';
const STYLE  = ':host{display:inline-block;line-height:0}';

function opampPinInfo() {
  return [
    { name: 'IN+', x: 0,  y: 12, number: 1, signals: [] as string[] },
    { name: 'IN-', x: 0,  y: 52, number: 2, signals: [] as string[] },
    { name: 'OUT', x: 80, y: 32, number: 3, signals: [] as string[] },
  ];
}

function opampSvg(label: string): string {
  return `
    <style>${STYLE}</style>
    <svg width="80" height="72" xmlns="http://www.w3.org/2000/svg">
      <!-- Input leads -->
      <line x1="0"  y1="12" x2="18" y2="12" stroke="${LEAD}" stroke-width="2"/>
      <line x1="0"  y1="52" x2="18" y2="52" stroke="${LEAD}" stroke-width="2"/>
      <!-- Output lead -->
      <line x1="62" y1="32" x2="80" y2="32" stroke="${LEAD}" stroke-width="2"/>
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
      <text x="40" y="70" text-anchor="middle" font-family="sans-serif" font-size="7" fill="${LABEL}" font-weight="bold">${label}</text>
    </svg>`;
}

function makeOpampClass(label: string) {
  return class extends HTMLElement {
    readonly pinInfo = opampPinInfo();
    constructor() {
      super();
      this.attachShadow({ mode: 'open' }).innerHTML = opampSvg(label);
    }
  };
}

const OpAmpIdeal = makeOpampClass('IDEAL');
const OpAmpLM358 = makeOpampClass('LM358');
const OpAmpLM741 = makeOpampClass('LM741');
const OpAmpTL072 = makeOpampClass('TL072');
const OpAmpLM324 = makeOpampClass('LM324');

function def(tag: string, cls: CustomElementConstructor) {
  if (!customElements.get(tag)) customElements.define(tag, cls);
}

def('wokwi-opamp-ideal', OpAmpIdeal);
def('wokwi-opamp-lm358', OpAmpLM358);
def('wokwi-opamp-lm741', OpAmpLM741);
def('wokwi-opamp-tl072', OpAmpTL072);
def('wokwi-opamp-lm324', OpAmpLM324);

export {};
