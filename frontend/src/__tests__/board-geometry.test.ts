// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { boardBox, boardSize, normalizeRotation } from '../utils/boardGeometry';
import { calculatePinPosition } from '../utils/pinPositionCalculator';

describe('board geometry', () => {
  it('normalises any angle to a quarter turn', () => {
    expect(normalizeRotation(undefined)).toBe(0);
    expect(normalizeRotation(90)).toBe(90);
    expect(normalizeRotation(450)).toBe(90);
    expect(normalizeRotation(-90)).toBe(270);
    expect(normalizeRotation(89)).toBe(90);
  });

  it('swaps the footprint on a quarter turn, about the same centre', () => {
    const size = boardSize('esp32'); // 141 x 265
    const flat = boardBox({ boardKind: 'esp32', x: 100, y: 50 });
    const turned = boardBox({ boardKind: 'esp32', x: 100, y: 50, rotation: 90 });
    expect(flat).toEqual({ left: 100, top: 50, w: size.w, h: size.h });
    expect(turned.w).toBe(size.h);
    expect(turned.h).toBe(size.w);
    expect(turned.left + turned.w / 2).toBeCloseTo(flat.left + flat.w / 2);
    expect(turned.top + turned.h / 2).toBeCloseTo(flat.top + flat.h / 2);
  });

  it('rotates a board pin about the footprint centre', () => {
    // A 100x50 element at (0,0) with one pin at its top-left corner.
    const el = document.createElement('div');
    el.id = 'geo-board';
    Object.defineProperty(el, 'pinInfo', { value: [{ name: 'P', x: 0, y: 0 }] });
    document.body.appendChild(el);
    const box = { w: 100, h: 50 };
    // Centre (50, 25). The top-left corner turned 90 degrees clockwise lands
    // at the top-right corner of the turned box: (75, -25).
    const pos = calculatePinPosition('geo-board', 'P', 0, 0, 90, box);
    expect(pos?.x).toBeCloseTo(75);
    expect(pos?.y).toBeCloseTo(-25);
    expect(calculatePinPosition('geo-board', 'P', 0, 0, 0, box)).toEqual({ x: 0, y: 0 });
    el.remove();
  });
});
