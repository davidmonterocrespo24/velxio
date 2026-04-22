/**
 * <wokwi-inductor> — local replacement for the upstream wokwi-elements
 * version. Kept inside velxio because we cannot push the original Lit
 * sources to wokwi/wokwi-elements.
 *
 * Plain HTMLElement (no Lit) — the SVG is static and `value` is read by
 * the SPICE layer from the simulator store, not from this DOM node.
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
  <path d="M4.7,1.5 C5.2,0 6.0,0 6.5,1.5 C7.0,3 7.8,3 8.3,1.5 C8.8,0 9.6,0 10.1,1.5 C10.6,3 11.4,3 11.0,1.5"
        fill="none" stroke="#B23820" stroke-width="0.5" stroke-linecap="round" />
  <rect x="4.5" y="0.15" width="6.7" height="2.7" rx="0.6" fill="#752119" opacity="0.7" />
  <path d="M4.7,1.5 C5.2,-0.2 6.0,-0.2 6.5,1.5 C7.0,3.2 7.8,3.2 8.3,1.5 C8.8,-0.2 9.6,-0.2 10.1,1.5 C10.6,3.2 11.4,3.2 11.0,1.5"
        fill="none" stroke="#B23820" stroke-width="0.45" stroke-linecap="round" />
</svg>`;

export class InductorElement extends HTMLElement {
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
    return this.getAttribute('value') ?? '1m';
  }
  set value(v: string) {
    this.setAttribute('value', String(v));
  }
}

if (!customElements.get('wokwi-inductor')) {
  customElements.define('wokwi-inductor', InductorElement);
}
