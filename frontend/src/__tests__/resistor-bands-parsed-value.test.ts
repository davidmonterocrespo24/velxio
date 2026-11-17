// @vitest-environment jsdom
/**
 * A resistor's colour bands show the value the simulation uses
 * (velxio/velxio-prod#230).
 *
 * The value field takes "1k", "4k7" or "1M" since the [book] batch A parser
 * (#105, #101): the inspector reads them as 1 kΩ, 4.7 kΩ and 1 MΩ, and so does
 * the netlist. The drawing did not: the canvas handed the field's text to
 * wokwi-resistor, whose bands come from parseFloat(value), so "1k" drew the
 * bands of 1 Ω (brown, black, gold), "4k7" those of 4 Ω and "1M" those of
 * 1 Ω. The part's element now gets the number in ohms.
 *
 * The real DynamicComponent (the canvas) and the real PartInspectorDialog
 * preview mount the real wokwi-resistor; the bands are read from its SVG.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DynamicComponent } from '../components/DynamicComponent';
import { PartInspectorDialog } from '../components/simulator/PartInspectorDialog';
import { useSimulatorStore } from '../store/useSimulatorStore';
import type { ComponentMetadata } from '../types/component-metadata';
import { elementValueOf } from '../simulation/spice/valueFields';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const META: ComponentMetadata[] = JSON.parse(
  readFileSync(resolve(process.cwd(), 'public/components-metadata.json'), 'utf-8'),
).components;
const meta = (id: string) => {
  const m = META.find((c) => c.id === id);
  if (!m) throw new Error(`no metadata for ${id}`);
  return m;
};

// wokwi-resistor's band colours (resistor-element.js), by digit.
const COLOUR: Record<string, string> = {
  '#C3C7C0': 'silver',
  '#F1D863': 'gold',
  '#000000': 'black',
  '#8F4814': 'brown',
  '#FB0000': 'red',
  '#FC9700': 'orange',
  '#FCF800': 'yellow',
  '#00B800': 'green',
  '#0000FF': 'blue',
  '#A803D6': 'violet',
  '#808080': 'grey',
  '#FCFCFC': 'white',
};

type ResistorEl = HTMLElement & { value: string; updateComplete?: Promise<unknown> };

/** The three value bands the element draws (the fourth is the gold tolerance band). */
async function bands(el: ResistorEl): Promise<string[]> {
  await el.updateComplete;
  const svg = el.shadowRoot!.querySelector('svg')!;
  const fill = (sel: string) => {
    const f = svg.querySelector(sel)?.getAttribute('fill') ?? '?';
    return COLOUR[f] ?? f;
  };
  return [fill('rect[x="4"]'), fill('path[d^="m6 "]'), fill('path[d^="m7.8"]')];
}

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  useSimulatorStore.setState({ components: [], wires: [] } as never);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = '';
  useSimulatorStore.setState({ components: [], wires: [] } as never);
});

/** Put a resistor on the canvas with this value field and read its bands. */
async function canvasBands(value: unknown, metadataId = 'resistor'): Promise<string[]> {
  const metadata = meta(metadataId);
  const properties = { ...metadata.defaultValues, value };
  await act(async () => {
    root.render(createElement(DynamicComponent, { id: 'r1', metadata, properties, x: 0, y: 0 }));
  });
  const el = host.querySelector('wokwi-resistor') as ResistorEl | null;
  if (!el) throw new Error('no wokwi-resistor on the canvas');
  return bands(el);
}

describe('the resistor on the canvas draws the value the simulation uses (#230)', () => {
  it('draws "1600" as 1.6 kΩ, as before', async () => {
    expect(await canvasBands('1600')).toEqual(['brown', 'blue', 'red']);
  });

  it('draws "1k" as 1 kΩ (brown, black, red), not 1 Ω', async () => {
    expect(await canvasBands('1k')).toEqual(['brown', 'black', 'red']);
  });

  it('draws "4k7" as 4.7 kΩ (yellow, violet, red), not 4 Ω', async () => {
    expect(await canvasBands('4k7')).toEqual(['yellow', 'violet', 'red']);
  });

  it('draws "1M" as 1 MΩ (brown, black, green), not 1 Ω', async () => {
    expect(await canvasBands('1M')).toEqual(['brown', 'black', 'green']);
  });

  it('draws a value with its unit, "2.2 kΩ" and "220R", by the number', async () => {
    expect(await canvasBands('2.2 kΩ')).toEqual(['red', 'red', 'red']);
    act(() => root.unmount());
    root = createRoot(host);
    expect(await canvasBands('220R')).toEqual(['red', 'red', 'brown']);
  });

  it('follows an edit of the field: "1600" then "4k7" then "1M"', async () => {
    const metadata = meta('resistor');
    const render = (value: string) =>
      act(async () => {
        root.render(
          createElement(DynamicComponent, { id: 'r1', metadata, properties: { value }, x: 0, y: 0 }),
        );
      });
    await render('1600');
    const el = host.querySelector('wokwi-resistor') as ResistorEl;
    expect(await bands(el)).toEqual(['brown', 'blue', 'red']);
    await render('4k7');
    expect(await bands(el)).toEqual(['yellow', 'violet', 'red']);
    await render('1M');
    expect(await bands(el)).toEqual(['brown', 'black', 'green']);
  });

  it('draws a preset resistor the same way (resistor-10k given "4k7")', async () => {
    expect(await canvasBands('4k7', 'resistor-10k')).toEqual(['yellow', 'violet', 'red']);
  });

  it('draws the number the simulation falls back to when the text is not a value', async () => {
    // "4,7k" is not a value: the simulation runs 1 kΩ and the inspector says so.
    expect(await canvasBands('4,7k')).toEqual(['brown', 'black', 'red']);
  });

  it('keeps the field text in the project: only the element gets the number', async () => {
    useSimulatorStore.getState().setComponents([
      { id: 'r1', metadataId: 'resistor', x: 0, y: 0, properties: { value: '4k7' } },
    ] as never);
    await canvasBands('4k7');
    const comp = useSimulatorStore.getState().components.find((c) => c.id === 'r1')!;
    expect(comp.properties.value).toBe('4k7');
  });
});

describe('the inspector preview draws the same bands (#230)', () => {
  it('shows "1M" as 1 MΩ in the dialog preview', async () => {
    const metadata = meta('resistor');
    useSimulatorStore.getState().setComponents([
      { id: 'r1', metadataId: 'resistor', x: 0, y: 0, properties: { value: '1M' } },
    ] as never);
    await act(async () => {
      root.render(
        createElement(PartInspectorDialog, {
          componentId: 'r1',
          componentMetadata: metadata,
          componentProperties: { value: '1M' },
          position: { x: 0, y: 0 },
          pinInfo: [],
          onClose: () => {},
          onDelete: () => {},
          onPropertyChange: () => {},
        }),
      );
    });
    const els = [...document.querySelectorAll('wokwi-resistor')] as ResistorEl[];
    expect(els.length).toBeGreaterThan(0);
    for (const el of els) expect(await bands(el)).toEqual(['brown', 'black', 'green']);
  });
});

describe('elementValueOf: which properties the element gets as a number', () => {
  it('hands a resistor value to its element in ohms', () => {
    expect(elementValueOf('resistor', 'value', '4k7')).toBe('4700');
    expect(elementValueOf('resistor-1k', 'value', '1M')).toBe('1000000');
    expect(elementValueOf('resistor', 'value', 220)).toBe('220');
    expect(elementValueOf('resistor', 'value', '')).toBe('1000');
  });

  it('leaves every other property and part as written', () => {
    // A capacitor's drawing does not show its value; a property that is not a
    // number field passes through untouched.
    expect(elementValueOf('capacitor', 'value', '100nF')).toBe('100nF');
    expect(elementValueOf('resistor', 'rotation', 90)).toBe(90);
    expect(elementValueOf('led', 'color', 'red')).toBe('red');
  });
});
