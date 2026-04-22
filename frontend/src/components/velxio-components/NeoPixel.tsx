/**
 * NeoPixel — WS2812 LED strip component.
 *
 * Receives pixel data from the ESP32 backend via `ws2812_update` events.
 * Each pixel is an RGB object { r, g, b } (0–255 each).
 *
 * For ESP32 boards, the canvas element must have id="ws2812-{boardId}-{channel}"
 * so the store can dispatch CustomEvents to it.
 *
 * Usage:
 *   <NeoPixel id="ws2812-esp32-0" count={8} x={100} y={200} />
 *
 * When no pixels have arrived yet the strip shows dimmed placeholder circles.
 */

import { useEffect, useRef, useState } from 'react';

export interface NeoPixelPixel {
  r: number;
  g: number;
  b: number;
}

interface NeoPixelProps {
  id?: string;
  /** Number of LEDs in the strip (used for layout when pixels array is empty) */
  count?: number;
  x?: number;
  y?: number;
  /** Layout direction */
  direction?: 'horizontal' | 'vertical';
  onPinClick?: (pinName: string) => void;
}

const LED_SIZE = 16;
const LED_GAP = 4;

function drawPixels(
  canvas: HTMLCanvasElement,
  pixels: NeoPixelPixel[],
  numLeds: number,
  direction: 'horizontal' | 'vertical',
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  for (let i = 0; i < numLeds; i++) {
    const px = pixels[i] ?? { r: 20, g: 20, b: 20 };
    const cx = direction === 'horizontal' ? LED_SIZE / 2 + i * (LED_SIZE + LED_GAP) : LED_SIZE / 2;
    const cy = direction === 'vertical' ? LED_SIZE / 2 + i * (LED_SIZE + LED_GAP) : LED_SIZE / 2;

    const r = LED_SIZE / 2;
    const gradient = ctx.createRadialGradient(cx, cy, 1, cx, cy, r);
    const color = `rgb(${px.r},${px.g},${px.b})`;
    gradient.addColorStop(0, color);
    gradient.addColorStop(1, 'rgba(0,0,0,0.6)');

    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = gradient;
    ctx.fill();

    ctx.strokeStyle = 'rgba(255,255,255,0.2)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}

export const NeoPixel = ({
  id,
  count = 8,
  x = 0,
  y = 0,
  direction = 'horizontal',
  onPinClick,
}: NeoPixelProps) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [pixels, setPixels] = useState<NeoPixelPixel[]>([]);
  const numLeds = Math.max(count, pixels.length);

  // Initial draw (placeholder)
  useEffect(() => {
    if (canvasRef.current) {
      drawPixels(canvasRef.current, pixels, numLeds, direction);
    }
  }, [pixels, numLeds, direction]);

  // Listen for ws2812-pixels CustomEvents dispatched by useSimulatorStore
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !id) return;
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ pixels: NeoPixelPixel[] }>).detail;
      setPixels(detail.pixels);
    };
    canvas.addEventListener('ws2812-pixels', handler);
    return () => canvas.removeEventListener('ws2812-pixels', handler);
  }, [id]);

  const w = direction === 'horizontal' ? numLeds * (LED_SIZE + LED_GAP) - LED_GAP : LED_SIZE;
  const h = direction === 'vertical' ? numLeds * (LED_SIZE + LED_GAP) - LED_GAP : LED_SIZE;

  return (
    <canvas
      id={id}
      ref={canvasRef}
      width={w}
      height={h}
      style={{
        position: 'absolute',
        left: `${x}px`,
        top: `${y}px`,
        cursor: onPinClick ? 'pointer' : 'default',
        borderRadius: '4px',
        background: '#111',
      }}
      onClick={() => onPinClick?.('DIN')}
      title="WS2812 NeoPixel Strip"
    />
  );
};
