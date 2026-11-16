// @vitest-environment jsdom
/**
 * On the ESP32 DevKit V1 the pads named VP and VN are the ones the picture
 * labels VP and VN (velxio/velxio-prod#172).
 *
 * The real board, like the ESP32-WROOM-32 module it carries (datasheet v3.8,
 * table 2: pin 3 EN, pin 4 SENSOR_VP = GPIO36, pin 5 SENSOR_VN = GPIO39, pin 6
 * IO34) and Espressif's DevKitC (header J2: 3V3, EN, VP, VN, IO34), runs EN,
 * VP, VN, D34 down the left header, and so does the picture Velxio draws. The
 * pad table, copied from wokwi-boards' board.json, had VN on the second pad
 * and VP on the third: a wire to the pad printed VP was GPIO39, so
 * analogRead(36), the core's A0, read the other pad.
 *
 * Checked against the picture itself: each left-header label of the SVG starts
 * just below its pad (rotate(270) text), so the pad right above a label is
 * the pad that label names.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import '../components/velxio-components/Esp32Element';

// The picture the element draws (Esp32Element.ts, esp32SvgUrl).
const SVG = readFileSync(join(__dirname, '../../public/boards/esp32-devkit-v1.svg'), 'utf-8');

/** Left-header labels: element px from the top (5 px per mm; SVG user units are CSS px). */
function leftLabels(): Map<string, number> {
  const out = new Map<string, number>();
  for (const m of SVG.matchAll(/<tspan x="(-?[\d.]+)" y="12\.8">([^<]+)<\/tspan>/g)) {
    // rotate(270) maps (x, y) to (y, -x): the label starts at -x down the board.
    const mm = (-parseFloat(m[1]!) * 25.4) / 96;
    out.set(m[2]!, mm * 5);
  }
  return out;
}

function devkitPads(): Array<{ name: string; x: number; y: number }> {
  const el = document.createElement('velxio-esp32') as HTMLElement & {
    pinInfo?: Array<{ name: string; x: number; y: number }>;
  };
  el.setAttribute('board-kind', 'esp32');
  document.body.appendChild(el);
  const pins = (el.pinInfo ?? []).filter((p) => p.x < 70); // the left header
  el.remove();
  return pins;
}

describe('DevKit V1 VP and VN pads (velxio/velxio-prod#172)', () => {
  it('the pad right above each left-header label is the pad of that name', () => {
    const pads = devkitPads();
    const labels = leftLabels();
    const silk = (label: string) => label.replace(/^D(\d+)$/, '$1');
    const misplaced: string[] = [];
    for (const [label, y] of labels) {
      const above = pads.filter((p) => p.y <= y).sort((a, b) => b.y - a.y)[0];
      const named = pads.filter((p) => p.y === above?.y).map((p) => p.name);
      if (!named.includes(silk(label))) misplaced.push(`${label} over ${named.join('/')}`);
    }
    expect(misplaced).toEqual([]);
  });

  it('runs EN, VP, VN, 34 down the header, as the module does', () => {
    const order = devkitPads()
      .filter((p) => ['EN', 'VP', 'VN', '34'].includes(p.name))
      .sort((a, b) => a.y - b.y)
      .map((p) => p.name);
    expect(order).toEqual(['EN', 'VP', 'VN', '34']);
  });
});
