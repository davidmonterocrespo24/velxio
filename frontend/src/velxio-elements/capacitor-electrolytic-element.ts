/**
 * <velxio-capacitor-electrolytic> — polarized aluminum-can capacitor.
 *
 * Vertical cylinder seen from the side, with a stripe down one side
 * marking the negative terminal (real-world convention). Two leads come
 * out of the bottom: pin "+" on the left, pin "−" on the right (under
 * the stripe).
 *
 * SPICE-wise it is bidirectional just like any C, but the visual
 * polarity matches the physical part so users wire it correctly.
 */

interface ElementPin {
  name: string;
  x: number;
  y: number;
  signals: unknown[];
}

const SVG = `
<svg width="9mm" height="14mm" version="1.1"
     viewBox="0 0 9 14" xmlns="http://www.w3.org/2000/svg">
  <!-- Leads (two parallel wires from bottom) -->
  <rect x="2.0" y="11.5" width="0.55" height="2.5" fill="#aaa" />
  <rect x="6.45" y="11.5" width="0.55" height="2.5" fill="#aaa" />

  <!-- Can body (top ellipse + side rect + bottom ellipse for cylinder look) -->
  <rect x="0.5" y="1.2" width="8" height="10.5" rx="0.4" fill="#1f3b6b" />
  <ellipse cx="4.5" cy="1.2" rx="4" ry="0.9" fill="#2a4d8a" />
  <ellipse cx="4.5" cy="1.2" rx="3" ry="0.55" fill="#3a64a8" opacity="0.6" />

  <!-- Negative-stripe down the right half (over the negative lead) -->
  <rect x="5.6" y="1.2" width="2.9" height="10.5" rx="0.4" fill="#dfe3ec" />
  <text x="7.05" y="6.5" font-family="sans-serif" font-size="2.4"
        text-anchor="middle" fill="#1f3b6b" font-weight="bold">−</text>
  <text x="7.05" y="9.0" font-family="sans-serif" font-size="2.4"
        text-anchor="middle" fill="#1f3b6b" font-weight="bold">−</text>

  <!-- Vent cross on top -->
  <line x1="3.0" y1="0.9" x2="6.0" y2="1.5" stroke="#13284a" stroke-width="0.18" />
  <line x1="3.0" y1="1.5" x2="6.0" y2="0.9" stroke="#13284a" stroke-width="0.18" />
</svg>`;

export class CapacitorElectrolyticElement extends HTMLElement {
  static observedAttributes = ['value'];

  // Pin coordinates measured against the SVG viewBox above (in mm),
  // converted to the same px scale the rest of the wokwi catalog uses
  // (≈ 3.78 px / mm but DynamicComponent reads the raw numbers and lets
  // the canvas scale them — so we just keep them in viewBox units * a
  // small factor for visual alignment with the leads).
  readonly pinInfo: ElementPin[] = [
    { name: '+', x: 8.6, y: 53, signals: [] },
    { name: '−', x: 25.5, y: 53, signals: [] },
  ];

  constructor() {
    super();
    const root = this.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>:host{display:flex}</style>${SVG}`;
  }

  get value(): string {
    return this.getAttribute('value') ?? '10u';
  }
  set value(v: string) {
    this.setAttribute('value', String(v));
  }
}

if (!customElements.get('velxio-capacitor-electrolytic')) {
  customElements.define('velxio-capacitor-electrolytic', CapacitorElectrolyticElement);
}
