/**
 * The registry and the two built-in models, exercised through the same
 * PadEvent stream a simulator would feed them.
 */
import { describe, expect, it } from 'vitest';
import {
  createLineModel,
  hasLineModel,
  lineModelTypes,
  numberField,
  registerLineModel,
  type LineClock,
} from '../lineModels';
import { INITIAL_PAD, type PadEvent, type PadState } from '../padEvent';
import { dht22Payload, dht22Frame, DHT22_RESPONSE_START_US } from '../models/dht22';
import { hcsr04Frame, clampDistanceCm } from '../models/hc-sr04';
import '../index';

/** A 16 MHz clock the models can be run against in isolation. */
function clockAt(now: number, hz = 16_000_000): LineClock {
  return { now: () => now, us: (n) => Math.round((n * hz) / 1e6) };
}

/** Build the event stream a guest produces, one drive state after another. */
function events(pin: number, drives: Array<PadState['drive']>, cycle = 0): PadEvent[] {
  const out: PadEvent[] = [];
  let prev: PadState = INITIAL_PAD;
  for (const drive of drives) {
    const next: PadState = { drive, pull: drive === 'z' ? 1 : 0, level: drive !== 'low', cycle };
    out.push({ pin, ...next, prev });
    prev = next;
  }
  return out;
}

describe('lineModels registry', () => {
  it('knows the two built-in models and nothing it was not told', () => {
    expect(hasLineModel('dht22')).toBe(true);
    expect(hasLineModel('hc-sr04')).toBe(true);
    expect(hasLineModel('ds18b20-not-registered')).toBe(false);
    expect(createLineModel({ sensor_type: 'nope', pin: 1 })).toBeNull();
    expect(lineModelTypes()).toEqual(expect.arrayContaining(['dht22', 'hc-sr04']));
  });

  it('adding a sensor is one registration, with no other file involved', () => {
    registerLineModel('test-blip', (rec) => ({
      listens: [rec.pin],
      drives: [rec.pin],
      rest: () => [{ pin: rec.pin, level: true, driven: false }],
      onPad: (e, clock) =>
        e.drive === 'z' ? { pin: rec.pin, edges: [{ level: false, atCycle: clock.now() + 1 }] } : null,
      update: () => {},
      reset: () => {},
    }));
    const m = createLineModel({ sensor_type: 'test-blip', pin: 9 })!;
    expect(m.drives).toEqual([9]);
    const [e] = events(9, ['z']);
    expect(m.onPad(e, clockAt(100))!.edges[0].atCycle).toBe(101);
  });

  it('numberField accepts numbers and numeric strings, else the default', () => {
    expect(numberField(3, 1)).toBe(3);
    expect(numberField('24.5', 1)).toBe(24.5);
    expect(numberField('abc', 1)).toBe(1);
    expect(numberField(undefined, 7)).toBe(7);
    expect(numberField(NaN, 7)).toBe(7);
  });
});

describe('dht22 model', () => {
  it('encodes the AM2302 payload byte for byte, sign in bit 15', () => {
    expect([...dht22Payload(25.0, 50.0)]).toEqual([0x01, 0xf4, 0x00, 0xfa, 0xef]);
    expect([...dht22Payload(-10.5, 33.3)]).toEqual([0x01, 0x4d, 0x80, 0x69, 0x37]);
  });

  it('answers with 84 edges: the response gap, 80/80 preamble, 40 bits of 50 + 26|70, and a release', () => {
    const us = clockAt(0).us;
    const f = dht22Frame(4, 1000, dht22Payload(25, 50), us);
    expect(f.edges).toHaveLength(84);
    expect(f.edges[0]).toEqual({ level: false, atCycle: 1000 + us(DHT22_RESPONSE_START_US) });
    expect(f.edges[1]).toEqual({ level: true, atCycle: 1000 + us(DHT22_RESPONSE_START_US) + us(80) });
    expect(f.edges[2].atCycle - f.edges[1].atCycle).toBe(us(80));
    // First data bit of 0x01 is a '0': 50 us low then 26 us high.
    expect(f.edges[3].atCycle - f.edges[2].atCycle).toBe(us(50));
    expect(f.edges[4].atCycle - f.edges[3].atCycle).toBe(us(26));
    expect(f.edges[83].level).toBe(true);
    expect(f.releaseAtCycle).toBe(f.edges[83].atCycle + us(50));
  });

  it('triggers only on a release after a low, never on the low itself or on a bare release', () => {
    const m = createLineModel({ sensor_type: 'dht22', pin: 4, temperature: 21, humidity: 40 })!;
    const clk = clockAt(5000);
    const [toHigh, toLow, release] = events(4, ['high', 'low', 'z']);
    expect(m.onPad(toHigh, clk)).toBeNull();
    expect(m.onPad(toLow, clk)).toBeNull();
    const frame = m.onPad(release, clk);
    expect(frame).not.toBeNull();
    expect(frame!.pin).toBe(4);
    expect(frame!.edges).toHaveLength(84);
    // A release with no preceding low is not a start signal.
    const m2 = createLineModel({ sensor_type: 'dht22', pin: 4 })!;
    const [bare] = events(4, ['z']);
    expect(m2.onPad(bare, clk)).toBeNull();
  });

  it('ignores the master while its own frame is on the wire, then listens again', () => {
    const m = createLineModel({ sensor_type: 'dht22', pin: 4 })!;
    const [, toLow, release] = events(4, ['high', 'low', 'z']);
    const first = m.onPad(release, clockAt(0)) ?? (m.onPad(toLow, clockAt(0)), m.onPad(release, clockAt(0)));
    expect(first).not.toBeNull();
    const busy = first!.releaseAtCycle! - 1;
    expect(m.onPad(toLow, clockAt(busy))).toBeNull();
    expect(m.onPad(release, clockAt(busy))).toBeNull();
    const after = first!.releaseAtCycle! + 1;
    m.onPad(toLow, clockAt(after));
    expect(m.onPad(release, clockAt(after))).not.toBeNull();
  });

  it('update() changes the next payload; reset() forgets a half start signal', () => {
    const m = createLineModel({ sensor_type: 'dht22', pin: 4, temperature: 25, humidity: 50 })!;
    m.update({ temperature: -10.5, humidity: '33.3' }, clockAt(0));
    const [, toLow, release] = events(4, ['high', 'low', 'z']);
    m.onPad(toLow, clockAt(0));
    m.reset();
    expect(m.onPad(release, clockAt(0))).toBeNull(); // the low was forgotten
    m.onPad(toLow, clockAt(0));
    const f = m.onPad(release, clockAt(0))!;
    // -10.5 C / 33.3 %: first data byte 0x01, so bit 7 is '0' (26 us high).
    const us = clockAt(0).us;
    expect(f.edges[4].atCycle - f.edges[3].atCycle).toBe(us(26));
    // temp_H 0x80 = sign: bit 23 (edges 2 + 2*16 .. ) is '1'
    const bit16High = f.edges[2 + 2 * 16 + 2].atCycle - f.edges[2 + 2 * 16 + 1].atCycle;
    expect(bit16High).toBe(us(70));
  });

  it('rests its DATA line released, on the pull-up', () => {
    const m = createLineModel({ sensor_type: 'dht22', pin: 4 })!;
    expect(m.rest()).toEqual([{ pin: 4, level: true, driven: false }]);
    expect(m.listens).toEqual([4]);
    expect(m.drives).toEqual([4]);
  });
});

describe('hc-sr04 model', () => {
  it('answers a TRIG rise with a two-edge ECHO: 600 us later, 58 us per cm long', () => {
    const us = clockAt(0).us;
    const f = hcsr04Frame(6, 1000, 15, us);
    expect(f.edges).toHaveLength(2);
    expect(f.edges[0]).toEqual({ level: true, atCycle: 1000 + us(600) });
    expect(f.edges[1].atCycle - f.edges[0].atCycle).toBe(us((15 / 17150) * 1e6));
    expect(f.selfTimed).toBeUndefined(); // by shape: two edges do not hold the clock
  });

  it('listens on TRIG, drives ECHO, rests ECHO low and driven', () => {
    const m = createLineModel({ sensor_type: 'hc-sr04', pin: 5, echo_pin: 6, distance: 30 })!;
    expect(m.listens).toEqual([5]);
    expect(m.drives).toEqual([6]);
    expect(m.rest()).toEqual([{ pin: 6, level: false, driven: true }]);
  });

  it('triggers on the rise only, and not while an echo is still out', () => {
    const m = createLineModel({ sensor_type: 'hc-sr04', pin: 5, echo_pin: 6, distance: 100 })!;
    const [rise, fall] = events(5, ['high', 'low']);
    expect(m.onPad(fall, clockAt(0))).toBeNull();
    const f = m.onPad(rise, clockAt(0))!;
    expect(f.pin).toBe(6);
    expect(m.onPad(rise, clockAt(f.edges[1].atCycle - 1))).toBeNull();
    expect(m.onPad(rise, clockAt(f.edges[1].atCycle + 1))).not.toBeNull();
  });

  it('clamps the distance to the sensor range and takes updates', () => {
    expect(clampDistanceCm(1)).toBe(2);
    expect(clampDistanceCm(999)).toBe(400);
    const m = createLineModel({ sensor_type: 'hc-sr04', pin: 5, echo_pin: 6, distance: 999 })!;
    const [rise] = events(5, ['high']);
    const us = clockAt(0).us;
    let f = m.onPad(rise, clockAt(0))!;
    expect(f.edges[1].atCycle - f.edges[0].atCycle).toBe(us((400 / 17150) * 1e6));
    m.update({ distance: 10 }, clockAt(0));
    m.reset();
    f = m.onPad(rise, clockAt(0))!;
    expect(f.edges[1].atCycle - f.edges[0].atCycle).toBe(us((10 / 17150) * 1e6));
  });

  it('with no echo pin it drives nothing and answers nothing', () => {
    const m = createLineModel({ sensor_type: 'hc-sr04', pin: 5 })!;
    expect(m.drives).toEqual([]);
    const [rise] = events(5, ['high']);
    expect(m.onPad(rise, clockAt(0))).toBeNull();
  });
});
