/**
 * An infrared demodulator's output pin — a TSOP-series can, the thing behind
 * the lens on every IR receiver module.
 *
 * The part is not a sensor of anything physical. It listens to the air
 * (`simulation/ir/irAir`) and puts what it heard on its pin: the carrier
 * stripped off, the envelope left, ACTIVE LOW, idle HIGH. That inversion is
 * the whole device, and it is why the air carries marks and spaces rather than
 * pin levels — the emitter's LED is on during a mark and this pin is low
 * during the same mark.
 *
 * It is a line model and not a WASM chip for one reason: a NEC bit is 560 us
 * and the difference between a zero and a one is 1.1 ms. `clock.us` converts
 * against the guest's OWN configured clock and the edges land on the guest's
 * cycle counter, so IRremote's 50 us sampling ISR and its pin-change decoder
 * both read exactly what a real remote would have given them. Nothing driven
 * from an animation frame can resolve 560 us, which is precisely how the old
 * `setTimeout(next, 0.562)` implementation managed to be undecodable by every
 * IR library in existence.
 *
 * Nothing the guest does starts a frame, so `listens` is empty and `update`
 * is where the work happens — the contract's own documented case of a device
 * that speaks unprompted.
 */

import type { HostEdge, HostEdgeFrame } from '../LineTimeline';
import { necEncode, type IrPulse } from '../../ir/necCodec';
import { numberField, registerLineModel, type LineClock, type LineModel } from '../lineModels';

/** Settling gap before the first edge, so a frame never lands on the cycle it was queued at. */
const LEAD_US = 100;

/**
 * The envelope of a pulse train as the demodulator's pin carries it.
 *
 * `pulses` are marks and spaces in microseconds; the pin is LOW for a mark and
 * HIGH for a space. The frame always ends HIGH: a decoder waiting for the end
 * of a transmission has to see the line come back to idle, and a train that
 * ends on a mark (NEC's stop mark does) would otherwise leave it low forever.
 */
export function envelopeFrame(
  pin: number,
  startCycle: number,
  pulses: readonly IrPulse[],
  us: (n: number) => number,
): HostEdgeFrame | null {
  if (!pulses.length) return null;
  const edges: HostEdge[] = [];
  let t = startCycle + us(LEAD_US);
  let level: boolean | null = null;
  for (const p of pulses) {
    if (p.us <= 0) continue;
    const want = p.level === 1 ? false : true; // a mark pulls the output LOW
    if (want !== level) {
      edges.push({ level: want, atCycle: t });
      level = want;
    }
    t += us(p.us);
  }
  if (!edges.length) return null;
  if (level === false) edges.push({ level: true, atCycle: t }); // back to idle

  // No `releaseAtCycle`. Release is for a line the GUEST also drives — a DHT's
  // open-drain bus. A demodulator's output is host-only and idles HIGH, so
  // handing the pad back would drop it to whatever the pull gives, and a
  // decoder waiting for the end of the frame would see the line go low and
  // stay there. The host keeps driving; the last edge leaves it high.
  return { pin, edges, selfTimed: true };
}

/** The NEC frame for an address and a command, as the pin carries it. */
export function necFrame(
  pin: number,
  startCycle: number,
  address: number,
  command: number,
  us: (n: number) => number,
): HostEdgeFrame | null {
  return envelopeFrame(pin, startCycle, necEncode(address, command), us);
}

/**
 * A raw train off the wire protocol. The air carries `IrPulse[]`; a backend
 * worker and a JSON round-trip may deliver the same thing as a flat array of
 * numbers (`[markUs, spaceUs, ...]`, mark first), so both are accepted rather
 * than making every caller agree on one.
 */
export function toPulses(value: unknown): IrPulse[] | null {
  if (!Array.isArray(value) || !value.length) return null;
  if (typeof value[0] === 'number') {
    return (value as number[])
      .map((us, i) => ({ level: (i % 2 === 0 ? 1 : 0) as 0 | 1, us: Number(us) }))
      .filter((p) => Number.isFinite(p.us) && p.us > 0);
  }
  const out: IrPulse[] = [];
  for (const p of value as Array<Record<string, unknown>>) {
    const us = Number(p?.['us']);
    if (!Number.isFinite(us) || us <= 0) continue;
    out.push({ level: Number(p?.['level']) === 1 ? 1 : 0, us });
  }
  return out.length ? out : null;
}

/**
 * Keys whose VALUE CHANGING is the transmission, whatever the new value is.
 *
 * It has to be a change and not a presence, because the hosted path merges
 * every update into the record it registered with (`requestLine`, the
 * `{ ...props, ...p }` line): on an ESP32 the trigger key is therefore present
 * in every update a slider produces, and a model that fired on presence
 * transmitted once per slider tick.
 */
const TRIGGER_KEYS = ['seq', 'send'] as const;

registerLineModel('ir-nec', (rec) => {
  const pin = rec.pin;
  let address = numberField(rec.address, 0x00);
  let command = numberField(rec.command, 0x16);
  /** The last value seen for each trigger key, seeded from the record so the
   *  registration itself is not read as a press. */
  const seen = new Map<string, unknown>(TRIGGER_KEYS.map((k) => [k, rec[k]]));
  /** Cycle the frame on the wire finishes at: a second one on top of it would
   *  garble both, which is what happens in the room too. */
  let busyUntil = -Infinity;

  const model: LineModel = {
    listens: [],
    drives: [pin],
    rest: () => [{ pin, level: true, driven: true }],
    onPad: () => null,
    update(props, clock?: LineClock) {
      if ('address' in props) address = numberField(props.address, address);
      if ('command' in props) command = numberField(props.command, command);
      // Read per update and never remembered: an air frame carries its own
      // train, and the NEXT transmission — a Send button on the panel, say —
      // must not replay the last one the room happened to deliver.
      const carried = 'pulses' in props ? toPulses(props.pulses) : null;

      let fired = false;
      for (const k of TRIGGER_KEYS) {
        if (!(k in props)) continue;
        if (props[k] !== seen.get(k)) fired = true;
        seen.set(k, props[k]);
      }
      if (!fired || !clock) return null;

      const now = clock.now();
      if (now < busyUntil) return null; // still emitting the previous frame
      const frame = carried
        ? envelopeFrame(pin, now, carried, clock.us)
        : necFrame(pin, now, address, command, clock.us);
      if (!frame) return null;
      busyUntil = frame.edges[frame.edges.length - 1].atCycle;
      return frame;
    },
    reset() {
      busyUntil = -Infinity;
    },
  };
  return model;
});
