/**
 * A popover opened from a board's dock stays inside the canvas.
 *
 * The numbers are a 1440 x 900 window with the editor, the assistant and the
 * serial monitor open (the micro:bit's browser pass of 2026-11-23): the canvas
 * is 578 x 650 at (482, 45), and the tilt pad of a board at its default place
 * was cut in half by the code editor, where a click on it went.
 */
import { describe, expect, it } from 'vitest';
import {
  placePopover,
  POPOVER_GAP,
  POPOVER_MARGIN,
  type PlacementRect,
} from '../components/simulator/popoverPlacement';

const CANVAS: PlacementRect = { left: 482, top: 45, width: 578, height: 650 };
/** The micro:bit where the picker puts it, and the dock's second button under it. */
const BOARD: PlacementRect = { left: 540, top: 103, width: 262, height: 214 };
const DOCK: PlacementRect = { left: 573, top: 324, width: 28, height: 24 };
const TILT = { width: 200, height: 205 };
const SENSORS = { width: 230, height: 470 };

/** Where the popover ends up on the screen. */
function onScreen(
  anchor: PlacementRect,
  popover: { width: number; height: number },
  clip: PlacementRect,
  board?: PlacementRect | null,
): PlacementRect & { right: number; bottom: number; cut: boolean } {
  const p = placePopover(anchor, popover, clip, board);
  const height = p.maxHeight ?? popover.height;
  const left = anchor.left + p.left;
  const top = anchor.top + p.top;
  return {
    left,
    top,
    width: popover.width,
    height,
    right: left + popover.width,
    bottom: top + height,
    cut: p.maxHeight !== null,
  };
}

function expectInside(r: ReturnType<typeof onScreen>, clip: PlacementRect): void {
  expect(r.left).toBeGreaterThanOrEqual(clip.left + POPOVER_MARGIN);
  expect(r.right).toBeLessThanOrEqual(clip.left + clip.width - POPOVER_MARGIN);
  expect(r.top).toBeGreaterThanOrEqual(clip.top + POPOVER_MARGIN);
  expect(r.bottom).toBeLessThanOrEqual(clip.top + clip.height - POPOVER_MARGIN);
}

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

/** The width of the board the popover hides. */
const covered = (r: PlacementRect, board: PlacementRect): number =>
  r.top >= board.top + board.height || r.top + r.height <= board.top
    ? 0
    : Math.max(0, Math.min(r.left + r.width, board.left + board.width) - Math.max(r.left, board.left));

describe('placePopover', () => {
  it('opens under the dock, left edges together, when it fits there', () => {
    const r = onScreen(DOCK, TILT, CANVAS, BOARD);
    expectInside(r, CANVAS);
    expect(r.left).toBe(DOCK.left);
    expect(r.top).toBe(DOCK.top + DOCK.height + POPOVER_GAP);
    expect(r.cut).toBe(false);
  });

  it('the tilt pad of a board at the left edge of the canvas is not under the code editor', () => {
    // The old place: 200 px to the left of the button's right edge.
    const oldLeft = DOCK.left + DOCK.width - TILT.width;
    expect(oldLeft, 'the bug: under the editor').toBeLessThan(CANVAS.left);
    const dock = { ...DOCK, left: CANVAS.left - 20 };
    const r = onScreen(dock, TILT, CANVAS, { ...BOARD, left: CANVAS.left - 60 });
    expectInside(r, CANVAS);
  });

  it('slides left when the board is at the right edge', () => {
    const dock = { ...DOCK, left: 1000 };
    const r = onScreen(dock, TILT, CANVAS, { ...BOARD, left: 900 });
    expectInside(r, CANVAS);
    expect(r.right).toBe(CANVAS.left + CANVAS.width - POPOVER_MARGIN);
  });

  it('a tall panel goes beside the board, whole, and the board stays in view', () => {
    const r = onScreen({ ...DOCK, left: 545 }, SENSORS, CANVAS, BOARD);
    expectInside(r, CANVAS);
    expect(r.cut).toBe(false);
    expect(r.left).toBe(BOARD.left + BOARD.width + POPOVER_GAP);
    expect(covered(r, BOARD)).toBe(0);
  });

  it('a board low on the canvas, with six pixels missing beside it: still whole, still beside', () => {
    const board = { left: 560, top: 303, width: 262, height: 214 };
    const r = onScreen({ left: 565, top: 524, width: 28, height: 24 }, SENSORS, CANVAS, board);
    expectInside(r, CANVAS);
    expect(r.cut).toBe(false);
    expect(covered(r, board)).toBeLessThanOrEqual(board.width * 0.4);
  });

  it('takes the left side when that is where the room is', () => {
    const board = { ...BOARD, left: 780 };
    const r = onScreen({ ...DOCK, left: 785 }, SENSORS, CANVAS, board);
    expectInside(r, CANVAS);
    expect(r.right).toBeLessThanOrEqual(board.left + board.width * 0.4);
    expect(covered(r, board)).toBeLessThanOrEqual(board.width * 0.4);
  });

  it('a board as wide as the canvas: under the dock with a scroll while that is usable', () => {
    const board = { left: 490, top: 100, width: 560, height: 300 };
    const r = onScreen({ left: 495, top: 410, width: 28, height: 24 }, SENSORS, CANVAS, board);
    expectInside(r, CANVAS);
    expect(r.cut).toBe(true);
    expect(r.top).toBe(410 + 24 + POPOVER_GAP);
    expect(r.height).toBeGreaterThanOrEqual(160);
  });

  it('and above the dock when it is not', () => {
    const board = { left: 490, top: 250, width: 560, height: 300 };
    const r = onScreen({ left: 495, top: 560, width: 28, height: 24 }, SENSORS, CANVAS, board);
    expectInside(r, CANVAS);
    expect(r.cut).toBe(false);
    expect(r.bottom).toBe(560 - POPOVER_GAP);
  });

  it('a canvas shorter than the panel cuts it to the canvas', () => {
    const low = { ...CANVAS, height: 260 };
    const r = onScreen({ left: 545, top: 200, width: 28, height: 24 }, SENSORS, low, { ...BOARD, top: 60, height: 130 });
    expectInside(r, low);
    expect(r.cut).toBe(true);
  });

  it('a popover wider than the canvas starts at its left edge', () => {
    const narrow = { ...CANVAS, width: 180 };
    const r = onScreen(DOCK, TILT, narrow, BOARD);
    expect(r.left).toBe(narrow.left + POPOVER_MARGIN);
  });

  it('with no board to keep clear of it opens above the dock', () => {
    const r = onScreen({ left: 545, top: 560, width: 28, height: 24 }, SENSORS, CANVAS, null);
    expectInside(r, CANVAS);
    expect(r.bottom).toBeLessThanOrEqual(560 - POPOVER_GAP);
  });

  // The button that opened it is the only way to close it.
  it('a small embed: the popover is cut, and its button stays clear', () => {
    const clip: PlacementRect = { left: 0, top: 0, width: 390, height: 330 };
    const board = { left: 20, top: 80, width: 262, height: 214 };
    const dock = { left: 25, top: 300, width: 28, height: 24 };
    for (const popover of [TILT, { width: 230, height: 430 }]) {
      const r = onScreen(dock, popover, clip, board);
      expectInside(r, clip);
      const overButton = r.left < dock.left + dock.width && r.right > dock.left && r.top < dock.top + dock.height && r.bottom > dock.top;
      expect(overButton, `${popover.width} px wide`).toBe(false);
    }
  });

  it('a canvas of a few pixels does not make it invisible', () => {
    const p = placePopover(DOCK, TILT, { ...CANVAS, height: 40 }, BOARD);
    expect(p.maxHeight).toBeGreaterThanOrEqual(48);
  });

  it('in any geometry: inside the canvas, clear of its button, the same twice', () => {
    // A linear congruential generator: the same cases on every run.
    let seed = 20261123;
    const rnd = (lo: number, hi: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return lo + (seed / 2147483648) * (hi - lo);
    };
    for (let i = 0; i < 20_000; i++) {
      const clip = { left: rnd(0, 500), top: rnd(0, 120), width: rnd(320, 1400), height: rnd(260, 1000) };
      const board = { left: clip.left + rnd(-200, clip.width), top: clip.top + rnd(-200, clip.height), width: rnd(40, 700), height: rnd(40, 500) };
      // A dock whose button is in view: what can be clicked.
      const dock = {
        left: clamp(board.left, clip.left, clip.left + clip.width - 28),
        top: clamp(board.top + board.height + 6, clip.top, clip.top + clip.height - 24),
        width: 28,
        height: 24,
      };
      const popover = { width: rnd(150, 290), height: rnd(60, 600) };
      const r = onScreen(dock, popover, clip, board);
      const where = `case ${i}: ${JSON.stringify({ clip, board, dock, popover, r })}`;
      const overButton = r.left < dock.left + dock.width && r.right > dock.left && r.top < dock.top + dock.height && r.bottom > dock.top;
      expect(overButton, where).toBe(false);
      expect(r.left >= clip.left + POPOVER_MARGIN - 1 && r.right <= clip.left + clip.width - POPOVER_MARGIN + 1, where).toBe(true);
      // The 48 px floor is the one thing that may stick out, and only where
      // neither above nor below the button has that much.
      if (r.height > 48) {
        expect(r.top >= clip.top + POPOVER_MARGIN - 1 && r.bottom <= clip.top + clip.height - POPOVER_MARGIN + 1, where).toBe(true);
      }
      expect(placePopover(dock, popover, clip, board)).toEqual(placePopover(dock, popover, clip, board));
    }
  });

  describe('with buttons painted over the canvas', () => {
    /** The zoom buttons, in the canvas's bottom right corner; another one in its top right. */
    const ZOOM: PlacementRect = { left: 946, top: 649, width: 100, height: 32 };
    const CORNER: PlacementRect = { left: 961, top: 59, width: 85, height: 32 };
    const place = (anchor: PlacementRect, popover: { width: number; height: number }, board: PlacementRect) => {
      const p = placePopover(anchor, popover, CANVAS, board, [ZOOM, CORNER]);
      const height = p.maxHeight ?? popover.height;
      return { left: anchor.left + p.left, top: anchor.top + p.top, bottom: anchor.top + p.top + height, cut: p.maxHeight !== null };
    };

    it('a panel that meets the ones below ends above them', () => {
      const plain = onScreen({ ...DOCK, left: 545 }, SENSORS, CANVAS, BOARD);
      expect(plain.bottom, 'the panel would end beside its last buttons').toBeGreaterThan(ZOOM.top);
      const r = place({ ...DOCK, left: 545 }, SENSORS, BOARD);
      expect(r.bottom).toBeLessThanOrEqual(ZOOM.top - POPOVER_MARGIN);
      expect(r.top).toBeGreaterThanOrEqual(CORNER.top + CORNER.height);
      expect(r.cut).toBe(false);
    });

    it('one that does not meet them is where it was', () => {
      expect(place(DOCK, TILT, BOARD)).toMatchObject({ left: DOCK.left, top: DOCK.top + DOCK.height + POPOVER_GAP });
    });

    it('one too tall for what is left between them is cut there, and scrolls', () => {
      const r = place({ ...DOCK, left: 545 }, { width: 230, height: 640 }, BOARD);
      expect(r.bottom).toBeLessThanOrEqual(ZOOM.top - POPOVER_MARGIN);
      expect(r.top).toBeGreaterThanOrEqual(CORNER.top + CORNER.height + POPOVER_MARGIN);
      expect(r.cut).toBe(true);
    });
  });

  it('measuring the same geometry twice gives the same place, at any zoom', () => {
    for (const z of [0.37, 1, 1.7]) {
      const board = { left: 540.3, top: 103.7, width: 262 * z, height: 214 * z };
      const dock = { left: 573.25, top: 103.7 + 214 * z + 6.1, width: 28, height: 24 };
      const first = placePopover(dock, SENSORS, CANVAS, board);
      expect(placePopover(dock, SENSORS, CANVAS, board)).toEqual(first);
      expect(Number.isInteger(first.left) && Number.isInteger(first.top)).toBe(true);
    }
  });
});
