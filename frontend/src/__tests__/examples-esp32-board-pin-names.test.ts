// @vitest-environment jsdom
/**
 * Every wire an ESP32 gallery example lands on its board names a pin the
 * board element really has.
 *
 * The canvas resolves a wire endpoint by the element's pinInfo; a name the
 * element does not carry leaves the wire hanging and the circuit unpowered.
 * The DevKit names its pins after the GPIO ('25', '34') with 'GND' on the left
 * and 'GND2' on the right; the wokwi element's names ('D25', 'GND.2') read
 * right in a review and pass a netlist test that uses the same wrong names on
 * both sides, which is how esp32-pwm-dac-lm358-12v shipped with its PWM, its
 * sense line and its ground all dangling (2026-11).
 */
import { describe, it, expect } from 'vitest';
import '../components/velxio-components/Esp32Element';
import { exampleProjects } from '../data/examples';

const ESP32_ELEMENT_KINDS = new Set([
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
]);

const pinCache = new Map<string, Set<string>>();
function pinsOf(kind: string): Set<string> {
  let pins = pinCache.get(kind);
  if (!pins) {
    const el = document.createElement('velxio-esp32') as HTMLElement & { pinInfo?: Array<{ name: string }> };
    el.setAttribute('board-kind', kind);
    document.body.appendChild(el);
    pins = new Set((el.pinInfo ?? []).map((p) => p.name));
    el.remove();
    pinCache.set(kind, pins);
  }
  return pins;
}

type Board = { id: string; kind: string };
function boardsOf(ex: (typeof exampleProjects)[number]): Board[] {
  const multi = (ex as { boards?: Array<{ id: string; boardKind: string }> }).boards;
  if (multi?.length) return multi.map((b) => ({ id: b.id, kind: b.boardKind }));
  return ex.boardType ? [{ id: ex.boardType, kind: ex.boardType }] : [];
}

describe('ESP32 gallery examples: board pins exist on the element', () => {
  it('the element answers with its pins', () => {
    expect(pinsOf('esp32').has('25')).toBe(true);
    expect(pinsOf('esp32').has('GND2')).toBe(true);
    expect(pinsOf('esp32').has('D25')).toBe(false);
  });

  it('every board endpoint of every ESP32-family example is a real pin', () => {
    const bad: string[] = [];
    for (const ex of exampleProjects) {
      for (const b of boardsOf(ex)) {
        if (!ESP32_ELEMENT_KINDS.has(b.kind)) continue;
        const pins = pinsOf(b.kind);
        for (const w of ex.wires ?? []) {
          for (const end of [w.start, w.end]) {
            if (end.componentId === b.id && !pins.has(end.pinName)) {
              bad.push(`${ex.id}: ${b.kind} has no pin '${end.pinName}' (wire ${w.id})`);
            }
          }
        }
      }
    }
    expect(bad).toEqual([]);
  });
});
