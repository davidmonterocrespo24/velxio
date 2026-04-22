/**
 * Wire Segment Utilities
 *
 * Handles computation and manipulation of wire segments for interactive editing.
 * Segments are the straight horizontal/vertical lines between path points.
 */

import type { Wire, WireControlPoint } from '../types/wire';

export interface WireSegment {
  id: string;
  startPoint: { x: number; y: number };
  endPoint: { x: number; y: number };
  orientation: 'horizontal' | 'vertical';
  midPoint: { x: number; y: number };
  length: number;
  startIndex: number; // Index in orthoPoints array
  endIndex: number; // Index in orthoPoints array
}

/**
 * Get all path points (start + control points + end)
 */
export function getPathPoints(wire: Wire): Array<{ x: number; y: number }> {
  const points: Array<{ x: number; y: number }> = [];

  points.push({ x: wire.start.x, y: wire.start.y });

  for (const cp of wire.controlPoints) {
    points.push({ x: cp.x, y: cp.y });
  }

  points.push({ x: wire.end.x, y: wire.end.y });

  return points;
}

/**
 * Generate orthogonal path points from control points
 * Converts diagonal connections to L-shapes (horizontal then vertical or vice versa)
 */
export function generateOrthogonalPoints(
  points: Array<{ x: number; y: number }>,
): Array<{ x: number; y: number }> {
  const result: Array<{ x: number; y: number }> = [];

  for (let i = 0; i < points.length - 1; i++) {
    const current = points[i];
    const next = points[i + 1];

    result.push(current);

    // If points are not aligned, add intermediate point
    if (current.x !== next.x && current.y !== next.y) {
      const dx = Math.abs(next.x - current.x);
      const dy = Math.abs(next.y - current.y);

      if (dx > dy) {
        // Go horizontal first
        result.push({ x: next.x, y: current.y });
      } else {
        // Go vertical first
        result.push({ x: current.x, y: next.y });
      }
    }
  }

  result.push(points[points.length - 1]);

  return result;
}

/**
 * Compute all segments from a wire
 */
export function computeSegments(wire: Wire): WireSegment[] {
  const pathPoints = getPathPoints(wire);
  const orthoPoints = generateOrthogonalPoints(pathPoints);
  const segments: WireSegment[] = [];

  for (let i = 0; i < orthoPoints.length - 1; i++) {
    const start = orthoPoints[i];
    const end = orthoPoints[i + 1];

    // Skip zero-length segments
    if (start.x === end.x && start.y === end.y) continue;

    const orientation = start.y === end.y ? 'horizontal' : 'vertical';
    const length =
      orientation === 'horizontal' ? Math.abs(end.x - start.x) : Math.abs(end.y - start.y);

    segments.push({
      id: `${wire.id}-seg-${i}`,
      startPoint: start,
      endPoint: end,
      orientation,
      midPoint: {
        x: (start.x + end.x) / 2,
        y: (start.y + end.y) / 2,
      },
      length,
      startIndex: i,
      endIndex: i + 1,
    });
  }

  return segments;
}

/**
 * Find which segment is under the cursor
 */
export function findSegmentUnderCursor(
  segments: WireSegment[],
  mouseX: number,
  mouseY: number,
  threshold: number = 8, // 8px tolerance
): WireSegment | null {
  for (const segment of segments) {
    if (segment.orientation === 'horizontal') {
      const minX = Math.min(segment.startPoint.x, segment.endPoint.x);
      const maxX = Math.max(segment.startPoint.x, segment.endPoint.x);
      const lineY = segment.startPoint.y;

      if (mouseX >= minX && mouseX <= maxX && Math.abs(mouseY - lineY) <= threshold) {
        return segment;
      }
    } else {
      const minY = Math.min(segment.startPoint.y, segment.endPoint.y);
      const maxY = Math.max(segment.startPoint.y, segment.endPoint.y);
      const lineX = segment.startPoint.x;

      if (mouseY >= minY && mouseY <= maxY && Math.abs(mouseX - lineX) <= threshold) {
        return segment;
      }
    }
  }

  return null;
}

/**
 * Update orthogonal points when dragging a segment
 */
export function updateOrthogonalPointsForSegmentDrag(
  orthoPoints: Array<{ x: number; y: number }>,
  segment: WireSegment,
  offset: number,
): Array<{ x: number; y: number }> {
  const newPoints = orthoPoints.map((p) => ({ ...p }));
  const { startIndex, endIndex, orientation } = segment;

  const newStart = { ...newPoints[startIndex] };
  const newEnd = { ...newPoints[endIndex] };

  if (orientation === 'horizontal') {
    newStart.y += offset;
    newEnd.y += offset;
  } else {
    newStart.x += offset;
    newEnd.x += offset;
  }

  const resultPoints: Array<{ x: number; y: number }> = [];

  // Add points before the dragged segment
  for (let i = 0; i < startIndex; i++) {
    resultPoints.push(newPoints[i]);
  }

  // If dragging the first segment, inject the original start pin to act as a stub anchor
  if (startIndex === 0 && offset !== 0) {
    resultPoints.push({ ...newPoints[0] });
  }

  // Add the dragged segment's end points
  resultPoints.push(newStart);
  resultPoints.push(newEnd);

  // If dragging the last segment, inject the original end pin to act as a stub anchor
  if (endIndex === newPoints.length - 1 && offset !== 0) {
    resultPoints.push({ ...newPoints[newPoints.length - 1] });
  }

  // Add points after the dragged segment
  for (let i = endIndex + 1; i < newPoints.length; i++) {
    resultPoints.push(newPoints[i]);
  }

  return resultPoints;
}

/**
 * Convert orthogonal points back to control points
 * Removes start/end points and intermediate points that are redundant
 *
 * IMPORTANT: The first and last orthoPoints should match the wire endpoints.
 * We preserve ALL intermediate points that represent corners (direction changes).
 */
export function orthogonalPointsToControlPoints(
  orthoPoints: Array<{ x: number; y: number }>,
  _start: { x: number; y: number },
  _end: { x: number; y: number },
): WireControlPoint[] {
  if (orthoPoints.length < 2) {
    return [];
  }

  // Remove first and last points (those are start/end endpoints)
  const innerPoints = orthoPoints.slice(1, -1);

  if (innerPoints.length === 0) {
    return [];
  }

  // Keep only corner points (where direction changes)
  const controlPoints: WireControlPoint[] = [];

  for (let i = 0; i < innerPoints.length; i++) {
    const current = innerPoints[i];
    // Get prev from orthoPoints (index i in innerPoints = index i+1 in orthoPoints)
    const prev = orthoPoints[i]; // Previous point in orthoPoints
    const next = orthoPoints[i + 2]; // Next point in orthoPoints

    // Check if current point is a corner (changes direction)
    // We use a cross product check to tolerate slight non-90-degree angles during drag
    const dx1 = current.x - prev.x;
    const dy1 = current.y - prev.y;
    const dx2 = next.x - current.x;
    const dy2 = next.y - current.y;

    // Cross product magnitude. If > 0.1, the path bends here.
    const isCorner = Math.abs(dx1 * dy2 - dy1 * dx2) > 0.1;

    if (isCorner) {
      controlPoints.push({
        id: `cp-${Date.now()}-${i}`,
        x: current.x,
        y: current.y,
      });
    }
  }

  return controlPoints;
}
