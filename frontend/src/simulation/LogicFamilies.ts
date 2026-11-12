/**
 * LogicFamilies — input/output electrical characteristics per logic family.
 *
 * Phase 3 of the mixed-mode simulator project (see
 * `project/sim-mixedmode/phase-03-logic-families.md` in velxio-prod).
 *
 * The point: digital ICs don't all have the same idea of "HIGH" or "LOW".
 * A 5V TTL part guarantees output ≥ 2.4V on HIGH and ≤ 0.4V on LOW,
 * but expects input ≥ 2.0V to read HIGH and ≤ 0.8V to read LOW.  A 5V
 * CMOS part has much tighter rails (≥ 4.5V / ≤ 0.5V) and wider input
 * noise margins.  Schmitt-trigger inputs (74HC14) add hysteresis so a
 * slowly-rising or noisy input doesn't glitch the output.
 *
 * The SPICE-resolved PinResolver uses these per-family parameters
 * instead of a flat `vcc/2` threshold so that:
 *   - circuits that work in real life work in simulation (TTL/CMOS
 *     interoperation, noise rejection)
 *   - circuits that DON'T work in real life look broken in simulation
 *     (e.g. driving a 5V CMOS gate from a 3.3V LVCMOS33 output won't
 *     reliably read HIGH — VOH = 3.3V max, Vih for CMOS-5V = 3.5V min)
 *
 * Parameter sources:
 *   - 74HC family: TI SN74HC datasheets (VIL = 1.5V, VIH = 3.5V @ 5V Vcc)
 *   - 74HCT family: TI SN74HCT (TTL-compatible inputs: VIL = 0.8V, VIH = 2.0V)
 *   - 74HC14 Schmitt: TI SN74HC14, SCLS085L (Vt+ 2.75 V, Vt- 1.75 V @ 5V Vcc:
 *     the typical values at 4.5 V and 6 V interpolated, see HC14_VT_*_FRACTION)
 *   - AVR_HC: ATmega328P datasheet section 28.2 (IO DC characteristics)
 *   - LVCMOS33: ESP32 / RP2040 / generic 3.3V logic, JEDEC JESD8-7A
 *   - TTL: 7400 series classic TTL
 */

/**
 * 74HC14 Schmitt-trigger thresholds as fractions of VCC. TI SN74HC14
 * (SCLS085L, 5.5) gives typical VT+ / VT- of 1.2 / 0.6 V at 2 V, 2.5 / 1.6 V
 * at 4.5 V and 3.3 / 2.0 V at 6 V: about 55 % and 35 % of VCC, so 2.75 /
 * 1.75 V at 5 V against 2.77 / 1.73 V interpolated from the table. The SPICE
 * model of the part (componentToSpice, ic-74hc14) and the Schmitt family
 * below use these same numbers.
 */
export const HC14_VT_POS_FRACTION = 0.55;
export const HC14_VT_NEG_FRACTION = 0.35;

export interface LogicFamily {
  /** Display name for logs / UI. */
  name: string;
  /** Operating supply voltage in volts. */
  vcc: number;
  /** Max input voltage that still reads LOW. */
  vil: number;
  /** Min input voltage that still reads HIGH. */
  vih: number;
  /**
   * Schmitt-trigger hysteresis thresholds.  Set only when the family
   * has Schmitt inputs (74HC14, 74HC13, ESP32 GPIO pins on some
   * speed settings).  When set, the PinResolver uses these for
   * threshold conversion and ignores `vil`/`vih`.
   */
  vil_schmitt?: number;
  vih_schmitt?: number;
  /**
   * Input pin capacitance in pF.  Modeled in the netlist as a small
   * cap to GND at the component pin's node.  Combined with the source's
   * output impedance this gives a real RC rising/falling edge slope
   * (~50 ns for 30Ω × 5 pF, plenty for ringing to show up at MHz
   * speeds).  Typical values: TTL 5-7 pF, CMOS 3-5 pF, Schmitt 7-10 pF.
   */
  cin_pF: number;
  /** Output low max (driven LOW). */
  vol_max?: number;
  /** Output high min (driven HIGH). */
  voh_min?: number;
  /**
   * Output driver impedance in ohms.  Modeled as series R in the
   * netlist between the ngspice voltage source (representing
   * digitalWrite) and the actual pin node.  Used by Phase 3+ netlist
   * emission to model real slew rates and current limits.
   */
  output_impedance_ohm?: number;
}

export const FAMILIES = {
  /**
   * Classic 7400-series TTL @ 5V.  Wide noise margins, ratty output
   * levels (VOH only guaranteed to 2.4V), high input current.  Rare
   * in modern circuits but still found in lab kits.
   */
  TTL: {
    name: 'TTL',
    vcc: 5,
    vil: 0.8,
    vih: 2.0,
    cin_pF: 5,
    vol_max: 0.4,
    voh_min: 2.4,
    output_impedance_ohm: 80,
  },

  /**
   * 74HC family @ 5V CMOS.  Rail-to-rail outputs, wide input noise
   * margins (Vil = 30%·Vcc, Vih = 70%·Vcc).  The default for most
   * Arduino-era logic ICs.
   */
  'CMOS-5V': {
    name: 'CMOS-5V',
    vcc: 5,
    vil: 1.5,
    vih: 3.5,
    cin_pF: 5,
    vol_max: 0.1,
    voh_min: 4.9,
    output_impedance_ohm: 30,
  },

  /**
   * 74HC14, 74HC13, and other Schmitt-trigger inputs @ 5V CMOS.
   * Use the Vt+/Vt- thresholds; the resolver ignores vil/vih when the
   * _schmitt variants are present.  Hysteresis 1.0 V (2.75 V - 1.75 V)
   * per TI's SN74HC14 datasheet (HC14_VT_*_FRACTION at 5 V).
   */
  'CMOS-5V-SCHMITT': {
    name: 'CMOS-5V (Schmitt)',
    vcc: 5,
    vil: 1.5,
    vih: 3.5,
    vil_schmitt: 1.75,
    vih_schmitt: 2.75,
    cin_pF: 7,
    vol_max: 0.1,
    voh_min: 4.9,
    output_impedance_ohm: 30,
  },

  /**
   * 74HCT family @ 5V.  CMOS internals but TTL-compatible input
   * thresholds (so they can be driven by classic 7400-series outputs).
   * VIH = 2.0V is the giveaway.
   */
  'CMOS-5V-TTL-INPUTS': {
    name: 'CMOS-5V (TTL inputs)',
    vcc: 5,
    vil: 0.8,
    vih: 2.0,
    cin_pF: 5,
    vol_max: 0.1,
    voh_min: 4.9,
    output_impedance_ohm: 30,
  },

  /**
   * LVCMOS33 — 3.3V CMOS logic with TTL-compatible input thresholds.
   * ESP32 GPIO, RP2040 GPIO, most modern ARM Cortex-M MCUs use this.
   * VIH = 2.0V means a 5V CMOS output (VOH ≥ 4.9V) easily drives it,
   * but a 3.3V output back into a 5V CMOS-input gate is marginal.
   */
  LVCMOS33: {
    name: 'LVCMOS33',
    vcc: 3.3,
    vil: 0.8,
    vih: 2.0,
    cin_pF: 5,
    vol_max: 0.4,
    voh_min: 2.4,
    output_impedance_ohm: 30,
  },

  /**
   * AVR/ATmega 5V HC-family.  Arduino Uno, Mega, Nano (5V variant).
   * Documented in ATmega328P datasheet section 28.2.
   */
  AVR_HC: {
    name: 'AVR (ATmega) 5V',
    vcc: 5,
    vil: 1.0,
    vih: 3.0,
    cin_pF: 8,
    vol_max: 0.5,
    voh_min: 4.2,
    // Effective output impedance ~25Ω for a 40 mA driver pulling
    // toward Vcc - 0.7V at Iol=10mA.
    output_impedance_ohm: 25,
  },

  /**
   * Generic 3.3V CMOS — older parts, voltage regulators, sensor breakouts.
   * Strictly CMOS thresholds (30%/70% of Vcc), NOT TTL-compatible.
   */
  'CMOS-3.3V': {
    name: 'CMOS-3.3V',
    vcc: 3.3,
    vil: 1.0,
    vih: 2.3,
    cin_pF: 5,
    vol_max: 0.1,
    voh_min: 3.2,
    output_impedance_ohm: 30,
  },
} as const satisfies Record<string, LogicFamily>;

export type LogicFamilyId = keyof typeof FAMILIES;

/**
 * Map a board kind to its native I/O logic family.  Used by
 * DynamicComponent when constructing a SPICE-resolved PinResolver for a
 * component pin: the threshold model defaults to whatever the BOARD
 * drives, unless the component declares its own logicFamily metadata
 * field (Phase 3 continued — not yet wired in components-metadata.json).
 */
const BOARD_FAMILY: Record<string, LogicFamilyId> = {
  'arduino-uno':       'AVR_HC',
  'arduino-mega':      'AVR_HC',
  'arduino-nano':      'AVR_HC',
  attiny85:            'AVR_HC',
  esp32:               'LVCMOS33',
  'esp32-c3':          'LVCMOS33',
  'esp32-s3':          'LVCMOS33',
  'esp32-cam':         'LVCMOS33',
  'xiao-esp32-c3':     'LVCMOS33',
  'xiao-esp32-s3':     'LVCMOS33',
  'arduino-nano-esp32':'LVCMOS33',
  'esp32-devkit-c-v4': 'LVCMOS33',
  'raspberry-pi-pico': 'LVCMOS33',
  'pi-pico-w':         'LVCMOS33',
  'raspberry-pi-3':    'LVCMOS33',
};

/**
 * Lookup the I/O logic family for a board.  Falls back to AVR_HC (5V
 * Arduino) when the board is unknown — that's the most common
 * fallback and produces conservative thresholds.
 */
export function getBoardLogicFamily(boardKind: string): LogicFamily {
  const id = BOARD_FAMILY[boardKind] ?? 'AVR_HC';
  return FAMILIES[id];
}

/**
 * Lookup by id with defensive fallback.  Useful when a component
 * declares its `logicFamily` field in metadata as a string — we
 * resolve it through this helper to avoid runtime errors for typos.
 */
export function getLogicFamilyById(id: string | null | undefined): LogicFamily | null {
  if (!id) return null;
  return (FAMILIES as Record<string, LogicFamily>)[id] ?? null;
}
