/**
 * esp32-proxy-resync-hash.test.ts — the ESP32 proxy resync sees every byte.
 *
 * A peer board's I2C device is mirrored into the ESP32 QEMU worker as a
 * 256-register snapshot and refreshed every 250 ms, but only when its hash
 * changes. The hash used to sample one byte in sixteen plus the first eight,
 * so a change at 0xF7 (a BMP280 measurement) or 0x3D (an MPU-6050 axis) left
 * it equal and the ESP32 read the first value for the whole run.
 */
import { describe, it, expect } from 'vitest';
import { Esp32BridgeShim } from '../store/useSimulatorStore';

const hash = (regs: Uint8Array) =>
  (Esp32BridgeShim as unknown as { _hashRegs(r: Uint8Array): number })._hashRegs(regs);

describe('Esp32BridgeShim._hashRegs', () => {
  it('changes when any single byte changes', () => {
    const base = new Uint8Array(256);
    const h0 = hash(base);
    for (const i of [0x00, 0x07, 0x3d, 0xd0, 0xf7, 0xfc, 0xff]) {
      const r = base.slice();
      r[i] = 0x5a;
      expect(hash(r), `byte 0x${i.toString(16)}`).not.toBe(h0);
    }
  });

  it('is stable for equal contents and an unsigned 32-bit number', () => {
    const a = new Uint8Array(256).map((_, i) => i);
    const b = a.slice();
    expect(hash(a)).toBe(hash(b));
    expect(hash(a)).toBeGreaterThanOrEqual(0);
    expect(hash(a)).toBeLessThan(2 ** 32);
  });
});
