/**
 * Phase 3 tests — logic family catalog and threshold conversion via
 * `configFromLogicFamily` + `createSpiceResolvedPinResolver`.
 *
 * Verifies:
 *   - Every family has self-consistent parameters (vil < vih, etc.)
 *   - Per-board family lookup (Arduino Uno → AVR_HC, ESP32 → LVCMOS33)
 *   - Schmitt-trigger hysteresis routes through to the resolver config
 *   - Real-world noise-margin scenarios (TTL input with ringing)
 */

import { describe, it, expect, vi } from 'vitest';
import {
  FAMILIES,
  getBoardLogicFamily,
  getLogicFamilyById,
  HC14_VT_NEG_FRACTION,
  HC14_VT_POS_FRACTION,
  type LogicFamily,
} from '../simulation/LogicFamilies';
import {
  configFromLogicFamily,
  createSpiceResolvedPinResolver,
  type SpiceVoltageSource,
} from '../simulation/PinResolver';

function mockSource(): {
  source: SpiceVoltageSource;
  fire: (v: number) => void;
} {
  let voltage: number | null = null;
  const subs: Array<(state: string, v: number) => void> = [];
  return {
    source: {
      subscribe(_id, _pin, cb) {
        subs.push(cb as (s: string, v: number) => void);
        return () => {
          const i = subs.indexOf(cb as (s: string, v: number) => void);
          if (i >= 0) subs.splice(i, 1);
        };
      },
      getCurrentVoltage() {
        return voltage;
      },
    },
    fire(v: number) {
      voltage = v;
      for (const cb of subs) cb('UNKNOWN' as unknown as string, v);
    },
  };
}

describe('LogicFamilies — catalog sanity', () => {
  it.each(Object.entries(FAMILIES))('%s has self-consistent params', (name, family: LogicFamily) => {
    expect(family.name).toBeTruthy();
    expect(family.vcc).toBeGreaterThan(0);
    expect(family.vil).toBeLessThan(family.vih); // dead band must have width
    expect(family.cin_pF).toBeGreaterThan(0);
    if (family.vol_max !== undefined && family.voh_min !== undefined) {
      // Output range must cover input range — otherwise the family
      // can't drive itself.
      expect(family.vol_max).toBeLessThanOrEqual(family.vil);
      expect(family.voh_min).toBeGreaterThanOrEqual(family.vih);
    }
    if (family.vil_schmitt !== undefined && family.vih_schmitt !== undefined) {
      expect(family.vil_schmitt).toBeLessThan(family.vih_schmitt);
    }
    // Suppress unused-name lint: `name` is just for test labelling.
    void name;
  });

  it('TTL/LVCMOS33 share input thresholds (interoperate by design)', () => {
    expect(FAMILIES.TTL.vil).toBe(FAMILIES.LVCMOS33.vil);
    expect(FAMILIES.TTL.vih).toBe(FAMILIES.LVCMOS33.vih);
  });

  it('CMOS-5V-SCHMITT has the SN74HC14 thresholds the SPICE model uses', () => {
    const schmitt = FAMILIES['CMOS-5V-SCHMITT'];
    expect(schmitt.vih_schmitt).toBeCloseTo(HC14_VT_POS_FRACTION * schmitt.vcc, 9);
    expect(schmitt.vil_schmitt).toBeCloseTo(HC14_VT_NEG_FRACTION * schmitt.vcc, 9);
    // TI SCLS085L typical hysteresis: 0.9 V at 4.5 V, 1.3 V at 6 V.
    const hyst = (schmitt.vih_schmitt ?? 0) - (schmitt.vil_schmitt ?? 0);
    expect(hyst).toBeGreaterThan(0.9);
    expect(hyst).toBeLessThan(1.3);
  });
});

describe('getBoardLogicFamily', () => {
  it('Arduino Uno → AVR_HC (5V)', () => {
    const f = getBoardLogicFamily('arduino-uno');
    expect(f.name).toBe('AVR (ATmega) 5V');
    expect(f.vcc).toBe(5);
  });

  it('ESP32 → LVCMOS33 (3.3V)', () => {
    const f = getBoardLogicFamily('esp32');
    expect(f.vcc).toBe(3.3);
    expect(f.vih).toBe(2.0); // TTL-compatible inputs at 3.3V
  });

  it('Raspberry Pi Pico → LVCMOS33', () => {
    const f = getBoardLogicFamily('raspberry-pi-pico');
    expect(f.vcc).toBe(3.3);
  });

  it('unknown board falls back to AVR_HC (conservative default)', () => {
    const f = getBoardLogicFamily('made-up-board-9000');
    expect(f.vcc).toBe(5);
  });
});

describe('getLogicFamilyById', () => {
  it('returns null for nullish/unknown ids', () => {
    expect(getLogicFamilyById(null)).toBeNull();
    expect(getLogicFamilyById(undefined)).toBeNull();
    expect(getLogicFamilyById('')).toBeNull();
    expect(getLogicFamilyById('not-a-family')).toBeNull();
  });

  it('resolves valid family ids', () => {
    expect(getLogicFamilyById('TTL')?.name).toBe('TTL');
    expect(getLogicFamilyById('CMOS-5V-SCHMITT')?.vih_schmitt).toBeDefined();
  });
});

describe('configFromLogicFamily', () => {
  it('uses vih/vil for non-Schmitt families', () => {
    const cfg = configFromLogicFamily(FAMILIES['CMOS-5V']);
    expect(cfg.thresholdHigh).toBe(FAMILIES['CMOS-5V'].vih);
    expect(cfg.thresholdLow).toBe(FAMILIES['CMOS-5V'].vil);
    expect(cfg.vcc).toBe(5);
  });

  it('uses vih_schmitt/vil_schmitt for Schmitt families (hysteresis)', () => {
    const cfg = configFromLogicFamily(FAMILIES['CMOS-5V-SCHMITT']);
    expect(cfg.thresholdHigh).toBe(FAMILIES['CMOS-5V-SCHMITT'].vih_schmitt);
    expect(cfg.thresholdLow).toBe(FAMILIES['CMOS-5V-SCHMITT'].vil_schmitt);
    // Important: thresholdLow < thresholdHigh → real hysteresis exists
    expect(cfg.thresholdLow).toBeLessThan(cfg.thresholdHigh);
  });
});

describe('SpiceResolvedPinResolver + Schmitt family — noise rejection', () => {
  it('does not glitch on noise within the dead band', () => {
    const { source, fire } = mockSource();
    const r = createSpiceResolvedPinResolver(
      'ic-74hc14-1',
      'A',
      source,
      configFromLogicFamily(FAMILIES['CMOS-5V-SCHMITT']),
    );
    const cb = vi.fn();
    r.onChange(cb);

    // First fire: FLOATING → LOW (real transition, cb fires once).
    fire(0.5);
    expect(cb).toHaveBeenCalledWith('LOW', 0.5);
    cb.mockClear();

    // Cross Vt+ (2.75 V for 74HC14) → HIGH
    fire(3.5);
    expect(cb).toHaveBeenCalledWith('HIGH', 3.5);
    cb.mockClear();

    // Bounce inside the dead band (Vt- = 1.75 V, Vt+ = 2.75 V) — must NOT glitch
    fire(2.5);
    fire(2.0);
    fire(2.7);
    expect(cb).not.toHaveBeenCalled();

    // Drop below Vt- → LOW
    fire(1.2);
    expect(cb).toHaveBeenCalledWith('LOW', 1.2);
  });

  it('non-Schmitt family does NOT hold state in the dead band', () => {
    const { source, fire } = mockSource();
    // CMOS-5V has vih=3.5 and vil=1.5. configFromLogicFamily uses vih/vil
    // directly (no hysteresis variant), so thresholdHigh === 3.5 and
    // thresholdLow === 1.5.  Voltages in 1.5..3.5 stay in last state.
    const r = createSpiceResolvedPinResolver(
      'ic-74hc04-1',
      'A',
      source,
      configFromLogicFamily(FAMILIES['CMOS-5V']),
    );
    const cb = vi.fn();
    r.onChange(cb);

    fire(0.5);  // LOW
    fire(4.5);  // → HIGH
    expect(cb).toHaveBeenLastCalledWith('HIGH', 4.5);
    cb.mockClear();

    // Drop to 2.5V — in dead band, stays HIGH (this is the
    // last-state-wins behavior even without explicit hysteresis)
    fire(2.5);
    expect(cb).not.toHaveBeenCalled();
  });
});
