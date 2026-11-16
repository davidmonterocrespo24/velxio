/**
 * The servo takes any plausible pulse and stops at its ends
 * (velxio/velxio-prod#168).
 *
 * On a board whose pin edges carry CPU cycles (the AVR), the servo measured
 * each pulse and dropped any outside 544-2400 us, keeping the previous angle.
 * The Servo library's own 0 degree pulse jitters around 544 us (543.4 to
 * 544.6 us, from its Timer1 ISR), so most of them were dropped, and with
 * attach(pin, 500, 2500), a common setting for an SG90's full travel,
 * write(0) and write(180) never moved the horn at all. A real servo has a
 * dead band of about 10 us (Tower Pro SG90 datasheet) and hard stops at both
 * ends (Wokwi's servo); driving past an end is a high-current state at the
 * stop (Arduino Servo docs), not a pulse it ignores. The ESP32 path and the
 * unwired fallback already accepted 200-4000 us and clamped the angle.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { PinManager } from '../simulation/PinManager';
import { PartSimulationRegistry } from '../simulation/parts/PartSimulationRegistry';
import '../simulation/parts/ComplexParts';

const SIG = 9;
const HZ = 16_000_000;

afterEach(() => vi.unstubAllGlobals());

function servo() {
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', () => {});
  const pinManager = new PinManager();
  let cycles = 0;
  // The part's view of an AVR board: pin edges on the PinManager, a cycle counter.
  const sim = {
    pinManager,
    getCurrentCycles: () => cycles,
    getClockHz: () => HZ,
    setPinState: () => {},
    isRunning: () => true,
  };
  const el = { angle: 90 } as { angle: number };
  PartSimulationRegistry.get('servo')!.attachEvents!(
    el as unknown as HTMLElement,
    sim as never,
    (n: string) => (n === 'PWM' ? SIG : null),
    'servo1',
  );
  /** One pulse of `us` microseconds, then the rest of a 20 ms period. */
  const pulse = (us: number) => {
    pinManager.triggerPinChange(SIG, true);
    cycles += Math.round((us * HZ) / 1e6);
    pinManager.triggerPinChange(SIG, false);
    cycles += Math.round(((20_000 - us) * HZ) / 1e6);
  };
  return { el, pulse };
}

describe('servo pulse range (velxio/velxio-prod#168)', () => {
  it("the Servo library's 0 degree pulses, a hair under 544 us, reach 0 degrees", () => {
    const { el, pulse } = servo();
    pulse(1500);
    expect(el.angle).toBe(93);
    pulse(543.44);
    expect(el.angle).toBe(0);
  });

  it('and its 180 degree pulses, a hair over 2400 us, reach 180', () => {
    const { el, pulse } = servo();
    pulse(1500);
    pulse(2400.5);
    expect(el.angle).toBe(180);
  });

  it('attach(pin, 500, 2500): write(0) and write(180) drive the horn to its stops', () => {
    const { el, pulse } = servo();
    pulse(1500);
    pulse(500);
    expect(el.angle).toBe(0);
    pulse(2500);
    expect(el.angle).toBe(180);
  });

  it('a pulse no servo would take (a glitch, plain PWM) still leaves it where it is', () => {
    const { el, pulse } = servo();
    pulse(1500);
    pulse(50);
    expect(el.angle).toBe(93);
    pulse(10_000);
    expect(el.angle).toBe(93);
  });
});
