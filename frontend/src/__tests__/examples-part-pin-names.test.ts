// @vitest-environment jsdom
/**
 * Every wire a gallery example lands on a part names a pin that part's
 * element really has.
 *
 * The canvas and the bus fabric find a wire's end by the element's pinInfo.
 * A name the element does not carry is drawn at the part's corner and is
 * electrically nowhere. microsd-card-esp32 and microsd-card-uno wired the
 * card as MOSI/MISO, while the card's pads are DI/DO (the names its bus
 * device walks the wires from since the board-buses fabric): the card never
 * saw a command and SD.begin() failed on every run (velxio.dev, 2026-11).
 *
 * The board side has its own check (examples-esp32-board-pin-names.test.ts);
 * boards are skipped here. Parts whose element registers no pins under jsdom
 * are skipped too: the test can only vouch for what it can read.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import '../elements-register';
import { exampleProjects } from '../data/examples';
import { isBoardComponentType } from '../utils/exampleToBuildNetlistInput';

// jsdom has no ImageData, and the SSD1306 element builds one in its
// constructor. A throw there is reported by jsdom as an uncaught error, not
// to createElement's caller, and fails the run. The pins do not depend on it.
const g = globalThis as { ImageData?: unknown };
g.ImageData ??= class {
  readonly data: Uint8ClampedArray;
  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.data = new Uint8ClampedArray(width * height * 4);
  }
};

/**
 * Wired by a name the element lacks, still to be fixed one by one. Each
 * needs its own look in the app first: the 7-segment's digit logic listens on
 * COM.1/COM.2 with a polarity rule, so renaming COM can turn a display that
 * lights today off. Remove an entry when its example is fixed; a new case
 * fails here.
 */
const KNOWN: ReadonlySet<string> = new Set([
  "100d-single-digit-seven-segment-display-with-raspberry-pi-pico-micropython: wokwi-7segment 'COM'",
  "esp32-7segment: wokwi-7segment 'COM'",
  "pico-7segment: wokwi-7segment 'COM'",
  "stm32-bluepill-7segment: wokwi-7segment 'COM'",
  "uno-7segment: wokwi-7segment 'COM'",
  "i2c-rtc-read: wokwi-ds1307 'VCC'",
  "stm32-bluepill-rtc: wokwi-ds1307 'VCC'",
]);

const raw = JSON.parse(
  readFileSync(path.resolve(__dirname, '../../public/components-metadata.json'), 'utf8'),
) as { components: Array<{ id: string; tagName: string }> };
const tagOf = new Map<string, string>();
for (const m of raw.components) {
  tagOf.set(m.id, m.tagName);
  tagOf.set(m.tagName, m.tagName);
}

function pinsOf(type: string, properties: Record<string, unknown>): string[] | null {
  const tag = tagOf.get(type) ?? type;
  if (!customElements.get(tag)) return null;
  const el = document.createElement(tag) as HTMLElement & Record<string, unknown>;
  for (const [k, v] of Object.entries(properties)) {
    try {
      el[k] = v;
    } catch {
      // a read-only property: the default stands
    }
  }
  // Never connected to the document: pinInfo is a getter over the element's
  // properties, and a connected element renders, which some cannot do in
  // jsdom (the SSD1306 paints a canvas in firstUpdated).
  try {
    const pins = ((el.pinInfo as Array<{ name: string }> | undefined) ?? []).map((p) => p.name);
    return pins.length ? pins : null;
  } catch {
    return null;
  }
}

describe('gallery examples: part pins exist on the element', () => {
  it('reads the microSD card as the canvas does', () => {
    expect(pinsOf('microsd-card', {})).toEqual(['CD', 'DO', 'GND', 'SCK', 'VCC', 'DI', 'CS']);
  });

  it('every part endpoint of every example is a real pin, apart from the known list', () => {
    const bad = new Set<string>();
    const seenKnown = new Set<string>();
    for (const ex of exampleProjects) {
      for (const c of ex.components ?? []) {
        if (isBoardComponentType(c.type)) continue;
        const pins = pinsOf(c.type, c.properties ?? {});
        if (!pins) continue;
        for (const w of ex.wires ?? []) {
          for (const end of [w.start, w.end]) {
            if (end.componentId !== c.id || pins.includes(end.pinName)) continue;
            const key = `${ex.id}: ${c.type} '${end.pinName}'`;
            if (KNOWN.has(key)) seenKnown.add(key);
            else bad.add(`${key} (pins: ${pins.join(', ')})`);
          }
        }
      }
    }
    expect([...bad]).toEqual([]);
    // A fixed example leaves the list, so the list cannot hide a new case.
    expect([...KNOWN].filter((k) => !seenKnown.has(k))).toEqual([]);
  });
});
