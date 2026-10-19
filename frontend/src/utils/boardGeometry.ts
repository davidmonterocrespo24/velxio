/**
 * Board geometry on the canvas: footprint size, rotation, and the rotated
 * bounding box.
 *
 * A board keeps (x, y) as the top-left of its UNROTATED footprint and turns
 * about the footprint's centre, the same convention components use (their
 * wrapper rotates about `center center`). Every consumer that turns a board
 * pin into canvas coordinates rotates (x + pin.x, y + pin.y) about that
 * centre — see calculatePinPosition's pivotBox and PinOverlay's pivotBox.
 */
import { getProBoard } from '../lib/proBoardRegistry';

// Board visual dimensions (width × height) for the drag-overlay sizing.
// ESP32 sizes match the wokwi-boards SVG rendered at 5 px/mm.
export const BOARD_SIZE: Record<string, { w: number; h: number }> = {
  // wokwi-elements: rendered at 96 dpi — 1mm = 3.7795px
  'arduino-uno': { w: 274, h: 202 }, // 72.58mm × 53.34mm
  'arduino-nano': { w: 170, h: 67 }, // 44.9mm  × 17.8mm
  'arduino-mega': { w: 388, h: 192 }, // 102.66mm × 50.80mm
  // Pi Pico physical board is 51mm × 21mm vertical-narrow. The render
  // uses velxio's <velxio-pi-pico-w>, same Web Component as 'pi-pico-w'
  // because the Pico and Pico W are pin-compatible. Used to render the
  // wokwi-nano-rp2040-connect (168×68) — that was a completely different
  // board with D2-D13 pin labels, so wires in pico examples that
  // referenced GP10/GP18/etc. landed at (0,0). The render now matches
  // the boardKind name.
  'raspberry-pi-pico': { w: 105, h: 264 },
  // Zero/1/2 render through the Pi-3 element (same 40-pin header art); the
  // backend picks their QEMU CPU/memory profile from the boardKind.
  'raspberry-pi-zero': { w: 250, h: 160 },
  'raspberry-pi-1': { w: 250, h: 160 },
  'raspberry-pi-2': { w: 250, h: 160 },
  'raspberry-pi-3': { w: 250, h: 160 }, // RaspberryPi3Element: PI_WIDTH=250 PI_HEIGHT=160
  'raspberry-pi-4': { w: 330, h: 215 }, // RaspberryPi4Element — real board photo (925×602 @ scale)
  'raspberry-pi-5': { w: 330, h: 220 }, // RaspberryPi5Element — real board photo (1024×681 @ scale)
  esp32: { w: 141, h: 265 }, // esp32-devkit-v1: 28.2 × 53 mm
  'esp32-s3': { w: 128, h: 350 }, // esp32-s3-devkitc-1: 25.5 × 70 mm
  'esp32-c3': { w: 127, h: 215 }, // esp32-c3-devkitm-1: 25.4 × 42.9 mm
  'pi-pico-w': { w: 105, h: 264 },
  'esp32-devkit-c-v4': { w: 140, h: 283 },
  'esp32-cam': { w: 136, h: 202 },
  'wemos-lolin32-lite': { w: 128, h: 250 },
  'xiao-esp32-s3': { w: 91, h: 117 },
  'arduino-nano-esp32': { w: 217, h: 90 },
  'xiao-esp32-c3': { w: 91, h: 117 },
  'aitewinrobot-esp32c3-supermini': { w: 90, h: 123 },
  'stm32-bluepill': { w: 114, h: 271 }, // 22.855 × 54.193 mm (wokwi-boards SVG)
  'stm32-blackpill': { w: 103, h: 266 }, // 20.695 × 53.125 mm (wokwi-boards SVG)
  'stm32-bluepill-f103cb': { w: 114, h: 271 }, // reuses Blue Pill SVG
  'stm32-blackpill-f401': { w: 103, h: 266 }, // reuses Black Pill SVG
  // Inline-rendered boards — sizes match Stm32BoardElement.inlineConfig()
  // (INLINE_W=158; h = 24 + rows*13 + 16).
  'stm32-f4-discovery': { w: 158, h: 235 }, // 15 rows per side
  'stm32-olimex-h405': { w: 158, h: 196 }, // 12 rows per side
  'stm32-netduino-plus2': { w: 158, h: 196 }, // 12 rows per side
  'stm32-netduino2': { w: 158, h: 196 }, // 12 rows per side
  attiny85: { w: 160, h: 132 },
};


const DEFAULT_SIZE = { w: 300, h: 200 };

/** Unrotated footprint of a board kind. */
export function boardSize(boardKind: string): { w: number; h: number } {
  return BOARD_SIZE[boardKind] ?? getProBoard(boardKind)?.size ?? DEFAULT_SIZE;
}

/** Rotation normalised to 0 / 90 / 180 / 270. */
export function normalizeRotation(rotation: unknown): number {
  const r = Math.round((Number(rotation) || 0) / 90) * 90;
  return ((r % 360) + 360) % 360;
}

/** Canvas-space bounding box of a (possibly rotated) board. */
export function boardBox(board: {
  boardKind: string;
  x: number;
  y: number;
  rotation?: number;
}): { left: number; top: number; w: number; h: number } {
  const size = boardSize(board.boardKind);
  const quarter = normalizeRotation(board.rotation) % 180 !== 0;
  const w = quarter ? size.h : size.w;
  const h = quarter ? size.w : size.h;
  const cx = board.x + size.w / 2;
  const cy = board.y + size.h / 2;
  return { left: cx - w / 2, top: cy - h / 2, w, h };
}
