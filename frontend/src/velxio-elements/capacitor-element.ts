/**
 * <wokwi-capacitor> — local replacement for the upstream wokwi-elements
 * version. Kept inside velxio because we cannot push the original Lit
 * sources to wokwi/wokwi-elements.
 *
 * Plain HTMLElement (no Lit) — the SVG is static and `value` is read by
 * the SPICE layer from the simulator store, not from this DOM node, so
 * we don't need reactive rendering.
 */

interface ElementPin {
  name: string;
  x: number;
  y: number;
  signals: unknown[];
}

const SVG = `
<svg width="15.645mm" height="3mm" version="1.1"
     viewBox="0 0 15.645 3" xmlns="http://www.w3.org/2000/svg">
  <rect y="1.175" width="15.558" height="0.638" fill="#aaa" />
  <ellipse cx="7.82" cy="1.5" rx="3.2" ry="1.5" fill="#165696" />
  <ellipse cx="6.8" cy="0.9" rx="1.0" ry="0.55" fill="#3a7cc8" opacity="0.5" />
</svg>`;

export class CapacitorElement extends HTMLElement {
  static observedAttributes = ['value'];

  readonly pinInfo: ElementPin[] = [
    { name: '1', x: 0, y: 5.65, signals: [] },
    { name: '2', x: 58.8, y: 5.65, signals: [] },
  ];

  constructor() {
    super();
    const root = this.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>:host{display:flex}</style>${SVG}`;
  }

  get value(): string {
    return this.getAttribute('value') ?? '1u';
  }
  set value(v: string) {
    this.setAttribute('value', String(v));
  }
}

if (!customElements.get('wokwi-capacitor')) {
  customElements.define('wokwi-capacitor', CapacitorElement);
}
