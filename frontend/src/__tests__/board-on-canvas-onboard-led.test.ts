// @vitest-environment jsdom
/**
 * BoardOnCanvas hands the on-board LED visuals to every board element that
 * can draw them (issue #374).
 *
 * The ten ESP32 cases used to return `<Esp32 ... />` with no LED prop while
 * the Arduino and ATtiny cases passed `led13`; the LED state the canvas
 * computed never reached the picture. The prop is now one map for every kind,
 * and this test reads it back off the mounted element.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { BoardOnCanvas } from '../components/simulator/BoardOnCanvas';
import type { BoardInstance, BoardKind, BoardLedVisuals } from '../types/board';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ESP32_KINDS: BoardKind[] = [
  'esp32',
  'esp32-devkit-c-v4',
  'esp32-cam',
  'wemos-lolin32-lite',
  'esp32-s3',
  'xiao-esp32-s3',
  'arduino-nano-esp32',
  'esp32-c3',
  'xiao-esp32-c3',
  'aitewinrobot-esp32c3-supermini',
];

function board(kind: BoardKind): BoardInstance {
  return {
    id: `b-${kind}`,
    boardKind: kind,
    x: 0,
    y: 0,
    running: true,
    compiledProgram: null,
    serialOutput: '',
    serialBaudRate: 115200,
    serialMonitorOpen: false,
    activeFileGroupId: 'g',
    languageMode: 'arduino',
  };
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function render(kind: BoardKind, onboardLeds: BoardLedVisuals | undefined) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      createElement(BoardOnCanvas, {
        board: board(kind),
        running: true,
        onboardLeds,
        onMouseDown: () => {},
        onPinClick: () => {},
      }),
    );
  });
  return document.getElementById(`b-${kind}`) as
    | (HTMLElement & { onboardLeds?: BoardLedVisuals; led13?: boolean; led1?: boolean })
    | null;
}

afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe('BoardOnCanvas: every ESP32 kind receives the LED visuals on its element', () => {
  it.each(ESP32_KINDS)('%s', async (kind) => {
    const visuals: BoardLedVisuals = { led: true, flash: true, rgb: { r: 0, g: 64, b: 0 } };
    const el = await render(kind, visuals);
    expect(el).not.toBeNull();
    expect(el!.tagName.toLowerCase()).toBe('velxio-esp32');
    expect(el!.onboardLeds).toEqual(visuals);
  });

  it('a stopped board (no visuals) leaves the element dark', async () => {
    const el = await render('esp32', undefined);
    expect(el!.onboardLeds ?? {}).toEqual({});
    const dots = Array.from(el!.shadowRoot!.querySelectorAll<HTMLElement>('[data-onboard-led]'));
    expect(dots.length).toBeGreaterThan(0);
    for (const d of dots) expect(d.style.opacity).toBe('0');
  });
});

describe('BoardOnCanvas: the kinds that already worked read the same map', () => {
  it.each(['arduino-uno', 'arduino-nano', 'arduino-mega'] as const)('%s: led13 follows `led`', async (kind) => {
    const el = await render(kind, { led: true });
    expect(el!.led13).toBe(true);
  });

  it('attiny85: led1 follows `led`', async () => {
    const el = await render('attiny85', { led: true });
    expect(el!.led1).toBe(true);
  });

  it('arduino-uno with no visuals is off', async () => {
    const el = await render('arduino-uno', undefined);
    expect(el!.led13).toBe(false);
  });
});
