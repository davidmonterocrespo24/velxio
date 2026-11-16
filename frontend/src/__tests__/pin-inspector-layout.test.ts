/**
 * pinInspectorLayout — the Part Inspector's spatial pin geometry.
 *
 * The coordinate tables here are copied VERBATIM from the real elements (the
 * file/line each block cites), not invented: the point of the suite is that
 * the classifier reads actual shipped parts sensibly. If a part's pinInfo
 * changes upstream, refresh the copy.
 */
import { describe, expect, it } from 'vitest';
import {
  layoutInspectorPins,
  signalKindOf,
  type InspectorPinInput,
} from '../utils/pinInspectorLayout';

// components/velxio-components/Esp32Element.ts:38-76 (PINS_ESP32), board
// natural size 141x265 (BOARD_CONFIGS.esp32). Two vertical columns: left
// x=6, right x=134. Silk aliases (16/RX2, 17/TX2) share coordinates.
const ESP32_PINS: InspectorPinInput[] = [
  { name: 'EN', x: 6, y: 29 },
  { name: 'VP', x: 6, y: 42 },
  { name: 'VN', x: 6, y: 54 },
  { name: '34', x: 6, y: 67 },
  { name: '35', x: 6, y: 80 },
  { name: '32', x: 6, y: 93 },
  { name: '33', x: 6, y: 105 },
  { name: '25', x: 6, y: 118 },
  { name: '26', x: 6, y: 131 },
  { name: '27', x: 6, y: 143 },
  { name: '14', x: 6, y: 156 },
  { name: '12', x: 6, y: 169 },
  { name: '13', x: 6, y: 181 },
  { name: 'GND', x: 6, y: 194 },
  { name: 'VIN', x: 6, y: 207 },
  { name: '3V3', x: 134, y: 207 },
  { name: 'GND2', x: 134, y: 194 },
  { name: '15', x: 134, y: 181 },
  { name: '2', x: 134, y: 169 },
  { name: '4', x: 134, y: 156 },
  { name: 'RX2', x: 134, y: 143 },
  { name: 'TX2', x: 134, y: 131 },
  { name: '5', x: 134, y: 118 },
  { name: '18', x: 134, y: 105 },
  { name: '19', x: 134, y: 93 },
  { name: '21', x: 134, y: 80 },
  { name: 'RX0', x: 134, y: 67 },
  { name: 'TX0', x: 134, y: 54 },
  { name: '22', x: 134, y: 42 },
  { name: '23', x: 134, y: 29 },
];
const ESP32_SIZE = { width: 141, height: 265 };

// @wokwi/elements led-element.js:28-34 (unflipped), element box 40x50.
const LED_PINS: InspectorPinInput[] = [
  { name: 'A', x: 25, y: 42 },
  { name: 'C', x: 15, y: 42 },
];
const LED_SIZE = { width: 40, height: 50 };

describe('layoutInspectorPins — the ESP32 board (the 30-pin scroll case)', () => {
  const r = layoutInspectorPins(ESP32_PINS, ESP32_SIZE);

  it('classifies every pin left or right, none interior', () => {
    for (const p of r.pins) {
      expect(['left', 'right']).toContain(p.edge);
    }
    expect(r.pins.filter((p) => p.edge === 'left')).toHaveLength(15);
    expect(r.pins.filter((p) => p.edge === 'right')).toHaveLength(15);
  });

  it('keeps a minimum spacing between labels on the same side', () => {
    for (const edge of ['left', 'right'] as const) {
      const ys = r.pins
        .filter((p) => p.edge === edge)
        .map((p) => p.labelY)
        .sort((a, b) => a - b);
      for (let i = 1; i < ys.length; i++) {
        expect(ys[i] - ys[i - 1]).toBeGreaterThanOrEqual(16 - 1e-6);
      }
    }
  });

  it('preserves the dot y-order in the label order per side', () => {
    for (const edge of ['left', 'right'] as const) {
      const group = r.pins.filter((p) => p.edge === edge).sort((a, b) => a.dotY - b.dotY);
      for (let i = 1; i < group.length; i++) {
        expect(group[i].labelY).toBeGreaterThan(group[i - 1].labelY);
      }
    }
  });

  it('reserves side gutters and no top/bottom gutters', () => {
    expect(r.padLeft).toBeGreaterThan(0);
    expect(r.padRight).toBeGreaterThan(0);
    expect(r.padTop).toBe(0);
    expect(r.padBottom).toBe(0);
  });

  it('scales the art into the default box', () => {
    expect(r.artHeight).toBeLessThanOrEqual(260);
    expect(r.scale).toBeCloseTo(260 / 265, 5);
  });
});

describe('layoutInspectorPins — small parts', () => {
  it('puts the LED legs on the bottom edge', () => {
    const r = layoutInspectorPins(LED_PINS, LED_SIZE);
    for (const p of r.pins) expect(p.edge).toBe('bottom');
    expect(r.padBottom).toBeGreaterThan(0);
    expect(r.padLeft).toBe(0);
  });

  it('caps upscaling at 2x so a tiny part is not a blur', () => {
    const r = layoutInspectorPins(LED_PINS, { width: 20, height: 10 });
    expect(r.scale).toBe(2);
    expect(r.artWidth).toBe(40);
  });

  it('handles zero pins and one pin', () => {
    const none = layoutInspectorPins([], LED_SIZE);
    expect(none.pins).toHaveLength(0);
    expect(none.padLeft + none.padRight + none.padTop + none.padBottom).toBe(0);

    const one = layoutInspectorPins([{ name: 'OUT', x: 2, y: 25 }], { width: 50, height: 50 });
    expect(one.pins[0].edge).toBe('left');
    expect(one.pins[0].needsLeader).toBe(false);
  });
});

describe('layoutInspectorPins — a crowded header fits its edge', () => {
  it('packs 8 top pins inside the art width (they are drawn as vertical text)', () => {
    // The SSD1306's 8-pin header measured 240px wide in the dialog. With
    // horizontal labels this demanded ~288px and the labels escaped the
    // dialog; vertical labels use the side spacing instead.
    const pins: InspectorPinInput[] = Array.from({ length: 8 }, (_, i) => ({
      name: ['DATA', 'CLK', 'DC', 'RST', 'CS', '3V3', 'VIN', 'GND'][i],
      x: 14 + i * 13,
      y: 2,
    }));
    const r = layoutInspectorPins(pins, { width: 128, height: 119 });
    for (const p of r.pins) expect(p.edge).toBe('top');
    const xs = r.pins.map((p) => p.labelX).sort((a, b) => a - b);
    expect(xs[0]).toBeGreaterThanOrEqual(0);
    expect(xs[xs.length - 1]).toBeLessThanOrEqual(r.artWidth);
    for (let i = 1; i < xs.length; i++) {
      expect(xs[i] - xs[i - 1]).toBeGreaterThanOrEqual(16 - 1e-6);
    }
  });
});

describe('layoutInspectorPins — inset columns (the ReSpeaker Lite case)', () => {
  // pro/.../SeeedElements.ts ReSpeakerLiteElement.pinInfo, body 178x437.
  // The XIAO socket is TWO INSET COLUMNS (x=50.5 / 126.5 on a 178-wide body)
  // plus two breakout pad columns at x=10. A nearest-edge rule called most of
  // these "interior" and printed no label, so the part looked like it was
  // missing pins. Every pin must get a label.
  const RESPEAKER: InspectorPinInput[] = [
    ...['D0', 'D1', 'D2', 'D3', 'D4', 'D5', 'D6'].map((name, i) => ({
      name,
      x: 50.5,
      y: [43, 55, 68, 81, 93, 106, 119][i],
    })),
    ...['D7', 'D8', 'D9', 'D10', '3V3', 'GND', '5V'].map((name, i) => ({
      name,
      x: 126.5,
      y: [43, 55, 68, 81, 93, 106, 119][i],
    })),
    ...['BTN1', 'BTN2', 'BTN3'].map((name, i) => ({ name, x: 10, y: 214 + i * 15 })),
    ...['IO1', 'IO2', 'IO3', 'IO4'].map((name, i) => ({ name, x: 10, y: 289 + i * 13 })),
  ];

  const r = layoutInspectorPins(RESPEAKER, { width: 178, height: 437 });

  it('labels every single pin — none silently dropped', () => {
    expect(r.pins).toHaveLength(RESPEAKER.length);
    const named = new Set(r.pins.map((p) => p.name));
    for (const p of RESPEAKER) expect(named.has(p.name)).toBe(true);
  });

  it('keeps each inset column on the side of the body it sits on', () => {
    const sideOf = (n: string) => r.pins.find((p) => p.name === n)!.edge;
    for (const n of ['D0', 'D3', 'D6']) expect(sideOf(n)).toBe('left');
    for (const n of ['D7', '3V3', '5V']) expect(sideOf(n)).toBe('right');
    for (const n of ['BTN1', 'IO4']) expect(sideOf(n)).toBe('left');
  });

  it('draws a leader from every inset dot to its gutter label', () => {
    for (const n of ['D0', 'D7', '3V3']) {
      expect(r.pins.find((p) => p.name === n)!.needsLeader).toBe(true);
    }
  });

  it('never puts a column end-pin in the top or bottom gutter', () => {
    expect(r.pins.some((p) => p.edge === 'top' || p.edge === 'bottom')).toBe(false);
  });

  it('grows the box so a stack taller than the body is not clipped', () => {
    // 13 labels on the left at >=16px need more room than the scaled body,
    // so the first and last used to be cut off by the preview's clip.
    const top = -r.padTop;
    const bottom = r.artHeight + r.padBottom;
    for (const p of r.pins) {
      expect(p.labelY).toBeGreaterThanOrEqual(top);
      expect(p.labelY).toBeLessThanOrEqual(bottom);
    }
  });
});


describe('layoutInspectorPins — the Arduino Uno (two opposite headers)', () => {
  // node_modules/@wokwi/elements arduino-uno-element pinInfo, board 274x208.
  // 18 pins along the top header (y=9) and 13 along the bottom (y=192), with
  // SIX x values shared between the two. Reading those pairs as columns threw
  // most of the board into the side gutters with leaders fanning across the
  // art; a column has to be a run of pads, not two opposite ends.
  const UNO: InspectorPinInput[] = [
    { name: 'A5.2', x: 87, y: 9 },
    { name: 'A4.2', x: 97, y: 9 },
    { name: 'AREF', x: 106, y: 9 },
    { name: 'GND.1', x: 115.5, y: 9 },
    { name: '13', x: 125, y: 9 },
    { name: '12', x: 134.5, y: 9 },
    { name: '11', x: 144, y: 9 },
    { name: '10', x: 153.5, y: 9 },
    { name: '9', x: 163, y: 9 },
    { name: '8', x: 173, y: 9 },
    { name: '7', x: 189, y: 9 },
    { name: '6', x: 198.5, y: 9 },
    { name: '5', x: 208, y: 9 },
    { name: '4', x: 217.5, y: 9 },
    { name: '3', x: 227, y: 9 },
    { name: '2', x: 236.5, y: 9 },
    { name: '1', x: 246, y: 9 },
    { name: '0', x: 255.5, y: 9 },
    { name: 'IOREF', x: 131, y: 191.5 },
    { name: 'RESET', x: 140.5, y: 191.5 },
    { name: '3.3V', x: 150, y: 191.5 },
    { name: '5V', x: 160, y: 191.5 },
    { name: 'GND.2', x: 169.5, y: 191.5 },
    { name: 'GND.3', x: 179, y: 191.5 },
    { name: 'VIN', x: 188.5, y: 191.5 },
    { name: 'A0', x: 208, y: 191.5 },
    { name: 'A1', x: 217.5, y: 191.5 },
    { name: 'A2', x: 227, y: 191.5 },
    { name: 'A3', x: 236.5, y: 191.5 },
    { name: 'A4', x: 246, y: 191.5 },
    { name: 'A5', x: 255.5, y: 191.5 }
  ];

  const r = layoutInspectorPins(UNO, { width: 274, height: 208 });

  it('puts every pin on the header it belongs to', () => {
    expect(r.pins).toHaveLength(31);
    expect(r.pins.filter((p) => p.edge === 'top')).toHaveLength(18);
    expect(r.pins.filter((p) => p.edge === 'bottom')).toHaveLength(13);
  });

  it('uses no side gutters at all', () => {
    expect(r.pins.some((p) => p.edge === 'left' || p.edge === 'right')).toBe(false);
  });

  it('keeps the shared-x pairs apart — one per header', () => {
    for (const name of ['5', '4', '3', '2', '1', '0']) {
      const p = r.pins.find((q) => q.name === name);
      if (p) expect(p.edge).toBe('top');
    }
  });
});

describe('signalKindOf', () => {
  it('maps the wokwi signal shapes', () => {
    expect(signalKindOf({ name: 'SDA', x: 0, y: 0, signals: [{ type: 'i2c', signal: 'SDA' }] })).toBe('i2c');
    expect(signalKindOf({ name: 'GND', x: 0, y: 0, signals: [{ type: 'power', signal: 'GND' }] })).toBe('power-gnd');
    expect(signalKindOf({ name: 'VCC', x: 0, y: 0, signals: [{ type: 'power', signal: 'VCC' }] })).toBe('power-vcc');
    expect(signalKindOf({ name: 'D1', x: 0, y: 0 })).toBe('other');
    expect(signalKindOf({ name: 'D1', x: 0, y: 0, signals: [] })).toBe('other');
  });
});
