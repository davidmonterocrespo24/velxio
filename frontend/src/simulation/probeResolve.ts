/**
 * Decide what a clicked wire actually carries, so the scope can probe it.
 *
 * The oscilloscope was born as a logic analyzer: channels keyed (boardId, pin)
 * and fed by GPIO transitions with CPU-cycle timestamps. That is the right
 * source when the wire really does hang off a board pin — microsecond
 * resolution, no solver involved — and the wrong one for a resistor divider,
 * which no GPIO drives.
 *
 * So resolution is ordered, best source first:
 *
 *   1. A wire endpoint sitting ON a board pin that maps to a GPIO number.
 *   2. A wire that reaches a GPIO through resistors (a series resistor into an
 *      LED still shows the driving pin's square wave). PinTrace already knows
 *      how to walk that and, importantly, tells us when the hop crossed an
 *      ACTIVE device — past a transistor the pin's logic level no longer
 *      describes this wire, so we stop trusting it — or a capacitor or an
 *      inductor, on the path or on a node of it: such a node is the pin's
 *      level filtered (an RC low-pass is the PWM's mean), not its edges.
 *   3. Otherwise the SPICE net, read as a voltage.
 *
 * Net names come from the pinNetMap the solver PUBLISHES, never from a local
 * re-derivation. Names are positional (n0, n1, ...), so any disagreement about
 * how many nets exist shifts every later name and the probe silently reports a
 * neighbouring node — the exact bug fixed in 340e207c for the voltmeter and the
 * overlay, and the reason this module reads the published map like they do.
 */

import type { Wire, WireEndpoint } from '../types/wire';
import type { BoardInstance } from '../types/board';
import { boardPinToNumber } from '../utils/boardPinMapping';
import { boardPinGroupFor } from './spice/boardPinGroups';
import { traceDetailed, type TraceState } from './PinTrace';
import { ADC_PIN_MAP } from './spice/connectAnalogInputsToMcu';

/** The ground net is a constant, and never appears in nodeVoltages. */
export const GROUND_NET = '0';

export type ProbeTarget =
  | {
      kind: 'digital';
      /** Board whose GPIO drives this wire. */
      boardId: string;
      /** GPIO number, as PinManager reports it. */
      pin: number;
      /** Logic-high voltage of that board, so a square wave sits at the right
       *  height when it shares a volts axis with an analog trace. */
      amplitudeV: number;
      label: string;
    }
  | {
      kind: 'analog';
      /** SPICE net name from the PUBLISHED pinNetMap. */
      netName: string;
      label: string;
    };

export interface ProbeContext {
  /** The simulator store state. PinTrace types its input as the whole store
   *  (TraceState = ReturnType<typeof useSimulatorStore.getState>), and passing
   *  a hand-built subset would drift the moment the tracer reads one more
   *  field. */
  state: TraceState;
  /** `${componentId}:${pinName}` -> net name, as PUBLISHED by the solver. */
  pinNetMap: Map<string, string>;
}

function boardOf(ctx: ProbeContext, componentId: string): BoardInstance | undefined {
  return ctx.state.boards.find((b) => b.id === componentId);
}

function vccOf(board: BoardInstance): number {
  return boardPinGroupFor(board.boardKind).vcc;
}

/**
 * An ADC input carries a voltage, not a logic level.
 *
 * boardPinToNumber happily maps A0 to 14 on an Uno, so without this check a
 * divider tap wired to A0 resolves DIGITAL and the scope draws a square wave
 * for an analog reading — misleading, and in practice empty, because the ADC
 * path emits no digital transitions to sample.
 */
function isAdcPin(board: BoardInstance, pinName: string): boolean {
  const pins = ADC_PIN_MAP[board.boardKind];
  return !!pins?.some((p) => p.pinName === pinName);
}

/**
 * The same question asked by PIN NUMBER, for the trace path.
 *
 * PinTrace reports where it arrived as an Arduino pin number, not a name, and
 * the number alone cannot tell an ADC input from a digital one — A0 IS pin 14.
 * Mapping the board's ADC pin names back through boardPinToNumber is what
 * closes that: without it a divider tap reached THROUGH a resistor still
 * resolved digital (observed live as a "D14" channel that drew nothing).
 */
function isAdcPinNumber(board: BoardInstance, pin: number): boolean {
  const pins = ADC_PIN_MAP[board.boardKind];
  if (!pins) return false;
  return pins.some((p) => boardPinToNumber(board.boardKind, p.pinName) === pin);
}

/** A board pin that is a real, DIGITAL GPIO. Power/ground pins return -1/null,
 *  and ADC inputs are deliberately excluded (see isAdcPin). */
function gpioAt(ctx: ProbeContext, e: WireEndpoint): { board: BoardInstance; pin: number } | null {
  const board = boardOf(ctx, e.componentId);
  if (!board) return null;
  if (isAdcPin(board, e.pinName)) return null;
  const pin = boardPinToNumber(board.boardKind, e.pinName);
  if (pin === null || pin < 0) return null;
  return { board, pin };
}

/**
 * What the scope should show for `wire`, or null when nothing observable
 * resolves (an isolated wire between two unpowered parts, before any solve).
 */
export function resolveProbe(wire: Wire, ctx: ProbeContext): ProbeTarget | null {
  const ends = [wire.start, wire.end];

  // 1. Straight onto a GPIO.
  for (const e of ends) {
    const hit = gpioAt(ctx, e);
    if (hit) {
      return {
        kind: 'digital',
        boardId: hit.board.id,
        pin: hit.pin,
        amplitudeV: vccOf(hit.board),
        label: `${e.pinName}`,
      };
    }
  }

  // 2. Through passives to a GPIO. Reuse PinTrace rather than re-walking the
  //    graph: it already models breadboard seating, passive pin pairs and the
  //    active-device rule this depends on.
  for (const e of ends) {
    let traced;
    try {
      traced = traceDetailed(ctx.state, e.componentId, e.pinName);
    } catch {
      continue; // a trace failure must never block probing
    }
    // Past a transistor / op-amp / diode the driving pin's logic level no
    // longer describes this wire; fall through to the analog path, which
    // reports what the solver actually computed here.
    if (traced.crossedActiveDevice) continue;
    // The same past a capacitor or an inductor, or on any node one of them
    // holds before the pin's own: an RC filter's output is the PWM's DC
    // level with a little ripple, not pin 9's pulses (velxio/velxio-prod#142).
    if (traced.crossedReactive) continue;
    // arduinoPin is -1 for a supply/GND pad and null when nothing was
    // reached; only a real GPIO carries a level worth plotting.
    if (traced.arduinoPin === null || traced.arduinoPin < 0) continue;
    if (!traced.boardId) continue;
    const board = boardOf(ctx, traced.boardId);
    if (!board) continue;
    // An ADC input carries a voltage; plotting it as a logic level is both
    // misleading and empty, since the ADC path emits no digital transitions.
    if (isAdcPinNumber(board, traced.arduinoPin)) continue;
    return {
      kind: 'digital',
      boardId: traced.boardId,
      pin: traced.arduinoPin,
      amplitudeV: vccOf(board),
      label: `D${traced.arduinoPin}`,
    };
  }

  // 3. The SPICE net.
  for (const e of ends) {
    const net = ctx.pinNetMap.get(`${e.componentId}:${e.pinName}`);
    if (net) {
      return {
        kind: 'analog',
        netName: net,
        // Ground has no nodeVoltages entry; the reader treats net '0' as a
        // constant 0 V rather than "no data".
        label: net === GROUND_NET ? 'GND' : net,
      };
    }
  }

  return null;
}

/** Stable channel id for a probe target, so probing the same wire twice does
 *  not stack duplicate channels. Digital keeps the historical
 *  `osc-ch-<boardId>-<pin>` shape so a wire probe and the pin picker collapse
 *  onto ONE channel when they name the same pin. */
export function probeChannelId(target: ProbeTarget): string {
  return target.kind === 'digital'
    ? `osc-ch-${target.boardId}-${target.pin}`
    : `osc-net-${target.netName}`;
}
