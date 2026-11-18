/**
 * Parts-on-breadboard support (Wokwi-style).
 *
 * Model (mirrors what Wokwi persists as `["r1:1","bb1:6t.b","",["$bb"]]`):
 * a part seated on a breadboard is connected by one INVISIBLE zero-length
 * wire per pin, from the part pin to the hole under it. Those wires are
 * ordinary `Wire` objects flagged `bb: true`, so the netlist builder, the
 * digital trace and SPICE treat them exactly like hand-drawn wires — the
 * only special-casing is cosmetic (not rendered, not hit-testable).
 *
 * Two building blocks live here:
 *  - pure geometry over the exported hole grids (testable without DOM), and
 *  - a DOM adapter that reads the dragged part's pinInfo to compute the
 *    anchor-pin snap and the per-pin seating.
 */

import {
  BREADBOARD_PINS,
} from '../velxio-elements/breadboard-element';
import {
  BREADBOARD_MINI_PINS,
} from '../velxio-elements/breadboard-mini-element';
import { breadboardGroupKey, isBreadboard } from './breadboardNets';
import { calculatePinPosition } from './pinPositionCalculator';
import { readPinInfo } from './readPinInfo';

export interface Hole {
  name: string;
  x: number; // element-space CSS px (relative to the breadboard inner element)
  y: number;
}

interface Pt {
  x: number;
  y: number;
}

export interface ComponentLike {
  id: string;
  metadataId: string;
  x: number;
  y: number;
  properties?: Record<string, unknown>;
}

/** Magnet range for the anchor pin while dragging (px, world units). */
export const SNAP_TOLERANCE = 9;
/**
 * A pin within this of a hole center counts as plugged in. Must absorb the
 * worst element-geometry residual (~1.6 px — pin spacings are not exact
 * 9.6 multiples) while staying below half the hole pitch (4.8 px) so a
 * pin can never be ambiguous between two holes.
 */
export const SEAT_TOLERANCE = 4;

/** DynamicComponent wrapper inset: border 2 + padding 4 on every side. */
const WRAPPER_INSET = 6;

export function breadboardHoles(metadataId: string): readonly Hole[] | null {
  if (metadataId === 'breadboard') return BREADBOARD_PINS;
  if (metadataId === 'breadboard-mini') return BREADBOARD_MINI_PINS;
  return null;
}

/**
 * Nearest hole of one breadboard to a world point. Pure — hole world
 * position is bb top-left + wrapper inset + element-space hole coords.
 * Rotated breadboards are not supported (returns null).
 */
export function nearestHole(
  bb: ComponentLike,
  world: Pt,
  maxDistance: number,
): { name: string; x: number; y: number; dist: number } | null {
  if (Number(bb.properties?.rotation) || 0) return null;
  const holes = breadboardHoles(bb.metadataId);
  if (!holes) return null;
  const ox = bb.x + WRAPPER_INSET;
  const oy = bb.y + WRAPPER_INSET;
  let best: { name: string; x: number; y: number; dist: number } | null = null;
  for (const h of holes) {
    const hx = ox + h.x;
    const hy = oy + h.y;
    const dist = Math.hypot(hx - world.x, hy - world.y);
    if (dist <= maxDistance && (!best || dist < best.dist)) {
      best = { name: h.name, x: hx, y: hy, dist };
    }
  }
  return best;
}

function breadboardsOf(components: ComponentLike[]): ComponentLike[] {
  return components.filter((c) => isBreadboard(c.metadataId));
}

/** Pin names of a mounted component, from its DOM element's pinInfo. */
function pinNames(componentId: string): string[] | null {
  const el = document.getElementById(componentId);
  const pinInfo = readPinInfo<{ name: string }>(el);
  if (!pinInfo || !Array.isArray(pinInfo) || pinInfo.length === 0) return null;
  return pinInfo.map((p) => p.name);
}

/**
 * Snap a dragged component's tentative position so its ANCHOR pin (first
 * pinInfo entry) lands exactly on the nearest hole center. Returns the
 * adjusted {x, y} or null when no hole is within SNAP_TOLERANCE (or the
 * geometry cannot be measured).
 */
export function snapPositionToBreadboard(
  comp: ComponentLike,
  tentativeX: number,
  tentativeY: number,
  components: ComponentLike[],
): Pt | null {
  if (isBreadboard(comp.metadataId)) return null;
  const bbs = breadboardsOf(components);
  if (bbs.length === 0) return null;
  const names = pinNames(comp.id);
  if (!names) return null;
  const rotation = Number(comp.properties?.rotation) || 0;
  const anchor = calculatePinPosition(
    comp.id, names[0], tentativeX + WRAPPER_INSET, tentativeY + WRAPPER_INSET, rotation,
  );
  if (!anchor) return null;
  let best: { hole: { x: number; y: number; dist: number }; } | null = null;
  for (const bb of bbs) {
    const hole = nearestHole(bb, anchor, SNAP_TOLERANCE);
    if (hole && (!best || hole.dist < best.hole.dist)) best = { hole };
  }
  if (!best) return null;
  return {
    x: tentativeX + (best.hole.x - anchor.x),
    y: tentativeY + (best.hole.y - anchor.y),
  };
}

export interface Seat {
  pinName: string;
  pinX: number;
  pinY: number;
  bbId: string;
  holeName: string;
  holeX: number;
  holeY: number;
}

/**
 * Compute the per-pin seating of a component at its CURRENT position:
 * every pin within SEAT_TOLERANCE of a hole. Returns null when geometry
 * cannot be measured (unmounted DOM) — callers must then leave any
 * existing seating untouched; an empty array means "measured, not seated".
 */
export function computeSeating(
  comp: ComponentLike,
  components: ComponentLike[],
): Seat[] | null {
  if (isBreadboard(comp.metadataId)) return [];
  const bbs = breadboardsOf(components);
  if (bbs.length === 0) return [];
  const names = pinNames(comp.id);
  if (!names) return null;
  const rotation = Number(comp.properties?.rotation) || 0;
  const seats: Seat[] = [];
  for (const name of names) {
    const pin = calculatePinPosition(
      comp.id, name, comp.x + WRAPPER_INSET, comp.y + WRAPPER_INSET, rotation,
    );
    if (!pin) continue;
    let best: { bbId: string; hole: { name: string; x: number; y: number; dist: number } } | null =
      null;
    for (const bb of bbs) {
      const hole = nearestHole(bb, pin, SEAT_TOLERANCE);
      if (hole && (!best || hole.dist < best.hole.dist)) best = { bbId: bb.id, hole };
    }
    if (best) {
      seats.push({
        pinName: name,
        pinX: pin.x,
        pinY: pin.y,
        bbId: best.bbId,
        holeName: best.hole.name,
        holeX: best.hole.x,
        holeY: best.hole.y,
      });
    }
  }
  return seats;
}

/**
 * True when the component's bounding-box center is over a breadboard's
 * body — used to auto-rotate axial parts (resistors) to vertical so they
 * bridge the center trench like on a real board.
 */
export function isOverBreadboard(
  comp: ComponentLike,
  tentativeX: number,
  tentativeY: number,
  components: ComponentLike[],
): boolean {
  const el = document.getElementById(comp.id);
  const w = el ? (el as HTMLElement).offsetWidth : 40;
  const h = el ? (el as HTMLElement).offsetHeight : 40;
  const cx = tentativeX + WRAPPER_INSET + w / 2;
  const cy = tentativeY + WRAPPER_INSET + h / 2;
  for (const bb of breadboardsOf(components)) {
    const bbEl = document.getElementById(bb.id);
    if (!bbEl) continue;
    const bw = (bbEl as HTMLElement).offsetWidth;
    const bh = (bbEl as HTMLElement).offsetHeight;
    if (
      cx >= bb.x + WRAPPER_INSET && cx <= bb.x + WRAPPER_INSET + bw &&
      cy >= bb.y + WRAPPER_INSET && cy <= bb.y + WRAPPER_INSET + bh
    ) {
      return true;
    }
  }
  return false;
}

/** Axial 2-pin parts that read better vertical on a breadboard: 'resistor'
 * plus every preconfigured 'resistor-<value>' variant. */
export function isAutoVerticalPart(metadataId: string): boolean {
  return metadataId.startsWith('resistor') || metadataId.startsWith('wokwi-resistor');
}

// ── Full seating solver ──────────────────────────────────────────────────
//
// `snapPositionToBreadboard` above is the drag-time magnet: it aligns the
// ANCHOR pin only and assumes the rest follow. That is fine while dragging
// but it is what produces HALF-SEATED parts — one pin finds a hole, the
// others hang off the board and are electrically dead (a 7-segment dropped
// slightly high seats its top pin row in bank-a and its bottom row on
// nothing). The solver below runs on DROP and answers a stricter question:
// where is the nearest position at which EVERY pin lands in a free hole?
//
// It is deliberately geometry-only — pin offsets come from the caller, which
// reads them off the live DOM `pinInfo`. So it works for ANY component that
// can be wired at all, with no per-part whitelist.

/** How far the solver may slide a part from where it was dropped, in holes.
 * 6 pitches ≈ 58 px — enough to skip past an occupied neighbour without the
 * part appearing to teleport across the board. */
const SEARCH_RADIUS_HOLES = 6;
const HOLE_PITCH = 9.6;
/**
 * Radius used to ASSIGN pins to holes before the fine translation — half a
 * pitch, so every pin sitting over the grid gets exactly one candidate hole.
 * Deliberately looser than SEAT_TOLERANCE: assignment answers "which hole",
 * the post-translation check answers "does it fit".
 */
const ASSIGN_RADIUS = HOLE_PITCH / 2;
/** Spatial-hash cell size. One pitch keeps ~1 hole per cell, so a 3x3 cell
 * probe is a cheap exact-enough nearest lookup. */
const CELL = HOLE_PITCH;

/** A pin's position relative to the component's x/y (rotation applied). */
export interface PinOffset {
  name: string;
  dx: number;
  dy: number;
}

export interface Placement {
  x: number;
  y: number;
  /** hole name per pin, in the same order as the input offsets. */
  holes: { pinName: string; holeName: string }[];
  /** Distance from the requested position — 0 when it was already correct. */
  moved: number;
}

interface IndexedHoles {
  cells: Map<number, Hole[]>;
  ox: number;
  oy: number;
}

/** Numeric cell key: no string per probe (a board seat preview probes the
 *  grid tens of thousands of times a frame). Unique for any canvas size. */
function cellKey(gx: number, gy: number): number {
  return gx * 1_000_003 + gy;
}

/** The index of the last breadboards seen, by kind and position: a seat
 *  preview re-solves every pointer frame against the same breadboard. */
const indexCache = new Map<string, IndexedHoles>();

/** Bucket a breadboard's holes by world position for O(1) nearest lookup. */
function indexHoles(bb: ComponentLike): IndexedHoles | null {
  const cacheKey = `${bb.metadataId}|${bb.x}|${bb.y}`;
  const hit = indexCache.get(cacheKey);
  if (hit) return hit;
  const holes = breadboardHoles(bb.metadataId);
  if (!holes) return null;
  const ox = bb.x + WRAPPER_INSET;
  const oy = bb.y + WRAPPER_INSET;
  const cells = new Map<number, Hole[]>();
  for (const h of holes) {
    const key = cellKey(Math.floor((ox + h.x) / CELL), Math.floor((oy + h.y) / CELL));
    const bucket = cells.get(key);
    if (bucket) bucket.push(h);
    else cells.set(key, [h]);
  }
  const idx = { cells, ox, oy };
  if (indexCache.size >= 16) indexCache.clear();
  indexCache.set(cacheKey, idx);
  return idx;
}

/** Strip (net group) of each hole of a breadboard kind, computed once. */
const groupCache = new Map<string, Map<string, string | null>>();
function holeGroup(metadataId: string, holeName: string): string | null {
  let groups = groupCache.get(metadataId);
  if (!groups) {
    groups = new Map();
    groupCache.set(metadataId, groups);
  }
  let g = groups.get(holeName);
  if (g === undefined) {
    g = breadboardGroupKey(metadataId, holeName);
    groups.set(holeName, g);
  }
  return g;
}

/** Nearest hole to a world point via the spatial hash, or null past `max`. */
function lookupHole(idx: IndexedHoles, x: number, y: number, max: number): Hole | null {
  const cx = Math.floor(x / CELL);
  const cy = Math.floor(y / CELL);
  let best: Hole | null = null;
  let bestDist = max;
  for (let gx = cx - 1; gx <= cx + 1; gx++) {
    for (let gy = cy - 1; gy <= cy + 1; gy++) {
      const bucket = idx.cells.get(cellKey(gx, gy));
      if (!bucket) continue;
      for (const h of bucket) {
        const d = Math.hypot(idx.ox + h.x - x, idx.oy + h.y - y);
        if (d <= bestDist) {
          bestDist = d;
          best = h;
        }
      }
    }
  }
  return best;
}

/**
 * Nearest position at which every pin sits in a free hole of ONE breadboard.
 *
 * Completeness note: candidates are generated by moving the FIRST pin onto
 * each nearby hole. That loses nothing — in any fully-seated placement every
 * pin is on a hole, the first one included — so enumerating the first pin's
 * possible holes enumerates every valid placement, at 1/N the cost of
 * trying all pins.
 *
 * @param pins    pin offsets from the component origin, rotation already applied
 * @param bb      the target breadboard
 * @param occupied hole names already taken on this board (by other parts)
 * @param wantX/wantY where the user dropped it
 * @param accept  optional extra rule a fully seated placement must pass (a
 *                board uses it to refuse a spot where its BODY would cover
 *                another part's pins); a rejected candidate is skipped, not
 *                fatal, so the next-nearest placement can still win.
 * @returns the closest valid placement, or null when the part does not fit
 *          anywhere within the search radius.
 */
export function solvePlacement(
  pins: PinOffset[],
  bb: ComponentLike,
  occupied: ReadonlySet<string>,
  wantX: number,
  wantY: number,
  accept?: (placement: Placement) => boolean,
): Placement | null {
  if (pins.length === 0) return null;
  const idx = indexHoles(bb);
  if (!idx) return null;

  const holes = breadboardHoles(bb.metadataId)!;
  const anchor = pins[0];
  const anchorX = wantX + anchor.dx;
  const anchorY = wantY + anchor.dy;
  const radius = SEARCH_RADIUS_HOLES * HOLE_PITCH;

  // Each hole near the anchor is one HYPOTHESIS about which hole the anchor
  // belongs to. It is not the final position: see the fine translation below.
  const candidates: { x: number; y: number }[] = [];
  for (const h of holes) {
    const hx = idx.ox + h.x;
    const hy = idx.oy + h.y;
    if (Math.hypot(hx - anchorX, hy - anchorY) > radius) continue;
    candidates.push({ x: hx - anchor.dx, y: hy - anchor.dy });
  }

  let best: Placement | null = null;
  for (const cand of candidates) {
    const assigned: { pinName: string; holeName: string; hx: number; hy: number }[] = [];
    const usedHere = new Set<string>();
    const groupsHere = new Set<string>();
    let ok = true;
    let sumDx = 0;
    let sumDy = 0;
    for (const pin of pins) {
      const px = cand.x + pin.dx;
      const py = cand.y + pin.dy;
      // ASSIGN_RADIUS, not SEAT_TOLERANCE: this pass only decides WHICH hole
      // each pin belongs to. Judging fit here would reject any footprint the
      // anchor hypothesis cannot satisfy exactly.
      const hole = lookupHole(idx, px, py, ASSIGN_RADIUS);
      // Every pin must find a hole, and no two pins may share one — a part
      // whose own pins collide is a geometry bug, not a valid seating.
      if (!hole || occupied.has(hole.name) || usedHere.has(hole.name)) {
        ok = false;
        break;
      }
      // Nor may two pins land in the same STRIP: a column strip (and worse, a
      // power rail) is a single net, so that silently shorts the part to
      // itself. Geometrically legal, electrically ruinous — a 7-segment will
      // happily lay its pins across a rail without this.
      const group = holeGroup(bb.metadataId, hole.name);
      if (group !== null) {
        if (groupsHere.has(group)) {
          ok = false;
          break;
        }
        groupsHere.add(group);
      }
      usedHere.add(hole.name);
      const hx = idx.ox + hole.x;
      const hy = idx.oy + hole.y;
      assigned.push({ pinName: pin.name, holeName: hole.name, hx, hy });
      sumDx += hx - px;
      sumDy += hy - py;
    }
    if (!ok) continue;

    // Fine translation: the centroid of the pin-to-hole residuals, which
    // minimises the sum of squared distances for this assignment.
    //
    // This is what makes off-pitch footprints seatable at all. A diode spans
    // 7.5 pitches, so pinning one leg dead-centre leaves the other 4.8 px
    // out — beyond tolerance, rejected. Shift the whole part by 2.4 px and
    // BOTH legs sit 2.4 px off centre, comfortably inside tolerance. That is
    // what bending the leads does on a real board.
    const tx = sumDx / pins.length;
    const ty = sumDy / pins.length;
    const fx = cand.x + tx;
    const fy = cand.y + ty;

    // Now judge fit, strictly, against the assignment we just committed to.
    // Staying under SEAT_TOLERANCE (< half pitch) keeps every pin's nearest
    // hole unambiguous, so computeSeating later resolves the same holes and
    // the netlist is unaffected by the offset.
    for (let i = 0; i < pins.length; i++) {
      const a = assigned[i];
      if (Math.hypot(a.hx - (fx + pins[i].dx), a.hy - (fy + pins[i].dy)) > SEAT_TOLERANCE) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;

    // Evaluate every candidate rather than taking the first: the translation
    // reorders things, so the nearest hypothesis need not yield the nearest
    // final position. Ties keep the earlier candidate (grid emission order).
    const moved = Math.hypot(fx - wantX, fy - wantY);
    if (!best || moved < best.moved) {
      const placement: Placement = {
        x: fx,
        y: fy,
        holes: assigned.map((a) => ({ pinName: a.pinName, holeName: a.holeName })),
        moved,
      };
      if (accept && !accept(placement)) continue;
      best = placement;
    }
  }
  return best;
}

/** Pin offsets of a mounted component, read off the live DOM. Generic: any
 * element with a `pinInfo` getter works, which is every wireable part. */
function pinOffsets(comp: ComponentLike, atX: number, atY: number): PinOffset[] | null {
  const raw = pinNames(comp.id);
  if (!raw) return null;
  // Deduplicate: some parts declare repeated pin names (STM32 boards carry
  // GND x5, 3V3 x4). calculatePinPosition resolves by name and always finds
  // the FIRST match, so duplicates would all report the same coordinates and
  // then collide on one hole, failing the part outright. Solving the unique
  // names seats the part; the repeats ride along on their own strips.
  const names = [...new Set(raw)];
  const rotation = Number(comp.properties?.rotation) || 0;
  const offsets: PinOffset[] = [];
  for (const name of names) {
    const p = calculatePinPosition(comp.id, name, atX + WRAPPER_INSET, atY + WRAPPER_INSET, rotation);
    if (!p) return null; // partial geometry would seat the part wrong
    offsets.push({ name, dx: p.x - atX, dy: p.y - atY });
  }
  return offsets.length > 0 ? offsets : null;
}

/** Holes already taken on `bb`, by every component except `exceptId`. */
function occupiedHoles(
  bb: ComponentLike,
  components: ComponentLike[],
  exceptId: string,
): Set<string> {
  const taken = new Set<string>();
  for (const other of components) {
    if (other.id === exceptId || other.id === bb.id) continue;
    if (isBreadboard(other.metadataId)) continue;
    const seats = computeSeating(other, components);
    if (!seats) continue;
    for (const s of seats) {
      if (s.bbId === bb.id) taken.add(s.holeName);
    }
  }
  return taken;
}

/**
 * Drop-time seating: given where the user let go of a part, return the
 * nearest position where it is FULLY seated on a breadboard and collides
 * with nothing. Returns null when it does not belong on a board at all, or
 * when no free spot exists nearby — callers then leave it where it was
 * dropped rather than forcing a wrong seating.
 *
 * Works for every component with `pinInfo`; there is no part whitelist.
 */
export function seatOnDrop(
  comp: ComponentLike,
  droppedX: number,
  droppedY: number,
  components: ComponentLike[],
  /** Holes of a breadboard taken by something that is not a component: a
   *  BOARD plugged into it holds the holes of its pins and every hole under
   *  its body between its two header rows (utils/boardSeat.ts). */
  extraOccupied?: (bbId: string) => ReadonlySet<string>,
): Placement | null {
  if (isBreadboard(comp.metadataId)) return null;
  const bbs = breadboardsOf(components);
  if (bbs.length === 0) return null;
  const pins = pinOffsets(comp, droppedX, droppedY);
  if (!pins) return null;

  // Only consider boards the part is actually near — dropping a part on the
  // left board must not fling it onto one across the canvas.
  let best: Placement | null = null;
  for (const bb of bbs) {
    const occupied = occupiedHoles(bb, components, comp.id);
    const extra = extraOccupied?.(bb.id);
    if (extra) for (const h of extra) occupied.add(h);
    const placement = solvePlacement(
      pins,
      bb,
      occupied,
      droppedX,
      droppedY,
    );
    if (placement && (!best || placement.moved < best.moved)) best = placement;
  }
  return best;
}

/**
 * Correct an agent-placed component's position so its anchor pin lands where
 * the server's solver decided it should. This is the seating the agent already
 * solved server-side; the browser only re-does the final positioning.
 *
 * Why the browser has to redo it: the backend computes the exact anchor target
 * in BREADBOARD-ELEMENT space (pivot-free, so rotation-safe) but only an
 * APPROXIMATE canvas x/y, because the true rotation pivot is the DOM wrapper
 * centre — and the wrapper includes a text label whose width the server cannot
 * measure. Under rotation that leaves the part off by enough that
 * `computeSeating` finds no holes and the part sits visibly disconnected.
 *
 * `anchorX/anchorY` are the anchor pin's position in the breadboard's element
 * space, straight from the solver — and they already carry the sub-pitch
 * "fine translation" the solver applies to off-lattice footprints (a diode
 * spans 7.5 pitches, so its anchor is deliberately ~2.4 px off a hole centre
 * to split the error). Targeting the hole CENTRE instead would leave the far
 * pin 4.8 px out and half-seat the part — verified against real DOM geometry.
 *
 * The fix is a pure TRANSLATION, never a re-solve: read where the anchor pin
 * actually is from the live DOM (real pivot), read where the solver put it,
 * and shift the whole part by the difference. Every other pin follows, because
 * pin-to-pin offsets do not depend on the pivot. It cannot slide the part to
 * different holes, so the netlist the agent validated is preserved.
 *
 * Returns the corrected {x, y}, or null when the geometry cannot be measured
 * yet (element not mounted) — callers keep the backend's hint and retry.
 */
export function resolveSeatPosition(
  comp: ComponentLike,
  bbId: string,
  anchorPin: string,
  anchorX: number,
  anchorY: number,
  components: ComponentLike[],
): Pt | null {
  const bb = components.find((c) => c.id === bbId);
  if (!bb || !isBreadboard(bb.metadataId)) return null;
  const rotation = Number(comp.properties?.rotation) || 0;
  const anchor = calculatePinPosition(
    comp.id,
    anchorPin,
    comp.x + WRAPPER_INSET,
    comp.y + WRAPPER_INSET,
    rotation,
  );
  if (!anchor) return null; // DOM not ready — caller retries on the next frame
  const targetX = bb.x + WRAPPER_INSET + anchorX;
  const targetY = bb.y + WRAPPER_INSET + anchorY;
  return { x: comp.x + (targetX - anchor.x), y: comp.y + (targetY - anchor.y) };
}
