/**
 * LogicGateElements.ts — Custom Web Components for standard logic gates.
 *
 * Implements SVG-rendered logic gate elements for use in the Velxio simulator.
 * These do NOT exist in wokwi-elements, so we define them here.
 *
 * Tags defined:
 *   wokwi-logic-and  — 2-input AND gate
 *   wokwi-logic-nand — 2-input NAND gate
 *   wokwi-logic-or   — 2-input OR gate
 *   wokwi-logic-nor  — 2-input NOR gate
 *   wokwi-logic-xor  — 2-input XOR gate
 *   wokwi-logic-xnor — 2-input XNOR gate
 *   wokwi-logic-not  — 1-input NOT (inverter)
 *
 * Pin layout (in CSS pixels, used by PinOverlay):
 *   2-input gates (72 × 48 px): A(0,14)  B(0,34)  Y(72,24)
 *   NOT gate       (56 × 36 px): A(0,18)           Y(56,18)
 */

// ─── Shared colours ───────────────────────────────────────────────────────────
const FILL   = '#e8f0fa';
const STROKE = '#3360b0';
const LEAD   = '#555555';
const TEXT   = '#1a3060';
const STYLE  = ':host{display:inline-block;line-height:0}';

// ─── 2-input gate base ───────────────────────────────────────────────────────

function twoInputPinInfo() {
  return [
    { name: 'A', x: 0,  y: 14, number: 1, signals: [] },
    { name: 'B', x: 0,  y: 34, number: 2, signals: [] },
    { name: 'Y', x: 72, y: 24, number: 3, signals: [] },
  ];
}

function leads2Input(): string {
  return `
    <line x1="0"  y1="14" x2="20" y2="14" stroke="${LEAD}" stroke-width="2"/>
    <line x1="0"  y1="34" x2="20" y2="34" stroke="${LEAD}" stroke-width="2"/>`;
}

function outputLead(fromX: number): string {
  return `<line x1="${fromX}" y1="24" x2="72" y2="24" stroke="${LEAD}" stroke-width="2"/>`;
}

function bubbleAndLead(bubbleCx: number): string {
  const r = 4;
  const lineStart = bubbleCx + r;
  return `<circle cx="${bubbleCx}" cy="24" r="${r}" fill="${FILL}" stroke="${STROKE}" stroke-width="1.5"/>
    <line x1="${lineStart}" y1="24" x2="72" y2="24" stroke="${LEAD}" stroke-width="2"/>`;
}

function label(x: number, y: number, text: string): string {
  return `<text x="${x}" y="${y}" font-family="sans-serif" font-size="10" fill="${TEXT}" font-weight="bold">${text}</text>`;
}

// ─── AND Gate (72×48) ─────────────────────────────────────────────────────────
// Body: rectangle (20-42,6-42) + semicircle arc right side (radius 18, tip at x=60)

class AndGateElement extends HTMLElement {
  readonly pinInfo = twoInputPinInfo();
  constructor() {
    super();
    this.attachShadow({ mode: 'open' }).innerHTML = `
      <style>${STYLE}</style>
      <svg width="72" height="48" xmlns="http://www.w3.org/2000/svg">
        ${leads2Input()}
        <path d="M20,6 L42,6 A18,18 0 0,1 42,42 L20,42 Z"
              fill="${FILL}" stroke="${STROKE}" stroke-width="1.5"/>
        ${outputLead(60)}
        ${label(26, 28, '&amp;')}
      </svg>`;
  }
}

// ─── NAND Gate (72×48) ────────────────────────────────────────────────────────
// AND body + inversion bubble at output (cx=64, r=4 → spans x60-x68)

class NandGateElement extends HTMLElement {
  readonly pinInfo = twoInputPinInfo();
  constructor() {
    super();
    this.attachShadow({ mode: 'open' }).innerHTML = `
      <style>${STYLE}</style>
      <svg width="72" height="48" xmlns="http://www.w3.org/2000/svg">
        ${leads2Input()}
        <path d="M20,6 L42,6 A18,18 0 0,1 42,42 L20,42 Z"
              fill="${FILL}" stroke="${STROKE}" stroke-width="1.5"/>
        ${bubbleAndLead(64)}
        ${label(26, 28, '&amp;')}
      </svg>`;
  }
}

// ─── OR Gate (72×48) ──────────────────────────────────────────────────────────
// Body: Q-bezier — top curve, bottom curve, concave left side
// Tip at (54,24); output line from 54→72

class OrGateElement extends HTMLElement {
  readonly pinInfo = twoInputPinInfo();
  constructor() {
    super();
    this.attachShadow({ mode: 'open' }).innerHTML = `
      <style>${STYLE}</style>
      <svg width="72" height="48" xmlns="http://www.w3.org/2000/svg">
        ${leads2Input()}
        <path d="M18,6 Q50,6 54,24 Q50,42 18,42 Q26,24 18,6 Z"
              fill="${FILL}" stroke="${STROKE}" stroke-width="1.5"/>
        ${outputLead(54)}
        ${label(25, 28, '≥1')}
      </svg>`;
  }
}

// ─── NOR Gate (72×48) ─────────────────────────────────────────────────────────
// OR body + inversion bubble at output (cx=58, r=4 → spans x54-x62)

class NorGateElement extends HTMLElement {
  readonly pinInfo = twoInputPinInfo();
  constructor() {
    super();
    this.attachShadow({ mode: 'open' }).innerHTML = `
      <style>${STYLE}</style>
      <svg width="72" height="48" xmlns="http://www.w3.org/2000/svg">
        ${leads2Input()}
        <path d="M18,6 Q50,6 54,24 Q50,42 18,42 Q26,24 18,6 Z"
              fill="${FILL}" stroke="${STROKE}" stroke-width="1.5"/>
        ${bubbleAndLead(58)}
        ${label(25, 28, '≥1')}
      </svg>`;
  }
}

// ─── XOR Gate (72×48) ─────────────────────────────────────────────────────────
// OR body + extra curved line to the left (the XOR distinguishing mark)

class XorGateElement extends HTMLElement {
  readonly pinInfo = twoInputPinInfo();
  constructor() {
    super();
    this.attachShadow({ mode: 'open' }).innerHTML = `
      <style>${STYLE}</style>
      <svg width="72" height="48" xmlns="http://www.w3.org/2000/svg">
        ${leads2Input()}
        <!-- XOR extra curve (3px left of OR left side) -->
        <path d="M14,6 Q22,24 14,42"
              fill="none" stroke="${STROKE}" stroke-width="1.5"/>
        <!-- OR body -->
        <path d="M18,6 Q50,6 54,24 Q50,42 18,42 Q26,24 18,6 Z"
              fill="${FILL}" stroke="${STROKE}" stroke-width="1.5"/>
        ${outputLead(54)}
        ${label(24, 28, '=1')}
      </svg>`;
  }
}

// ─── XNOR Gate (72×48) ────────────────────────────────────────────────────────
// XOR body (OR + left curve) + inversion bubble at output (cx=58, r=4)

class XnorGateElement extends HTMLElement {
  readonly pinInfo = twoInputPinInfo();
  constructor() {
    super();
    this.attachShadow({ mode: 'open' }).innerHTML = `
      <style>${STYLE}</style>
      <svg width="72" height="48" xmlns="http://www.w3.org/2000/svg">
        ${leads2Input()}
        <path d="M14,6 Q22,24 14,42"
              fill="none" stroke="${STROKE}" stroke-width="1.5"/>
        <path d="M18,6 Q50,6 54,24 Q50,42 18,42 Q26,24 18,6 Z"
              fill="${FILL}" stroke="${STROKE}" stroke-width="1.5"/>
        ${bubbleAndLead(58)}
        ${label(24, 28, '=1')}
      </svg>`;
  }
}

// ─── NOT Gate (56×36) ─────────────────────────────────────────────────────────
// Triangle pointing right + inversion bubble at tip
// Input A(0,18) → triangle base at x=4,  tip at x=44
// Bubble cx=48,r=4 → extends to x=52; output lead x52→56; Pin Y(56,18)

class NotGateElement extends HTMLElement {
  readonly pinInfo = [
    { name: 'A', x: 0,  y: 18, number: 1, signals: [] },
    { name: 'Y', x: 56, y: 18, number: 2, signals: [] },
  ];
  constructor() {
    super();
    this.attachShadow({ mode: 'open' }).innerHTML = `
      <style>${STYLE}</style>
      <svg width="56" height="36" xmlns="http://www.w3.org/2000/svg">
        <line x1="0" y1="18" x2="4" y2="18" stroke="${LEAD}" stroke-width="2"/>
        <path d="M4,4 L44,18 L4,32 Z"
              fill="${FILL}" stroke="${STROKE}" stroke-width="1.5"/>
        <circle cx="48" cy="18" r="4" fill="${FILL}" stroke="${STROKE}" stroke-width="1.5"/>
        <line x1="52" y1="18" x2="56" y2="18" stroke="${LEAD}" stroke-width="2"/>
        ${label(10, 22, '1')}
      </svg>`;
  }
}

// ─── Register custom elements ─────────────────────────────────────────────────

if (!customElements.get('wokwi-logic-and'))  customElements.define('wokwi-logic-and',  AndGateElement);
if (!customElements.get('wokwi-logic-nand')) customElements.define('wokwi-logic-nand', NandGateElement);
if (!customElements.get('wokwi-logic-or'))   customElements.define('wokwi-logic-or',   OrGateElement);
if (!customElements.get('wokwi-logic-nor'))  customElements.define('wokwi-logic-nor',  NorGateElement);
if (!customElements.get('wokwi-logic-xor'))  customElements.define('wokwi-logic-xor',  XorGateElement);
if (!customElements.get('wokwi-logic-xnor')) customElements.define('wokwi-logic-xnor', XnorGateElement);
if (!customElements.get('wokwi-logic-not'))  customElements.define('wokwi-logic-not',  NotGateElement);

// ─── 3/4-input gate elements ──────────────────────────────────────────────────
// Generic N-input gates (96 × 72 for 3-in, 108 × 84 for 4-in). Inputs spaced
// vertically, single output on the right tip.

function nInputPinInfo(count: number, height: number, bodyRight: number) {
  const spacing = height / (count + 1);
  const pins = [];
  for (let i = 0; i < count; i++) {
    const letter = String.fromCharCode(65 + i); // A, B, C, D
    pins.push({ name: letter, x: 0, y: Math.round((i + 1) * spacing), number: i + 1, signals: [] });
  }
  pins.push({ name: 'Y', x: bodyRight + 14, y: Math.round(height / 2), number: count + 1, signals: [] });
  return pins;
}

function makeMultiInputGateSvg(
  variant: 'and' | 'or' | 'nand' | 'nor',
  inputs: number,
  text: string,
): string {
  const W = inputs === 4 ? 108 : 96;
  const H = inputs === 4 ? 84 : 72;
  const inv = variant === 'nand' || variant === 'nor';
  const orStyle = variant === 'or' || variant === 'nor';
  const bodyLeft = 24;
  const bodyRight = W - 24;
  const outputTipX = orStyle ? bodyRight - 2 : bodyRight - 8;

  // Input leads
  const spacing = H / (inputs + 1);
  let leads = '';
  for (let i = 0; i < inputs; i++) {
    const y = Math.round((i + 1) * spacing);
    leads += `<line x1="0" y1="${y}" x2="${bodyLeft}" y2="${y}" stroke="${LEAD}" stroke-width="2"/>`;
  }

  // Body shape
  let body: string;
  if (orStyle) {
    body = `
      <path d="M${bodyLeft - 6},6 Q${bodyRight - 20},6 ${outputTipX},${H / 2} Q${bodyRight - 20},${H - 6} ${bodyLeft - 6},${H - 6} Q${bodyLeft + 4},${H / 2} ${bodyLeft - 6},6 Z"
            fill="${FILL}" stroke="${STROKE}" stroke-width="1.5"/>`;
  } else {
    // AND / NAND — flat left, rounded right
    const radius = (H - 12) / 2;
    const rightStraight = bodyRight - radius - 4;
    body = `
      <path d="M${bodyLeft},6 L${rightStraight},6 A${radius},${radius} 0 0 1 ${rightStraight},${H - 6} L${bodyLeft},${H - 6} Z"
            fill="${FILL}" stroke="${STROKE}" stroke-width="1.5"/>`;
  }

  // Output lead / bubble
  let output: string;
  if (inv) {
    const bubbleCx = outputTipX + 4;
    output = `
      <circle cx="${bubbleCx}" cy="${H / 2}" r="4" fill="${FILL}" stroke="${STROKE}" stroke-width="1.5"/>
      <line x1="${bubbleCx + 4}" y1="${H / 2}" x2="${W}" y2="${H / 2}" stroke="${LEAD}" stroke-width="2"/>`;
  } else {
    output = `<line x1="${outputTipX}" y1="${H / 2}" x2="${W}" y2="${H / 2}" stroke="${LEAD}" stroke-width="2"/>`;
  }

  return `
    <style>${STYLE}</style>
    <svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
      ${leads}
      ${body}
      ${output}
      <text x="${bodyLeft + 6}" y="${H / 2 + 4}" font-family="sans-serif" font-size="10" fill="${TEXT}" font-weight="bold">${text}</text>
    </svg>`;
}

function makeMultiInputGateClass(variant: 'and' | 'or' | 'nand' | 'nor', inputs: number) {
  const text = variant === 'and' || variant === 'nand' ? '&amp;' : '≥1';
  const W = inputs === 4 ? 108 : 96;
  const H = inputs === 4 ? 84 : 72;
  const bodyRight = W - 24;
  return class extends HTMLElement {
    readonly pinInfo = nInputPinInfo(inputs, H, bodyRight);
    constructor() {
      super();
      this.attachShadow({ mode: 'open' }).innerHTML = makeMultiInputGateSvg(variant, inputs, text);
    }
  };
}

const And3Gate  = makeMultiInputGateClass('and',  3);
const Or3Gate   = makeMultiInputGateClass('or',   3);
const Nand3Gate = makeMultiInputGateClass('nand', 3);
const Nor3Gate  = makeMultiInputGateClass('nor',  3);
const And4Gate  = makeMultiInputGateClass('and',  4);
const Or4Gate   = makeMultiInputGateClass('or',   4);
const Nand4Gate = makeMultiInputGateClass('nand', 4);
const Nor4Gate  = makeMultiInputGateClass('nor',  4);

if (!customElements.get('wokwi-logic-and-3'))  customElements.define('wokwi-logic-and-3',  And3Gate);
if (!customElements.get('wokwi-logic-or-3'))   customElements.define('wokwi-logic-or-3',   Or3Gate);
if (!customElements.get('wokwi-logic-nand-3')) customElements.define('wokwi-logic-nand-3', Nand3Gate);
if (!customElements.get('wokwi-logic-nor-3'))  customElements.define('wokwi-logic-nor-3',  Nor3Gate);
if (!customElements.get('wokwi-logic-and-4'))  customElements.define('wokwi-logic-and-4',  And4Gate);
if (!customElements.get('wokwi-logic-or-4'))   customElements.define('wokwi-logic-or-4',   Or4Gate);
if (!customElements.get('wokwi-logic-nand-4')) customElements.define('wokwi-logic-nand-4', Nand4Gate);
if (!customElements.get('wokwi-logic-nor-4'))  customElements.define('wokwi-logic-nor-4',  Nor4Gate);

// Mark as a module (all symbols are internal — this file is imported for side effects only)
export {};
