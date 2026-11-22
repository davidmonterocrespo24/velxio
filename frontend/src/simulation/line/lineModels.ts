/**
 * lineModels — the registry of line-owning sensor models, and the shape of
 * one.
 *
 * A line-owning sensor is a device that answers the guest on a wire the guest
 * also drives (DHT22, DS18B20, an IR demodulator) or on a companion wire it
 * pulses back (HC-SR04's ECHO). Its MODEL is real per-device behaviour — the
 * waveform it answers with — and belongs in one file per device under
 * `./models/`. Everything else about hosting such a sensor is generic and
 * lives in {@link LineSensorHub}: which pad events reach the model, where its
 * edges go, how its pads are claimed, and when the board's clock may skip.
 *
 * Adding a sensor is therefore two data edits and no code edits anywhere else:
 * one entry in `simulation/sensorModels.ts` (the canvas-facing declaration:
 * which component pins carry data, which properties the model reads) and one
 * `registerLineModel(sensorType, factory)` call in a new file under
 * `./models/`. No simulator, bridge or engine learns the sensor's name; they
 * only ever see frames and cycle counts.
 */

import type { PadEvent } from './padEvent';
import type { HostEdgeFrame } from './LineTimeline';

/** What a model needs from the board's clock. */
export interface LineClock {
  /** Current guest cycle. */
  now(): number;
  /**
   * Microseconds to guest cycles at the frequency THE GUEST HAS CONFIGURED, not
   * the chip maximum. `core.cycles` is the guest's own counter, and a driver
   * measures a pulse as (fall - rise) / its configured MHz; a fixture on the
   * bare-IDF 160 MHz default once decoded an injected 15 cm as 22.5 cm because
   * the host used the chip's 240 MHz.
   */
  us(microseconds: number): number;
}

/**
 * What a model puts on the wire in answer to one event: nothing, one frame, or
 * one frame per line. A single-wire sensor answers on its own line; a device
 * that joins several lines (a keypad's held key shorts a row to a column)
 * changes more than one of them in the same instant.
 */
export type LineFrames = HostEdgeFrame | readonly HostEdgeFrame[] | null;

/** The frames of a {@link LineFrames}, as a list. */
export function framesOf(out: LineFrames | void): readonly HostEdgeFrame[] {
  if (!out) return [];
  return 'pin' in out ? [out] : out;
}

/** A pad's resting state when nobody is talking on it. */
export interface PadRest {
  pin: number;
  level: boolean;
  /**
   * `true`: the sensor holds the level itself (an HC-SR04 drives ECHO low
   * between pings). `false`: the line is released and the level is what the
   * pull produces (a DHT22's DATA idles on its pull-up). The distinction
   * matters to engines that model host ownership of a pad: a released line
   * must not be host-owned, or the guest's next start signal becomes
   * unobservable.
   */
  driven: boolean;
}

export interface LineModel {
  /** Board pins the model must hear guest pad events on. */
  readonly listens: readonly number[];
  /** Board pins the model drives, so they can be claimed. */
  readonly drives: readonly number[];
  /** Resting state of each driven pin, applied at attach and reset. */
  rest(): PadRest[];
  /**
   * One guest pad event on a pin from `listens`. Return the frame (or frames,
   * one per line) to put on the wire, or null. Host-originated edges never
   * arrive here: a simulator reports the GUEST's drive state, and an injected
   * input changes none of it.
   */
  onPad(e: PadEvent, clock: LineClock): LineFrames;
  /**
   * New values from the canvas (a slider moved, a button was pressed).
   * Unknown keys are ignored.
   *
   * A model may return a frame here. Most do not: a DHT answers when the
   * guest asks, so a slider only changes what the NEXT answer carries. But a
   * device that speaks unprompted — an IR demodulator with a remote pointed
   * at it — has no guest event to hang a frame on, and pressing the button
   * on the canvas IS the event. Returning a frame puts it on the wire at the
   * current cycle, with the same timing guarantees as an answer. `clock` is
   * there for that: a model that only stores values ignores it.
   */
  update(props: Record<string, unknown>, clock: LineClock): LineFrames | void;
  /**
   * Forget protocol state: the board rebooted. The host says so at its own
   * boot; a reboot inside the engine (an esp_restart, a deep-sleep wake) the
   * hub infers from the guest's cycle count going back, and calls this then
   * too, so a gate kept as an absolute cycle needs no check of its own.
   */
  reset(): void;
}

/**
 * The record the canvas hands over: `sensor_type`, the resolved board GPIO
 * of the data (or trigger) pin, extra pins by field name (`echo_pin`), and
 * the property values (`temperature`, `distance`, …). Same shape the wire
 * protocol to a backend worker carries, so one record serves both hosts.
 */
export interface LineSensorRecord {
  sensor_type: string;
  pin: number;
  [field: string]: unknown;
}

export type LineModelFactory = (rec: LineSensorRecord) => LineModel;

const factories = new Map<string, LineModelFactory>();

/** Register the model for one `sensor_type`. Re-registering replaces. */
export function registerLineModel(sensorType: string, factory: LineModelFactory): void {
  factories.set(sensorType, factory);
}

/** Whether a model exists for `sensor_type` (what a host can promise to run). */
export function hasLineModel(sensorType: string): boolean {
  return factories.has(sensorType);
}

/** Every registered `sensor_type`. */
export function lineModelTypes(): string[] {
  return [...factories.keys()];
}

/** Build a model for a record, or null when no model is registered for it. */
export function createLineModel(rec: LineSensorRecord): LineModel | null {
  const make = factories.get(rec.sensor_type);
  return make ? make(rec) : null;
}

/** A finite number off a record field, else the default. */
export function numberField(v: unknown, dflt: number): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = parseFloat(v);
    if (Number.isFinite(n)) return n;
  }
  return dflt;
}
