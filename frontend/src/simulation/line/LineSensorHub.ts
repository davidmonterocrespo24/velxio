/**
 * LineSensorHub — hosts line-owning sensor models on one board.
 *
 * One instance per simulator that declares `mode: 'local'`. It is the whole of
 * the generic half: it turns a sensor record into a model, listens to the pad
 * events the model asked for, hands the frames the model returns to the
 * board's timeline, keeps the model's pins at rest between exchanges, and
 * answers the two questions the rest of the board asks — does anything own
 * this pad, and may the clock skip right now. It never dispatches on a
 * sensor's name.
 *
 * Usage from a simulator:
 *   const hub = new LineSensorHub(port);           // port: LineHostPort
 *   hub.attach({ sensor_type: 'dht22', pin: 4, temperature: 21 });
 *   // in the time-skipping path, while the guest is executing:
 *   const allowed = hub.skipBudget(want, port.now());
 *   // on reboot:
 *   hub.reset();
 *
 * A reboot the host never hears of is caught here too. An engine that reboots
 * in place (an `esp_restart`, a deep-sleep wake) starts its cycle counter over
 * and calls no hook, so `reset()` does not run. Every gate a model keeps is an
 * absolute cycle of the uptime that ended: a DHT22 ignores its line until its
 * last reply is out, and in the new count that moment comes as late as it came
 * in the old one. A sketch that read the sensor 150 ms after each boot got NaN
 * from the second boot on. So the hub, as the timeline already does with its
 * frames, takes a count lower than one it has seen for a reboot and does what
 * `reset()` does. It sees the count on every call that carries one: a pad
 * event, an update, a skip query.
 */

import { LineTimeline } from './LineTimeline';
import type { LineHostPort } from './LineHost';
import './models';
import {
  createLineModel,
  framesOf,
  type LineClock,
  type LineFrames,
  type LineModel,
  type LineSensorRecord,
} from './lineModels';

interface Attached {
  rec: LineSensorRecord;
  model: LineModel;
  unsubscribe: Array<() => void>;
}

export class LineSensorHub {
  readonly timeline: LineTimeline;
  private readonly port: LineHostPort;
  private readonly clock: LineClock;
  /** Keyed by the record's `pin` (the data or trigger pin), like the wire protocol. */
  private readonly attached = new Map<number, Attached>();
  /** The highest guest cycle a call has shown since the last reset (see `observe`). */
  private lastSeen = -Infinity;

  constructor(port: LineHostPort) {
    this.port = port;
    this.timeline = new LineTimeline(port);
    this.clock = {
      now: () => port.now(),
      us: (n) => Math.round((n * port.clockHz()) / 1_000_000),
    };
  }

  /** Number of attached sensors. */
  get size(): number {
    return this.attached.size;
  }

  /**
   * Attach a sensor. Returns false when no model is registered for its
   * `sensor_type` — the caller reports that; nothing is attached silently. A
   * record on a pin that already has a sensor replaces it.
   */
  attach(rec: LineSensorRecord): boolean {
    const model = createLineModel(rec);
    if (!model) return false;
    this.detach(rec.pin);
    const unsubscribe = model.listens.map((pin) =>
      this.port.onPad(pin, (e) => {
        this.observe(this.clock.now());
        this.emit(model.onPad(e, this.clock));
      }),
    );
    this.attached.set(rec.pin, { rec, model, unsubscribe });
    this.restPins(model);
    return true;
  }

  /**
   * New property values for the sensor keyed on `pin`. A model that speaks
   * unprompted may answer the change with a frame — see `LineModel.update`.
   */
  update(pin: number, props: Record<string, unknown>): void {
    const model = this.attached.get(pin)?.model;
    if (!model) return;
    this.observe(this.clock.now());
    this.emit(model.update(props, this.clock));
  }

  detach(pin: number): void {
    const a = this.attached.get(pin);
    if (!a) return;
    for (const u of a.unsubscribe) u();
    this.attached.delete(pin);
  }

  detachAll(): void {
    for (const pin of [...this.attached.keys()]) this.detach(pin);
  }

  /** The board rebooted: forget protocol state, forget frames, re-rest pads. */
  reset(): void {
    // The clock starts over with the board: its first count is not a step back.
    this.lastSeen = -Infinity;
    this.restart();
  }

  /** Pins any attached model drives — off limits to every other layer. */
  ownsPin(pin: number): boolean {
    for (const a of this.attached.values()) {
      if (a.model.drives.includes(pin)) return true;
    }
    return false;
  }

  /** The skip allowed to a mechanism that advances time while the guest executes. */
  skipBudget(want: number, nowCycle: number): number {
    this.observe(nowCycle);
    return this.timeline.skipBudget(want, nowCycle);
  }

  /** The floor alone: false while a self-timed frame is on the wire. */
  maySkip(nowCycle: number): boolean {
    this.observe(nowCycle);
    return this.timeline.maySkip(nowCycle);
  }

  /** The fence alone: cycles to the nearest pending edge, Infinity if none. */
  cyclesUntilNextEdge(nowCycle: number): number {
    this.observe(nowCycle);
    return this.timeline.cyclesUntilNextEdge(nowCycle);
  }

  /** The attached records, for a host that mirrors them somewhere (a worker). */
  records(): LineSensorRecord[] {
    return [...this.attached.values()].map((a) => a.rec);
  }

  /**
   * Note the guest's cycle count. A count lower than the highest one seen is a
   * reboot inside the engine that no host hook announced: every model starts
   * over and every pad goes back to rest, as at `reset()`. Equal counts are
   * not a step back: two pad events can share a cycle. A guest that sets its
   * own counter back (a WSR.CCOUNT write) is taken for a reboot too, as the
   * timeline has always taken it.
   */
  private observe(now: number): void {
    // Every slip gate of an engine comes through here: the common path is one
    // compare, and the reboot is a call of its own.
    if (now < this.lastSeen) this.rebooted(now);
    else this.lastSeen = now;
  }

  private rebooted(now: number): void {
    // Recorded first: re-resting a pad must not find the old count again.
    this.lastSeen = now;
    this.restart();
  }

  /** Forget frames and protocol state, and put every pad back at rest. */
  private restart(): void {
    this.timeline.reset();
    for (const a of this.attached.values()) {
      a.model.reset();
      this.restPins(a.model);
    }
  }

  /** Every frame of one answer goes on the wire at the same instant. */
  private emit(out: LineFrames | void): void {
    const frames = framesOf(out);
    if (!frames.length) return;
    const now = this.clock.now();
    for (const frame of frames) this.timeline.emit(frame, now);
  }

  private restPins(model: LineModel): void {
    for (const r of model.rest()) this.port.restPad(r.pin, r.level, r.driven);
  }
}
