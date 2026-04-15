/**
 * FlipFlopElements.ts — Custom Web Components for edge-triggered flip-flops.
 *
 * Digital-simulation-only (no SPICE mapper — real edge detection requires
 * time-domain `ddt()` which doesn't work in `.op`).
 *
 * Tags defined:
 *   wokwi-flip-flop-d   — D-type (Q ← D on rising CLK)
 *   wokwi-flip-flop-t   — T-type (Q toggles when T=1 on rising CLK)
 *   wokwi-flip-flop-jk  — JK (hold/set/reset/toggle on rising CLK)
 *
 * Pin layouts (80 × 64 px):
 *   D-FF:   D  (0, 16)  CLK (0, 48)  Q (80, 16)  Qbar (80, 48)
 *   T-FF:   T  (0, 16)  CLK (0, 48)  Q (80, 16)  Qbar (80, 48)
 *   JK-FF:  J  (0, 12)  K   (0, 36)  CLK (0, 56)  Q (80, 16)  Qbar (80, 48)
 */

const FILL   = '#eef3fa';
const STROKE = '#2a2a2a';
const LEAD   = '#555555';
const LABEL  = '#333333';
const STYLE  = ':host{display:inline-block;line-height:0}';
const W = 80;
const H = 64;

function ffSvg(inputLabels: Array<{ label: string; y: number; isClk?: boolean }>, partLabel: string): string {
  const inputLeads = inputLabels.map(inp => `
    <line x1="0" y1="${inp.y}" x2="14" y2="${inp.y}" stroke="${LEAD}" stroke-width="2"/>
    ${inp.isClk
      ? `<!-- Clock triangle (inverter-like marker) -->
         <polygon points="14,${inp.y - 4} 20,${inp.y} 14,${inp.y + 4}" fill="none" stroke="${STROKE}" stroke-width="1"/>`
      : ''}
    <text x="2" y="${inp.y - 2}" font-family="sans-serif" font-size="6" fill="${LABEL}">${inp.label}</text>
  `).join('');

  return `
    <style>${STYLE}</style>
    <svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
      <!-- Body -->
      <rect x="14" y="6" width="${W - 28}" height="${H - 12}" rx="3" fill="${FILL}" stroke="${STROKE}" stroke-width="1.5"/>
      ${inputLeads}
      <!-- Outputs -->
      <line x1="${W - 14}" y1="16" x2="${W}" y2="16" stroke="${LEAD}" stroke-width="2"/>
      <line x1="${W - 14}" y1="48" x2="${W}" y2="48" stroke="${LEAD}" stroke-width="2"/>
      <text x="${W - 22}" y="14" font-family="sans-serif" font-size="6" fill="${LABEL}">Q</text>
      <text x="${W - 26}" y="46" font-family="sans-serif" font-size="6" fill="${LABEL}">Q̄</text>
      <!-- Part label -->
      <text x="${W / 2}" y="${H / 2 + 4}" text-anchor="middle" font-family="sans-serif" font-size="10" fill="${LABEL}" font-weight="bold">${partLabel}</text>
    </svg>`;
}

class DFlipFlopElement extends HTMLElement {
  readonly pinInfo = [
    { name: 'D',    x: 0,  y: 16, number: 1, signals: [] as string[] },
    { name: 'CLK',  x: 0,  y: 48, number: 2, signals: [] as string[] },
    { name: 'Q',    x: W,  y: 16, number: 3, signals: [] as string[] },
    { name: 'Qbar', x: W,  y: 48, number: 4, signals: [] as string[] },
  ];
  constructor() {
    super();
    this.attachShadow({ mode: 'open' }).innerHTML = ffSvg(
      [{ label: 'D', y: 16 }, { label: 'CLK', y: 48, isClk: true }],
      'D-FF',
    );
  }
}

class TFlipFlopElement extends HTMLElement {
  readonly pinInfo = [
    { name: 'T',    x: 0,  y: 16, number: 1, signals: [] as string[] },
    { name: 'CLK',  x: 0,  y: 48, number: 2, signals: [] as string[] },
    { name: 'Q',    x: W,  y: 16, number: 3, signals: [] as string[] },
    { name: 'Qbar', x: W,  y: 48, number: 4, signals: [] as string[] },
  ];
  constructor() {
    super();
    this.attachShadow({ mode: 'open' }).innerHTML = ffSvg(
      [{ label: 'T', y: 16 }, { label: 'CLK', y: 48, isClk: true }],
      'T-FF',
    );
  }
}

class JKFlipFlopElement extends HTMLElement {
  readonly pinInfo = [
    { name: 'J',    x: 0,  y: 12, number: 1, signals: [] as string[] },
    { name: 'K',    x: 0,  y: 36, number: 2, signals: [] as string[] },
    { name: 'CLK',  x: 0,  y: 56, number: 3, signals: [] as string[] },
    { name: 'Q',    x: W,  y: 16, number: 4, signals: [] as string[] },
    { name: 'Qbar', x: W,  y: 48, number: 5, signals: [] as string[] },
  ];
  constructor() {
    super();
    this.attachShadow({ mode: 'open' }).innerHTML = ffSvg(
      [{ label: 'J', y: 12 }, { label: 'K', y: 36 }, { label: 'CLK', y: 56, isClk: true }],
      'JK-FF',
    );
  }
}

if (!customElements.get('wokwi-flip-flop-d'))  customElements.define('wokwi-flip-flop-d',  DFlipFlopElement);
if (!customElements.get('wokwi-flip-flop-t'))  customElements.define('wokwi-flip-flop-t',  TFlipFlopElement);
if (!customElements.get('wokwi-flip-flop-jk')) customElements.define('wokwi-flip-flop-jk', JKFlipFlopElement);

export {};
