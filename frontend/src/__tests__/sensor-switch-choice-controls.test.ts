// @vitest-environment jsdom
/**
 * A sensor value that is really a switch or a choice is edited as one.
 *
 * Sensors model "magnet present", "probe disconnected" or "event: strike /
 * disturber / noise" as integer sliders, and the property dialog showed them
 * as a bare number (a range from 0 to 1 and a box holding "1"). sliderInput()
 * reads what a slider really is: declared `options` make a select with those
 * names, a 0..1 step-1 slider is a checkbox, or a select when its formatValue
 * names both positions (the thermal Source: Manual / Thermal zone). The panel
 * shows the same control. The value stored and dispatched stays the number,
 * so saved projects, Reset and the parts are unchanged.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { PartInspectorDialog } from '../components/simulator/PartInspectorDialog';
import { SensorControlPanel } from '../components/simulator/SensorControlPanel';
import { useSimulatorStore } from '../store/useSimulatorStore';
import { registerSensorUpdate, unregisterSensorUpdate } from '../simulation/SensorUpdateRegistry';
import {
  SENSOR_CONTROLS,
  registerSensorControls,
  sensorProjectFields,
  sliderInput,
  type SliderControl,
} from '../simulation/sensorControlConfig';
import type { ComponentMetadata } from '../types/component-metadata';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

// Overlay-registered, the way the pro tree registers its parts.
registerSensorControls({
  'overlay-lightning': {
    title: 'Lightning',
    controls: [
      { type: 'slider', key: 'distance_km', label: 'Distance', min: 1, max: 40, step: 1, unit: 'km', defaultValue: 12 },
      {
        type: 'slider',
        key: 'event_kind',
        label: 'Event',
        min: 0,
        max: 2,
        step: 1,
        unit: '',
        defaultValue: 0,
        options: { 0: 'Lightning strike', 1: 'Disturber', 2: 'Noise' },
      },
      { type: 'slider', key: 'magnet', label: 'Magnet present', min: 0, max: 1, step: 1, unit: '', defaultValue: 1 },
      {
        type: 'slider',
        key: 'source',
        label: 'Source',
        min: 0,
        max: 1,
        step: 1,
        unit: '',
        defaultValue: 0,
        formatValue: (v: number) => (v >= 0.5 ? 'Thermal zone' : 'Manual'),
      },
    ],
    defaultValues: { distance_km: 12, event_kind: 0, magnet: 1, source: 0 },
  },
});
const META = {
  id: 'overlay-lightning',
  tagName: 'overlay-lightning-el',
  name: 'Lightning sensor',
  category: 'sensors',
  thumbnail: '',
  properties: [],
  defaultValues: {},
  pinCount: 0,
  tags: [],
} as unknown as ComponentMetadata;

const slider = (key: string) =>
  SENSOR_CONTROLS.bmp280.controls.find((c) => c.key === key) as SliderControl;

describe('sliderInput: what a slider really is', () => {
  it('a physical quantity stays a range (BMP280 temperature)', () => {
    expect(sliderInput(slider('temperature'))).toEqual({ kind: 'range' });
  });

  it('a 0..1 step-1 slider without names is a switch', () => {
    expect(
      sliderInput({ type: 'slider', key: 'm', label: 'M', min: 0, max: 1, step: 1, unit: '', defaultValue: 1 }),
    ).toEqual({ kind: 'toggle' });
  });

  it('declared options make a choice, sorted, without values outside the range', () => {
    expect(
      sliderInput({
        type: 'slider', key: 'k', label: 'K', min: 1, max: 3, step: 1, unit: '', defaultValue: 1,
        options: { 3: 'C', 1: 'A', 2: 'B', 9: 'out of range' },
      }),
    ).toEqual({
      kind: 'choice',
      options: [
        { value: 1, label: 'A' },
        { value: 2, label: 'B' },
        { value: 3, label: 'C' },
      ],
    });
  });

  it('a two-position slider whose formatValue names the positions is a choice between those names', () => {
    expect(
      sliderInput({
        type: 'slider', key: 'a', label: 'I2C address', min: 0, max: 1, step: 1, unit: '', defaultValue: 0,
        formatValue: (v) => (v ? '0x60' : '0x68'),
      }),
    ).toEqual({
      kind: 'choice',
      options: [
        { value: 0, label: '0x68' },
        { value: 1, label: '0x60' },
      ],
    });
  });

  it('a two-position slider whose formatValue only prints the number stays a switch', () => {
    expect(
      sliderInput({
        type: 'slider', key: 'b', label: 'B', min: 0, max: 1, step: 1, unit: '', defaultValue: 0,
        formatValue: (v) => v.toFixed(0),
      }),
    ).toEqual({ kind: 'toggle' });
  });

  it('every catalogue slider is a range (no catalogue part changes its input)', () => {
    for (const def of Object.values(SENSOR_CONTROLS)) {
      for (const c of def.controls) {
        if (c.type === 'slider') expect(sliderInput(c).kind, c.key).toBe('range');
      }
    }
  });
});

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
  unregisterSensorUpdate('lt');
  useSimulatorStore.setState({ components: [], wires: [] } as never);
});

function openDialog(properties: Record<string, unknown>) {
  useSimulatorStore.getState().setComponents([
    { id: 'lt', metadataId: META.id, x: 0, y: 0, properties },
  ] as never);
  const render = () => {
    const comp = useSimulatorStore.getState().components.find((c) => c.id === 'lt')!;
    root.render(
      createElement(PartInspectorDialog, {
        componentId: 'lt',
        componentMetadata: META,
        componentProperties: comp.properties,
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
  return {
    props: () => useSimulatorStore.getState().components.find((c) => c.id === 'lt')!.properties,
  };
}

const field = (key: string) => document.querySelector<HTMLDivElement>(`[data-sensor-field="${key}"]`)!;

function choose(select: HTMLSelectElement, value: string) {
  act(() => {
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

describe('the property dialog', () => {
  it('a choice is a select with its names, at the project value', () => {
    openDialog({ event_kind: 1 });
    const sel = field('event_kind').querySelector('select')!;
    expect([...sel.options].map((o) => o.textContent)).toEqual(['Lightning strike', 'Disturber', 'Noise']);
    expect(sel.value).toBe('1');
    expect(field('event_kind').querySelector('input')).toBeNull();
  });

  it('picking a name stores its NUMBER', () => {
    const d = openDialog({});
    choose(field('event_kind').querySelector('select')!, '2');
    expect(d.props()).toEqual({ event_kind: 2 });
  });

  it('a switch is a checkbox, checked at 1, and stores 0 / 1', () => {
    const d = openDialog({});
    const box = field('magnet').querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(box.checked).toBe(true);
    expect(field('magnet').querySelector('input[type="range"], input.pid-sensor-input')).toBeNull();
    act(() => box.click());
    expect(d.props()).toEqual({ magnet: 0 });
    act(() => box.click());
    expect(d.props()).toEqual({ magnet: 1 });
  });

  it('a two-position slider named by its formatValue is a select of those names', () => {
    const d = openDialog({ source: '1' });
    const sel = field('source').querySelector('select')!;
    expect([...sel.options].map((o) => o.textContent)).toEqual(['Manual', 'Thermal zone']);
    expect(sel.value).toBe('1');
    choose(sel, '0');
    expect(d.props()).toEqual({ source: 0 });
  });

  it('a real quantity keeps its range and number box', () => {
    openDialog({});
    expect(field('distance_km').querySelector('input[type="range"]')).not.toBeNull();
    expect(field('distance_km').querySelector<HTMLInputElement>('input.pid-sensor-input')!.value).toBe('12');
  });

  it('sensorProjectFields carries the input kind, so every consumer sees the same control', () => {
    const kinds = sensorProjectFields({ id: 'lt', metadataId: META.id, properties: {} }).map(
      (f) => [f.key, f.input.kind],
    );
    expect(kinds).toEqual([
      ['distance_km', 'range'],
      ['event_kind', 'choice'],
      ['magnet', 'toggle'],
      ['source', 'choice'],
    ]);
  });
});

describe('the sensor panel shows the same controls', () => {
  function openPanel() {
    useSimulatorStore.getState().setComponents([
      { id: 'lt', metadataId: META.id, x: 0, y: 0, properties: {} },
    ] as never);
    const got: Array<Record<string, number | boolean>> = [];
    registerSensorUpdate('lt', (v) => got.push(v));
    act(() =>
      root.render(
        createElement(SensorControlPanel, {
          componentId: 'lt',
          metadataId: META.id,
          sensorName: 'Lightning sensor',
          onClose: () => {},
        }),
      ),
    );
    got.length = 0; // the first-open replay of the project values
    return got;
  }

  it('a select for a choice and a checkbox for a switch, dispatching numbers', () => {
    const got = openPanel();
    const selects = host.querySelectorAll('select');
    expect(selects.length).toBe(2);
    expect([...selects[0].options].map((o) => o.textContent)).toEqual(['Lightning strike', 'Disturber', 'Noise']);
    choose(selects[0], '1');
    expect(got.at(-1)).toEqual({ event_kind: 1 });

    const box = host.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(box.checked).toBe(true);
    act(() => box.click());
    expect(got.at(-1)).toEqual({ magnet: 0 });
    expect(box.checked).toBe(false);

    // The real quantity is still a slider.
    expect(host.querySelectorAll('input[type="range"]').length).toBe(1);
  });
});
