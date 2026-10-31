/**
 * Wire auto-routing: find an orthogonal route from pin to pin that avoids
 * crossing other components AND avoids riding on top of existing wires.
 *
 * This runs only for SYSTEM-owned wire shapes (`autoRouted` wires): first
 * pin-to-pin creation, agent-created wires, and the post-move re-route
 * pass. Manual edits are never re-routed — dragging a segment clears the
 * flag and the wire goes exactly where the user puts it.
 *
 * Algorithm: A* over the compressed orthogonal grid spanned by the pin
 * coordinates, the inflated obstacle edges, and "corridor" lines offset
 * SEPARATION px to each side of existing wire segments (so the router has
 * lanes to run BESIDE a wire instead of on it). Costs are soft where the
 * physics is soft:
 *
 *   - component bodies       -> hard blocked (never cross)
 *   - parallel run over a wire -> heavy cost per px (the ugly case)
 *   - perpendicular crossing  -> small fixed cost (often unavoidable)
 *   - each 90-degree bend     -> medium cost (straighter routes win)
 *
 * A crossing must stay possible: dense boards would otherwise become
 * unroutable and everything degrades to the default elbow. Wires that
 * share an endpoint with the route are exempt from wire costs entirely —
 * two wires meeting on one pin necessarily touch there.
 */

import { expandOrthogonalPoints, previewElbow, simplifyOrthogonalPath } from './wireUtils';

export interface ObstacleRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Point {
  x: number;
  y: number;
}

/** An axis-aligned piece of an existing wire's rendered polyline. */
export interface WireSegment {
  a: Point;
  b: Point;
}

/** Clearance kept between a routed wire and component bounding boxes. */
export const ROUTE_MARGIN = 8;

/** Extra path cost per 90-degree bend, in world px. */
const BEND_PENALTY = 40;

/** Lane spacing beside existing wires — also the distance under which a
 * parallel run counts as "riding on" a wire. Slightly wider than the
 * rendered stroke + outline (~6px) so side-by-side wires stay legible. */
export const WIRE_SEPARATION = 8;

/** Cost per px of running parallel on top of / hugging an existing wire.
 * Calibrated against BEND_PENALTY: dodging sideways costs 2 bends (~80)
 * plus ~2*SEPARATION of extra length, so any overlap longer than ~50px
 * prefers the detour. */
const OVERLAP_PENALTY_PER_PX = 2;

/** Fixed cost for crossing an existing wire perpendicularly. Small on
 * purpose: crossings are often unavoidable and are visually fine. */
const CROSS_PENALTY = 12;

/** Only wires within this margin of the route's bounding box participate,
 * both as costs and as corridor coordinates — keeps the grid tiny on
 * wire-dense canvases. */
const WIRE_WINDOW_MARGIN = 120;

/** Hard cap on grid size, beyond which routing silently degrades to the
 * direct elbow. Far above any realistic canvas. */
const MAX_COORDS_PER_AXIS = 256;

/** Hard cap on A* work per wire (heap pops). A wire whose pin is walled in
 * has no route at all, and A* then visits every state of the grid (up to
 * 256 x 256 x 3), each step pricing every nearby wire: seconds per wire,
 * minutes on a dense canvas, with the tab frozen. A real route on a busy
 * canvas needs a few thousand pops; past the cap the wire takes the direct
 * elbow, exactly as when the grid is too large. */
const MAX_EXPANSIONS = 50_000;

function inflate(r: ObstacleRect, m: number): ObstacleRect {
  return { x: r.x - m, y: r.y - m, w: r.w + 2 * m, h: r.h + 2 * m };
}

function rectContains(r: ObstacleRect, p: Point): boolean {
  return p.x > r.x && p.x < r.x + r.w && p.y > r.y && p.y < r.y + r.h;
}

/**
 * A rect that contains an endpoint cannot be blocked whole (the wire must
 * leave the pin) — but dropping it entirely let routes cross the WHOLE
 * body. Seen live: strips under a seated 4-digit display start inside its
 * inflated bbox, so the display stopped being an obstacle for every wire
 * leaving those strips and 15 wires ran straight across it.
 *
 * Instead, carve an ESCAPE CORRIDOR from the endpoint to the rect's
 * nearest edge and keep the rest blocked: the far side of the body stays
 * an obstacle, and the route exits through the corridor like a real
 * jumper leaving from under a chip.
 *
 * Returns the still-blocked sub-rects (0-3 of them).
 */
type EscapeDir = 'left' | 'right' | 'up' | 'down';

/**
 * Escape direction for a point inside ONE OR MORE overlapping rects: the
 * direction with the shortest run until the point clears ALL of them.
 *
 * Every containing rect must then carve its corridor in this SAME
 * direction. Seated resistors overlap heavily (19px pitch, ~66px inflated
 * boxes), and when each rect picked its own nearest edge the corridors
 * pointed different ways and walled each other off — A* found no exit,
 * fell back to the direct elbow, and the wire crossed a display.
 */
function unionEscapeDir(rects: ObstacleRect[], p: Point): EscapeDir {
  const containing = rects.filter((r) => rectContains(r, p));
  if (containing.length === 0) return 'down';
  const dLeft = Math.max(...containing.map((r) => p.x - r.x));
  const dRight = Math.max(...containing.map((r) => r.x + r.w - p.x));
  const dTop = Math.max(...containing.map((r) => p.y - r.y));
  const dBottom = Math.max(...containing.map((r) => r.y + r.h - p.y));
  const min = Math.min(dLeft, dRight, dTop, dBottom);
  if (min === dBottom) return 'down';
  if (min === dTop) return 'up';
  if (min === dRight) return 'right';
  return 'left';
}

function carveEscape(r: ObstacleRect, p: Point, dir?: EscapeDir): ObstacleRect[] {
  if (!rectContains(r, p)) return [r];
  const dLeft = p.x - r.x;
  const dRight = r.x + r.w - p.x;
  const dTop = p.y - r.y;
  const dBottom = r.y + r.h - p.y;
  let d: EscapeDir;
  if (dir) {
    d = dir;
  } else {
    const min = Math.min(dLeft, dRight, dTop, dBottom);
    d = min === dBottom ? 'down' : min === dTop ? 'up' : min === dRight ? 'right' : 'left';
  }
  const C = ROUTE_MARGIN; // corridor half-width
  const out: ObstacleRect[] = [];
  const push = (x: number, y: number, w: number, h: number) => {
    if (w > 1 && h > 1) out.push({ x, y, w, h });
  };
  // Side blocks OVERLAP the endpoint's row/column by 1px: segment-vs-rect
  // hits are strict, so without the overlap the endpoint's row is a free
  // seam between the far block and the side bands and the route rides it
  // straight across the body.
  if (d === 'down' || d === 'up') {
    // Vertical corridor at p.x, opening toward the chosen horizontal edge.
    const corridorY = (d === 'down' ? p.y : r.y) - (d === 'down' ? 1 : 0);
    const corridorEnd = d === 'down' ? r.y + r.h : p.y + 1;
    // Everything on the OTHER side of the endpoint stays fully blocked.
    if (d === 'down') push(r.x, r.y, r.w, dTop);
    else push(r.x, p.y, r.w, dBottom);
    // Beside the corridor, still blocked.
    push(r.x, corridorY, p.x - C - r.x, corridorEnd - corridorY);
    push(p.x + C, corridorY, r.x + r.w - (p.x + C), corridorEnd - corridorY);
  } else {
    // Horizontal corridor at p.y, opening toward the chosen vertical edge.
    const corridorX = (d === 'right' ? p.x : r.x) - (d === 'right' ? 1 : 0);
    const corridorEnd = d === 'right' ? r.x + r.w : p.x + 1;
    if (d === 'right') push(r.x, r.y, dLeft, r.h);
    else push(p.x, r.y, dRight, r.h);
    push(corridorX, r.y, corridorEnd - corridorX, p.y - C - r.y);
    push(corridorX, p.y + C, corridorEnd - corridorX, r.y + r.h - (p.y + C));
  }
  return out;
}

/**
 * Axis-aligned segment vs rect overlap. Touching an edge exactly does not
 * count as a hit, so routes may run along the inflated boundary.
 */
function segmentHitsRect(a: Point, b: Point, r: ObstacleRect): boolean {
  if (a.y === b.y) {
    // Horizontal
    if (!(a.y > r.y && a.y < r.y + r.h)) return false;
    return Math.max(a.x, b.x) > r.x && Math.min(a.x, b.x) < r.x + r.w;
  }
  if (a.x === b.x) {
    // Vertical
    if (!(a.x > r.x && a.x < r.x + r.w)) return false;
    return Math.max(a.y, b.y) > r.y && Math.min(a.y, b.y) < r.y + r.h;
  }
  // Non-orthogonal segments never occur in routed paths
  return false;
}

function pathClear(pts: Point[], rects: ObstacleRect[]): boolean {
  for (let i = 1; i < pts.length; i++) {
    for (const r of rects) {
      if (segmentHitsRect(pts[i - 1], pts[i], r)) return false;
    }
  }
  return true;
}

/** 1D interval overlap length (0 when disjoint). */
function overlap1d(a1: number, a2: number, b1: number, b2: number): number {
  const lo = Math.max(Math.min(a1, a2), Math.min(b1, b2));
  const hi = Math.min(Math.max(a1, a2), Math.max(b1, b2));
  return Math.max(0, hi - lo);
}

/**
 * Soft cost of one candidate edge against the existing wire segments:
 * parallel proximity (< WIRE_SEPARATION) is charged per overlapping px,
 * perpendicular crossings a small fixed amount. Both endpoints of the
 * candidate edge are axis-aligned by construction.
 */
function wireCostOfEdge(a: Point, b: Point, segs: WireSegment[]): number {
  let cost = 0;
  const horizontal = a.y === b.y;
  for (const s of segs) {
    const sHorizontal = s.a.y === s.b.y;
    if (horizontal === sHorizontal) {
      // Parallel: charge when running inside the separation corridor.
      const gap = horizontal ? Math.abs(a.y - s.a.y) : Math.abs(a.x - s.a.x);
      if (gap < WIRE_SEPARATION) {
        const len = horizontal
          ? overlap1d(a.x, b.x, s.a.x, s.b.x)
          : overlap1d(a.y, b.y, s.a.y, s.b.y);
        cost += OVERLAP_PENALTY_PER_PX * len;
      }
    } else {
      // Perpendicular: charge each strict crossing.
      const h = horizontal ? { a, b } : { a: s.a, b: s.b };
      const v = horizontal ? { a: s.a, b: s.b } : { a, b };
      const crosses =
        v.a.x > Math.min(h.a.x, h.b.x) &&
        v.a.x < Math.max(h.a.x, h.b.x) &&
        h.a.y > Math.min(v.a.y, v.b.y) &&
        h.a.y < Math.max(v.a.y, v.b.y);
      if (crosses) cost += CROSS_PENALTY;
    }
  }
  return cost;
}

function pathWireCost(pts: Point[], segs: WireSegment[]): number {
  let cost = 0;
  for (let i = 1; i < pts.length; i++) cost += wireCostOfEdge(pts[i - 1], pts[i], segs);
  return cost;
}

/** Minimal binary min-heap keyed on `f`. */
class Heap {
  private a: { f: number; s: number }[] = [];
  get size() {
    return this.a.length;
  }
  push(f: number, s: number) {
    const a = this.a;
    a.push({ f, s });
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].f <= a[i].f) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop(): { f: number; s: number } {
    const a = this.a;
    const top = a[0];
    const last = a.pop()!;
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l].f < a[m].f) m = l;
        if (r < a.length && a[r].f < a[m].f) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

/**
 * Route from `start` to `end` avoiding `rawRects` (component bounding
 * boxes in world coordinates, uninflated).
 *
 * Returns the interior corner points of the route (ready to store as
 * waypoints), or null when the default direct elbow is already clear —
 * or when no clean route exists — so the caller falls back to the
 * existing preview-matching behavior.
 */
export function routeAroundObstacles(
  start: Point,
  end: Point,
  rawRects: ObstacleRect[],
  wireSegments: WireSegment[] = [],
): Point[] | null {
  // Rects that contain an endpoint can never be blocked whole (the wire
  // must leave the pin) — carve an escape corridor instead of dropping the
  // obstacle, so the rest of the body still repels the route. All rects
  // containing one endpoint carve in the SAME union-chosen direction, so
  // the corridors of overlapping rects chain into one continuous exit.
  const inflated = rawRects.map((r) => inflate(r, ROUTE_MARGIN));
  const startDir = unionEscapeDir(inflated, start);
  const endDir = unionEscapeDir(inflated, end);
  const rects = inflated
    .flatMap((r) => carveEscape(r, start, startDir))
    .flatMap((r) => carveEscape(r, end, endDir));

  // Wires participate only inside a window around the route, and never
  // when they share an endpoint with it (wires meeting on one pin must
  // touch there — charging for that would just distort every route).
  const winX0 = Math.min(start.x, end.x) - WIRE_WINDOW_MARGIN;
  const winX1 = Math.max(start.x, end.x) + WIRE_WINDOW_MARGIN;
  const winY0 = Math.min(start.y, end.y) - WIRE_WINDOW_MARGIN;
  const winY1 = Math.max(start.y, end.y) + WIRE_WINDOW_MARGIN;
  const near = (p: Point, q: Point) => Math.abs(p.x - q.x) < 1 && Math.abs(p.y - q.y) < 1;
  const segs = wireSegments.filter((s) => {
    if (near(s.a, start) || near(s.b, start) || near(s.a, end) || near(s.b, end)) return false;
    const sx0 = Math.min(s.a.x, s.b.x);
    const sx1 = Math.max(s.a.x, s.b.x);
    const sy0 = Math.min(s.a.y, s.b.y);
    const sy1 = Math.max(s.a.y, s.b.y);
    return sx1 >= winX0 && sx0 <= winX1 && sy1 >= winY0 && sy0 <= winY1;
  });

  if (rects.length === 0 && segs.length === 0) return null;

  // Preferred direct route: the same elbow the live preview drew. Only
  // accepted early when it is BOTH obstacle-clear and wire-cost-free.
  const elbow = previewElbow(start, end.x, end.y);
  const direct = elbow ? [start, elbow, end] : [start, end];
  if (pathClear(direct, rects) && pathWireCost(direct, segs) === 0) return null;

  // The other elbow orientation costs nothing extra — try it before A*.
  if (elbow) {
    const alt = elbow.x === end.x ? { x: start.x, y: end.y } : { x: end.x, y: start.y };
    const altPath = [start, alt, end];
    if (pathClear(altPath, rects) && pathWireCost(altPath, segs) === 0) return [alt];
  }

  // ── A* over the compressed grid ─────────────────────────────────────
  const xsSet = new Set<number>([start.x, end.x]);
  const ysSet = new Set<number>([start.y, end.y]);
  for (const r of rects) {
    xsSet.add(r.x);
    xsSet.add(r.x + r.w);
    ysSet.add(r.y);
    ysSet.add(r.y + r.h);
  }
  // Corridor lanes beside each wire segment, so the router can run NEXT TO
  // a wire instead of on it. Without these coordinates the compressed grid
  // simply has no lane there to choose.
  for (const s of segs) {
    if (s.a.y === s.b.y) {
      ysSet.add(s.a.y - WIRE_SEPARATION);
      ysSet.add(s.a.y + WIRE_SEPARATION);
    } else {
      xsSet.add(s.a.x - WIRE_SEPARATION);
      xsSet.add(s.a.x + WIRE_SEPARATION);
    }
  }
  const xs = [...xsSet].sort((a, b) => a - b);
  const ys = [...ysSet].sort((a, b) => a - b);
  if (xs.length > MAX_COORDS_PER_AXIS || ys.length > MAX_COORDS_PER_AXIS) return null;

  const cols = xs.length;
  const rows = ys.length;
  const xi = new Map(xs.map((v, i) => [v, i]));
  const yi = new Map(ys.map((v, i) => [v, i]));

  // State = (grid node, incoming direction). Directions: 0 none, 1 horizontal, 2 vertical.
  const nodeId = (cx: number, cy: number, dir: number) => (cy * cols + cx) * 3 + dir;
  const startCx = xi.get(start.x)!;
  const startCy = yi.get(start.y)!;
  const endCx = xi.get(end.x)!;
  const endCy = yi.get(end.y)!;

  const dist = new Map<number, number>();
  const prev = new Map<number, number>();
  const h = (cx: number, cy: number) =>
    Math.abs(xs[cx] - end.x) + Math.abs(ys[cy] - end.y);

  const heap = new Heap();
  const s0 = nodeId(startCx, startCy, 0);
  dist.set(s0, 0);
  heap.push(h(startCx, startCy), s0);

  const stepClear = (a: Point, b: Point) => rects.every((r) => !segmentHitsRect(a, b, r));

  let goal = -1;
  let expansions = 0;
  while (heap.size) {
    if (++expansions > MAX_EXPANSIONS) return null;
    const { s } = heap.pop();
    const dir = s % 3;
    const node = (s - dir) / 3;
    const cx = node % cols;
    const cy = (node - cx) / cols;
    const d = dist.get(s)!;
    if (cx === endCx && cy === endCy) {
      goal = s;
      break;
    }
    const neighbors: Array<[number, number, number]> = [
      [cx - 1, cy, 1],
      [cx + 1, cy, 1],
      [cx, cy - 1, 2],
      [cx, cy + 1, 2],
    ];
    for (const [nx, ny, ndir] of neighbors) {
      if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
      const a = { x: xs[cx], y: ys[cy] };
      const b = { x: xs[nx], y: ys[ny] };
      if (!stepClear(a, b)) continue;
      const bend = dir !== 0 && dir !== ndir ? BEND_PENALTY : 0;
      const nd =
        d + Math.abs(b.x - a.x) + Math.abs(b.y - a.y) + bend + wireCostOfEdge(a, b, segs);
      const ns = nodeId(nx, ny, ndir);
      if (nd < (dist.get(ns) ?? Infinity)) {
        dist.set(ns, nd);
        prev.set(ns, s);
        heap.push(nd + h(nx, ny), ns);
      }
    }
  }
  if (goal < 0) return null;

  // Reconstruct, simplify, return interior corners only.
  const pts: Point[] = [];
  for (let s: number | undefined = goal; s !== undefined; s = prev.get(s)) {
    const dir = s % 3;
    const node = (s - dir) / 3;
    const cx = node % cols;
    pts.push({ x: xs[cx], y: ys[(node - cx) / cols] });
  }
  pts.reverse();
  const simplified = simplifyOrthogonalPath(pts);
  return simplified.slice(1, -1);
}

/**
 * Bounding boxes of every component except the wire's own endpoints,
 * measured from the rendered DOM (store coordinates + element size).
 * Boards are deliberately NOT obstacles: pins live on both board edges
 * and detouring around a board produces absurd routes. Returns [] in
 * non-DOM environments (tests) and for unmounted components.
 */
export function collectComponentObstacles(
  components: Array<{ id: string; x: number; y: number }>,
  excludeIds: Array<string | undefined>,
): ObstacleRect[] {
  const skip = new Set(excludeIds.filter(Boolean));
  return collectComponentRects(components)
    .filter((r) => !skip.has(r.id))
    .map((r) => r.rect);
}

/**
 * Same measurement as collectComponentObstacles but keeping the component
 * id, so a caller routing MANY wires can measure the DOM once and filter
 * each wire's endpoint components in memory instead of re-querying.
 */
export function collectComponentRects(
  components: Array<{ id: string; x: number; y: number }>,
): Array<{ id: string; rect: ObstacleRect }> {
  if (typeof document === 'undefined') return [];
  const out: Array<{ id: string; rect: ObstacleRect }> = [];
  for (const c of components) {
    const esc = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(c.id) : c.id;
    const el = document.querySelector(
      `.dynamic-component-wrapper[data-component-id="${esc}"]`,
    ) as HTMLElement | null;
    if (!el) continue;
    const w = el.offsetWidth;
    const hh = el.offsetHeight;
    if (!w || !hh) continue;
    out.push({ id: c.id, rect: { x: c.x, y: c.y, w, h: hh } });
  }
  return out;
}

/**
 * Every rendered segment of the given wires, as axis-aligned obstacles for
 * the router. Skips invisible breadboard seating wires (`bb`) and the wire
 * being routed itself. Uses the same expansion the renderer uses, so the
 * costs see exactly what the user sees.
 */
export function collectWireSegments(
  wires: Array<{
    id: string;
    bb?: boolean;
    start: Point;
    end: Point;
    waypoints?: Point[];
  }>,
  excludeWireId?: string,
): WireSegment[] {
  const segs: WireSegment[] = [];
  for (const w of wires) {
    if (w.bb || w.id === excludeWireId) continue;
    const pts = simplifyOrthogonalPath(
      expandOrthogonalPoints([
        { x: w.start.x, y: w.start.y },
        ...(w.waypoints ?? []),
        { x: w.end.x, y: w.end.y },
      ]),
    );
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      if (a.x === b.x || a.y === b.y) segs.push({ a, b });
    }
  }
  return segs;
}
