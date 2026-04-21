/**
 * Bmp280Element.ts — Custom Web Component for the BMP280 barometric sensor.
 *
 * wokwi-elements does not include a BMP280 element, so we define one here.
 * Visual: a small I2C breakout board (82 × 61 px) styled after the MPU6050 module.
 *
 * Pins:
 *   VCC (left, top)   — 3.3 V power
 *   GND (left, 2nd)   — Ground
 *   SDA (left, 3rd)   — I2C data
 *   SCL (left, bottom)— I2C clock
 */

class Bmp280Element extends HTMLElement {
  readonly pinInfo = [
    { name: 'VCC', x: 0, y: 10, number: 1, signals: [{ type: 'power', signal: 'VCC' }] },
    { name: 'GND', x: 0, y: 22, number: 2, signals: [{ type: 'power', signal: 'GND' }] },
    { name: 'SDA', x: 0, y: 34, number: 3, signals: [] },
    { name: 'SCL', x: 0, y: 46, number: 4, signals: [] },
  ];

  constructor() {
    super();
    this.attachShadow({ mode: 'open' }).innerHTML = `
      <style>:host { display: inline-block; line-height: 0; }</style>
      <svg width="82" height="61" xmlns="http://www.w3.org/2000/svg">
        <!-- PCB body -->
        <rect x="6" y="2" width="74" height="57" rx="3" ry="3"
              fill="#2d6a2d" stroke="#1a4a1a" stroke-width="1"/>

        <!-- Chip (BMP280 die) -->
        <rect x="30" y="16" width="24" height="20" rx="2" ry="2"
              fill="#1a1a1a" stroke="#444" stroke-width="0.5"/>
        <text x="42" y="29" font-family="monospace" font-size="5"
              fill="#aaa" text-anchor="middle">BMP280</text>

        <!-- Pin header pads on left edge -->
        <rect x="1" y="6"  width="9" height="5" rx="1" fill="#c8a000" stroke="#8a6000" stroke-width="0.5"/>
        <rect x="1" y="18" width="9" height="5" rx="1" fill="#c8a000" stroke="#8a6000" stroke-width="0.5"/>
        <rect x="1" y="30" width="9" height="5" rx="1" fill="#c8a000" stroke="#8a6000" stroke-width="0.5"/>
        <rect x="1" y="42" width="9" height="5" rx="1" fill="#c8a000" stroke="#8a6000" stroke-width="0.5"/>

        <!-- Pin labels -->
        <text x="12" y="11"  font-family="monospace" font-size="5" fill="#9cf" text-anchor="start">VCC</text>
        <text x="12" y="23"  font-family="monospace" font-size="5" fill="#9cf" text-anchor="start">GND</text>
        <text x="12" y="35"  font-family="monospace" font-size="5" fill="#9cf" text-anchor="start">SDA</text>
        <text x="12" y="47"  font-family="monospace" font-size="5" fill="#9cf" text-anchor="start">SCL</text>

        <!-- Decoupling caps (decorative) -->
        <rect x="60" y="8"  width="6" height="4" rx="1" fill="#555"/>
        <rect x="68" y="8"  width="6" height="4" rx="1" fill="#555"/>
        <rect x="60" y="48" width="6" height="4" rx="1" fill="#555"/>

        <!-- Silk screen label -->
        <text x="56" y="42" font-family="monospace" font-size="5"
              fill="#aaffaa" text-anchor="middle">GY-BMP280</text>
      </svg>`;
  }
}

if (!customElements.get('velxio-bmp280')) {
  customElements.define('velxio-bmp280', Bmp280Element);
}
