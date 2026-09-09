/**
 * The air, the codec, and the two line models — the layer under the parts.
 *
 * `protocol-parts.test.ts` covers the two canvas parts end to end. This file
 * covers the pieces they stand on, and in particular the three things that are
 * easy to get wrong and impossible to see on a canvas: the round trip through
 * the codec, the polarity of the envelope, and the demodulation of a bit-banged
 * 38 kHz carrier back into marks and spaces.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  channelHears,
  emitIr,
  irAirStats,
  listenIr,
  necDecode,
  necEncode,
  necEncodeRepeat,
  resetIrAir,
  type IrPulse,
  NEC_HEADER_MARK_US,
  NEC_HEADER_SPACE_US,
  NEC_ONE_SPACE_US,
  NEC_ZERO_SPACE_US,
  NEC_BIT_MARK_US,
} from '../simulation/ir';
import { LineSensorHub } from '../simulation/line/LineSensorHub';
import type { LineHostPort } from '../simulation/line/LineHost';
import { INITIAL_PAD, type PadEvent, type PadState } from '../simulation/line/padEvent';
import { CARRIER_GAP_US, FLUSH_DEBOUNCE_MS } from '../simulation/line/models/ir-tx';

const CLOCK_HZ = 16e6;

function makeHub() {
  const listeners = new Map<number, Set<(e: PadEvent) => void>>();
  const edges: Array<[number, boolean, number]> = [];
  let cycle = 10_000;
  const port: LineHostPort = {
    now: () => cycle,
    clockHz: () => CLOCK_HZ,
    scheduleEdge: (pin, level, at) => edges.push([pin, level, at]),
    onPad: (pin, cb) => {
      if (!listeners.has(pin)) listeners.set(pin, new Set());
      listeners.get(pin)!.add(cb);
      return () => listeners.get(pin)!.delete(cb);
    },
    restPad: () => {},
  };
  const hub = new LineSensorHub(port);
  return {
    hub,
    edges,
    /**
     * Drive the pad from the guest side and HOLD it for `us`.
     *
     * The order matters and getting it backwards is the classic way to write a
     * test that measures the previous interval as the current one: a simulator
     * reports the change at the instant it happens, so the level is announced
     * FIRST and the clock advances after. A helper that advanced first shifted
     * every duration one pulse along, which turned a 9 ms header into a 4.5 ms
     * one and made a perfectly good decoder look broken.
     */
    hold(pin: number, drive: PadState['drive'], us: number, prev: PadState) {
      const next: PadState = { drive, pull: 0, level: drive === 'high', cycle };
      listeners.get(pin)?.forEach((cb) => cb({ pin, ...next, prev }));
      cycle += Math.round((us * CLOCK_HZ) / 1e6);
      return next;
    },
    at: () => cycle,
  };
}

/** The mark/space train an edge list represents, on an active-low output. */
function edgesToPulses(edges: Array<[number, boolean, number]>): IrPulse[] {
  const out: IrPulse[] = [];
  for (let i = 0; i + 1 < edges.length; i++) {
    out.push({
      level: edges[i][1] ? 0 : 1,
      us: ((edges[i + 1][2] - edges[i][2]) / CLOCK_HZ) * 1e6,
    });
  }
  return out;
}

describe('NEC codec', () => {
  it('round-trips an address and a command', () => {
    for (const [addr, cmd] of [
      [0x00, 0x45],
      [0xff, 0x00],
      [0x04, 0x1c],
      [0x7f, 0xa2],
    ]) {
      const f = necDecode(necEncode(addr, cmd));
      expect([f.protocol, f.address, f.command, f.verified]).toEqual(['NEC', addr, cmd, true]);
    }
  });

  it('sends the header, then 32 bits, then a stop mark', () => {
    const p = necEncode(0x00, 0x45);
    expect(p).toHaveLength(2 + 64 + 1);
    expect(p[0]).toEqual({ level: 1, us: NEC_HEADER_MARK_US });
    expect(p[1]).toEqual({ level: 0, us: NEC_HEADER_SPACE_US });
    expect(p[p.length - 1]).toEqual({ level: 1, us: NEC_BIT_MARK_US });
  });

  it('a bit is in the SPACE, least significant first', () => {
    // 0x01: only bit 0 set, so the first data space is long and the rest short.
    const p = necEncode(0x01, 0x00);
    expect(p[3].us).toBe(NEC_ONE_SPACE_US);
    expect(p[5].us).toBe(NEC_ZERO_SPACE_US);
  });

  it('an address above 0xff goes out as extended NEC and comes back whole', () => {
    const f = necDecode(necEncode(0x1234, 0x56));
    expect(f.address).toBe(0x1234);
    expect(f.command).toBe(0x56);
  });

  it('decodes a repeat frame as carrying no data', () => {
    const f = necDecode(necEncodeRepeat());
    expect(f.protocol).toBe('NEC-repeat');
  });

  it('tolerates the timing drift a guest running behind real time produces', () => {
    const stretched = necEncode(0x04, 0x1c).map((p) => ({ ...p, us: p.us * 1.15 }));
    expect(necDecode(stretched).command).toBe(0x1c);
  });

  it('reports a train it cannot parse as raw rather than as a wrong reading', () => {
    expect(
      necDecode([
        { level: 1, us: 100 },
        { level: 0, us: 100 },
      ]).protocol,
    ).toBe('raw');
  });

  it('skips the leading space a capture usually starts with', () => {
    expect(necDecode([{ level: 0, us: 40_000 }, ...necEncode(0x04, 0x1c)]).command).toBe(0x1c);
  });
});

describe('irAir — the medium', () => {
  beforeEach(() => resetIrAir());

  it('delivers to everyone and skips the source', () => {
    const heard: string[] = [];
    listenIr(
      'a',
      () => '',
      () => (heard.push('a'), true),
    );
    listenIr(
      'b',
      () => '',
      () => (heard.push('b'), true),
    );
    listenIr(
      'c',
      () => '',
      () => (heard.push('c'), true),
    );
    expect(emitIr({ pulses: necEncode(0, 1), sourceId: 'b' })).toBe(2);
    expect(heard.sort()).toEqual(['a', 'c']);
  });

  it('counts a delivery only when the receiver took it', () => {
    listenIr(
      'a',
      () => '',
      () => false,
    );
    expect(emitIr({ pulses: necEncode(0, 1), sourceId: 'x' })).toBe(0);
    expect(irAirStats.emitted).toBe(1);
  });

  it('a thrown receiver does not stop the others', () => {
    listenIr(
      'bad',
      () => '',
      () => {
        throw new Error('boom');
      },
    );
    listenIr(
      'good',
      () => '',
      () => true,
    );
    expect(emitIr({ pulses: necEncode(0, 1), sourceId: 'x' })).toBe(1);
  });

  it('decodes the frame once, for every listener and every indicator', () => {
    let seen: { address: number; command: number } | null = null;
    listenIr(
      'a',
      () => '',
      (f) => ((seen = { address: f.address, command: f.command }), true),
    );
    emitIr({ pulses: necEncode(0x04, 0x1c), sourceId: 'x' });
    expect(seen).toEqual({ address: 0x04, command: 0x1c });
  });

  it('the channel rule: empty hears all, set hears only its own, case and space folded', () => {
    expect(channelHears('', 'anything')).toBe(true);
    expect(channelHears('', '')).toBe(true);
    expect(channelHears('left', 'left')).toBe(true);
    expect(channelHears(' LEFT ', 'left')).toBe(true);
    expect(channelHears('left', 'right')).toBe(false);
    expect(channelHears('left', '')).toBe(false);
  });

  it('re-reads a listener channel at delivery, so retuning needs no resubscribe', () => {
    let channel = 'left';
    let hits = 0;
    listenIr(
      'a',
      () => channel,
      () => (hits++, true),
    );
    emitIr({ pulses: necEncode(0, 1), sourceId: 'x', channel: 'right' });
    expect(hits).toBe(0);
    channel = 'right';
    emitIr({ pulses: necEncode(0, 1), sourceId: 'x', channel: 'right' });
    expect(hits).toBe(1);
  });

  it('an empty train is not a transmission', () => {
    listenIr(
      'a',
      () => '',
      () => true,
    );
    expect(emitIr({ pulses: [], sourceId: 'x' })).toBe(0);
    expect(irAirStats.emitted).toBe(0);
  });

  it('unsubscribing stops delivery', () => {
    let hits = 0;
    const off = listenIr(
      'a',
      () => '',
      () => (hits++, true),
    );
    emitIr({ pulses: necEncode(0, 1), sourceId: 'x' });
    off();
    emitIr({ pulses: necEncode(0, 1), sourceId: 'x' });
    expect(hits).toBe(1);
  });
});

describe('ir-nec — the receive model', () => {
  it('inverts the train: the pin is LOW for a mark', () => {
    const { hub, edges } = makeHub();
    hub.attach({ sensor_type: 'ir-nec', pin: 5 });
    hub.update(5, { pulses: necEncode(0x04, 0x1c), seq: 1 });
    expect(edges[0][1]).toBe(false);
    expect(necDecode(edgesToPulses(edges))).toMatchObject({ address: 0x04, command: 0x1c });
  });

  it('ends HIGH even though a NEC train ends on a mark', () => {
    const { hub, edges } = makeHub();
    hub.attach({ sensor_type: 'ir-nec', pin: 5 });
    hub.update(5, { pulses: necEncode(0, 1), seq: 1 });
    // A decoder waiting for the end of the frame must see the line come back
    // to idle; a train that ended low would strand it there forever.
    expect(edges[edges.length - 1][1]).toBe(true);
  });

  it('fires on a trigger key CHANGING, not on it being present', () => {
    const { hub, edges } = makeHub();
    hub.attach({ sensor_type: 'ir-nec', pin: 5, address: 0, command: 0x45 });
    hub.update(5, { address: 1 }); // a slider tick, no send
    expect(edges).toHaveLength(0);
    hub.update(5, { seq: 1 });
    expect(edges.length).toBeGreaterThan(0);
    const n = edges.length;
    // The hosted path merges the record into every update, so the key is
    // present again with the SAME value: that is not a second press.
    hub.update(5, { seq: 1, address: 1 });
    expect(edges).toHaveLength(n);
  });

  it('does not start a second frame on top of one still going out', () => {
    const { hub, edges } = makeHub();
    hub.attach({ sensor_type: 'ir-nec', pin: 5 });
    hub.update(5, { seq: 1 });
    const n = edges.length;
    hub.update(5, { seq: 2 }); // the clock has not moved; the first is still on the wire
    expect(edges).toHaveLength(n);
  });

  it('falls back to its own address and command when the air carried no train', () => {
    const { hub, edges } = makeHub();
    hub.attach({ sensor_type: 'ir-nec', pin: 5, address: 0x08, command: 0x22 });
    hub.update(5, { seq: 1 });
    expect(necDecode(edgesToPulses(edges))).toMatchObject({ address: 0x08, command: 0x22 });
  });

  it('never replays the last train it was handed', () => {
    const { hub, edges } = makeHub();
    hub.attach({ sensor_type: 'ir-nec', pin: 5, address: 0x08, command: 0x22 });
    hub.update(5, { pulses: necEncode(0x01, 0x02), seq: 1 });
    expect(necDecode(edgesToPulses(edges))).toMatchObject({ address: 0x01, command: 0x02 });
    edges.length = 0;
    hub.reset();
    hub.update(5, { seq: 2 }); // a Send with nothing carried: its own code, not the last one
    expect(necDecode(edgesToPulses(edges))).toMatchObject({ address: 0x08, command: 0x22 });
  });

  it('drives its pin and listens to none', () => {
    const { hub } = makeHub();
    hub.attach({ sensor_type: 'ir-nec', pin: 5 });
    expect(hub.ownsPin(5)).toBe(true);
  });
});

describe('ir-tx — the transmit model', () => {
  beforeEach(() => {
    resetIrAir();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  /** Bit-bang `pulses` on a pad the way a sketch does: a 38 kHz square wave
   *  through each mark, a flat low through each space. */
  function bitBang(h: ReturnType<typeof makeHub>, pin: number, pulses: IrPulse[], carrierUs = 13) {
    let prev: PadState = INITIAL_PAD;
    for (const p of pulses) {
      if (p.level === 1) {
        for (let t = 0; t + carrierUs * 2 <= p.us; t += carrierUs * 2) {
          prev = h.hold(pin, 'high', carrierUs, prev);
          prev = h.hold(pin, 'low', carrierUs, prev);
        }
      } else {
        prev = h.hold(pin, 'low', p.us, prev);
      }
    }
    // The pin has to move once more for the last interval to be measurable.
    return h.hold(pin, 'high', 100, prev);
  }

  it('demodulates a bit-banged 38 kHz carrier back to the frame that was sent', () => {
    const h = makeHub();
    h.hub.attach({ sensor_type: 'ir-tx', pin: 4, source_id: 'led-1' });
    let got: { address: number; command: number } | null = null;
    listenIr(
      'rx',
      () => '',
      (f) => ((got = { address: f.address, command: f.command }), true),
    );

    bitBang(h, 4, necEncode(0x04, 0x1c));
    vi.advanceTimersByTime(FLUSH_DEBOUNCE_MS + 10);

    expect(got).toEqual({ address: 0x04, command: 0x1c });
  });

  it('reports the carrier it measured', () => {
    const h = makeHub();
    h.hub.attach({ sensor_type: 'ir-tx', pin: 4, source_id: 'led-1' });
    bitBang(h, 4, necEncode(0x00, 0x45));
    vi.advanceTimersByTime(FLUSH_DEBOUNCE_MS + 10);
    // 13 us per half cycle is 38.5 kHz. Measured, not assumed.
    expect(irAirStats.last!.carrierHz).toBeGreaterThan(30_000);
    expect(irAirStats.last!.carrierHz).toBeLessThan(45_000);
  });

  it('also handles an unmodulated envelope, with no carrier at all', () => {
    const h = makeHub();
    h.hub.attach({ sensor_type: 'ir-tx', pin: 4, source_id: 'led-1' });
    let got: number | null = null;
    listenIr(
      'rx',
      () => '',
      (f) => ((got = f.command), true),
    );

    let prev: PadState = INITIAL_PAD;
    for (const p of necEncode(0x00, 0x45)) {
      prev = h.hold(4, p.level === 1 ? 'high' : 'low', p.us, prev);
    }
    h.hold(4, 'low', 100, prev);
    vi.advanceTimersByTime(FLUSH_DEBOUNCE_MS + 10);

    expect(got).toBe(0x45);
    expect(irAirStats.last!.carrierHz).toBe(0); // no transitions inside the marks
  });

  it('a low notch shorter than the carrier gap is carrier, not a space', () => {
    const h = makeHub();
    h.hub.attach({ sensor_type: 'ir-tx', pin: 4, source_id: 'led-1' });
    listenIr(
      'rx',
      () => '',
      () => true,
    );
    // Notches at half the gap must not split the 9 ms header into pieces.
    bitBang(h, 4, necEncode(0x04, 0x1c), Math.floor(CARRIER_GAP_US / 2));
    vi.advanceTimersByTime(FLUSH_DEBOUNCE_MS + 10);
    expect(irAirStats.last!.command).toBe(0x1c);
  });

  it('owns no pad — the guest drives that pin', () => {
    const h = makeHub();
    h.hub.attach({ sensor_type: 'ir-tx', pin: 4, source_id: 'led-1' });
    expect(h.hub.ownsPin(4)).toBe(false);
  });

  it('a stray edge or two is not a transmission', () => {
    const h = makeHub();
    h.hub.attach({ sensor_type: 'ir-tx', pin: 4, source_id: 'led-1' });
    let prev: PadState = INITIAL_PAD;
    prev = h.hold(4, 'high', 1000, prev);
    h.hold(4, 'low', 1000, prev);
    vi.advanceTimersByTime(FLUSH_DEBOUNCE_MS + 10);
    expect(irAirStats.emitted).toBe(0);
  });

  it('transmits on its channel', () => {
    const h = makeHub();
    h.hub.attach({ sensor_type: 'ir-tx', pin: 4, source_id: 'led-1', channel: 'left' });
    bitBang(h, 4, necEncode(0x00, 0x45));
    vi.advanceTimersByTime(FLUSH_DEBOUNCE_MS + 10);
    expect(irAirStats.last!.channel).toBe('left');
  });

  it('a reboot throws away a half-captured frame', () => {
    const h = makeHub();
    h.hub.attach({ sensor_type: 'ir-tx', pin: 4, source_id: 'led-1' });
    let prev: PadState = INITIAL_PAD;
    for (const p of necEncode(0x00, 0x45).slice(0, 20)) {
      prev = h.hold(4, p.level === 1 ? 'high' : 'low', p.us, prev);
    }
    h.hub.reset();
    vi.advanceTimersByTime(FLUSH_DEBOUNCE_MS + 10);
    expect(irAirStats.emitted).toBe(0);
  });
});
