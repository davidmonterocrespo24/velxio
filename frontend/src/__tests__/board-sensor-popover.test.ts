// @vitest-environment jsdom
/**
 * The tilt popover asks for its place when it opens and again when the canvas
 * changes size, and the wheel over it does not zoom the canvas.
 *
 * jsdom lays nothing out: the rectangles are the ones of the browser pass that
 * found the pad under the code editor (popover-placement.test.ts has the
 * arithmetic).
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BoardSensorControls } from '../components/simulator/BoardSensorControls';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const observers: Array<{ targets: Element[]; fire: () => void }> = [];
class FakeResizeObserver {
  readonly targets: Element[] = [];
  constructor(cb: () => void) {
    observers.push({ targets: this.targets, fire: cb });
  }
  observe(el: Element) {
    this.targets.push(el);
  }
  unobserve() {}
  disconnect() {
    this.targets.length = 0;
  }
}

const rect = (left: number, top: number, width: number, height: number) =>
  ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;

let root: Root;
let canvas: HTMLDivElement;
let clip = rect(482, 45, 578, 650);

const popover = () => canvas.querySelector<HTMLElement>('.board-dock > div > div > div');
const button = () => canvas.querySelector<HTMLButtonElement>('button[title^="Tilt the board"]')!;
const click = (el: Element) => act(() => el.dispatchEvent(new MouseEvent('click', { bubbles: true })));

beforeEach(() => {
  observers.length = 0;
  clip = rect(482, 45, 578, 650);
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  canvas = document.createElement('div');
  canvas.className = 'canvas-content';
  canvas.innerHTML = '<div id="mb"></div><div class="board-dock"><div></div></div>';
  document.body.appendChild(canvas);
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    if (this === canvas) return clip;
    if (this.id === 'mb') return rect(490, 103, 262, 214);
    // The anchor: the second button of a dock at the canvas's left edge.
    return rect(495, 324, 28, 24);
  });
  // The popover as the browser lays it out: 200 x 205.
  for (const [name, value] of Object.entries({ offsetWidth: 200, offsetHeight: 205, clientHeight: 203, scrollHeight: 203 })) {
    Object.defineProperty(HTMLElement.prototype, name, { configurable: true, get: () => value });
  }
  root = createRoot(canvas.querySelector('.board-dock > div')!);
  act(() => root.render(createElement(BoardSensorControls, { boardId: 'mb', showImu: true, showBattery: false })));
});

afterEach(() => {
  act(() => root.unmount());
  canvas.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const name of ['offsetWidth', 'offsetHeight', 'clientHeight', 'scrollHeight']) {
    delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name];
  }
});

describe('the tilt popover', () => {
  it('opens under its button, to the right of the canvas edge', () => {
    click(button());
    const style = popover()!.style;
    expect(style.position).toBe('absolute');
    expect(style.left).toBe('0px');
    expect(style.top).toBe('30px');
    expect(style.right).toBe('');
  });

  it('moves when the canvas shrinks under it, and is watched only while open', () => {
    click(button());
    const watching = observers.at(-1)!;
    expect(watching.targets.map((el) => el.className || el.tagName)).toEqual(
      expect.arrayContaining(['canvas-content', 'board-dock']),
    );
    // The serial monitor opens: no room under the board any more.
    clip = rect(482, 45, 578, 350);
    act(() => watching.fire());
    expect(popover()!.style.left, 'beside the board').toBe(`${490 + 262 + 6 - 495}px`);
    expect(Number.parseInt(popover()!.style.top, 10)).toBeLessThan(0);
    click(button());
    expect(popover()).toBeNull();
    expect(watching.targets).toEqual([]);
  });

  it('keeps the wheel to itself', () => {
    click(button());
    const onCanvas = vi.fn();
    canvas.addEventListener('wheel', onCanvas);
    popover()!.dispatchEvent(new Event('wheel', { bubbles: true }));
    expect(onCanvas).not.toHaveBeenCalled();
    // A pinch over it must not zoom the page either (the canvas's own
    // listener is what prevents it elsewhere).
    const pinch = new WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true });
    popover()!.dispatchEvent(pinch);
    expect(pinch.defaultPrevented).toBe(true);
    const plain = new WheelEvent('wheel', { bubbles: true, cancelable: true });
    popover()!.dispatchEvent(plain);
    expect(plain.defaultPrevented, 'a plain wheel scrolls the popover').toBe(false);
    button().dispatchEvent(new Event('wheel', { bubbles: true }));
    expect(onCanvas, 'the dock itself still zooms').toHaveBeenCalledTimes(1);
  });
});
