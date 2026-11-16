// @vitest-environment jsdom
/**
 * The scope's vertical scale and trigger level can be set from the panel
 * (velxio/velxio-prod#114).
 *
 * Analog rows have fitted each capture since ae6bd398 (always including 0 V,
 * like DC coupling), but nothing in the panel could change V/div, the offset
 * or the trigger level: the store setters had no caller, and the level was
 * fixed at 1.65 V. So:
 *  - the book's chapter 14 collector, 4.83 V carrying 9 mVpp, fitted 1 V/div
 *    and its signal moved 0.07 px of the 60 px row: a flat line;
 *  - Normal and Single never fired on a signal that does not cross 1.65 V
 *    (in the gallery's common-emitter amplifier, neither the ±0.2 V input nor
 *    the 3.9-5.7 V collector does).
 *
 * The real panel is rendered in jsdom; a recording canvas context shows what
 * a row draws.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Oscilloscope } from '../components/simulator/Oscilloscope';
import { useOscilloscopeStore, type OscAnalogChannel } from '../store/useOscilloscopeStore';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class RecordingContext {
  ys: number[] = [];
  texts: string[] = [];
  strokeStyle = '';
  fillStyle = '';
  lineWidth = 1;
  font = '';
  textAlign = 'left';
  private path: number[] = [];
  clearRect(): void {
    this.ys = [];
    this.texts = [];
  }
  beginPath(): void {
    this.path = [];
  }
  moveTo(_x: number, y: number): void {
    this.path.push(y);
  }
  lineTo(_x: number, y: number): void {
    this.path.push(y);
  }
  stroke(): void {
    // Only the trace is stroked in a channel's own colour.
    if (this.strokeStyle === TRACE) this.ys.push(...this.path);
  }
  fillText(text: string): void {
    this.texts.push(text);
  }
  setLineDash(): void {}
  scale(): void {}
  setTransform(): void {}
}

const TRACE = '#00ff41'; // the first channel colour
const ROW_H = 60;
const contexts = new Map<HTMLCanvasElement, RecordingContext>();
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  contexts.clear();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (
    this: HTMLCanvasElement,
  ) {
    let ctx = contexts.get(this);
    if (!ctx) {
      ctx = new RecordingContext();
      contexts.set(this, ctx);
    }
    return ctx as unknown as CanvasRenderingContext2D;
  } as never);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    const h = this.closest('.osc-ruler') ? 20 : ROW_H;
    return { x: 0, y: 0, left: 0, top: 0, right: 800, bottom: h, width: 800, height: h, toJSON() {} } as DOMRect;
  });
  useOscilloscopeStore.setState({
    open: true,
    running: true,
    timeDivMs: 1,
    channels: [],
    samples: {},
    triggerMode: 'auto',
    triggerChannelId: null,
    triggeredAtMs: null,
    triggerStatus: 'idle',
    triggerEdge: 'rising',
  });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

const render = () => act(() => root.render(createElement(Oscilloscope)));
const store = () => useOscilloscopeStore.getState();
const analog = (id: string) => store().channels.find((c) => c.id === id) as OscAnalogChannel;

/** A 4.83 V collector carrying a 1 kHz, 9 mVpp sine, over 10 ms. */
function collectorCapture(id: string): void {
  const t = Array.from({ length: 401 }, (_, i) => i * 0.025);
  store().pushAnalogBlock(id, t, t.map((ms) => 4.83 + 0.0045 * Math.sin(2 * Math.PI * ms)));
}

function rowContext(): RecordingContext {
  const canvas = host.querySelector('.osc-channel-row canvas') as HTMLCanvasElement;
  const ctx = contexts.get(canvas);
  expect(ctx, 'the row was drawn').toBeDefined();
  return ctx!;
}

function control<T extends Element>(selector: string): T {
  const el = host.querySelector(selector);
  expect(el, selector).not.toBeNull();
  return el as T;
}

function choose(select: HTMLSelectElement, value: string): void {
  act(() => {
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

function type(input: HTMLInputElement, text: string): void {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  act(() => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
}

describe('V/div and offset, per analog channel', () => {
  it('sets 5 mV/div and an offset, keeps them on the next capture, and Auto gives the fit back', () => {
    const id = store().addNetChannel('n4', 'n4');
    collectorCapture(id);
    expect(analog(id)).toMatchObject({ voltsPerDiv: 1, yOffsetV: 2 }); // the DC fit: 0 V..4.83 V
    render();

    // Leaving Auto for 5 mV/div centres the row on the capture: around
    // Auto's 2 V it would show nothing of a 4.83 V signal.
    choose(control<HTMLSelectElement>('select.osc-vdiv'), '0.005');
    expect(analog(id)).toMatchObject({ voltsPerDiv: 0.005, yOffsetV: 4.83, autoScale: false });
    type(control<HTMLInputElement>('input.osc-offset'), '4.832');
    expect(analog(id)).toMatchObject({ voltsPerDiv: 0.005, yOffsetV: 4.832, autoScale: false });

    collectorCapture(id);
    expect(analog(id)).toMatchObject({ voltsPerDiv: 0.005, yOffsetV: 4.832 });
    // 9 mVpp at 5 mV/div over 8 divisions of 60 px: about 13.5 px of trace.
    const ys = rowContext().ys;
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(12);
    // The row says what its scale is.
    expect(rowContext().texts.join(' ')).toContain('5mV/div');

    choose(control<HTMLSelectElement>('select.osc-vdiv'), 'auto');
    expect(analog(id)).toMatchObject({ voltsPerDiv: 1, autoScale: true });
  });

  it('keeps a V/div finer than 10 mV', () => {
    const id = store().addNetChannel('n4', 'n4');
    store().setChannelVoltsPerDiv(id, 0.001);
    expect(analog(id).voltsPerDiv).toBe(0.001);
  });
});

describe('AC coupling', () => {
  it('removes the mean, so Auto fits the 9 mVpp ripple of a 4.83 V collector to the row', () => {
    const id = store().addNetChannel('n4', 'n4');
    collectorCapture(id);
    render();
    const flat = rowContext().ys;
    expect(Math.max(...flat) - Math.min(...flat)).toBeLessThan(1);

    act(() => control<HTMLButtonElement>('button.osc-coupling').click());
    expect(analog(id)).toMatchObject({ coupling: 'ac', voltsPerDiv: 0.002, yOffsetV: 0 });
    const ys = rowContext().ys;
    // 9 mVpp at 2 mV/div: 4.5 of the 8 divisions, about 34 px.
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(30);
    expect(rowContext().texts.join(' ')).toMatch(/2mV\/div.*AC/);
  });
});

describe('the trigger level', () => {
  it('defaults to the middle of the capture, so Normal fires on a signal that never reaches 1.65 V', () => {
    const id = store().addNetChannel('n2', 'n2');
    store().setTriggerMode('normal');
    store().setTriggerChannel(id);
    // A 0.1-0.3 V square: it never crosses 1.65 V.
    const t = Array.from({ length: 40 }, (_, i) => i * 0.25);
    store().pushAnalogBlock(id, t, t.map((ms) => (Math.floor(ms) % 2 === 0 ? 0.1 : 0.3)));
    expect(store().triggerStatus).toBe('triggered');
    expect(store().triggeredAtMs).toBe(1);
  });

  it('can be typed in the panel for an analog trigger channel, and emptied back to auto', () => {
    const id = store().addNetChannel('n2', 'n2');
    store().setTriggerMode('normal');
    store().setTriggerChannel(id);
    render();
    const level = control<HTMLInputElement>('input.osc-trigger-level');
    type(level, '0.25');
    expect(store().triggerLevelV).toBe(0.25);
    type(level, '');
    expect(store().triggerLevelV).toBeNull();
  });
});
