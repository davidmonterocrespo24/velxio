/**
 * The voltmeter shows microvolts in microvolts (velxio/velxio-prod#129).
 *
 * formatV switched to µV only below 1 µV, so the whole 1 µV - 1 mV decade
 * was shown in millivolts with two decimals: 1.10 µV read "0.00 mV" while
 * a smaller 0.90 µV read "0.90 µV". Now µV below 1 mV and mV below 1 V,
 * like the hover labels already did.
 */
import { describe, it, expect } from 'vitest';
import { readVoltmeter } from '../simulation/spice/probes';
import type { ElectricalSolveResult } from '../simulation/spice/types';

function show(volts: number): string {
  const solve = {
    nodeVoltages: { n1: volts },
    branchCurrents: {},
    converged: true,
    error: null,
    analysisMode: 'op',
  } as unknown as ElectricalSolveResult;
  return readVoltmeter(
    { id: 'vm', metadataId: 'instr-voltmeter', properties: {} },
    (_c, pin) => (pin === 'V+' ? 'n1' : '0'),
    solve,
  ).display;
}

describe('the voltmeter display', () => {
  it('keeps the microvolt decade in µV', () => {
    expect(show(0.9e-6)).toBe('0.90 µV');
    expect(show(1.1e-6)).toBe('1.10 µV');
    expect(show(4.9e-6)).toBe('4.90 µV');
    expect(show(99e-6)).toBe('99.00 µV');
    expect(show(-250e-6)).toBe('-250.00 µV');
  });

  it('shows millivolts from 1 mV and volts from 1 V, as before', () => {
    expect(show(1e-3)).toBe('1.00 mV');
    expect(show(0.5)).toBe('500.00 mV');
    expect(show(1.5)).toBe('1.500 V');
    expect(show(-12)).toBe('-12.000 V');
  });
});
