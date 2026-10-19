// @vitest-environment jsdom
/**
 * The ESP32 board element draws its on-board LED(s) (issue #374).
 *
 * `velxio-esp32` used to be a static picture plus pin overlays: nothing in it
 * could light. It now carries one overlay per LED footprint and a
 * `onboardLeds` property the React wrapper sets, the way the Arduino
 * wrappers set `led13`. The footprints are keyed by the same LED ids as
 * BOARD_ONBOARD_LEDS, and the first block below holds the two tables in step:
 * an LED the board declares but the element cannot draw would be a dark LED
 * with no error anywhere, which is the bug this fixes.
 */
import { describe, it, expect } from 'vitest';
import '../components/velxio-components/Esp32Element';
import {
  esp32LedFootprintIds,
  ledVisualColor,
} from '../components/velxio-components/Esp32Element';
import { BOARD_ONBOARD_LEDS, type BoardKind, type BoardLedVisuals } from '../types/board';
import { BOARD_SIZE } from '../utils/boardGeometry';

const ESP32_KINDS: BoardKind[] = [
  'esp32',
  'esp32-devkit-c-v4',
  'esp32-cam',
  'wemos-lolin32-lite',
  'esp32-s3',
  'xiao-esp32-s3',
  'arduino-nano-esp32',
  'esp32-c3',
  'xiao-esp32-c3',
  'aitewinrobot-esp32c3-supermini',
];

type LedElement = HTMLElement & { onboardLeds?: BoardLedVisuals };

function mount(kind: BoardKind): LedElement {
  const el = document.createElement('velxio-esp32') as LedElement;
  el.setAttribute('board-kind', kind);
  document.body.appendChild(el);
  return el;
}

const dot = (el: HTMLElement, id: string) =>
  el.shadowRoot!.querySelector<HTMLElement>(`[data-onboard-led="${id}"]`);

describe('velxio-esp32: footprints match the board table', () => {
  it.each(ESP32_KINDS)('%s draws exactly the LEDs its row declares', (kind) => {
    const declared = BOARD_ONBOARD_LEDS[kind].map((l) => l.id).sort();
    expect(esp32LedFootprintIds(kind).sort()).toEqual(declared);
    const el = mount(kind);
    const drawn = Array.from(el.shadowRoot!.querySelectorAll<HTMLElement>('[data-onboard-led]'))
      .map((d) => d.dataset.onboardLed)
      .sort();
    expect(drawn).toEqual(declared);
  });

  it.each(ESP32_KINDS)('%s: every dot sits inside the board picture, dark until told otherwise', (kind) => {
    const { w, h } = BOARD_SIZE[kind];
    const el = mount(kind);
    for (const d of Array.from(el.shadowRoot!.querySelectorAll<HTMLElement>('[data-onboard-led]'))) {
      const left = parseFloat(d.style.left);
      const top = parseFloat(d.style.top);
      const size = parseFloat(d.style.width);
      expect(left).toBeGreaterThanOrEqual(0);
      expect(top).toBeGreaterThanOrEqual(0);
      expect(left + size).toBeLessThanOrEqual(w);
      expect(top + size).toBeLessThanOrEqual(h);
      expect(d.style.opacity).toBe('0');
    }
  });
});

describe('velxio-esp32: the onboardLeds property lights and darkens the dot', () => {
  it.each([
    ['esp32', 'led'],
    ['esp32-cam', 'led'],
    ['esp32-cam', 'flash'],
    ['wemos-lolin32-lite', 'led'],
    ['xiao-esp32-s3', 'led'],
    ['arduino-nano-esp32', 'led'],
    ['aitewinrobot-esp32c3-supermini', 'led'],
  ] as const)('%s / %s', (kind, id) => {
    const el = mount(kind);
    el.onboardLeds = { [id]: true };
    const d = dot(el, id)!;
    expect(d.style.opacity).toBe('1');
    expect(d.style.boxShadow).not.toBe('');
    expect(d.style.background).toContain('radial-gradient');
    el.onboardLeds = { [id]: false };
    expect(d.style.opacity).toBe('0');
    el.onboardLeds = undefined;
    expect(d.style.opacity).toBe('0');
  });

  it('esp32-cam: the two LEDs are independent', () => {
    const el = mount('esp32-cam');
    el.onboardLeds = { flash: true, led: false };
    expect(dot(el, 'flash')!.style.opacity).toBe('1');
    expect(dot(el, 'led')!.style.opacity).toBe('0');
    el.onboardLeds = { flash: false, led: true };
    expect(dot(el, 'flash')!.style.opacity).toBe('0');
    expect(dot(el, 'led')!.style.opacity).toBe('1');
  });

  it.each(['esp32-s3', 'esp32-c3', 'arduino-nano-esp32'] as const)(
    '%s: an RGB visual colours the dot, black darkens it',
    (kind) => {
      const el = mount(kind);
      el.onboardLeds = { rgb: { r: 64, g: 0, b: 0 } };
      const d = dot(el, 'rgb')!;
      expect(d.style.opacity).toBe('1');
      expect(d.style.background).toContain('rgb(255, 0, 0)');
      el.onboardLeds = { rgb: { r: 0, g: 0, b: 0 } };
      expect(d.style.opacity).toBe('0');
    },
  );

  it('an id the kind has no footprint for is ignored, and a kind without LEDs has no dot', () => {
    const el = mount('esp32');
    el.onboardLeds = { flash: true, rgb: { r: 255, g: 255, b: 255 } };
    expect(dot(el, 'led')!.style.opacity).toBe('0');
    const bare = mount('xiao-esp32-c3');
    bare.onboardLeds = { led: true };
    expect(bare.shadowRoot!.querySelector('[data-onboard-led]')).toBeNull();
  });

  it('a re-render on a board-kind change keeps the lit state', () => {
    const el = mount('esp32');
    el.onboardLeds = { led: true };
    el.setAttribute('board-kind', 'wemos-lolin32-lite');
    expect(dot(el, 'led')!.style.opacity).toBe('1');
  });

  it('the picker thumbnail (no property ever set) shows every LED dark', () => {
    const el = mount('esp32-cam');
    for (const d of Array.from(el.shadowRoot!.querySelectorAll<HTMLElement>('[data-onboard-led]'))) {
      expect(d.style.opacity).toBe('0');
    }
  });
});

describe('ledVisualColor', () => {
  it('a single-colour LED lights in its own colour, an RGB one in the normalised pixel', () => {
    expect(ledVisualColor(true, '#58a6ff')).toBe('#58a6ff');
    expect(ledVisualColor(false, '#58a6ff')).toBeNull();
    expect(ledVisualColor(undefined, '#58a6ff')).toBeNull();
    expect(ledVisualColor({ r: 64, g: 32, b: 0 }, undefined)).toBe('rgb(255, 128, 0)');
    expect(ledVisualColor({ r: 0, g: 0, b: 0 }, undefined)).toBeNull();
  });
});
