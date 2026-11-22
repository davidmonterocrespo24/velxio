// @vitest-environment jsdom
/**
 * The scope's longest screen and what it shows on it (velxio/velxio-prod#196).
 *
 * Before:
 *  - Time/div stopped at 500 ms: ten divisions, a 5 s screen. A 13 s wait (the
 *    book's problem 25.11) never fit on one.
 *  - In Auto the window's right edge was the latest EDGE, not the board's
 *    clock: through a wait with the LED on nothing scrolled, and the edge that
 *    ended the wait jumped in from the right.
 *  - A digital channel keeps its last MAX_SAMPLES edges, and the stretch before
 *    the oldest one it kept was drawn LOW, a level nobody measured. So was the
 *    stretch before the first edge of a channel added while its board ran.
 *  - An analog capture is one solver sweep (0.4 s at most for a pin stepping a
 *    capacitor): on a long time base the rest of the row was blank.
 *
 * The real panel is rendered in jsdom with a canvas context that records what
 * is drawn (as oscilloscope-graticule-ruler.test.ts does), on the store's own
 * first board, whose clock and running flag the test sets.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Oscilloscope } from '../components/simulator/Oscilloscope';
import { useOscilloscopeStore, MAX_SAMPLES } from '../store/useOscilloscopeStore';
import {
  useSimulatorStore,
  getBoardSimulator,
  getBoardPinManager,
} from '../store/useSimulatorStore';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Seg {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** Records the strokes and texts drawn, in the drawing code's coordinates. */
class RecordingContext {
  segs: Seg[] = [];
  texts: Array<{ text: string; x: number; y: number }> = [];
  private path: Seg[] = [];
  private at: { x: number; y: number } | null = null;
  strokeStyle = '';
  fillStyle = '';
  lineWidth = 1;
  font = '';
  textAlign = 'left';
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

const W = 800;
const ROW_H = 60;
const RULER_H = 20;
const HIGH_Y = Math.round(ROW_H * 0.15);
const LOW_Y = Math.round(ROW_H * 0.85);
const BOARD = 'arduino-uno'; // the store's first board

const contexts = new Map<HTMLCanvasElement, RecordingContext>();
let host: HTMLDivElement;
let root: Root;
const frames = new Map<number, FrameRequestCallback>();
let frameId = 0;
let clockMs = 0;

beforeEach(() => {
  contexts.clear();
  frames.clear();
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
    const h = this.closest('.osc-ruler') ? RULER_H : ROW_H;
    return { x: 0, y: 0, left: 0, top: 0, right: W, bottom: h, width: W, height: h, toJSON() {} } as DOMRect;
  });
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    frames.set(++frameId, cb);
    return frameId;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    frames.delete(id);
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
  // The board's clock is the test's; the scope reads it the way it reads any
  // engine's (an own property beats the prototype's method).
  clockMs = 0;
  (getBoardSimulator(BOARD) as unknown as { scopeClockMs: () => number }).scopeClockMs = () =>
    clockMs;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  setRunning(false);
  delete (getBoardSimulator(BOARD) as unknown as { scopeClockMs?: unknown }).scopeClockMs;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function setRunning(running: boolean): void {
  useSimulatorStore.setState((s) => ({
    boards: s.boards.map((b) => (b.id === BOARD ? { ...b, running } : b)),
  }));
}

function render(): void {
  act(() => root.render(createElement(Oscilloscope)));
}

/** Run the animation frames the panel asked for, as the browser would. */
function frame(): void {
  act(() => {
    const due = [...frames.values()];
    frames.clear();
    for (const cb of due) cb(0);
  });
}

function rowCanvas(index: number): RecordingContext {
  const rows = host.querySelectorAll('.osc-channel-row');
  const canvas = rows[index]!.querySelector('canvas') as HTMLCanvasElement;
  const ctx = contexts.get(canvas);
  expect(ctx, `row ${index} was never drawn`).toBeDefined();
  return ctx!;
}

function ruler(): RecordingContext {
  const canvas = host.querySelector('.osc-ruler canvas') as HTMLCanvasElement;
  return contexts.get(canvas)!;
}

/** The time/div selector (the header's first select). */
function timeDivSelect(): HTMLSelectElement {
  return host.querySelector('select.osc-select') as HTMLSelectElement;
}

function chooseTimeDiv(ms: number): void {
  const select = timeDivSelect();
  act(() => {
    select.value = String(ms);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

/** The trace's horizontal runs: segments at the HIGH or the LOW level. */
const levelRuns = (ctx: RecordingContext, y: number) =>
  ctx.segs.filter((s) => s.y1 === y && s.y2 === y && s.x2 > s.x1);

/** Diagonal strokes: the "no data" hatching. */
const hatches = (ctx: RecordingContext) =>
  ctx.segs.filter((s) => s.x1 !== s.x2 && s.y1 !== s.y2);

describe('time bases up to 5 s per division', () => {
  it('offers 1 s, 2 s and 5 s per division, and 5 s/div is a 50 s screen', () => {
    const s = useOscilloscopeStore.getState();
    s.addChannel(BOARD, 13, 'D13', 5);
    s.pushSample(`osc-ch-${BOARD}-13`, 60_000, true);
    render();
    const values = Array.from(timeDivSelect().options).map((o) => Number(o.value));
    expect(values).toEqual(expect.arrayContaining([1000, 2000, 5000]));
    expect(Math.max(...values)).toBe(5000);

    chooseTimeDiv(5000);
    // Ten divisions of 5 s each, ending at the latest sample (60 s).
    expect(ruler().texts.map((t) => t.text)).toEqual([
      '10.0s', '15.0s', '20.0s', '25.0s', '30.0s', '35.0s', '40.0s', '45.0s', '50.0s', '55.0s',
    ]);
  });
});

describe('Auto follows the board clock, not the last edge', () => {
  it('keeps scrolling through a 13 s wait with no edge, the LED on all along', () => {
    const s = useOscilloscopeStore.getState();
    s.addChannel(BOARD, 13, 'D13', 5);
    s.pushSample(`osc-ch-${BOARD}-13`, 1000, true); // LED on at 1 s, then nothing
    setRunning(true);
    render();
    chooseTimeDiv(500);
    clockMs = 14_000;
    frame();
    // The window is the last 5 s of the board's clock: 9 s to 14 s.
    expect(ruler().texts[0]!.text).toBe('9.0s');
    const row = rowCanvas(0);
    // HIGH from the left edge to the right one; no LOW anywhere.
    expect(levelRuns(row, HIGH_Y).some((r) => r.x1 === 0 && r.x2 === W)).toBe(true);
    expect(levelRuns(row, LOW_Y)).toEqual([]);
  });

  it('forgets the clock of the run before when the scope is emptied for another circuit', () => {
    const s = useOscilloscopeStore.getState();
    s.addChannel(BOARD, 13, 'D13', 5);
    setRunning(true);
    render();
    chooseTimeDiv(500);
    clockMs = 120_000;
    frame();
    expect(ruler().texts[0]!.text).toBe('115.0s');
    // Another circuit loads: the channels go, then a new one is probed
    // before Run. Its screen starts at 0, not at the old run's 115 s.
    setRunning(false);
    act(() => useOscilloscopeStore.getState().resetChannels());
    act(() => useOscilloscopeStore.getState().addChannel(BOARD, 13, 'D13', 5));
    expect(ruler().texts[0]!.text).toBe('0.00ms');
  });

  it('holds still while the capture is paused, however far the clock runs', () => {
    const s = useOscilloscopeStore.getState();
    s.addChannel(BOARD, 13, 'D13', 5);
    s.pushSample(`osc-ch-${BOARD}-13`, 1000, true);
    setRunning(true);
    render();
    chooseTimeDiv(500);
    clockMs = 14_000;
    frame();
    act(() => useOscilloscopeStore.getState().setCapturing(false));
    clockMs = 30_000;
    frame();
    chooseTimeDiv(500); // a re-render that is not a frame
    expect(ruler().texts[0]!.text).toBe('9.0s');
  });
});

describe('what the scope does not know is "no data", not LOW', () => {
  it('a 490 Hz PWM over MAX_SAMPLES edges: before the oldest edge kept', () => {
    const s = useOscilloscopeStore.getState();
    s.addChannel(BOARD, 9, 'D9', 5);
    const id = `osc-ch-${BOARD}-9`;
    // 490 Hz at 50 %: an edge every 1.0204 ms, 12 000 of them (12.2 s),
    // from 40 s on, so the 50 s screen ends at the last one.
    const halfMs = 1000 / 490 / 2;
    for (let k = 0; k < MAX_SAMPLES + 2000; k++) s.pushSample(id, 40_000 + k * halfMs, k % 2 === 0);
    render();
    chooseTimeDiv(5000);
    const buf = useOscilloscopeStore.getState().samples[id]!;
    const oldestKeptMs = buf[0]!.timeMs;
    const lastMs = buf[buf.length - 1]!.timeMs;
    const xOldest = ((oldestKeptMs - (lastMs - 50_000)) / 50_000) * W;
    const row = rowCanvas(0);
    // Hatching up to the oldest edge kept, and the label in it.
    const hatch = hatches(row);
    expect(hatch.length).toBeGreaterThan(10);
    expect(Math.max(...hatch.map((h) => Math.max(h.x1, h.x2)))).toBeLessThanOrEqual(xOldest + 1e-6);
    expect(row.texts.map((t) => t.text)).toContain('no data');
    // No LOW level drawn from the left edge to the first edge kept.
    expect(levelRuns(row, LOW_Y).filter((r) => r.x1 < xOldest - 1)).toEqual([]);
  });

  it('a channel added while the board runs starts from the level the pin has then', () => {
    setRunning(true);
    clockMs = 5000;
    act(() => getBoardPinManager(BOARD)!.triggerPinChange(13, true, 'mcu'));
    render();
    // Add D13 from the panel's picker.
    act(() => (host.querySelector('button.osc-btn') as HTMLButtonElement).click());
    const d13 = Array.from(document.querySelectorAll('button.osc-pin-btn')).find(
      (b) => b.textContent === 'D13',
    ) as HTMLButtonElement;
    act(() => d13.click());
    const id = `osc-ch-${BOARD}-13`;
    expect(useOscilloscopeStore.getState().samples[id]).toEqual([
      { timeMs: 5000, state: true, unknownBefore: true },
    ]);
    chooseTimeDiv(1000);
    clockMs = 8000;
    frame();
    // Window 0-10 s: no data to 5 s, then HIGH to the right edge.
    const row = rowCanvas(0);
    expect(row.texts.map((t) => t.text)).toContain('no data');
    expect(levelRuns(row, LOW_Y)).toEqual([]);
    expect(levelRuns(row, HIGH_Y).some((r) => r.x1 === W / 2 && r.x2 === W)).toBe(true);
  });

  it('Clear on a running board restarts each channel from its pin level', () => {
    const s = useOscilloscopeStore.getState();
    s.addChannel(BOARD, 13, 'D13', 5);
    const id = `osc-ch-${BOARD}-13`;
    s.pushSample(id, 100, true);
    setRunning(true);
    clockMs = 2500;
    act(() => getBoardPinManager(BOARD)!.triggerPinChange(13, true, 'mcu'));
    render();
    const clear = host.querySelector('button.osc-btn-danger') as HTMLButtonElement;
    act(() => clear.click());
    expect(useOscilloscopeStore.getState().samples[id]).toEqual([
      { timeMs: 2500, state: true, unknownBefore: true },
    ]);
  });

  it('an analog capture shorter than the screen: no data after it', () => {
    const s = useOscilloscopeStore.getState();
    const id = s.addNetChannel('n1', 'n1');
    // A pin stepping a capacitor: the solver's 0.4 s sweep.
    const t = Array.from({ length: 401 }, (_, i) => i);
    s.pushAnalogBlock(id, t, t.map((ms) => 5 * (1 - Math.exp(-ms / 100))));
    render();
    chooseTimeDiv(500); // a 5 s screen, 0 to 5 s
    const row = rowCanvas(0);
    const hatch = hatches(row).filter((h) => Math.min(h.x1, h.x2) >= (400 / 5000) * W - 1e-6);
    expect(hatch.length).toBeGreaterThan(10);
    expect(row.texts.map((x) => x.text)).toContain('no data');
  });
});
