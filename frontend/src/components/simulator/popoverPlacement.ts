/**
 * Where a popover opened from a board's dock goes, so that all of it is inside
 * the canvas.
 *
 * The dock sits under its board and follows it through pan and drag, and the
 * canvas clips what leaves it: the code editor is on its left, the serial
 * monitor under it, the assistant on its right. A popover with one fixed place
 * is cut by one of them sooner or later: the tilt pad hung to the LEFT of its
 * button, and on a board at its default place half of the pad was under the
 * code editor, where a click went to the editor.
 *
 * The order of preference:
 *   1. under the dock, slid sideways as far as needed;
 *   2. when it does not fit under it, beside the board (what the board shows
 *      stays in view), slid up as far as needed;
 *   3. when there is no room beside the board either, under the dock or above
 *      it, with a scroll.
 * Never over the button that opened it: that is how it is closed.
 *
 * Everything is in screen pixels. The dock is counter-scaled by 1 / zoom, so a
 * pixel of the offset is a pixel of the screen at any zoom.
 */
import { useLayoutEffect, useState, type CSSProperties, type RefObject } from 'react';

export interface PlacementRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface PopoverPlacement {
  /** Offset of the popover's corner from the anchor's. */
  left: number;
  top: number;
  /** Height to cut it to (it scrolls inside), null when all of it fits. */
  maxHeight: number | null;
}

/** Between the dock (or the board) and the popover. */
export const POPOVER_GAP = 6;
/** Between the popover and the edge of the canvas. */
export const POPOVER_MARGIN = 8;
/** Under the dock, less height than this is not worth scrolling in. */
const MIN_SCROLL_HEIGHT = 160;
/** However little the canvas leaves, a popover that is open is not invisible. */
const MIN_HEIGHT = 48;
/** Beside the board, how much of its width the popover may still cover. */
const MAX_COVER = 0.4;

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
const meets = (a: PlacementRect, b: PlacementRect, gap = 0): boolean =>
  a.left < b.left + b.width + gap &&
  a.left + a.width > b.left - gap &&
  a.top < b.top + b.height + gap &&
  a.top + a.height > b.top - gap;

/**
 * @param board    The board the dock belongs to: what the popover should not cover.
 * @param overlaid What is painted over the canvas (the zoom buttons, whatever an
 *                 overlay adds in a corner): a popover that meets one ends
 *                 above it, or starts under it, or a control of its own is
 *                 hidden behind it.
 */
export function placePopover(
  anchor: PlacementRect,
  popover: { width: number; height: number },
  clip: PlacementRect,
  board?: PlacementRect | null,
  overlaid: readonly PlacementRect[] = [],
): PopoverPlacement {
  const placed = placeIn(anchor, popover, clip, board);
  const at: PlacementRect = {
    left: anchor.left + placed.left,
    top: anchor.top + placed.top,
    width: popover.width,
    height: placed.maxHeight ?? popover.height,
  };
  let top = clip.top;
  let bottom = clip.top + clip.height;
  for (const o of overlaid) {
    if (o.width === 0 || !meets(at, o, POPOVER_GAP)) continue;
    if (o.top + o.height / 2 < clip.top + clip.height / 2) top = Math.max(top, o.top + o.height);
    else bottom = Math.min(bottom, o.top);
  }
  if (top === clip.top && bottom === clip.top + clip.height) return placed;
  // Not worth it when what is left is too little to use.
  if (bottom - top < MIN_SCROLL_HEIGHT) return placed;
  return placeIn(anchor, popover, { ...clip, top, height: bottom - top }, board);
}

function placeIn(
  anchor: PlacementRect,
  popover: { width: number; height: number },
  clip: PlacementRect,
  board?: PlacementRect | null,
): PopoverPlacement {
  const inner = {
    left: clip.left + POPOVER_MARGIN,
    top: clip.top + POPOVER_MARGIN,
    right: clip.left + clip.width - POPOVER_MARGIN,
    bottom: clip.top + clip.height - POPOVER_MARGIN,
  };
  const room = Math.max(0, inner.bottom - inner.top);
  const x = clamp(anchor.left, inner.left, Math.max(inner.left, inner.right - popover.width));
  const under = anchor.top + anchor.height + POPOVER_GAP;
  // Whole pixels: the same geometry measured twice gives the same answer.
  const at = (px: number, py: number, cut: number | null): PopoverPlacement => ({
    left: Math.round(px - anchor.left),
    top: Math.round(py - anchor.top),
    maxHeight: cut === null ? null : Math.max(MIN_HEIGHT, Math.floor(cut)),
  });

  // A dock panned out at the top still opens its popover inside.
  if (Math.max(under, inner.top) + popover.height <= inner.bottom) return at(x, Math.max(under, inner.top), null);

  if (board && board.width > 0) {
    const height = Math.min(popover.height, room);
    // Slid up until its bottom is in, never past the top.
    const up = Math.max(inner.top, Math.min(under, inner.bottom - height));
    const right = Math.min(board.left + board.width + POPOVER_GAP, inner.right - popover.width);
    const left = Math.max(board.left - POPOVER_GAP - popover.width, inner.left);
    const covers = {
      right: right < inner.left ? Infinity : Math.max(0, board.left + board.width - right),
      left: left + popover.width > inner.right ? Infinity : Math.max(0, left + popover.width - board.left),
    };
    const sides: Array<'right' | 'left'> = covers.right <= covers.left ? ['right', 'left'] : ['left', 'right'];
    for (const side of sides) {
      const px = side === 'right' ? right : left;
      if (covers[side] > board.width * MAX_COVER) continue;
      if (meets({ left: px, top: up, width: popover.width, height }, anchor)) continue;
      return at(px, up, popover.height > room ? room : null);
    }
  }

  const below = inner.bottom - Math.max(under, inner.top);
  const above = Math.min(anchor.top - POPOVER_GAP, inner.bottom) - inner.top;
  if (below >= MIN_SCROLL_HEIGHT || below >= above) return at(x, Math.max(under, inner.top), below);
  const height = Math.min(popover.height, above);
  return at(x, inner.top + above - height, popover.height > above ? above : null);
}

const rectOf = (el: Element): PlacementRect => {
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, width: r.width, height: r.height };
};

/**
 * What sits over the canvas in a corner of its own: the canvas's children
 * beside the world that holds the circuit. Something as large as a panel is
 * not one of them.
 */
function paintedOver(clipEl: Element, clip: PlacementRect): PlacementRect[] {
  const rects: PlacementRect[] = [];
  for (const el of clipEl.children) {
    if (el.classList.contains('canvas-world')) continue;
    const r = rectOf(el);
    if (r.width > 0 && r.height > 0 && r.width * r.height < 0.1 * clip.width * clip.height) rects.push(r);
  }
  return rects;
}

/** Under the dock, left edges together: the place before anything is measured. */
const NATURAL: CSSProperties = { position: 'absolute', left: 0, top: `calc(100% + ${POPOVER_GAP}px)` };

/**
 * The position style of a popover inside its (position: relative) anchor.
 * Measured when it opens and again whenever the canvas, the dock or the
 * popover changes size: the serial monitor opening at Run takes half of the
 * canvas, and the dock is as wide as its board is drawn, so it follows the
 * zoom. Panning moves the popover with its board, as it always did.
 */
export function usePopoverInView(
  open: boolean,
  anchor: RefObject<HTMLElement | null>,
  popover: RefObject<HTMLElement | null>,
  boardId: string | null | undefined,
): CSSProperties {
  const [placement, setPlacement] = useState<PopoverPlacement | null>(null);

  useLayoutEffect(() => {
    if (!open) return;
    const measure = (): void => {
      const a = anchor.current;
      const p = popover.current;
      const clipEl = a?.closest('.canvas-content');
      if (!a || !p || !clipEl) return;
      const clip = rectOf(clipEl);
      // Nothing is laid out (a hidden pane, a DOM without layout).
      if (clip.width === 0 || p.offsetWidth === 0) return;
      const boardEl = boardId ? document.getElementById(boardId) : null;
      // scrollHeight: the whole of it, also while it is cut to a maxHeight.
      const next = placePopover(
        rectOf(a),
        { width: p.offsetWidth, height: p.scrollHeight + (p.offsetHeight - p.clientHeight) },
        clip,
        boardEl ? rectOf(boardEl) : null,
        paintedOver(clipEl, clip),
      );
      setPlacement((was) =>
        was && was.left === next.left && was.top === next.top && was.maxHeight === next.maxHeight ? was : next,
      );
    };
    measure();
    const p = popover.current;
    // The wheel belongs to the popover while it is over it: the canvas zooms
    // on it, with a listener of its own below React's root (which is also what
    // keeps a pinch from zooming the page).
    const keepWheel = (e: WheelEvent) => {
      e.stopPropagation();
      if (e.ctrlKey) e.preventDefault();
    };
    p?.addEventListener('wheel', keepWheel, { passive: false });
    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(() => measure());
      for (const el of [anchor.current?.closest('.canvas-content'), anchor.current?.closest('.board-dock'), p]) {
        if (el) observer.observe(el);
      }
    }
    return () => {
      p?.removeEventListener('wheel', keepWheel);
      observer?.disconnect();
    };
  }, [open, anchor, popover, boardId]);

  // Closed, the last place is kept: it is measured again before the next
  // opening is painted.
  if (!open || !placement) return NATURAL;
  return {
    position: 'absolute',
    left: placement.left,
    top: placement.top,
    ...(placement.maxHeight !== null ? { maxHeight: placement.maxHeight, overflowY: 'auto' as const } : {}),
  };
}
