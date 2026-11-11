/**
 * The photoresistor follows a real LDR (velxio/velxio-prod#103).
 *
 * The model was R = 1 MOhm / (1 + 5 * lux / 1000): 952 kOhm at 10 lux and
 * 167 kOhm at 1000 lux, 50 to 270 times a real part. With the module's
 * 10 kOhm on AO the output only moved between 0.05 and 0.28 V, and the
 * gallery's uno-photoresistor printed "Light: 3%  ADC=34" at 500 lux.
 *
 * An LDR datasheet gives a power law, R = R10 * (10 / lux)^gamma, capped at
 * the dark resistance. Senba GL55 series manual, GL5528 (the breakout
 * module's LDR): R10 10-20 kOhm (15 kOhm here), gamma 0.6, dark >= 1 MOhm.
 * Wokwi models the same element with the same law and exposes `rl10` (kOhm)
 * and `gamma`; Velxio takes those names so an imported project keeps them.
 */
import { describe, it, expect } from 'vitest';
import { componentToSpice } from '../simulation/spice/componentToSpice';
import { buildNetlist } from '../simulation/spice/NetlistBuilder';
import { exampleProjects } from '../data/examples';
import { exampleToBuildNetlistInput } from '../utils/exampleToBuildNetlistInput';
import { runNetlist } from './helpers/testSolver';
import type { BoardKind } from '../types/board';

/** Ohms of the LDR card the module emits at `lux` with `extra` properties. */
function ldrOhms(lux: number, extra: Record<string, unknown> = {}): number {
  const nets: Record<string, string> = { VCC: 'vcc', GND: '0', AO: 'n_ao' };
  const out = componentToSpice(
    { id: 'ldr1', metadataId: 'photoresistor-sensor', properties: { lux, ...extra } },
    (pin: string) => nets[pin] ?? null,
    { vcc: 5 },
  );
  const card = out!.cards.find((c) => c.startsWith('R_ldr1_ldr '))!;
  return Number(card.split(/\s+/).pop());
}

/** AO of the module on 5 V: the LDR from VCC to AO, its 10 kOhm from AO to GND. */
const aoVolts = (r: number) => (5 * 10_000) / (10_000 + r);

describe('photoresistor LDR law (#103)', () => {
  it('follows the GL5528 curve: 15 kOhm at 10 lux, slope 0.6, 1 MOhm dark', () => {
    expect(ldrOhms(10)).toBeCloseTo(15_000, 0);
    expect(ldrOhms(100)).toBeCloseTo(15_000 * 10 ** -0.6, 0); // 3.77 kOhm
    expect(ldrOhms(1000)).toBeCloseTo(15_000 * 100 ** -0.6, 0); // 946 Ohm
    expect(ldrOhms(1)).toBeCloseTo(15_000 * 10 ** 0.6, 0); // 59.7 kOhm
    expect(ldrOhms(0)).toBe(1_000_000);
  });

  it('puts the module output across the whole 0-5 V range', () => {
    expect(aoVolts(ldrOhms(0))).toBeLessThan(0.06);
    expect(aoVolts(ldrOhms(10))).toBeCloseTo(2.0, 1);
    expect(aoVolts(ldrOhms(100))).toBeCloseTo(3.63, 1);
    expect(aoVolts(ldrOhms(1000))).toBeGreaterThan(4.5);
  });

  it('takes the LDR from rl10 (kOhm) and gamma, as Wokwi does', () => {
    // Wokwi's defaults, rl10 = 50 and gamma = 0.7, and its table:
    // 50 kOhm at 10 lux, 9.98 kOhm at 100 lux, 1.99 kOhm at 1000 lux.
    expect(ldrOhms(10, { rl10: 50, gamma: 0.7 })).toBeCloseTo(50_000, 0);
    expect(ldrOhms(100, { rl10: 50, gamma: 0.7 }) / 1000).toBeCloseTo(9.98, 2);
    expect(ldrOhms(1000, { rl10: '50', gamma: '0.7' }) / 1000).toBeCloseTo(1.99, 2);
  });

  it('caps the light law at the dark resistance', () => {
    expect(ldrOhms(0.001)).toBe(1_000_000);
    expect(ldrOhms(1e-5, { dark: '5Meg' })).toBe(5_000_000);
    expect(ldrOhms(0, { dark: '1Meg' })).toBe(1_000_000);
    // GL55 series: dark is about 67 x R10, so a 150 kOhm GL5549 reads 10 MOhm.
    expect(ldrOhms(0, { rl10: 150, gamma: 0.9 })).toBeCloseTo(10_000_000, 0);
  });

  it(
    'uno-photoresistor reads 87 % at the default 500 lux, not 3 %',
    { timeout: 60_000 },
    async () => {
      const ex = exampleProjects.find((e) => e.id === 'uno-photoresistor')!;
      const input = exampleToBuildNetlistInput(ex, {
        boards: [{ id: 'arduino-uno', boardKind: 'arduino-uno' as BoardKind, pinStates: {} }],
      });
      const { netlist, pinNetMap } = buildNetlist(input);
      const r = await runNetlist(netlist);
      const a0 = r.dcValue(`v(${pinNetMap.get('arduino-uno:A0')})`);
      // 5 V * 10k / (10k + 1.43k) = 4.37 V; the sketch maps analogRead to percent.
      expect(a0).toBeCloseTo(4.37, 1);
      const raw = Math.round((a0 / 5) * 1023);
      const percent = Math.floor((raw * 100) / 1023);
      expect(percent).toBeGreaterThanOrEqual(85);
      expect(percent).toBeLessThanOrEqual(89);
    },
  );
});
