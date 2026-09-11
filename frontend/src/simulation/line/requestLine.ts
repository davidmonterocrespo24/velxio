/**
 * requestLine — what a canvas part calls instead of poking a simulator for
 * `schedulePinChange` and falling back to something silent when it is not
 * there.
 *
 * The part states what it is (`sensor_type`), which board pins it sits on and
 * its current property values, and gets back one of three answers:
 *
 *   local   the board's own hub attached the model; the part forwards property
 *           updates to `update()` and calls `release()` on unmount.
 *   hosted  the model runs elsewhere (a backend worker, an engine's hub) and
 *           the board was told; same two methods.
 *   none    the board cannot host this sensor. The part gets `why`, the gap is
 *           recorded for the circuit check, and nothing pretends to work.
 *
 * The part never learns which host it got, and the host never learns which
 * part asked.
 */

import { hasLineModel, type LineSensorRecord } from './lineModels';
import { isLineCapable, NO_TIMED_EDGES_WHY, type LineSupport } from './LineHost';
import './models';

export interface LineLease {
  mode: 'local' | 'hosted';
  update(props: Record<string, unknown>): void;
  release(): void;
}

export interface LineRefusal {
  mode: 'none';
  why: string;
}

export type LineAnswer = LineLease | LineRefusal;

/**
 * The legacy sensor channel a simulator may expose: `registerSensor` returns
 * true when a worker or an engine hub took the sensor. Kept as the transport
 * behind `mode: 'hosted'` so the ESP32 and STM32 shims need no new surface.
 */
interface LegacySensorChannel {
  registerSensor(type: string, pin: number, props: Record<string, unknown>): boolean;
  updateSensor(pin: number, props: Record<string, unknown>): void;
  unregisterSensor(pin: number): void;
}

/** Recorded refusals, for the circuit check to surface at Run. */
export interface LineGap {
  sensorType: string;
  pin: number;
  why: string;
  /** The canvas component that asked, when it said so — for the circuit check to point at it. */
  componentId?: string;
  /**
   * What kind of refusal this is, for the circuit check's wording. Absent for
   * a line-owning sensor the board cannot host; `no-adc` for an analog part
   * on a board with no analog input, where "will not answer" is the wrong
   * sentence — the fix is a converter chip, not a different board.
   */
  code?: string;
}

export interface LineRequestOptions {
  /** The canvas component asking, so a refusal can be attached to it. */
  componentId?: string;
}
const gaps = new Map<string, LineGap>();

/** Every refusal recorded since the last `clearLineGaps()`. */
export function lineGaps(): LineGap[] {
  return [...gaps.values()];
}

export function clearLineGaps(): void {
  gaps.clear();
}

/**
 * The key a refusal is filed under.
 *
 * Keyed by COMPONENT when the caller identifies itself, so a part that is
 * rewired replaces its own entry instead of leaving one behind. Keyed by
 * type@pin only for anonymous callers, which is what the map used to do for
 * everyone: rewire a refused DHT22 from GPIO 4 to a pin the board can host and
 * the success deleted dht22@5 while dht22@4 stayed, so the Circuit check kept
 * telling a user who had already fixed their wiring that it was still broken.
 */
function gapKey(rec: LineSensorRecord, opts?: LineRequestOptions): string {
  return opts?.componentId ? `#${opts.componentId}` : `${rec.sensor_type}@${rec.pin}`;
}

/** Drop a part's recorded refusal — call from a part's cleanup. */
export function releaseLineGap(componentId: string): void {
  gaps.delete(`#${componentId}`);
}

/**
 * Record a refusal for a part that does not go through requestLine.
 *
 * The line contract was built for sensors that OWN a wire and ask the board to
 * host their timing. An addressable-LED part consumes data instead of asking
 * for a lease, so it never called in — and its refusal was therefore invisible
 * to the verifier that exists to print exactly this. Same map, same key, same
 * Circuit-check line; only the caller is different.
 */
export function recordPartGap(gap: LineGap): void {
  gaps.set(gap.componentId ? `#${gap.componentId}` : `${gap.sensorType}@${gap.pin}`, gap);
}

function refuse(rec: LineSensorRecord, why: string, opts?: LineRequestOptions): LineRefusal {
  gaps.set(gapKey(rec, opts), {
    sensorType: rec.sensor_type,
    pin: rec.pin,
    why,
    componentId: opts?.componentId,
  });
  console.warn(`[line] ${rec.sensor_type} on pin ${rec.pin}: ${why}`);
  return { mode: 'none', why };
}

/**
 * Ask `sim` to host the sensor described by `rec`.
 *
 * Order: a `local` declaration wins (the model runs in the browser, on the
 * board's own clock); a `hosted` declaration that lists this `sensor_type`
 * goes through the legacy sensor channel; anything else is refused with the
 * board's own reason.
 */
export function requestLine(
  sim: object | null | undefined,
  rec: LineSensorRecord,
  opts?: LineRequestOptions,
): LineAnswer {
  if (!sim) return refuse(rec, 'no board is wired to this sensor', opts);
  const support: LineSupport = isLineCapable(sim)
    ? sim.lineSupport()
    : { mode: 'none', why: NO_TIMED_EDGES_WHY };

  if (support.mode === 'local') {
    if (!hasLineModel(rec.sensor_type)) {
      return refuse(rec, `no line model is registered for '${rec.sensor_type}'`, opts);
    }
    const hub = isLineCapable(sim) && sim.lineHub ? sim.lineHub() : null;
    if (!hub) return refuse(rec, 'the board declares local line support but provides no hub', opts);
    hub.attach(rec);
    gaps.delete(gapKey(rec, opts));
    return {
      mode: 'local',
      update: (props) => hub.update(rec.pin, props),
      release: () => hub.detach(rec.pin),
    };
  }

  if (support.mode === 'hosted') {
    if (!support.models.includes(rec.sensor_type)) {
      return refuse(
        rec,
        `this board's emulator models ${support.models.length ? support.models.join(', ') : 'no line sensors'}, not '${rec.sensor_type}'`,
        opts,
      );
    }
    const chan = sim as Partial<LegacySensorChannel>;
    if (typeof chan.registerSensor !== 'function') {
      return refuse(rec, 'the board declares hosted line support but has no sensor channel', opts);
    }
    const { sensor_type, pin, ...props } = rec;
    const taken = chan.registerSensor(sensor_type, pin, props);
    if (!taken) return refuse(rec, 'the host declined the sensor', opts);
    gaps.delete(gapKey(rec, opts));
    return {
      mode: 'hosted',
      update: (p) => chan.updateSensor?.(pin, { ...props, ...p }),
      release: () => chan.unregisterSensor?.(pin),
    };
  }

  return refuse(rec, support.why, opts);
}
