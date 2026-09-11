/**
 * Store-driven pre-flight verification, shared by the Run button
 * (EditorToolbar) and any programmatic runner (extensions can gate their own
 * run paths on the same rules). Builds the worst-case snapshot and solves it.
 *
 * Returns null when there is nothing analysable yet or the solver failed to
 * converge; callers treat null as "don't block".
 */

import { useSimulatorStore } from '../../store/useSimulatorStore';
import { buildInputFromStore } from '../spice/storeAdapter';
import { boardPinGroupFor } from '../spice/boardPinGroups';
import type { PinSourceState } from '../spice/types';
import { buildNetlist } from '../spice/NetlistBuilder';
import { verifyCircuit, occupiedSourcePairs, sourcePairKey, type VerificationResult } from './circuitVerifier';

/** The slice of the simulator store the pre-flight reads. */
export interface PreflightState {
  components: Array<{ id: string; metadataId: string; properties: Record<string, unknown> }>;
  wires: Array<{ id: string; start: { componentId: string; pinName: string }; end: { componentId: string; pinName: string } }>;
  boards: Array<{ id: string; boardKind: string }>;
}

export interface PreflightSnapshot {
  snap: {
    components: PreflightState['components'];
    wires: PreflightState['wires'];
    boards: Array<{ id: string; boardKind: string; pinStates: Record<string, PinSourceState> }>;
  };
  /** `${boardId}:${pinName}` of every board source the pre-flight invented. */
  synthesizedPins: Set<string>;
}

/**
 * The worst-case snapshot the Run button verifies: every wired digital pin
 * forced HIGH at the board's vcc. This is what we want because the user's
 * sketch WILL eventually do `digitalWrite(pin, HIGH)` (otherwise why is the
 * LED wired?). Testing idle state would never flag a missing series resistor
 * because the LED draws zero current when its pin is LOW.
 *
 * Caveat: pins wired only to inputs (e.g. a pull-up resistor + button) get
 * over-driven here too. The verifier rules are already tolerant: a properly
 * spec'd pull-up sees minimal current and does not trip overcurrent /
 * overpower. A circuit that would actually fault under HIGH is flagged.
 *
 * Exported so the gallery gate tests verify exactly what the button verifies.
 */
export function buildPreflightSnapshot(state: PreflightState): PreflightSnapshot {
  const synthesizedPins = new Set<string>();
  // Look BEFORE inventing: build the canvas once with no board sources at all
  // and read which node pairs a component ideal source already holds, and
  // which net each wired board pin sits on. A pin whose (net, ground) pair is
  // taken is an INPUT by construction (a Grove sensor module driving its SIG
  // pad, a logic gate's output into a pin the sketch reads): forcing it HIGH
  // would only manufacture the source-conflict the check then reports. That
  // is exactly what refused every Grove analog example on the XIAO for three
  // days (project/gallery-libraries-2026-09, cause G). Two GPIOs on one net
  // (a board-to-board link) get ONE synthesized source, not two fighting.
  // If the bare canvas cannot even be built, fall back to the old rule: the
  // verify below will fail the same way and the caller treats that as
  // "don't block".
  let occupied = new Set<string>();
  let pinNet = new Map<string, string>();
  try {
    const bare = buildNetlist({
      ...buildInputFromStore({
        components: state.components,
        wires: state.wires,
        boards: state.boards.map((b) => ({ id: b.id, boardKind: b.boardKind, pinStates: {} })),
      }),
      analysis: { kind: 'op' },
    });
    occupied = occupiedSourcePairs(bare.netlist);
    pinNet = bare.pinNetMap;
  } catch {
    /* unbuildable: stamp as before */
  }
  const synthesizedNets = new Set<string>();
  const boards = state.boards.map((b) => {
    const pinStates: Record<string, PinSourceState> = {};
    const group = boardPinGroupFor(b.boardKind as never);
    const wiredPinNames = new Set<string>();
    for (const w of state.wires) {
      if (w.start.componentId === b.id) wiredPinNames.add(w.start.pinName);
      if (w.end.componentId === b.id) wiredPinNames.add(w.end.pinName);
    }
    for (const pinName of wiredPinNames) {
      // Skip GND / power-rail pin names: they belong to the rail groups and
      // do not need to be re-asserted as digital sources. Aux pins included:
      // without this, "5V" would parseInt to pin 5 and get driven as a GPIO.
      if (group.gnd.includes(pinName)) continue;
      if (group.vcc_pins.includes(pinName)) continue;
      if (group.aux?.pins.includes(pinName)) continue;
      const arduinoPin = Number.parseInt(pinName, 10);
      // Skip pins we cannot identify as a digital GPIO ('AREF', 'RESET',
      // 'TX', 'RX' on some boards): rail-ish or not driven by the sketch.
      if (Number.isNaN(arduinoPin)) continue;
      const net = pinNet.get(`${b.id}:${pinName}`);
      if (net !== undefined) {
        // A board GPIO source is stamped as `V_<board>_<pin> <net> 0`, so the
        // pair it would occupy is (net, ground). Held already -> demote.
        if (occupied.has(sourcePairKey(net, '0'))) continue;
        // One invented source per net: the second GPIO on a shared net is the
        // other end of a link, and two ideal sources there is a conflict the
        // real sketch would never produce (one side reads).
        if (synthesizedNets.has(net)) continue;
        synthesizedNets.add(net);
      }
      pinStates[pinName] = { type: 'digital', v: group.vcc };
      synthesizedPins.add(`${b.id}:${pinName}`);
    }
    return { id: b.id, boardKind: b.boardKind, pinStates };
  });
  return { snap: { components: state.components, wires: state.wires, boards }, synthesizedPins };
}

export async function verifyCircuitFromStore(): Promise<VerificationResult | null> {
  try {
    const sim = useSimulatorStore.getState();
    // Skip if the circuit has not got anything analysable on it yet.
    const hasSource = sim.components.some(
      (c) =>
        c.metadataId.startsWith('signal-generator') ||
        c.metadataId.startsWith('battery') ||
        c.metadataId.startsWith('power-supply'),
    );
    if (!hasSource && sim.boards.length === 0) return null;

    const { snap, synthesizedPins } = buildPreflightSnapshot({
      components: sim.components.map((c) => ({ id: c.id, metadataId: c.metadataId, properties: c.properties })),
      wires: sim.wires,
      boards: sim.boards.map((b) => ({ id: b.id, boardKind: b.boardKind })),
    });
    const input = buildInputFromStore(snap);
    const result = await verifyCircuit(input, { synthesizedPins });
    // Concise outcome log: verification failing silently in production is
    // hard to spot otherwise (the rules read 0 A when currents are missing).
    console.log(
      '[verify]',
      JSON.stringify({
        errors: result.errors.map((e) => e.code),
        warnings: result.warnings.map((w) => w.code),
        solved: !!result.solve,
        branches: result.solve ? Object.keys(result.solve.branchCurrents) : null,
        nodes: result.solve ? Object.keys(result.solve.nodeVoltages) : null,
      }),
    );
    return result;
  } catch (err) {
    console.warn('[verifyCircuit] failed', err);
    return null;
  }
}
