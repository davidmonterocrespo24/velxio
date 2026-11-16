/**
 * One value parser, read the way people write values
 * (velxio/velxio-prod#105, #101).
 *
 *   - It looked at the LAST letter: "100nF" ended in an f and was 100
 *     femtofarads, "1uF" 1 fF, "4k7" 4 Ω and "1kHz" 1 (#105).
 *   - It lower-cased the text, so "1M" on a resistor was 1 mΩ, a short, where
 *     every schematic editor and Velxio's own catalog read a megaohm (#101).
 * Now: a number, ONE scale factor (M mega, m milli, meg mega in any case,
 * RKM "4k7"), and the unit letters after it ignored, as ngspice does. A text
 * that is not a value is not turned into some other number.
 */
import { describe, it, expect } from 'vitest';
import { parseValueWithUnits } from '../simulation/spice/valueParser';

const close = (got: number, want: number) => {
  expect(Number.isFinite(got)).toBe(true);
  expect(Math.abs(got - want)).toBeLessThanOrEqual(Math.abs(want) * 1e-12);
};

describe('the shared value parser (#105, #101)', () => {
  it('ignores the unit letters after the scale factor, as ngspice does (#105)', () => {
    close(parseValueWithUnits('100nF'), 100e-9);
    close(parseValueWithUnits('100 nF'), 100e-9);
    close(parseValueWithUnits('1uF'), 1e-6);
    close(parseValueWithUnits('10µF'), 10e-6);
    close(parseValueWithUnits('10μF'), 10e-6);
    close(parseValueWithUnits('470pF'), 470e-12);
    close(parseValueWithUnits('1000uF'), 1000e-6);
    close(parseValueWithUnits('10mH'), 10e-3);
    close(parseValueWithUnits('1kHz'), 1e3);
    close(parseValueWithUnits('50Hz'), 50);
    close(parseValueWithUnits('9V'), 9);
    close(parseValueWithUnits('500mA'), 0.5);
    close(parseValueWithUnits('2.2kΩ'), 2200);
  });

  it('reads upper-case M as mega and lower-case m as milli; meg is mega in any case (#101)', () => {
    close(parseValueWithUnits('1M'), 1e6);
    close(parseValueWithUnits('1MΩ'), 1e6);
    close(parseValueWithUnits('1 MΩ'), 1e6);
    close(parseValueWithUnits('4.7M'), 4.7e6);
    close(parseValueWithUnits('1MHz'), 1e6);
    close(parseValueWithUnits('1m'), 1e-3);
    close(parseValueWithUnits('1mΩ'), 1e-3);
    close(parseValueWithUnits('1Meg'), 1e6);
    close(parseValueWithUnits('1MEG'), 1e6);
    close(parseValueWithUnits('1meg'), 1e6);
    close(parseValueWithUnits('1Megohm'), 1e6);
  });

  it('reads RKM codes: the scale factor stands where the decimal point goes', () => {
    close(parseValueWithUnits('4k7'), 4700);
    close(parseValueWithUnits('2k2'), 2200);
    close(parseValueWithUnits('2M2'), 2.2e6);
    close(parseValueWithUnits('4n7'), 4.7e-9);
    close(parseValueWithUnits('0R47'), 0.47);
    close(parseValueWithUnits('4R7'), 4.7);
  });

  it('keeps the farad and the ampere: F is not femto and A is not atto', () => {
    close(parseValueWithUnits('1F'), 1);
    close(parseValueWithUnits('2 farads'), 2);
    close(parseValueWithUnits('1f'), 1e-15);
    close(parseValueWithUnits('1A'), 1);
    close(parseValueWithUnits('10 microfarads'), 10e-6);
  });

  it('still reads what it always read', () => {
    expect(parseValueWithUnits('4.7k')).toBe(4700);
    expect(parseValueWithUnits('220')).toBe(220);
    expect(parseValueWithUnits('1Meg')).toBe(1_000_000);
    expect(parseValueWithUnits(1000)).toBe(1000);
    expect(parseValueWithUnits('-12')).toBe(-12);
    expect(parseValueWithUnits('1e-6')).toBe(1e-6);
    // The netlist keeps the exact numbers it emitted before for unchanged text.
    expect(parseValueWithUnits('100n')).toBe(100 * 1e-9);
    expect(parseValueWithUnits('10u')).toBe(10 * 1e-6);
  });

  it('returns the default for a text that is not a value, instead of some other number', () => {
    // The old parser read "4,7k" as 4k and "1 000" as 1.
    expect(parseValueWithUnits('4,7k', 99)).toBe(99);
    expect(parseValueWithUnits('1,000', 99)).toBe(99);
    expect(parseValueWithUnits('1 000', 99)).toBe(99);
    expect(parseValueWithUnits('5 V DC', 99)).toBe(99);
    expect(parseValueWithUnits('banana', 42)).toBe(42);
    expect(parseValueWithUnits('', 7)).toBe(7);
    expect(parseValueWithUnits(undefined, 8)).toBe(8);
  });

  it('says why a text is not a value', async () => {
    const { parseValue } = await import('../simulation/spice/valueParser');
    const comma = parseValue('4,7k');
    expect(comma.ok).toBe(false);
    if (!comma.ok) {
      expect(comma.reason).toBe('comma');
      expect(comma.message).toMatch(/dot/);
    }
    const junk = parseValue('5 V DC');
    expect(junk.ok).toBe(false);
    const empty = parseValue('  ');
    expect(empty.ok === false && empty.reason).toBe('empty');
  });
});

describe('the readout format', () => {
  it('shows a quantity with an SI prefix and up to four digits', async () => {
    const { formatQuantity } = await import('../simulation/spice/valueParser');
    expect(formatQuantity(4700, 'Ω')).toBe('4.7 kΩ');
    expect(formatQuantity(1e6, 'Ω')).toBe('1 MΩ');
    expect(formatQuantity(0.001, 'Ω')).toBe('1 mΩ');
    expect(formatQuantity(100 * 1e-9, 'F')).toBe('100 nF');
    expect(formatQuantity(2.2e-11, 'F')).toBe('22 pF');
    expect(formatQuantity(0.5, 'A')).toBe('500 mA');
    expect(formatQuantity(-12, 'V')).toBe('-12 V');
    expect(formatQuantity(999_960, 'Ω')).toBe('1 MΩ');
    expect(formatQuantity(0, 'V')).toBe('0 V');
  });
});
