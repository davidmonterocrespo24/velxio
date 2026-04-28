/**
 * Wire hit detection utilities.
 * Used by SimulatorCanvas to detect wire clicks/hover without relying on SVG pointer-events.
 */

import type { Wire } from '../types/wire';

export interface RenderedSegment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  axis: 'horizontal' | 'vertical';
  /** Index j: this segment was generated from stored[j] → stored[j+1] */
  storedPairIndex: number;
}

/**
 * Expand stored waypoints into the actual orthogonal (L-shape) rendered points.
 * Between each consecutive stored pair, a corner point is inserted if they are not axis-aligned.
 */
export function getRenderedPoints(wire: Wire): { x: number; y: number }[] {
  const stored = [
    { x: wire.start.x, y: wire.start.y },
    ...(wire.waypoints ?? []),
    { x: wire.end.x, y: wire.end.y },
  ];

  if (stored.length < 2) return stored;

  const result: { x: number; y: number }[] = [stored[0]];
  for (let i = 1; i < stored.length; i++) {
    const prev = stored[i - 1];
    const curr = stored[i];
    if (prev.x !== curr.x && prev.y !== curr.y) {
      // L-shape: horizontal-first corner
      result.push({ x: curr.x, y: prev.y });
    }
    result.push(curr);
  }
  return result;
}

/**
 * Get all rendered segments with their metadata (axis, storedPairIndex).
 */
export function getRenderedSegments(wire: Wire): RenderedSegment[] {
  const stored = [
    { x: wire.start.x, y: wire.start.y },
    ...(wire.waypoints ?? []),
    { x: wire.end.x, y: wire.end.y },
  ];

  const segments: RenderedSegment[] = [];
  let ri = 0;
  const rendered = getRenderedPoints(wire);

  for (let j = 0; j < stored.length - 1; j++) {
    const prev = stored[j];
    const curr = stored[j + 1];
    const hasCorner = prev.x !== curr.x && prev.y !== curr.y;
    const numSubs = hasCorner ? 2 : 1;

    for (let s = 0; s < numSubs; s++) {
      const p1 = rendered[ri + s];
      const p2 = rendered[ri + s + 1];
      if (!p1 || !p2) continue;
      segments.push({
        x1: p1.x,
        y1: p1.y,
        x2: p2.x,
        y2: p2.y,
        axis: p1.y === p2.y ? 'horizontal' : 'vertical',
        storedPairIndex: j,
      });
    }
    ri += numSubs;
  }
  return segments;
}

/** Distance from point (px, py) to line segment (x1,y1)-(x2,y2). */
export function distToSegment(
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - x1, py - y1);
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lenSq));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

/** Find the topmost wire within `threshold` world-units of (wx, wy). */
export function findWireNearPoint(
  wires: Wire[],
  wx: number,
  wy: number,
  threshold: number,
): Wire | null {
  for (let i = wires.length - 1; i >= 0; i--) {
    const wire = wires[i];
    const segments = getRenderedSegments(wire);
    for (const seg of segments) {
      if (distToSegment(wx, wy, seg.x1, seg.y1, seg.x2, seg.y2) <= threshold) {
        return wire;
      }
    }
  }
  return null;
}

/** Find the segment of a wire closest to (wx, wy) within threshold. */
export function findSegmentNearPoint(
  wire: Wire,
  wx: number,
  wy: number,
  threshold: number,
): RenderedSegment | null {
  const segments = getRenderedSegments(wire);
  for (const seg of segments) {
    if (distToSegment(wx, wy, seg.x1, seg.y1, seg.x2, seg.y2) <= threshold) {
      return seg;
    }
  }
  return null;
}

/**
 * Project a point onto an orthogonal segment, clamped to its extent.
 * Horizontal segment → keep segment's y, clamp x to its range.
 * Vertical segment   → keep segment's x, clamp y to its range.
 */
export function projectOntoSegment(
  seg: RenderedSegment,
  px: number,
  py: number,
): { x: number; y: number } {
  if (seg.axis === 'horizontal') {
    const minX = Math.min(seg.x1, seg.x2);
    const maxX = Math.max(seg.x1, seg.x2);
    return { x: Math.max(minX, Math.min(maxX, px)), y: seg.y1 };
  }
  const minY = Math.min(seg.y1, seg.y2);
  const maxY = Math.max(seg.y1, seg.y2);
  return { x: seg.x1, y: Math.max(minY, Math.min(maxY, py)) };
}

/**
 * Insert a new waypoint into a wire at the position corresponding to a clicked
 * segment. `storedPairIndex` identifies which stored[j] → stored[j+1] pair was
 * hit (where stored = [start, ...waypoints, end]). The new waypoint is placed
 * at index `storedPairIndex` in the waypoints array, projected onto the segment
 * so it stays orthogonal.
 */
export function insertWaypointAtSegment(
  waypoints: { x: number; y: number }[],
  seg: RenderedSegment,
  px: number,
  py: number,
): { x: number; y: number }[] {
  const projected = projectOntoSegment(seg, px, py);
  const idx = seg.storedPairIndex;
  return [...waypoints.slice(0, idx), projected, ...waypoints.slice(idx)];
}

/**
 * Collect every x and y coordinate that a dragged wire point should be able to
 * snap against — the endpoints and waypoints of all *other* wires.
 * The dragged wire is excluded so a point doesn't snap to its own neighbours,
 * which would prevent any movement.
 */
export function collectAlignmentTargets(
  wires: Wire[],
  excludeWireId: string | null,
): { xs: Set<number>; ys: Set<number> } {
  const xs = new Set<number>();
  const ys = new Set<number>();
  for (const w of wires) {
    if (w.id === excludeWireId) continue;
    xs.add(w.start.x);
    ys.add(w.start.y);
    xs.add(w.end.x);
    ys.add(w.end.y);
    for (const wp of w.waypoints ?? []) {
      xs.add(wp.x);
      ys.add(wp.y);
    }
  }
  return { xs, ys };
}

/**
 * Find the nearest candidate from `targets` to `value` within `threshold`.
 * Returns the snapped value and the candidate that triggered it, or null
 * if nothing is in range.
 */
export function snapToNearest(
  value: number,
  targets: Set<number>,
  threshold: number,
): { snapped: number; target: number } | null {
  let bestDist = threshold;
  let bestTarget: number | null = null;
  for (const t of targets) {
    const d = Math.abs(value - t);
    if (d <= bestDist) {
      bestDist = d;
      bestTarget = t;
    }
  }
  if (bestTarget === null) return null;
  return { snapped: bestTarget, target: bestTarget };
}

/**
 * Compute new waypoints array when dragging a segment.
 * Inserts a new waypoint between stored[j] and stored[j+1] at the drag position.
 */
export function computeDragWaypoints(
  originalWaypoints: { x: number; y: number }[],
  storedPairIndex: number,
  dragX: number,
  dragY: number,
): { x: number; y: number }[] {
  const newWp = { x: dragX, y: dragY };
  return [
    ...originalWaypoints.slice(0, storedPairIndex),
    newWp,
    ...originalWaypoints.slice(storedPairIndex),
  ];
}

/**
 * Move an entire rendered segment perpendicularly.
 * - horizontal segment → moves up/down (change Y of both endpoints)
 * - vertical segment → moves left/right (change X of both endpoints)
 * If the segment is the first or last, inserts connector points to keep
 * the wire connected to its fixed start/end.
 */
export function moveSegment(
  renderedPts: { x: number; y: number }[],
  segIndex: number,
  axis: 'horizontal' | 'vertical',
  newValue: number,
): { x: number; y: number }[] {
  const n = renderedPts.length;
  const numSegs = n - 1;
  const pts = renderedPts.map((p) => ({ ...p }));

  if (axis === 'horizontal') {
    if (segIndex === 0 && numSegs > 0) {
      // First segment: keep start fixed, insert connector
      pts.splice(1, 0, { x: pts[0].x, y: newValue }, { x: pts[1].x, y: newValue });
      pts.splice(3, 1); // remove original pts[1] copy
    } else if (segIndex === numSegs - 1 && numSegs > 0) {
      // Last segment: keep end fixed, insert connector
      const last = pts[n - 1];
      pts.splice(n - 1, 0, { x: pts[n - 2].x, y: newValue }, { x: last.x, y: newValue });
    } else {
      pts[segIndex].y = newValue;
      pts[segIndex + 1].y = newValue;
    }
  } else {
    // vertical
    if (segIndex === 0 && numSegs > 0) {
      pts.splice(1, 0, { x: newValue, y: pts[0].y }, { x: newValue, y: pts[1].y });
      pts.splice(3, 1);
    } else if (segIndex === numSegs - 1 && numSegs > 0) {
      const last = pts[n - 1];
      pts.splice(n - 1, 0, { x: newValue, y: pts[n - 2].y }, { x: newValue, y: last.y });
    } else {
      pts[segIndex].x = newValue;
      pts[segIndex + 1].x = newValue;
    }
  }

  return pts;
}

/**
 * Simplify an orthogonal path by removing duplicate points and collapsing
 * collinear/U-turn triples.
 *
 * Three consecutive points sharing the same x (or same y) make the middle
 * one redundant — whether the path goes straight through (collinear) or
 * doubles back over itself (U-turn). Dropping the middle point handles
 * both, which is what eliminates the visible overlapping bumps that
 * accumulate after segment drags.
 */
export function simplifyOrthogonalPath(
  pts: { x: number; y: number }[],
): { x: number; y: number }[] {
  if (pts.length <= 2) return pts.map((p) => ({ ...p }));

  // Drop consecutive duplicates first
  const dedup: { x: number; y: number }[] = [];
  for (const p of pts) {
    const last = dedup[dedup.length - 1];
    if (!last || last.x !== p.x || last.y !== p.y) dedup.push({ ...p });
  }

  // Iteratively collapse three-in-a-row on the same axis until stable
  let result = dedup;
  let changed = true;
  while (changed && result.length > 2) {
    changed = false;
    for (let i = 1; i < result.length - 1; i++) {
      const prev = result[i - 1];
      const curr = result[i];
      const next = result[i + 1];
      if ((prev.x === curr.x && curr.x === next.x) || (prev.y === curr.y && curr.y === next.y)) {
        result = [...result.slice(0, i), ...result.slice(i + 1)];
        changed = true;
        break;
      }
    }
  }

  return result;
}

/**
 * Convert a list of rendered (expanded) points back to wire waypoints.
 * Waypoints are the interior corner/bend points (excludes start and end).
 * The path is first simplified to drop collinear runs and U-turn bumps;
 * what remains is exactly the set of corners, so everything between the
 * first and last point becomes a waypoint.
 */
export function renderedToWaypoints(
  renderedPts: { x: number; y: number }[],
): { x: number; y: number }[] {
  const simplified = simplifyOrthogonalPath(renderedPts);
  if (simplified.length <= 2) return [];
  return simplified.slice(1, -1).map((p) => ({ x: p.x, y: p.y }));
}

/**
 * Build an SVG path string from an ordered list of rendered points (straight segments).
 */
export function renderedPointsToPath(pts: { x: number; y: number }[]): string {
  if (pts.length < 2) return '';
  return (
    `M ${pts[0].x} ${pts[0].y}` +
    pts
      .slice(1)
      .map((p) => ` L ${p.x} ${p.y}`)
      .join('')
  );
}
