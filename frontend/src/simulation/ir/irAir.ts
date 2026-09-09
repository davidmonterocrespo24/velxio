/**
 * irAir — the air between infrared parts. The medium the simulator never had.
 *
 * WHAT WAS MISSING. Every other link on the canvas is a wire, and a wire is a
 * thing the user draws between two pads. Infrared is the one link with no
 * wire: a remote points at a receiver across the room and the two share
 * nothing but the room. So there was no layer for it, and both IR parts were
 * dead in the way that follows from that — the remote dispatched a DOM event
 * nothing listened to, and the receiver drove a pin it could never resolve.
 * The Grove emitter's own documentation said it out loud: it models the
 * emitter, not the link.
 *
 * WHAT THIS IS. One process-wide bus. An emitter publishes a mark/space train;
 * every listening receiver gets it. There is no geometry: not distance, not
 * angle, not line of sight, not which board a part is wired to. Two parts at
 * opposite corners of the canvas are as connected as two parts touching, which
 * is the point — a user placing a remote and a receiver has already expressed
 * the only intent that matters, and asking them to also aim it would be a
 * puzzle, not a simulation.
 *
 * MICROSECONDS, NOT CYCLES. The bus carries durations in real microseconds.
 * Each receiver converts them to ITS OWN board's guest cycles when it puts the
 * envelope on its pin. That is the whole reason a remote can fire a receiver
 * on an Uno and another on an ESP32 in the same run: the two boards count in
 * different units and neither one's clock is the air's.
 *
 * CHANNELS. By default every receiver hears every emitter, which is what a
 * room does. A part may also carry a `channel` — any short string — to build
 * isolated pairs when a project has several links that must not cross:
 *
 *   a receiver with NO channel hears everything;
 *   a receiver WITH a channel hears only emitters carrying the same one.
 *
 * So the default costs nothing and the escape hatch is one property. Matching
 * is on the trimmed, lower-cased string, because a user typing "Link A" in one
 * dialog and "link a" in the other meant the same link.
 *
 * AN EMITTER NEVER HEARS ITSELF. `sourceId` is the emitting component, and it
 * is skipped on delivery. A board with an IR diode and an IR receiver on the
 * same pad is a real thing to build, and its own transmission is the one frame
 * it must not decode.
 */

import { necDecode, type IrPulse, NEC_CARRIER_HZ } from './necCodec';

/** One transmission, as it crosses the room. */
export interface IrAirFrame {
  /** Mark/space durations in microseconds. `level` 1 = carrier on. */
  pulses: readonly IrPulse[];
  /** The carrier the emitter modulated onto, for a receiver that cares. */
  carrierHz: number;
  /** The emitting component, so it is skipped on delivery. */
  sourceId: string;
  /** Empty = the room. See the channel rule above. */
  channel: string;
  /** Wall clock at emission, for the UI only — never for timing a waveform. */
  atMs: number;
  /** What the train decodes to, carried alongside so every listener and every
   *  indicator agrees on one reading instead of decoding it again. */
  protocol: 'NEC' | 'NEC-repeat' | 'raw';
  address: number;
  command: number;
  verified: boolean;
}

/** What a receiver is handed. Returning true means it took the frame. */
export type IrAirSink = (frame: IrAirFrame) => boolean;

interface Listener {
  id: string;
  /** Read at delivery, so retuning a receiver needs no resubscribe. */
  channel: () => string;
  sink: IrAirSink;
}

const listeners = new Set<Listener>();

/** Counters for the console and the conformance tests. Never load-bearing. */
export const irAirStats = {
  emitted: 0,
  delivered: 0,
  listeners: 0,
  lastAtMs: 0,
  /** The last frame that crossed, for a quick look from the console. */
  last: null as IrAirFrame | null,
};
if (typeof globalThis !== 'undefined') {
  (globalThis as Record<string, unknown>)['__velxioIrAir'] = irAirStats;
}

const normalizeChannel = (c: string | null | undefined): string =>
  typeof c === 'string' ? c.trim().toLowerCase() : '';

/**
 * A receiver with no channel hears everything; one with a channel hears only
 * its own. Stated in one place so the two parts cannot drift apart.
 */
export function channelHears(receiverChannel: string, frameChannel: string): boolean {
  const rx = normalizeChannel(receiverChannel);
  return rx === '' || rx === normalizeChannel(frameChannel);
}

/**
 * Listen for transmissions. `channel` is a getter, not a value: a receiver's
 * channel is a component property the user can change while the simulation
 * runs, and re-reading it at delivery is cheaper and more honest than tearing
 * the subscription down and building it again.
 */
export function listenIr(id: string, channel: () => string, sink: IrAirSink): () => void {
  const entry: Listener = { id, channel, sink };
  listeners.add(entry);
  irAirStats.listeners = listeners.size;
  return () => {
    listeners.delete(entry);
    irAirStats.listeners = listeners.size;
  };
}

/**
 * Send a transmission. Returns how many receivers took it — zero is the
 * answer a caller should say out loud, because "the button did nothing" and
 * "nothing was listening" look identical on a canvas and only one of them is
 * the user's mistake.
 */
export function emitIr(tx: {
  pulses: readonly IrPulse[];
  sourceId: string;
  channel?: string;
  carrierHz?: number;
}): number {
  if (!tx.pulses.length) return 0;
  const nec = necDecode(tx.pulses);
  const frame: IrAirFrame = {
    pulses: tx.pulses,
    carrierHz: tx.carrierHz ?? NEC_CARRIER_HZ,
    sourceId: tx.sourceId,
    channel: normalizeChannel(tx.channel),
    atMs: Date.now(),
    protocol: nec.protocol,
    address: nec.address,
    command: nec.command,
    verified: nec.verified,
  };
  irAirStats.emitted++;
  irAirStats.lastAtMs = frame.atMs;
  irAirStats.last = frame;

  let taken = 0;
  for (const l of listeners) {
    if (l.id === frame.sourceId) continue;
    if (!channelHears(l.channel(), frame.channel)) continue;
    try {
      if (l.sink(frame)) taken++;
    } catch {
      // One broken receiver must not stop the others.
    }
  }
  irAirStats.delivered += taken;
  return taken;
}

/** Drop every listener. Tests only — a part releases its own subscription. */
export function resetIrAir(): void {
  listeners.clear();
  irAirStats.emitted = 0;
  irAirStats.delivered = 0;
  irAirStats.listeners = 0;
  irAirStats.last = null;
}
