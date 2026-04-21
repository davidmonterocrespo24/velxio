const PI_WIDTH = 250;
const PI_HEIGHT = 160;

class RaspberryPi3Element extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
  }

  connectedCallback() {
    this.render();
  }

  get pinInfo() {
    const pins = [];
    const startX = 20;
    const startY = 10;
    const pinSpacing = 10;

    // 40-pin header (2 rows of 20)
    for (let i = 0; i < 20; i++) {
      // Row 1 (odd pins 1, 3, 5...)
      pins.push({
        name: `${i * 2 + 1}`,
        x: startX + i * pinSpacing,
        y: startY,
        signals: [],
      });
      // Row 2 (even pins 2, 4, 6...)
      pins.push({
        name: `${i * 2 + 2}`,
        x: startX + i * pinSpacing,
        y: startY + pinSpacing,
        signals: [],
      });
    }
    return pins;
  }

  render() {
    let pinsSvg = '';
    const pins = this.pinInfo;
    pins.forEach((pin) => {
      // Pin gold plating
      pinsSvg += `<rect x="${pin.x - 3}" y="${pin.y - 3}" width="6" height="6" fill="#D4AF37" />`;
      // Pin hole
      pinsSvg += `<circle cx="${pin.x}" cy="${pin.y}" r="2" fill="#000" />`;
    });

    this.shadowRoot!.innerHTML = `
      <style>
        :host {
          display: block;
          width: ${PI_WIDTH}px;
          height: ${PI_HEIGHT}px;
          position: relative;
        }
        svg {
          width: 100%;
          height: 100%;
        }
        .board {
          fill: #E60049; /* Raspberry Pi Red/Pink */
          stroke: #B30039;
          stroke-width: 2;
          rx: 8;
        }
        .cpu {
          fill: #333;
          stroke: #111;
          rx: 2;
        }
        .usb {
          fill: #ccc;
          stroke: #999;
          rx: 2;
        }
        .eth {
          fill: #bbb;
          stroke: #888;
          rx: 2;
        }
        .gpio-header {
          fill: #222;
        }
      </style>
      <svg viewBox="0 0 ${PI_WIDTH} ${PI_HEIGHT}">
        <!-- PCB -->
        <rect class="board" x="2" y="2" width="${PI_WIDTH - 4}" height="${PI_HEIGHT - 4}" />
        
        <!-- CPU / Broadcom SoC -->
        <rect class="cpu" x="100" y="60" width="40" height="40" />
        <text x="120" y="80" fill="#777" font-size="8" text-anchor="middle" dy=".3em">BCM2837</text>
        
        <!-- USB Ports -->
        <rect class="usb" x="${PI_WIDTH - 40}" y="20" width="38" height="30" />
        <rect class="usb" x="${PI_WIDTH - 40}" y="60" width="38" height="30" />
        
        <!-- Ethernet -->
        <rect class="eth" x="${PI_WIDTH - 40}" y="100" width="38" height="40" />
        
        <!-- GPIO Header Base -->
        <rect class="gpio-header" x="15" y="5" width="200" height="20" rx="1" />
        
        <!-- Pins -->
        ${pinsSvg}
        
        <!-- Logo Text -->
        <text x="50" y="110" fill="#FFF" font-family="sans-serif" font-size="14" font-weight="bold">Raspberry Pi 3</text>
      </svg>
    `;
  }
}

if (!customElements.get('velxio-raspberry-pi-3')) {
  customElements.define('velxio-raspberry-pi-3', RaspberryPi3Element);
}

export {};
