// @vitest-environment jsdom
/**
 * The scope's rows can be measured on: analog rows have a graticule, the time
 * ruler sits under the traces, and HiDPI screens draw at the right scale
 * (velxio/velxio-prod#115).
 *
 * Before:
 *  - an analog row drew its trace, a dashed 0 V line and three volt labels,
 *    and no divisions at all;
 *  - the ruler spanned the whole panel while the traces start after the
 *    72 px label column, so its ticks drifted from the trace divisions (72 px
 *    at the left edge, 36 px mid-screen);
 *  - the digital rows and the ruler took their size from canvas.width, which
 *    is in device pixels, after scaling the context by devicePixelRatio: at
 *    DPR 2 (a Retina screen, or Windows at 200 %) they drew everything twice
 *    too large, showed half the time window and lost the ruler's labels.
 *
 * The real panel is rendered in jsdom with a canvas context that records
 * what is drawn; jsdom has no layout, so the element sizes are given.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Oscilloscope } from '../components/simulator/Oscilloscope';
import { useOscilloscopeStore } from '../store/useOscilloscopeStore';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** A straight segment the canvas stroked. */
interface Seg {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** Records the strokes and texts drawn in the coordinates the drawing code
 *  used (before the context's own scale, which maps them to device pixels). */
class RecordingContext {
  segs: Seg[] = [];
  texts: Array<{ text: string; x: number; y: number }> = [];
  private path: Seg[] = [];
  private at: { x: number; y: number } | null = null;
  strokeStyle = '';
  fillStyle = '';
  lineWidth = 1;
  font = '';
  clearRect(): void {
    this.segs = [];
    this.texts = [];
  }
  beginPath(): void {
    this.path = [];
    this.at = null;
  }
  moveTo(x: number, y: number): void {
    this.at = { x, y };
  }
  lineTo(x: number, y: number): void {
    if (this.at) this.path.push({ x1: this.at.x, y1: this.at.y, x2: x, y2: y });
    this.at = { x, y };
  }
  stroke(): void {
    this.segs.push(...this.path);
  }
  fillText(text: string, x: number, y: number): void {
    this.texts.push({ text, x, y });
  }
  setLineDash(): void {}
  scale(): void {}
  setTransform(): void {}
}

const W = 800; // CSS width of every row's drawing area
const ROW_H = 60;
const RULER_H = 20;

const contexts = new Map<HTMLCanvasElement, RecordingContext>();
let host: HTMLDivElement;
let root: Root;
const savedDpr = window.devicePixelRatio;

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
  // The layout jsdom does not do: every drawing area is W wide; a channel
  // row is 60 px tall and the ruler 20 px.
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    const inRuler = !!this.closest('.osc-ruler');
    const h = inRuler ? RULER_H : ROW_H;
    return { x: 0, y: 0, left: 0, top: 0, right: W, bottom: h, width: W, height: h, toJSON() {} } as DOMRect;
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
  });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  Object.defineProperty(window, 'devicePixelRatio', { value: savedDpr, configurable: true });
});

function setDpr(dpr: number): void {
  Object.defineProperty(window, 'devicePixelRatio', { value: dpr, configurable: true });
}

/** A digital channel with a 1 kHz square wave and an analog one with a 0-5 V
 *  ramp, both over the 10 ms window. */
function twoChannels(): { digital: string; analog: string } {
  const s = useOscilloscopeStore.getState();
  s.addChannel('uno', 9, 'D9', 5);
  const digital = 'osc-ch-uno-9';
  for (let k = 0; k <= 20; k++) s.pushSample(digital, k * 0.5, k % 2 === 0);
  const analog = s.addNetChannel('n1', 'n1');
  const t = Array.from({ length: 101 }, (_, i) => i * 0.1);
  s.pushAnalogBlock(analog, t, t.map((ms) => ms / 2));
  return { digital, analog };
}

function render(): void {
  act(() => root.render(createElement(Oscilloscope)));
}

function canvasOf(selector: string): RecordingContext {
  const canvas = host.querySelector(selector) as HTMLCanvasElement | null;
  expect(canvas, selector).not.toBeNull();
  const ctx = contexts.get(canvas!);
  expect(ctx, `${selector} was never drawn`).toBeDefined();
  return ctx!;
}

function rowCanvas(index: number): RecordingContext {
  const rows = host.querySelectorAll('.osc-channel-row');
  const canvas = rows[index]!.querySelector('canvas') as HTMLCanvasElement;
  const ctx = contexts.get(canvas);
  expect(ctx, `row ${index} was never drawn`).toBeDefined();
  return ctx!;
}

const verticals = (ctx: RecordingContext, height: number) =>
  ctx.segs
    .filter((s) => s.x1 === s.x2 && Math.min(s.y1, s.y2) <= 0 && Math.max(s.y1, s.y2) >= height)
    .map((s) => s.x1);
const horizontals = (ctx: RecordingContext, width: number) =>
  ctx.segs
    .filter((s) => s.y1 === s.y2 && Math.min(s.x1, s.x2) <= 0 && Math.max(s.x1, s.x2) >= width)
    .map((s) => s.y1);
const uniqSorted = (xs: number[]) => [...new Set(xs)].sort((a, b) => a - b);

describe('an analog row has a graticule to measure on', () => {
  it('draws the 10 time divisions of the digital rows and 8 volts divisions', () => {
    twoChannels();
    render();
    const analog = rowCanvas(1);
    const timeLines = Array.from({ length: 11 }, (_, d) => Math.round((d / 10) * W));
    expect(uniqSorted(verticals(analog, ROW_H))).toEqual(expect.arrayContaining(timeLines));
    const voltLines = Array.from({ length: 7 }, (_, k) => Math.round(((k + 1) / 8) * ROW_H));
    expect(uniqSorted(horizontals(analog, W))).toEqual(expect.arrayContaining(voltLines));
    // The digital row's time divisions are at the same x.
    expect(uniqSorted(verticals(rowCanvas(0), ROW_H))).toEqual(expect.arrayContaining(timeLines));
  });
});

describe('at devicePixelRatio 2 every row and the ruler draw in CSS pixels', () => {
  it('the digital row spans its own width and height, not twice them', () => {
    setDpr(2);
    twoChannels();
    render();
    const digital = rowCanvas(0);
    const xs = verticals(digital, ROW_H);
    expect(Math.max(...xs)).toBe(W);
    // The H and L levels of the trace sit inside the 60 px row.
    const ys = digital.segs.flatMap((s) => [s.y1, s.y2]);
    expect(Math.max(...ys)).toBeLessThanOrEqual(ROW_H);
    const levels = digital.texts.filter((t) => t.text === 'H' || t.text === 'L');
    expect(levels.length).toBe(2);
    for (const l of levels) {
      expect(l.x).toBeLessThan(W);
      expect(l.y).toBeLessThan(ROW_H);
    }
  });

  it('the ruler labels its ten divisions inside its 20 px', () => {
    setDpr(2);
    twoChannels();
    render();
    const ruler = canvasOf('.osc-ruler canvas');
    const ticks = uniqSorted(ruler.segs.filter((s) => s.x1 === s.x2).map((s) => s.x1));
    expect(ticks).toEqual(Array.from({ length: 11 }, (_, d) => Math.round((d / 10) * W)));
    expect(ruler.texts).toHaveLength(10);
    for (const label of ruler.texts) expect(label.y).toBeLessThan(RULER_H);
  });
});

describe('the ruler sits under the traces, not under the label column', () => {
  it('starts after a cell as wide as the label column, in a row that keeps the same scrollbar gutter', () => {
    twoChannels();
    render();
    const rulerCanvas = host.querySelector('.osc-ruler canvas')!;
    const rulerRow = host.querySelector('.osc-ruler')!;
    const channelRow = host.querySelector('.osc-channel-row')!;
    // Both rows: a label-width cell, then the drawing area.
    expect(channelRow.firstElementChild!.classList.contains('osc-channel-label')).toBe(true);
    const spacer = rulerRow.firstElementChild!;
    expect(spacer.classList.contains('osc-ruler-spacer')).toBe(true);
    expect(spacer.contains(rulerCanvas)).toBe(false);
    expect(rulerRow.contains(rulerCanvas)).toBe(true);

    // The stylesheet gives the cell the label column's width, and the ruler
    // row the same scrollbar gutter as the scrolling channel list, so its
    // drawing area has the traces' left edge and width.
    const css = readFileSync(
      resolve(process.cwd(), 'src/components/simulator/Oscilloscope.css'),
      'utf-8',
    );
    const rule = (selector: string): string => {
      const m = new RegExp(`(^|\\n)${selector.replace('.', '\\.')}\\s*\\{([^}]*)\\}`).exec(css);
      expect(m, `${selector} rule`).not.toBeNull();
      return m![2]!;
    };
    const width = (body: string) => /(^|;|\n)\s*width:\s*([^;]+);/.exec(body)?.[2]?.trim();
    expect(width(rule('.osc-ruler-spacer'))).toBe(width(rule('.osc-channel-label')));
    expect(rule('.osc-waveforms')).toMatch(/scrollbar-gutter:\s*stable/);
    expect(rule('.osc-ruler')).toMatch(/scrollbar-gutter:\s*stable/);
  });
});
