/**
 * The generic hub over a fake port: it must never need to know what a DHT22
 * is to host one.
 */
import { describe, expect, it, vi } from 'vitest';
import { LineSensorHub } from '../LineSensorHub';
import type { LineHostPort } from '../LineHost';
import { INITIAL_PAD, type PadEvent, type PadState } from '../padEvent';
import { DHT22_RESPONSE_START_US } from '../models/dht22';
import '../index';

function makePort(hz = 16_000_000) {
  let now = 0;
  const listeners = new Map<number, Set<(e: PadEvent) => void>>();
  const pads = new Map<number, PadState>();
  const port: LineHostPort & {
    edges: Array<[number, boolean, number]>;
    rests: Array<[number, boolean, boolean]>;
    releases: Array<[number, number]>;
    advance(c: number): void;
    /** The guest reboots inside the engine (an esp_restart, a deep-sleep wake): its counter starts over and the host hears nothing. */
    restart(): void;
    guest(pin: number, drive: PadState['drive']): void;
  } = {
    edges: [],
    rests: [],
    releases: [],
    now: () => now,
    clockHz: () => hz,
    scheduleEdge: (pin, level, at) => port.edges.push([pin, level, at]),
    scheduleRelease: (pin, at) => port.releases.push([pin, at]),
    onPad: (pin, cb) => {
      if (!listeners.has(pin)) listeners.set(pin, new Set());
      listeners.get(pin)!.add(cb);
      return () => listeners.get(pin)!.delete(cb);
    },
    restPad: (pin, level, driven) => port.rests.push([pin, level, driven]),
    advance: (c) => {
      now += c;
    },
    restart: () => {
      now = 0;
    },
    guest: (pin, drive) => {
      const prev = pads.get(pin) ?? INITIAL_PAD;
      const next: PadState = {
        drive,
        pull: drive === 'z' ? 1 : 0,
        level: drive !== 'low',
        cycle: now,
      };
      pads.set(pin, next);
      listeners.get(pin)?.forEach((cb) => cb({ pin, ...next, prev }));
    },
  };
  return port;
}

describe('LineSensorHub', () => {
  it('attaches a known model, rests its pads, and refuses an unknown type out loud', () => {
    const port = makePort();
    const hub = new LineSensorHub(port);
    expect(hub.attach({ sensor_type: 'no-such-sensor', pin: 3 })).toBe(false);
    expect(hub.size).toBe(0);
    expect(hub.attach({ sensor_type: 'dht22', pin: 4 })).toBe(true);
    expect(hub.size).toBe(1);
    expect(port.rests).toEqual([[4, true, false]]);
    expect(hub.attach({ sensor_type: 'hc-sr04', pin: 5, echo_pin: 6 })).toBe(true);
    expect(port.rests).toContainEqual([6, false, true]);
  });

  it('turns the guest start signal into a frame on the wire, through the timeline', () => {
    const port = makePort();
    const hub = new LineSensorHub(port);
    hub.attach({ sensor_type: 'dht22', pin: 4, temperature: 21, humidity: 40 });
    port.advance(10_000);
    port.guest(4, 'high');
    port.guest(4, 'low');
    port.advance(16 * 1100);
    port.guest(4, 'z');
    expect(port.edges).toHaveLength(84);
    expect(port.edges[0][2]).toBe(10_000 + 16 * 1100 + 16 * DHT22_RESPONSE_START_US);
    expect(port.releases).toHaveLength(1);
    expect(hub.timeline.busy).toBe(true);
    expect(hub.maySkip(port.now() + 100)).toBe(false); // 84 edges: self-timed
    expect(hub.ownsPin(4)).toBe(true);
  });

  it('a two-edge echo does not hold the clock, only fences it', () => {
    const port = makePort();
    const hub = new LineSensorHub(port);
    hub.attach({ sensor_type: 'hc-sr04', pin: 5, echo_pin: 6, distance: 20 });
    port.guest(5, 'high');
    expect(port.edges).toHaveLength(2);
    expect(hub.maySkip(port.now() + 10)).toBe(true);
    expect(hub.cyclesUntilNextEdge(port.now() + 10)).toBe(16 * 600 - 10);
    expect(hub.skipBudget(1_000_000, port.now() + 10)).toBe(16 * 600 - 10);
  });

  it('routes updates by pin and detaches cleanly', () => {
    const port = makePort();
    const hub = new LineSensorHub(port);
    hub.attach({ sensor_type: 'hc-sr04', pin: 5, echo_pin: 6, distance: 20 });
    hub.update(5, { distance: 40 });
    port.guest(5, 'high');
    const echo = port.edges[1][2] - port.edges[0][2];
    expect(echo).toBe(Math.round((40 / 17150) * 16e6));
    hub.detach(5);
    expect(hub.size).toBe(0);
    expect(hub.ownsPin(6)).toBe(false);
    port.edges.length = 0;
    port.guest(5, 'low');
    port.guest(5, 'high');
    expect(port.edges).toHaveLength(0); // unsubscribed
  });

  it('re-attaching on the same pin replaces the previous model', () => {
    const port = makePort();
    const hub = new LineSensorHub(port);
    hub.attach({ sensor_type: 'dht22', pin: 4, temperature: 1 });
    hub.attach({ sensor_type: 'dht22', pin: 4, temperature: 2 });
    expect(hub.size).toBe(1);
    port.guest(4, 'low');
    port.guest(4, 'z');
    expect(port.edges).toHaveLength(84); // one reply, not two
  });

  it('reset() forgets frames and protocol state and re-rests the pads', () => {
    const port = makePort();
    const hub = new LineSensorHub(port);
    hub.attach({ sensor_type: 'dht22', pin: 4 });
    port.guest(4, 'low');
    port.guest(4, 'z');
    expect(hub.timeline.busy).toBe(true);
    port.rests.length = 0;
    hub.reset();
    expect(hub.timeline.busy).toBe(false);
    expect(port.rests).toEqual([[4, true, false]]);
    // the half start signal before the reset is forgotten: a bare release does nothing
    port.edges.length = 0;
    port.guest(4, 'low');
    hub.reset();
    port.guest(4, 'z');
    expect(port.edges).toHaveLength(0);
  });

  it('records what it hosts, for a host that mirrors the records elsewhere', () => {
    const port = makePort();
    const hub = new LineSensorHub(port);
    hub.attach({ sensor_type: 'dht22', pin: 4, temperature: 21 });
    expect(hub.records()).toEqual([{ sensor_type: 'dht22', pin: 4, temperature: 21 }]);
  });

  it('never asks the port anything on attach beyond resting pads and subscribing', () => {
    const port = makePort();
    const spy = vi.spyOn(port, 'scheduleEdge');
    const hub = new LineSensorHub(port);
    hub.attach({ sensor_type: 'dht22', pin: 4 });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('LineSensorHub: a reboot no host announced (the guest clock goes backwards)', () => {
  // An engine that reboots in place (an esp_restart, a deep-sleep wake) starts
  // its cycle counter over and calls no host hook, so hub.reset() never runs.
  // Every gate a model keeps is an absolute cycle of the uptime that ended.
  const SECOND = 16_000_000;

  /** A DHT22 start signal: held low for 1.1 ms, then released to the pull-up. */
  function startSignal(port: ReturnType<typeof makePort>, pin: number): void {
    port.guest(pin, 'low');
    port.advance(16 * 1100);
    port.guest(pin, 'z');
  }

  it('a DHT22 answers the first read after the counter starts over', () => {
    const port = makePort();
    const hub = new LineSensorHub(port);
    hub.attach({ sensor_type: 'dht22', pin: 4, temperature: 21, humidity: 40 });
    port.advance(SECOND);
    startSignal(port, 4);
    expect(port.edges).toHaveLength(84);

    port.restart();
    port.edges.length = 0;
    port.advance(16_000);
    startSignal(port, 4);
    expect(port.edges).toHaveLength(84);
    expect(port.edges[0][2]).toBe(16_000 + 16 * 1100 + 16 * DHT22_RESPONSE_START_US);
    expect(hub.maySkip(port.now() + 100)).toBe(false); // the new reply holds the floor
  });

  it('an HC-SR04 answers the first ping after the counter starts over', () => {
    const port = makePort();
    const hub = new LineSensorHub(port);
    hub.attach({ sensor_type: 'hc-sr04', pin: 5, echo_pin: 6, distance: 20 });
    port.advance(SECOND);
    port.guest(5, 'high');
    port.advance(16 * 10);
    port.guest(5, 'low');
    expect(port.edges).toHaveLength(2);

    port.restart();
    port.edges.length = 0;
    port.advance(1000);
    port.guest(5, 'high');
    expect(port.edges).toEqual([
      [6, true, 1000 + 16 * 600],
      [6, false, 1000 + 16 * 600 + Math.round((20 / 17150) * 16e6)],
    ]);
  });

  it('an IR receiver puts the next button press on the wire after the counter starts over', () => {
    const port = makePort();
    const hub = new LineSensorHub(port);
    hub.attach({ sensor_type: 'ir-nec', pin: 7, address: 0, command: 0x16 });
    port.advance(SECOND);
    hub.update(7, { seq: 1 });
    const frameEdges = port.edges.length;
    expect(frameEdges).toBeGreaterThan(60);

    port.restart();
    port.edges.length = 0;
    port.advance(1000);
    hub.update(7, { seq: 2 });
    expect(port.edges).toHaveLength(frameEdges);
    expect(port.edges[0]).toEqual([7, false, 1000 + 16 * 100]);
  });

  it("a held key reaches the keypad's row at the cycle the column goes low, not at one of the old uptime", () => {
    const port = makePort();
    const hub = new LineSensorHub(port);
    hub.attach({
      sensor_type: 'matrix-keypad',
      pin: 10,
      rows: [10, 11],
      cols: [12, 13],
      pressed: [[0, 0]],
    });
    port.advance(SECOND);
    port.guest(10, 'z');
    port.guest(12, 'low');
    port.guest(12, 'z');
    expect(port.edges.some(([pin, level]) => pin === 10 && !level)).toBe(true);

    port.restart();
    port.edges.length = 0;
    port.advance(1000);
    port.guest(12, 'low');
    expect(port.edges.find(([pin]) => pin === 10)).toEqual([10, false, 1000]);
  });

  it('puts every pad back at rest once, at the first call that shows the counter went back', () => {
    const port = makePort();
    const hub = new LineSensorHub(port);
    hub.attach({ sensor_type: 'dht22', pin: 4 });
    hub.attach({ sensor_type: 'hc-sr04', pin: 5, echo_pin: 6 });
    port.advance(SECOND);
    port.guest(5, 'high');
    port.rests.length = 0;

    port.restart();
    port.advance(1000);
    expect(hub.maySkip(port.now())).toBe(true); // the new uptime's engine loop asks first
    expect(port.rests).toEqual([
      [4, true, false],
      [6, false, true],
    ]);
    port.advance(1000);
    port.guest(5, 'low');
    hub.maySkip(port.now());
    expect(port.rests).toHaveLength(2); // once per restart, not once per call
  });

  it("a skip query sees the restart too: a read that falls inside the old reply's window is answered", () => {
    const port = makePort();
    const hub = new LineSensorHub(port);
    hub.attach({ sensor_type: 'dht22', pin: 4 });
    port.advance(SECOND);
    startSignal(port, 4);
    const oldRelease = port.now();
    expect(port.edges).toHaveLength(84);

    port.restart();
    port.advance(500);
    hub.maySkip(port.now()); // the engine loop, early in the new uptime
    // The new uptime's read starts after the old one's release and ends inside
    // its reply: the counter shows no step back at the read itself.
    port.advance(oldRelease + 1000 - port.now());
    startSignal(port, 4);
    expect(port.edges).toHaveLength(2 * 84);
  });

  it('negative control: a counter that only moves forward keeps every gate and every pad', () => {
    const port = makePort();
    const hub = new LineSensorHub(port);
    hub.attach({ sensor_type: 'dht22', pin: 4 });
    port.advance(SECOND);
    startSignal(port, 4);
    port.rests.length = 0;
    // Two calls in the same cycle are not a step back either.
    hub.maySkip(port.now());
    hub.maySkip(port.now());
    port.advance(16 * 100);
    startSignal(port, 4); // inside the 5 ms reply: the sensor is not listening
    expect(port.edges).toHaveLength(84);
    expect(port.rests).toHaveLength(0);
    expect(hub.maySkip(port.now())).toBe(false); // still the first reply's floor
  });

  it("negative control: the host's own reboot hook is not taken for a second restart", () => {
    const port = makePort();
    const hub = new LineSensorHub(port);
    hub.attach({ sensor_type: 'dht22', pin: 4 });
    port.advance(SECOND);
    startSignal(port, 4);
    port.restart();
    port.rests.length = 0;
    hub.reset(); // the host's boot hook (EngineLineHost.reboot)
    port.advance(1000);
    hub.maySkip(port.now());
    port.edges.length = 0;
    startSignal(port, 4);
    expect(port.edges).toHaveLength(84);
    expect(port.rests).toEqual([[4, true, false]]); // once, by reset()
  });
});
