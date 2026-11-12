// @vitest-environment jsdom
/**
 * The part inspector says what a number field means (velxio/velxio-prod#105,
 * #101, #118): "= 4.7 kΩ" under a resistor's "4k7", "= 1 MΩ" under "1M",
 * and, for a text the simulator cannot read, that it is not a value and
 * which number the simulation uses instead. Before, nothing showed that "1M"
 * was a milliohm or that "100nF" was 100 femtofarads.
 *
 * The real PartInspectorDialog is rendered with the canvas's own
 * onPropertyChange contract, and the field is typed into.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PartInspectorDialog } from '../components/simulator/PartInspectorDialog';
import { useSimulatorStore } from '../store/useSimulatorStore';
import type { ComponentMetadata } from '../types/component-metadata';

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

let host: HTMLDivElement;
let root: Root;
let unsubscribe: (() => void) | null = null;

beforeEach(() => {
  useSimulatorStore.setState({ components: [], wires: [] } as never);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  unsubscribe?.();
  unsubscribe = null;
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = '';
  useSimulatorStore.setState({ components: [], wires: [] } as never);
});

function openDialog(id: string, metadata: ComponentMetadata, properties: Record<string, unknown>) {
  useSimulatorStore.getState().setComponents([
    { id, metadataId: metadata.id, x: 0, y: 0, properties },
  ] as never);
  const render = () => {
    const comp = useSimulatorStore.getState().components.find((c) => c.id === id)!;
    root.render(
      createElement(PartInspectorDialog, {
        componentId: id,
        componentMetadata: metadata,
        componentProperties: comp.properties,
        position: { x: 0, y: 0 },
        pinInfo: [],
        onClose: () => {},
        onDelete: () => {},
        onPropertyChange: (cid, propName, value) => {
          const c = useSimulatorStore.getState().components.find((x) => x.id === cid)!;
          useSimulatorStore.getState().updateComponent(cid, {
            properties: { ...c.properties, [propName]: value },
          });
        },
      }),
    );
  };
  act(() => render());
  unsubscribe = useSimulatorStore.subscribe(() => act(() => render()));
}

function type(input: HTMLInputElement, text: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const readouts = () => [...document.querySelectorAll('.pid-value-readout')].map((e) => e.textContent);
const errors = () => [...document.querySelectorAll('.pid-value-error')].map((e) => e.textContent ?? '');
const textInputs = () => [...document.querySelectorAll<HTMLInputElement>('.pid-tab-body input.pid-input')];

describe('the inspector shows what a number field means', () => {
  it('a resistor: "4k7" reads 4.7 kΩ, then "1M" reads 1 MΩ and "1m" 1 mΩ', () => {
    openDialog('r1', meta('resistor'), { value: '4k7' });
    expect(readouts()).toEqual(['= 4.7 kΩ']);
    type(textInputs()[0]!, '1M');
    expect(readouts()).toEqual(['= 1 MΩ']);
    type(textInputs()[0]!, '1m');
    expect(readouts()).toEqual(['= 1 mΩ']);
  });

  it('a preset capacitor typed as "100nF" reads 100 nF (it was 100 fF)', () => {
    openDialog('c1', meta('cap-100n'), { value: '100nF' });
    expect(readouts()).toEqual(['= 100 nF']);
  });

  it('the power supply reads each field in its unit', () => {
    openDialog('ps', meta('power-supply'), { mode: 'dc', voltage: '12V', frequency: '60', currentLimit: '500mA' });
    expect(readouts()).toEqual(['= 12 V', '= 60 Hz', '= 500 mA']);
  });

  it('a text that is not a value says so, and what the simulation uses', () => {
    openDialog('g', meta('signal-generator'), { waveform: 'sine', frequency: '1,5k', amplitude: 'big', offset: 0 });
    expect(readouts()).toEqual(['= 0 V']);
    const [comma, junk] = errors();
    expect(comma).toContain('4.7k');
    expect(comma).toContain('1 kHz');
    expect(junk).toContain('1 V');
    const invalid = textInputs().filter((i) => i.getAttribute('aria-invalid') === 'true');
    expect(invalid).toHaveLength(2);
  });

  it('a field the simulator does not read as a number gets no readout', () => {
    openDialog('pot', meta('potentiometer'), { value: 512 });
    expect(readouts()).toEqual([]);
    expect(errors()).toEqual([]);
  });

  // A field the part's mode does not read is never validated: clearing a DC
  // supply's "AC mode only" frequency showed "Not a value ... Simulates as
  // 50 Hz" although nothing simulates it (velxio/velxio-prod#118 follow-up).
  it("a DC supply's cleared frequency gets no note; in AC mode it does", () => {
    openDialog('ps', meta('power-supply'), { mode: 'dc', voltage: 5, frequency: 50, currentLimit: 1 });
    type(textInputs()[1]!, '');
    expect(errors()).toEqual([]);
    expect(textInputs().filter((i) => i.getAttribute('aria-invalid') === 'true')).toEqual([]);
    expect(readouts()).toEqual(['= 5 V', '= 1 A']);
    const select = document.querySelector<HTMLSelectElement>('.pid-tab-body select.pid-select')!;
    act(() => {
      select.value = 'ac';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const [note] = errors();
    expect(note).toContain('50 Hz');
  });

  it("a DC generator's amplitude is not checked, its offset is", () => {
    openDialog('g', meta('signal-generator'), { waveform: 'dc', frequency: '1,5k', amplitude: 'big', offset: 'five' });
    const [only, ...rest] = errors();
    expect(rest).toEqual([]);
    expect(only).toContain('0 V');
  });

  it('an empty field the mode reads keeps its note', () => {
    openDialog('ps', meta('power-supply'), { mode: 'dc', voltage: '', frequency: 50, currentLimit: 1 });
    const [note] = errors();
    expect(note).toContain('5 V');
  });
});
