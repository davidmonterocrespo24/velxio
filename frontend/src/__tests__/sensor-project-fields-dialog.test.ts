// @vitest-environment jsdom
/**
 * The property dialog edits a sensor's PROJECT values.
 *
 * Since Reset returns a sensor to its project value (PR #367) the dialog is
 * the only place a user sets that value, and for most sensors it had no field
 * for it: the BMP280 and the NTC declare no temperature property in their
 * metadata, so the dialog showed nothing to edit and a project temperature
 * could not be set any more. The fields now come from the sensor's own panel
 * definition (sensorProjectFields), one per slider, with its range, step, unit
 * and default, for catalogue and overlay-registered sensors alike.
 *
 * The real PartInspectorDialog is rendered, with the canvas's own
 * onPropertyChange contract (updateComponent), and the input is typed into.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PartInspectorDialog } from '../components/simulator/PartInspectorDialog';
import { useSimulatorStore } from '../store/useSimulatorStore';
import {
  SENSOR_CONTROLS,
  registerSensorControls,
  sensorProjectFields,
} from '../simulation/sensorControlConfig';
import type { ComponentMetadata } from '../types/component-metadata';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// jsdom has no ResizeObserver; the dialog uses one to keep itself on screen.
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const META: ComponentMetadata[] = JSON.parse(
  readFileSync(
    // jsdom gives import.meta.url an http scheme; vitest runs from frontend/.
    resolve(process.cwd(), 'public/components-metadata.json'),
    'utf-8',
  ),
).components;
const meta = (id: string) => {
  const m = META.find((c) => c.id === id);
  if (!m) throw new Error(`no metadata for ${id}`);
  return m;
};

// An overlay-registered sensor, the way the pro tree registers its parts
// (registerSensorControls from maxim/sensirion/dfrobot... register.ts).
registerSensorControls({
  'overlay-co2': {
    title: 'CO2',
    controls: [
      { type: 'slider', key: 'co2', label: 'CO2', min: 400, max: 5000, step: 10, unit: 'ppm', defaultValue: 700 },
      { type: 'button', key: 'breathe', label: 'Breathe' },
    ],
    defaultValues: { co2: 700 },
  },
});
const OVERLAY_META = {
  id: 'overlay-co2',
  tagName: 'overlay-co2-el',
  name: 'CO2 sensor',
  category: 'sensors',
  thumbnail: '',
  properties: [],
  defaultValues: {},
  pinCount: 0,
  tags: [],
} as unknown as ComponentMetadata;

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

/** The dialog as SimulatorCanvas mounts it, re-rendered on every store change
 *  (the canvas re-renders with the component's fresh properties). */
function openDialog(id: string, metadata: ComponentMetadata, properties: Record<string, unknown>, readOnly = false) {
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
        pinInfo: [],
        readOnly,
        onClose: () => {},
        onDelete: () => {},
        // SimulatorCanvas's onPropertyChange: a project edit.
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
  return {
    props: () => useSimulatorStore.getState().components.find((c) => c.id === id)!.properties,
  };
}

const field = (key: string) =>
  document.querySelector<HTMLDivElement>(`[data-sensor-field="${key}"]`);
const numberInput = (key: string) =>
  field(key)?.querySelector<HTMLInputElement>('input.pid-sensor-input') ?? null;

/** Type into a React-controlled input the way the browser does. */
function type(input: HTMLInputElement, text: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('the property dialog shows a field for every sensor project value', () => {
  it('BMP280: temperature and pressure, with the panel range, step, unit and default', () => {
    openDialog('bmp', meta('bmp280'), {});
    const t = numberInput('temperature')!;
    const p = numberInput('pressure')!;
    expect(t).not.toBeNull();
    expect(p).not.toBeNull();
    expect([t.min, t.max, t.step, t.value]).toEqual(['-40', '85', '1', '24']);
    expect([p.min, p.max, p.step, p.value]).toEqual(['300', '1100', '0.25', '1013.25']);
    expect(field('temperature')!.textContent).toContain('Temperature (°C)');
    expect(field('pressure')!.textContent).toContain('Pressure (hPa)');
    // A linear slider also gets a range input with the same bounds.
    const range = field('temperature')!.querySelector<HTMLInputElement>('input[type="range"]')!;
    expect([range.min, range.max, range.step]).toEqual(['-40', '85', '1']);
  });

  it('NTC: temperature, showing the value the project has', () => {
    openDialog('ntc', meta('ntc-temperature-sensor'), { temperature: '40' });
    expect(numberInput('temperature')!.value).toBe('40');
    expect([numberInput('temperature')!.min, numberInput('temperature')!.max]).toEqual(['-40', '125']);
  });

  it('an overlay-registered sensor gets its field too (buttons are not values)', () => {
    openDialog('co2', OVERLAY_META, {});
    expect(numberInput('co2')!.value).toBe('700');
    expect(field('breathe')).toBeNull();
  });

  it('a log-scale slider (LDR illumination) is edited as a number, never as a log position', () => {
    openDialog('ldr', meta('photoresistor-sensor'), { lux: 100 });
    expect(numberInput('lux')!.value).toBe('100');
    expect(field('lux')!.querySelector('input[type="range"]')).toBeNull();
  });

  it('a metadata property the sensor field covers is not listed twice (DS3231)', () => {
    openDialog('rtc', meta('ds3231'), { temperature: 25 });
    const inputs = document.querySelectorAll('.pid-tab-body input:not([type="range"])');
    expect(inputs.length).toBe(1);
  });

  it('every catalogue sensor with a slider has a field for each slider', () => {
    for (const [id, def] of Object.entries(SENSOR_CONTROLS)) {
      const fields = sensorProjectFields({ id: 'x', metadataId: id, properties: {} });
      const sliders = def.controls.filter((c) => c.type === 'slider');
      expect(fields.map((f) => f.key), id).toEqual(sliders.map((c) => c.key));
      for (const f of fields) expect(f.value, `${id}.${f.key}`).toBe(def.defaultValues[f.key]);
    }
  });

  it('a custom chip keeps its own attrs editor, with no sensor fields', () => {
    expect(
      sensorProjectFields({ id: 'c', metadataId: 'custom-chip', properties: { attrs: { ppm: 1 } } }),
    ).toEqual([]);
  });
});

describe('editing the field sets the project value', () => {
  it('BMP280 temperature 35 lands in component.properties as a number', () => {
    const d = openDialog('bmp', meta('bmp280'), {});
    type(numberInput('temperature')!, '35');
    expect(d.props()).toEqual({ temperature: 35 });
  });

  it('typing through values outside the range commits only a valid one', () => {
    const d = openDialog('bmp', meta('bmp280'), {});
    const p = numberInput('pressure')!;
    type(p, '9');
    type(p, '95');
    expect(d.props()).toEqual({});
    type(p, '950');
    expect(d.props()).toEqual({ pressure: 950 });
  });

  it('the IR remote keeps its hex text form (irAddress)', () => {
    const d = openDialog('ir', meta('ir-receiver'), { irAddress: '0x00', irCommand: '0x45' });
    expect(numberInput('command')!.value).toBe('0x45');
    type(numberInput('address')!, '0x10');
    expect(d.props().irAddress).toBe('0x10');
  });

  it('stays editable while the simulation runs (read-only dialog)', () => {
    const d = openDialog('ntc', meta('ntc-temperature-sensor'), {}, true);
    expect(numberInput('temperature')!.disabled).toBe(false);
    type(numberInput('temperature')!, '60');
    expect(d.props()).toEqual({ temperature: 60 });
  });

  it('while running it shows the project value, not a live slider value mirrored into properties', () => {
    const d = openDialog('ntc', meta('ntc-temperature-sensor'), { temperature: 40 }, true);
    // The NTC mirrors a live slider into properties for SPICE.
    act(() => useSimulatorStore.getState().applyLivePropertyChange('ntc', 'temperature', 80));
    expect(d.props().temperature).toBe(80);
    expect(numberInput('temperature')!.value).toBe('40');
  });
});
