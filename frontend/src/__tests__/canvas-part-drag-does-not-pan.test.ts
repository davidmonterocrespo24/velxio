// @vitest-environment jsdom
/**
 * Pressing or dragging a part while the simulation runs works the part and
 * leaves the canvas where it is (velxio#418).
 *
 * The canvas pans on a left press that reaches its own mousedown handler
 * (the background). While running, a press on a part was deliberately left
 * to propagate, on the belief that the part needed it; it does not (the event
 * reaches the element first and bubbles up from there). So the press reached
 * the canvas too: dragging the slide potentiometer moved the whole canvas
 * with it, and on a handheld wired from a joystick and pushbuttons the
 * slightest movement while clicking panned the view (Skythread, 2026-11-27).
 * The rotary potentiometer never showed it only because its element stops
 * the event itself.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
// The part catalogue the registry fetches at startup, served from the file
// (jsdom cannot fetch a relative URL). Installed before the canvas loads.
const META_TEXT = readFileSync(resolve(process.cwd(), 'public/components-metadata.json'), 'utf-8');
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
  String(input).endsWith('/components-metadata.json')
    ? new Response(META_TEXT, { status: 200, headers: { 'content-type': 'application/json' } })
    : realFetch(input, init)) as typeof fetch;

const { SimulatorCanvas } = await import('../components/simulator/SimulatorCanvas');
const { useSimulatorStore } = await import('../store/useSimulatorStore');
const registry = (await import('../services/ComponentRegistry')).default;
await registry.loadPromise;

let host: HTMLDivElement;
let root: Root;

function resetStore() {
  const s = useSimulatorStore.getState();
  for (const id of s.boards.map((b) => b.id)) s.removeBoard(id);
  useSimulatorStore.setState({ components: [], wires: [] });
  s.setRunning(false);
}

function mouse(type: string, target: Element, x: number, y: number, button = 0) {
  target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button }));
}

const worldTransform = () => (host.querySelector('.canvas-world') as HTMLElement | null)?.style.transform ?? '';

// The parts of issue #418 and of the Skythread handheld: each owns its pointer
// (utils/partOwnsPointer.ts), so the wrapper lets the press reach the element.
const PARTS = [
  { id: 'slider1', metadataId: 'slide-potentiometer', tag: 'wokwi-slide-potentiometer' },
  { id: 'stick1', metadataId: 'analog-joystick', tag: 'wokwi-analog-joystick' },
  { id: 'button1', metadataId: 'pushbutton', tag: 'wokwi-pushbutton' },
];

beforeEach(async () => {
  resetStore();
  PARTS.forEach((p, i) =>
    useSimulatorStore.getState().addComponent({
      id: p.id,
      metadataId: p.metadataId,
      x: 120 + i * 180,
      y: 200,
      properties: {},
    } as never),
  );
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root.render(createElement(SimulatorCanvas));
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  resetStore();
});

/** The part's own element (what a click lands on), inside its wrapper. */
function partElement(tag: string): Element {
  const el = host.querySelector(tag);
  if (!el) throw new Error(`${tag} did not render`);
  return el;
}

describe('a part pressed while the simulation runs (velxio#418)', () => {
  for (const part of PARTS) {
    it(`dragging the ${part.metadataId} works the part and leaves the canvas where it is`, async () => {
      await act(async () => useSimulatorStore.getState().setRunning(true));
      const canvas = host.querySelector('.canvas-content')!;
      const before = worldTransform();
      const el = partElement(part.tag);
      let elementSaw = 0;
      el.addEventListener('mousedown', () => elementSaw++);
      await act(async () => {
        mouse('mousedown', el, 300, 300);
        mouse('mousemove', canvas, 380, 340);
        mouse('mouseup', canvas, 380, 340);
      });
      expect(elementSaw, 'the part still gets its press').toBe(1);
      expect(worldTransform()).toBe(before);
    });
  }

  it('a middle-button drag over a running part still pans', async () => {
    await act(async () => useSimulatorStore.getState().setRunning(true));
    const canvas = host.querySelector('.canvas-content')!;
    const before = worldTransform();
    await act(async () => {
      mouse('mousedown', partElement('wokwi-slide-potentiometer'), 300, 300, 1);
      mouse('mousemove', canvas, 380, 340, 1);
      mouse('mouseup', canvas, 380, 340, 1);
    });
    expect(worldTransform()).not.toBe(before);
  });

  it('the background still pans while running', async () => {
    await act(async () => useSimulatorStore.getState().setRunning(true));
    const canvas = host.querySelector('.canvas-content')!;
    const before = worldTransform();
    await act(async () => {
      mouse('mousedown', canvas, 50, 50);
      mouse('mousemove', canvas, 130, 90);
      mouse('mouseup', canvas, 130, 90);
    });
    expect(worldTransform()).not.toBe(before);
  });

  it('when stopped, a press on the part is not a pan either (it picks the part up)', async () => {
    // With no board at all the canvas is in board-less (SPICE) interaction
    // mode: a circuit with a board is what "stopped" means here.
    await act(async () => {
      useSimulatorStore.getState().addBoard('arduino-uno' as never, 700, 500);
    });
    const canvas = host.querySelector('.canvas-content')!;
    const before = worldTransform();
    await act(async () => {
      mouse('mousedown', partElement('wokwi-slide-potentiometer'), 300, 300);
      mouse('mousemove', canvas, 360, 300);
      mouse('mouseup', canvas, 360, 300);
    });
    expect(worldTransform()).toBe(before);
  });
});
