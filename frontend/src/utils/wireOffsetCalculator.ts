/**
 * Wire Offset Calculator
 *
 * Automatically calculates visual offsets for overlapping wires to prevent
 * them from rendering on top of each other (similar to Fritzing/TinkerCAD).
 *
 * Algorithm:
 * 1. Detect wire segments that are parallel and overlapping
 * 2. Group overlapping segments
 * 3. Apply perpendicular offset to each wire in the group
 * 4. Distribute offsets evenly around the center line
 */

import type { Wire } from '../types/wire';

export const WIRE_SPACING = 6; // Pixels between parallel wires
const OVERLAP_TOLERANCE = 5; // Pixels tolerance for considering wires as overlapping

/**
 * Represents a wire segment (portion of a wire between two bends)
 */
interface WireSegment {
  wireId: string;
  isVertical: boolean;
  start: { x: number; y: number };
  end: { x: number; y: number };
  centerLine: number; // X position for vertical, Y position for horizontal
}

/**
 * Group of overlapping wire segments
 */
interface SegmentGroup {
  segments: WireSegment[];
  isVertical: boolean;
  centerLine: number;
  overlapStart: number; // Start of overlapping region
  overlapEnd: number;   // End of overlapping region
}

/**
 * Extract all segments from a wire's path
 */
function extractSegments(wire: Wire): WireSegment[] {
  const segments: WireSegment[] = [];

  // Start point
  let currentPoint = { x: wire.start.x, y: wire.start.y };

  // Add segments through control points
  if (wire.controlPoints && wire.controlPoints.length > 0) {
    for (const controlPoint of wire.controlPoints) {
      const nextPoint = { x: controlPoint.x, y: controlPoint.y };

      // Determine if segment is vertical or horizontal
      const isVertical = Math.abs(nextPoint.x - currentPoint.x) < Math.abs(nextPoint.y - currentPoint.y);
      const centerLine = isVertical ? currentPoint.x : currentPoint.y;

      segments.push({
        wireId: wire.id,
        isVertical,
        start: { ...currentPoint },
        end: { ...nextPoint },
        centerLine,
      });

      currentPoint = nextPoint;
    }
  }

  // Final segment to end point
  const endPoint = { x: wire.end.x, y: wire.end.y };
  const isVertical = Math.abs(endPoint.x - currentPoint.x) < Math.abs(endPoint.y - currentPoint.y);
  const centerLine = isVertical ? currentPoint.x : currentPoint.y;

  segments.push({
    wireId: wire.id,
    isVertical,
    start: { ...currentPoint },
    end: { ...endPoint },
    centerLine,
  });

  return segments;
}

/**
 * Check if two segments overlap
 */
function segmentsOverlap(seg1: WireSegment, seg2: WireSegment): boolean {
  // Must be same orientation
  if (seg1.isVertical !== seg2.isVertical) return false;

  // Must be on similar center line (within tolerance)
  if (Math.abs(seg1.centerLine - seg2.centerLine) > OVERLAP_TOLERANCE) return false;

  // Check if ranges overlap
  if (seg1.isVertical) {
    // Vertical: check Y range overlap
    const seg1MinY = Math.min(seg1.start.y, seg1.end.y);
    const seg1MaxY = Math.max(seg1.start.y, seg1.end.y);
    const seg2MinY = Math.min(seg2.start.y, seg2.end.y);
    const seg2MaxY = Math.max(seg2.start.y, seg2.end.y);

    return !(seg1MaxY < seg2MinY || seg2MaxY < seg1MinY);
  } else {
    // Horizontal: check X range overlap
    const seg1MinX = Math.min(seg1.start.x, seg1.end.x);
    const seg1MaxX = Math.max(seg1.start.x, seg1.end.x);
    const seg2MinX = Math.min(seg2.start.x, seg2.end.x);
    const seg2MaxX = Math.max(seg2.start.x, seg2.end.x);

    return !(seg1MaxX < seg2MinX || seg2MaxX < seg1MinX);
  }
}

/**
 * Group overlapping segments
 */
function groupOverlappingSegments(segments: WireSegment[]): SegmentGroup[] {
  const groups: SegmentGroup[] = [];
  const processed = new Set<string>();

  for (let i = 0; i < segments.length; i++) {
    const seg1 = segments[i];
    const key1 = `${seg1.wireId}-${i}`;

    if (processed.has(key1)) continue;

    // Find all segments that overlap with seg1
    const group: WireSegment[] = [seg1];
    processed.add(key1);

    for (let j = i + 1; j < segments.length; j++) {
      const seg2 = segments[j];
      const key2 = `${seg2.wireId}-${j}`;

      if (processed.has(key2)) continue;

      // Check if seg2 overlaps with any segment in the current group
      if (group.some(seg => segmentsOverlap(seg, seg2))) {
        group.push(seg2);
        processed.add(key2);
      }
    }

    // Only create a group if there are at least 2 overlapping segments
    if (group.length > 1) {
      const isVertical = group[0].isVertical;
      const centerLine = group.reduce((sum, seg) => sum + seg.centerLine, 0) / group.length;

      // Calculate overlap region
      let overlapStart: number;
      let overlapEnd: number;

      if (isVertical) {
        overlapStart = Math.max(...group.map(seg => Math.min(seg.start.y, seg.end.y)));
        overlapEnd = Math.min(...group.map(seg => Math.max(seg.start.y, seg.end.y)));
      } else {
        overlapStart = Math.max(...group.map(seg => Math.min(seg.start.x, seg.end.x)));
        overlapEnd = Math.min(...group.map(seg => Math.max(seg.start.x, seg.end.x)));
      }

      groups.push({
        segments: group,
        isVertical,
        centerLine,
        overlapStart,
        overlapEnd,
      });
    }
  }

  return groups;
}

/**
 * Calculate offset for each wire based on overlapping groups
 */
export function calculateWireOffsets(wires: Wire[]): Map<string, number> {
  const offsets = new Map<string, number>();

  // Initialize all offsets to 0
  wires.forEach(wire => offsets.set(wire.id, 0));

  // Extract all segments from all wires
  const allSegments: WireSegment[] = [];
  wires.forEach(wire => {
    allSegments.push(...extractSegments(wire));
  });

  // Group overlapping segments
  const groups = groupOverlappingSegments(allSegments);

  // Calculate offsets for each group
  groups.forEach(group => {
    const numWires = group.segments.length;

    // Get unique wire IDs in this group
    const wireIds = [...new Set(group.segments.map(seg => seg.wireId))];

    // Calculate offset for each wire
    wireIds.forEach((wireId, index) => {
      // Distribute offsets symmetrically around center
      // For n wires: offsets are [-spacing*(n-1)/2, ..., 0, ..., +spacing*(n-1)/2]
      const offset = (index - (numWires - 1) / 2) * WIRE_SPACING;

      // Store the maximum absolute offset for this wire
      // (in case wire participates in multiple groups)
      const currentOffset = offsets.get(wireId) || 0;
      if (Math.abs(offset) > Math.abs(currentOffset)) {
        offsets.set(wireId, offset);
      }
    });
  });

  return offsets;
}

/**
 * Apply offset to wire points (perpendicular to wire direction).
 *
 * Instead of moving the endpoints (which would visually disconnect the wire from its
 * pins), we keep the true pin positions fixed and insert short stub segments that
 * travel from each pin to the offset path, forming an L-shaped attachment at both ends.
 *
 * Example (horizontal wire, offset = +6):
 *   Before:  pin ────────────────── pin
 *   After:   pin          (stub)
 *              │ ──────────────── │
 *                              (stub)  pin
 */
export function applyOffsetToWire(wire: Wire, offset: number): Wire {
  if (offset === 0) return wire;

  // Determine primary direction from the first segment of the path
  const firstControlOrEnd =
    wire.controlPoints && wire.controlPoints.length > 0
      ? wire.controlPoints[0]
      : wire.end;

  const isHorizontalFirst =
    Math.abs(firstControlOrEnd.x - wire.start.x) >=
    Math.abs(firstControlOrEnd.y - wire.start.y);

  // True pin positions (never moved)
  const pinStart = { x: wire.start.x, y: wire.start.y };
  const pinEnd   = { x: wire.end.x,   y: wire.end.y   };

  // Offset intermediate points perpendicular to the primary direction
  const shiftedControlPoints = (wire.controlPoints || []).map(cp => ({
    ...cp,
    x: isHorizontalFirst ? cp.x           : cp.x + offset,
    y: isHorizontalFirst ? cp.y + offset  : cp.y,
  }));

  // Compute where the offset path actually starts/ends
  // (the point on the parallel track immediately after the pin stub)
  const offsetStart = isHorizontalFirst
    ? { x: pinStart.x, y: pinStart.y + offset }
    : { x: pinStart.x + offset, y: pinStart.y };

  const offsetEnd = isHorizontalFirst
    ? { x: pinEnd.x, y: pinEnd.y + offset }
    : { x: pinEnd.x + offset, y: pinEnd.y };

  // Build new control points:
  //   stub from pinStart → offsetStart, then the shifted intermediates, then stub from offsetEnd → pinEnd
  // We only need to add extra stubs when they are non-zero length.
  const newControlPoints: typeof wire.controlPoints = [];

  // Leading stub end-point (where the offset path begins)
  if (offsetStart.x !== pinStart.x || offsetStart.y !== pinStart.y) {
    newControlPoints.push({ id: `${wire.id}-stub-s`, ...offsetStart });
  }

  // Shifted original control points
  for (const cp of shiftedControlPoints) {
    newControlPoints.push(cp);
  }

  // Trailing stub start-point (where the offset path rejoins the pin)
  if (offsetEnd.x !== pinEnd.x || offsetEnd.y !== pinEnd.y) {
    newControlPoints.push({ id: `${wire.id}-stub-e`, ...offsetEnd });
  }

  return {
    ...wire,
    start: { ...wire.start, x: pinStart.x, y: pinStart.y },
    end:   { ...wire.end,   x: pinEnd.x,   y: pinEnd.y   },
    controlPoints: newControlPoints,
  };
}
