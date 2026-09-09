/**
 * NEC infrared, both directions: an address and a command to a mark/space
 * train, and a mark/space train back to an address and a command.
 *
 * The protocol: a 9 ms mark and a 4.5 ms space, then 32 bits, each a 560 us
 * mark followed by a space that is 560 us for a 0 and 1690 us for a 1, then a
 * final stop mark. The 32 bits are address, its complement, command, its
 * complement — least significant bit first within each byte. Extended NEC
 * keeps a 16-bit address instead of address plus complement, which is why the
 * address check only warns rather than rejects.
 *
 * A held-down key repeats as 9 ms + 2.25 ms + a stop mark, carrying no data.
 *
 * A "mark" is the interval the 38 kHz carrier is ON. What a demodulator puts
 * on its output pin is the INVERSE of that (active low), and what an emitter
 * puts on its LED is the carrier itself — so neither polarity belongs here.
 * This module speaks marks and spaces; the two line models do the inverting,
 * each on its own side of the air.
 */

/** One interval of a transmission. `level` 1 = carrier on (a mark), 0 = off. */
export interface IrPulse {
  level: 0 | 1;
  us: number;
}

export interface NecFrame {
  protocol: 'NEC' | 'NEC-repeat' | 'raw';
  address: number;
  command: number;
  /** True when address/command each matched their complement byte. */
  verified: boolean;
  /** How many pulses were consumed — the rest, if any, is another frame. */
  used: number;
}

export const NEC_HEADER_MARK_US = 9000;
export const NEC_HEADER_SPACE_US = 4500;
export const NEC_REPEAT_SPACE_US = 2250;
export const NEC_BIT_MARK_US = 560;
export const NEC_ZERO_SPACE_US = 560;
export const NEC_ONE_SPACE_US = 1690;
/** What a remote actually modulates onto. Carried on the air so a receiver
 *  tuned to another carrier could one day refuse a frame it cannot demodulate. */
export const NEC_CARRIER_HZ = 38000;

/**
 * Timings drift with the sending library's delay loop and, here, with how the
 * emulator paces the guest, so everything is matched proportionally. A quarter
 * is loose enough for both and still keeps 560 and 1690 well apart.
 */
const TOLERANCE = 0.25;

const near = (actual: number, expected: number): boolean =>
  Math.abs(actual - expected) <= expected * TOLERANCE;

/**
 * The pulse train for one NEC frame, ending on its stop mark.
 *
 * `address` above 0xff is sent as extended NEC: the 16 bits go out low byte
 * first and no complement is computed, which is what every remote that needs
 * more than 256 addresses does.
 */
export function necEncode(address: number, command: number): IrPulse[] {
  const extended = (address & 0xffff) > 0xff;
  const bytes = extended
    ? [address & 0xff, (address >> 8) & 0xff, command & 0xff, ~command & 0xff]
    : [address & 0xff, ~address & 0xff, command & 0xff, ~command & 0xff];

  const pulses: IrPulse[] = [
    { level: 1, us: NEC_HEADER_MARK_US },
    { level: 0, us: NEC_HEADER_SPACE_US },
  ];
  for (const byte of bytes) {
    for (let b = 0; b < 8; b++) {
      // Least significant bit first, within each byte.
      pulses.push({ level: 1, us: NEC_BIT_MARK_US });
      pulses.push({ level: 0, us: (byte >> b) & 1 ? NEC_ONE_SPACE_US : NEC_ZERO_SPACE_US });
    }
  }
  pulses.push({ level: 1, us: NEC_BIT_MARK_US });
  return pulses;
}

/** How often a held-down key repeats, in milliseconds. Real remotes send the
 *  first frame and then a repeat frame at this period for as long as the key is
 *  down; it is what makes a volume key ramp instead of stepping once. */
export const NEC_REPEAT_PERIOD_MS = 108;

/** The frame a held-down key sends every 108 ms: a header, a short space, a stop mark. */
export function necEncodeRepeat(): IrPulse[] {
  return [
    { level: 1, us: NEC_HEADER_MARK_US },
    { level: 0, us: NEC_REPEAT_SPACE_US },
    { level: 1, us: NEC_BIT_MARK_US },
  ];
}

/**
 * Decode one NEC frame from the front of a pulse train.
 *
 * Leading spaces are skipped: a capture usually begins in the gap before the
 * first mark, and a bare space at the front is not part of any frame.
 */
export function necDecode(pulses: readonly IrPulse[]): NecFrame {
  const fail: NecFrame = {
    protocol: 'raw',
    address: 0,
    command: 0,
    verified: false,
    used: pulses.length,
  };
  let i = 0;
  while (i < pulses.length && pulses[i].level === 0) i++;
  if (pulses.length - i < 3) return fail;
  if (!near(pulses[i].us, NEC_HEADER_MARK_US)) return fail;
  if (!near(pulses[i + 1].us, NEC_HEADER_SPACE_US)) {
    // The only other thing a NEC header can introduce is a repeat.
    if (near(pulses[i + 1].us, NEC_REPEAT_SPACE_US)) {
      return { protocol: 'NEC-repeat', address: 0, command: 0, verified: true, used: i + 3 };
    }
    return fail;
  }
  i += 2;

  const bits: number[] = [];
  while (bits.length < 32) {
    if (i + 1 >= pulses.length) return fail;
    if (!near(pulses[i].us, NEC_BIT_MARK_US)) return fail;
    const space = pulses[i + 1].us;
    if (near(space, NEC_ONE_SPACE_US)) bits.push(1);
    else if (near(space, NEC_ZERO_SPACE_US)) bits.push(0);
    else return fail;
    i += 2;
  }

  const byteAt = (n: number): number => {
    let v = 0;
    for (let b = 0; b < 8; b++) v |= bits[n * 8 + b] << b;
    return v;
  };
  const addrLow = byteAt(0);
  const addrHigh = byteAt(1);
  const command = byteAt(2);
  const commandInv = byteAt(3);

  const commandOk = ((command ^ commandInv) & 0xff) === 0xff;
  // Classic NEC sends the address twice, inverted; extended NEC uses both bytes
  // as a 16-bit address, so a mismatch there is normal and not an error.
  const classicAddr = ((addrLow ^ addrHigh) & 0xff) === 0xff;
  const address = classicAddr ? addrLow : addrLow | (addrHigh << 8);

  return {
    protocol: 'NEC',
    address,
    command,
    verified: commandOk,
    // The trailing stop mark, when the capture includes it.
    used: Math.min(pulses.length, i + 1),
  };
}
