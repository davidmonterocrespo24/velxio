/**
 * Wire utilities: path generation, auto-coloring, keyboard color shortcuts.
 * Implements Wokwi-style orthogonal wire routing.
 */

/** Keyboard shortcut → hex color (matches Wokwi's color palette) */
export const WIRE_KEY_COLORS: Record<string, string> = {
  '0': '#000000', // Black
  '1': '#8B4513', // Brown
  '2': '#cc0000', // Red
  '3': '#FF8C00', // Orange
  '4': '#FFD700', // Gold
  '5': '#22c55e', // Green
  '6': '#0000cc', // Blue
  '7': '#8B00FF', // Violet
  '8': '#808080', // Gray
  '9': '#FFFFFF', // White
  c: '#00FFFF', // Cyan
  l: '#32CD32', // Limegreen
  m: '#FF00FF', // Magenta
  p: '#800080', // Purple
  y: '#FFFF00', // Yellow
};

/** Default wire color when no specific signal is detected */
export const DEFAULT_WIRE_COLOR = '#22c55e';

/**
 * Automatically determine wire color from the starting pin name.
 * GND → black, VCC/5V/3.3V/VBUS/VIN → red, everything else → green.
 */
export function autoWireColor(pinName: string): string {
  const lower = pinName.toLowerCase();
  if (lower.includes('gnd') || lower === 'ground' || lower === '-' || lower.startsWith('gnd')) {
    return '#000000';
  }
  if (
    lower.includes('vcc') ||
    lower.includes('5v') ||
    lower.includes('3.3v') ||
    lower.includes('3v3') ||
    lower.includes('vbus') ||
    lower.includes('vin') ||
    lower === 'power' ||
    lower === '+' ||
    lower.startsWith('vcc') ||
    lower.startsWith('v+')
  ) {
    return '#cc0000';
  }
  return DEFAULT_WIRE_COLOR;
}

interface Point {
  x: number;
  y: number;
}

/**
 * Generate an orthogonal SVG path through a sequence of points.
 * Between each pair of consecutive points, an L-shape is drawn:
 * - Go horizontal to the next point's X, then vertical to its Y.
 * This matches Wokwi's routing style.
 */
export function generateOrthogonalPath(
  start: Point,
  waypoints: Point[] | undefined,
  end: Point,
): string {
  const points: Point[] = [start, ...(waypoints ?? []), end];
  if (points.length < 2) return '';

  let d = `M ${points[0].x} ${points[0].y}`;

  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const curr = points[i];
    const dx = curr.x - prev.x;
    const dy = curr.y - prev.y;

    if (dx === 0 || dy === 0) {
      // Already axis-aligned: straight line
      d += ` L ${curr.x} ${curr.y}`;
    } else {
      // L-shape: go horizontal first, then vertical
      d += ` L ${curr.x} ${prev.y} L ${curr.x} ${curr.y}`;
    }
  }

  return d;
}

/**
 * Same as generateOrthogonalPath but for live preview:
 * the last segment (to mouse cursor) adapts its elbow orientation
 * based on whether the horizontal or vertical distance is larger.
 */
export function generatePreviewPath(
  start: Point,
  waypoints: Point[],
  mouseX: number,
  mouseY: number,
): string {
  const fixed: Point[] = [start, ...waypoints];
  const last = fixed[fixed.length - 1];
  const mouse: Point = { x: mouseX, y: mouseY };

  const dx = Math.abs(mouseX - last.x);
  const dy = Math.abs(mouseY - last.y);

  // Choose elbow orientation based on distance: longer axis goes first
  let elbowX: number;
  let elbowY: number;
  if (dx >= dy) {
    // Horizontal-first
    elbowX = mouseX;
    elbowY = last.y;
  } else {
    // Vertical-first
    elbowX = last.x;
    elbowY = mouseY;
  }

  // Build the fixed segments
  let d = '';
  if (fixed.length >= 2) {
    d = generateOrthogonalPath(fixed[0], fixed.slice(1), fixed[fixed.length - 1]);
  } else {
    d = `M ${last.x} ${last.y}`;
  }

  // Append the live preview segment
  if (dx === 0 && dy === 0) return d;

  if (dx === 0 || dy === 0) {
    d += ` L ${mouse.x} ${mouse.y}`;
  } else {
    d += ` L ${elbowX} ${elbowY} L ${mouse.x} ${mouse.y}`;
  }

  return d;
}
