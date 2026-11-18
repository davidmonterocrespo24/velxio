/**
 * NetlistBuilder — turn a Velxio circuit (components + wires + board pin
 * state) into a complete ngspice netlist string.
 *
 * Algorithm (see plan phase_8_velxio_implementation §5):
 *   1. Union-Find on wires to identify nets.
 *   2. Canonicalize known-special nets: GND → "0", VCC/VDD/5V/3V3 → "vcc_rail"
 *      (a part's VCC pin only where no supply reaches its net),
 *      off-voltage board supply pins (VIN / 5V on a 3.3 V board, 3.3 V on a
 *      5 V board) → per-voltage "aux_rail_*" nets.
 *   3. Auto-name remaining nets "n0", "n1", ... deterministically.
 *   4. Detect floating nodes (no DC path to 0) → add auto pull-down 100 MΩ.
 *   5. Emit component cards via `componentToSpice`.
 *   6. Emit board GPIO source cards (digital or PWM quasi-static).
 *   7. Emit the Vcc rail source.
 *   8. Append `.model` / `.subckt` cards for every used device.
 *   9. Append analysis card (`.op` / `.tran` / `.ac`).
 *  10. `.end`.
 */
import { UnionFind } from './unionFind';
import { parseValueWithUnits } from './valueParser';
import { componentToSpice, logicGateLinks } from './componentToSpice';
import { auxRailNetName, isAuxRailNet } from './boardPinGroups';
import { hasInternalNets, breadboardGroupKey } from '../../utils/breadboardNets';
import type {
  AnalysisMode,
  BuildNetlistInput,
  ComponentForSpice,
  BoardForSpice,
  WireForSpice,
  SwitchMemoryCell,
  NodeMemoryCell,
} from './types';
import {
  largestTimeConstant,
  settledStepS,
  settleSeconds,
  startsAwayFromSteadyState,
} from './settleTime';

/** True for any self-driven supply net: ground, the main rail, or an aux rail. */
function isRailNet(net: string): boolean {
  return net === '0' || net === 'vcc_rail' || isAuxRailNet(net);
}

/**
 * Union the wired pins that a part shorts internally — a breadboard's 5-hole
 * columns and power rails, or the sockets a carrier board wires in parallel.
 * That connectivity is static, so it is modelled at the union-find level —
 * no SPICE cards needed — which makes it equally visible to buildNetlist,
 * the circuit verifier, and the overlay net maps (all of which run their own
 * bare union-find over wires).
 */
function unionBreadboardGroups(
  uf: UnionFind,
  components: ReadonlyArray<{ id: string; metadataId: string }>,
  wires: WireForSpice[],
  pinKey: (componentId: string, pinName: string) => string,
): void {
  for (const comp of components) {
    if (!hasInternalNets(comp.metadataId)) continue;
    const anchors = new Map<string, string>(); // groupKey → first pin key
    for (const pinName of pinsReferencedByWires(comp.id, wires)) {
      const group = breadboardGroupKey(comp.metadataId, pinName);
      if (!group) continue;
      const key = pinKey(comp.id, pinName);
      uf.add(key);
      const anchor = anchors.get(group);
      if (anchor) {
        uf.union(anchor, key);
      } else {
        anchors.set(group, key);
      }
    }
  }
}

// Matches GND, VSS, VEE, GROUND and any numbered ground pin in the common
// spellings boards actually emit: GND.1 / GND.2 (dotted), GND2 / GND3 (bare),
// GND_2 (underscore). Several dev-kit board elements label their extra ground
// pad "GND2" (no dot), which previously fell through and floated.
export const GROUND_PIN_RE = /^(gnd|vss|vee|ground)([._]?\d+)?$/i;
// Deliberately excludes "V+" / "V-" (which are probe terminals) and
// "VBB" (non-standard). VCC-like pins on boards are handled via the
// board.vccPinNames list, not this regex.
export const VCC_PIN_RE = /^(vcc|vdd|vcc_rail|5v|3v3|3\.3v)$/i;
/** The `vcc_rail` node named anywhere in a card: as a terminal or inside V(). */
const VCC_RAIL_TOKEN = /\bvcc_rail\b/;

/** metadataId prefixes of components that must NOT be auto-canonicalized
 *  by the pin-name regex (their pins are just probe labels). */
function skipCanonicalization(metadataId: string): boolean {
  return metadataId.startsWith('instr-');
}

/**
 * Sanitize a component / board / pin id for use inside a SPICE identifier
 * (V-source name, etc.). ngspice's interactive `alter` command treats `-`
 * as an arithmetic / range operator and silently no-ops on hyphenated
 * source names — so even though the netlist *parser* tolerates hyphens
 * via the regex on line 206, mid-simulation MCU pin transitions stop
 * propagating after the first solve. Substituting `-` → `_` here keeps
 * the identifier ngspice-safe AND consistent with whatever the scheduler
 * passes to `alter`. Must be reused by MixedModeScheduler when building
 * the alter target name.
 */
export function sanitizeSpiceId(id: string): string {
  return id.replace(/-/g, '_');
}

export interface BuildNetlistResult {
  netlist: string;
  /** "boardId:pinName" → SPICE net name, from the same UF used to build the netlist. */
  pinNetMap: Map<string, string>;
  /**
   * Every SPICE net name in the circuit except canonical "0" (ground).
   * Includes `vcc_rail` plus all auto-named nets (n0, n1, ...).  Used
   * by CircuitSimulationService to ask the solver for every node
   * voltage in one shot (vectorsOfInterest).
   */
  nets: string[];
  /**
   * Every voltage source name in the circuit (without the leading
   * `V` prefix is NOT how ngspice names them — they include the V).
   * Examples: `V_VCC_RAIL`, `V_uno_9`, `V_led1_sense`. Used to
   * request branch currents (`i(v_<name>)`).
   */
  voltageSources: string[];
  /**
   * Nets that are backed by a real electrical source/element — a power rail
   * ('0' / 'vcc_rail'), a board GPIO V-source, an internal pull resistor, or
   * any net a componentToSpice mapper emitted a card for (resistor, button
   * switch, divider, etc.). Excludes purely-floating nets (which only get the
   * step-7 auto-pull-down). `connectDigitalInputsToMcu` drives an MCU input pin
   * from the solve ONLY when its net is in here, so event-driven parts with no
   * SPICE model (rotary encoder, keypad, dialer, dip-switch, stepper) keep
   * driving their own pins via the part layer instead of being forced LOW by a
   * floating-net read.
   */
  sourcedNets: Set<string>;
  /**
   * Nets of wired board pins (rails excepted) that a part powers: net -> the
   * ids of those parts. A battery's or a bench supply's +, a generator's
   * output or a regulator's VOUT on the pin, directly or through connections
   * (an ammeter, a closed switch), with the part's return on ground
   * (poweredBy). Such a pin is an input the part drives: the pre-flight does
   * not force it HIGH (verifyFromStore), and a sketch that drives it anyway
   * fights the part (circuitVerifier, findPinDriveConflicts).
   */
  partPoweredNets: Map<string, string[]>;
  /**
   * Board pads (their V-source names, lower case) whose network holds no
   * capacitor or inductor: the nets the pad reaches through the parts wired
   * to it, not through a supply rail or ground. Such a load answers each
   * level at once, so a PWM pad there is exactly its two states weighted by
   * the duty (CircuitSimulationService). Behind a reactive part the PWM's
   * mean voltage is what the part integrates, and the pad stays at it.
   */
  staticPads: Set<string>;
  /**
   * The analysis the netlist's card runs: the input's, with a transient that
   * asked to `settle` given its start-up (`start`, TSTART), the end of the
   * run (`stop`) and, when the deck holds a diode, a finer `step`
   * (settledStepS). The solve must run this one, not the input's.
   */
  analysis: AnalysisMode;
  /**
   * The switches with memory in the deck (a relay's armature), with the state
   * each one starts in (BuildNetlistInput.memory). The circuit service reads
   * their control nodes after a solve to know where they ended.
   */
  memoryCells: SwitchMemoryCell[];
  /** The latch nets the deck seeds (.nodeset), with their seeds. */
  nodeMemoryCells: NodeMemoryCell[];
}

export function buildNetlist(input: BuildNetlistInput): BuildNetlistResult {
  const { components, wires, boards, analysis, extraCards = [], memory } = input;

  // ── 1. Union-Find over wires ─────────────────────────────────────────────
  const uf = new UnionFind();
  const pinKey = (componentId: string, pinName: string) => `${componentId}:${pinName}`;

  // Seed every pin referenced by a wire (components pins are added on demand).
  // Phase 4: when a wire has `length_cm` set, its endpoints stay in separate
  // nets and a R_wire_<id> card is emitted later (step 7).
  const resistiveWires: typeof wires = [];
  for (const w of wires) {
    const a = pinKey(w.start.componentId, w.start.pinName);
    const b = pinKey(w.end.componentId, w.end.pinName);
    uf.add(a);
    uf.add(b);
    if (w.length_cm !== undefined && w.length_cm > 0) {
      resistiveWires.push(w);
    } else {
      uf.union(a, b);
    }
  }

  // Breadboards: join wired holes that share an internal strip/rail.
  unionBreadboardGroups(uf, components, wires, pinKey);

  // ── 2. Canonicalize ground / VCC / aux-rail pins ─────────────────────────
  // Aux rails actually referenced by this circuit: net name → volts. Used to
  // emit one ideal source per aux rail in step 6.
  const auxRailVolts = new Map<string, number>();
  // Aux rails above their board's logic rail: VIN / 5V / VBUS / VSYS of a
  // 3.3 V board, the side the board takes its power in on (step 6).
  const inputRails = new Set<string>();
  for (const board of boards) {
    const auxNet = board.auxVolts !== undefined ? auxRailNetName(board.auxVolts) : null;
    const auxPins = new Set(auxNet ? (board.auxPinNames ?? []) : []);
    for (const pinName of board.groundPinNames ?? []) {
      uf.setCanonical(pinKey(board.id, pinName), '0');
    }
    for (const pinName of board.vccPinNames ?? []) {
      uf.setCanonical(pinKey(board.id, pinName), 'vcc_rail');
    }
    if (auxNet) {
      auxRailVolts.set(auxNet, board.auxVolts!);
      if (board.auxVolts! > board.vcc) inputRails.add(auxNet);
      for (const pinName of auxPins) {
        uf.setCanonical(pinKey(board.id, pinName), auxNet);
      }
    }
    // Fallback: any board pin a wire references whose name looks like a
    // ground pin (GND, GND.1, GND.9, etc.) is canonicalized to "0" even if
    // it's not in `groundPinNames`. Boards with many GND pins (ESP32-C3
    // dev kits ship up to 10) often miss some in the per-board list, which
    // would leave wires connected to those pins floating instead of grounded.
    // Aux pins are exempt from the VCC fallback — a "5V" pin on a 3.3 V
    // board matches VCC_PIN_RE but must stay on its aux rail.
    for (const pinName of pinsReferencedByWires(board.id, wires)) {
      if (GROUND_PIN_RE.test(pinName)) {
        uf.setCanonical(pinKey(board.id, pinName), '0');
      } else if (!auxPins.has(pinName) && VCC_PIN_RE.test(pinName)) {
        uf.setCanonical(pinKey(board.id, pinName), 'vcc_rail');
      }
    }
  }
  // A part's pin names hint at a rail too, but only on a net no board pin
  // names: a board's supply and ground pins are facts, a part's names are a
  // guess. A potentiometer wired with its power pins swapped (its GND on the
  // board's 3V3) turned the whole 3V3 net into ground (ground wins a clash),
  // no rail source was emitted, and everything on that rail solved at 0 V
  // (velxio/velxio-prod#21). Nets with only parts keep the hint.
  const boardNamed = new Set<string>();
  for (const board of boards) {
    for (const pinName of [
      ...(board.groundPinNames ?? []),
      ...(board.vccPinNames ?? []),
      ...(board.auxVolts !== undefined ? (board.auxPinNames ?? []) : []),
      ...pinsReferencedByWires(board.id, wires),
    ]) {
      const key = pinKey(board.id, pinName);
      if (uf.has(key) && isRailNet(uf.find(key))) boardNamed.add(uf.root(key));
    }
  }
  const dominantVcc = boards[0]?.vcc ?? 5;
  const hinted = (pinRe: RegExp, apply: (key: string) => void) => {
    for (const comp of components) {
      if (skipCanonicalization(comp.metadataId)) continue;
      for (const pinName of pinsReferencedByWires(comp.id, wires)) {
        const key = pinKey(comp.id, pinName);
        if (!boardNamed.has(uf.root(key)) && pinRe.test(pinName)) apply(key);
      }
    }
  };
  hinted(GROUND_PIN_RE, (key) => uf.setCanonical(key, '0'));
  // A VCC pin is a guess as well, and a supply the user wired beats it. On a
  // net that a battery, a bench supply, a generator or a regulator holds, or
  // that one reaches through a switch, an ammeter or any series part, the
  // pin is powered by that source. Joined to the logic rail instead, it put
  // two ideal sources against each other: a pot on a 9 V battery read
  // 2.50 V, the battery pushed 2.67 A into the hidden rail and Run called it
  // a short; a generator or a 7805 on a pot's VCC left no solution at all
  // (velxio/velxio-prod#102). Nets no supply reaches keep the hint.
  const supplied = suppliedRoots(uf, components, resistiveWires, pinKey, dominantVcc);
  hinted(VCC_PIN_RE, (key) => {
    if (!supplied.has(uf.root(key))) uf.setCanonical(key, 'vcc_rail');
  });

  // ── 3. Auto-name remaining nets deterministically ────────────────────────
  const netNames = assignDeterministicNetNames(uf);

  // Helper: pin → net name (null if pin isn't in any net)
  function netLookup(componentId: string, pinName: string): string | null {
    const key = pinKey(componentId, pinName);
    if (!uf.has(key)) return null;
    return netNames.get(uf.find(key)) ?? null;
  }

  // ── 4. Emit component cards ───────────────────────────────────────────────
  const cards: string[] = [];
  const modelLines = new Set<string>();
  // Nets backed by a real source/element (see BuildNetlistResult.sourcedNets).
  // Rails are always sourced; component + GPIO-source + pull nets are added
  // below. Deliberately NOT populated from the step-7 auto-pull-down cards,
  // since those mark FLOATING nets.
  const sourcedNets = new Set<string>(['0', 'vcc_rail', ...auxRailVolts.keys()]);
  // Parts that declare nets they power, with their own cards (step 6), and
  // every part's cards, for what they join with no voltage or load of their
  // own (connectionPairs). Taken from the parts alone: a pin the sketch
  // drives LOW (step 5) is a 0 V source, and it is not a wire to ground for a
  // part that powers that pin (poweredBy). Read only when a part powers
  // something, which most canvases never ask.
  const powering: PoweringPart[] = [];
  const emitted: Array<{ id: string; cards: readonly string[] }> = [];
  let connectionsOfParts: PartConnections[] | null = null;
  const partConnections = (): PartConnections[] =>
    (connectionsOfParts ??= emitted
      .map(({ id, cards: own }) => ({ id, pairs: connectionPairs(own) }))
      .filter((c) => c.pairs.length > 0));
  // The non-rail nets each emitted part joins, and whether it stores energy
  // (a C or L card), for BuildNetlistResult.staticPads.
  const partNets: Array<{ nets: string[]; reactive: boolean }> = [];

  // Logic gates on a feedback loop (an SR latch): they drive their pins
  // through an output resistance and the deck seeds their nets (step 8), so
  // the latch settles in a state instead of on its unstable midpoint
  // (velxio/velxio-prod#147).
  const latch = findLatches(components, (id, pin) => netLookup(id, pin));
  const memoryCells: SwitchMemoryCell[] = [];
  for (const comp of components) {
    const localLookup = (pinName: string) => netLookup(comp.id, pinName);
    const operated = memory?.switches?.get(comp.id);
    const emission = componentToSpice(comp, localLookup, {
      vcc: dominantVcc,
      operated,
      ...(latch.nets.size > 0 ? { latchNets: latch.nets } : {}),
    });
    if (!emission) continue;
    cards.push(...emission.cards);
    if (emission.memory) memoryCells.push({ id: comp.id, ...emission.memory, seed: operated === true });
    if (emission.supplies?.length) powering.push({ id: comp.id, supplies: emission.supplies, cards: emission.cards });
    emitted.push({ id: comp.id, cards: emission.cards });
    for (const m of emission.modelsUsed) modelLines.add(m);
    // Every net this component connects to now has a real SPICE element on it.
    const joined = new Set<string>();
    for (const pinName of pinsReferencedByWires(comp.id, wires)) {
      const n = netLookup(comp.id, pinName);
      if (!n) continue;
      sourcedNets.add(n);
      if (!isRailNet(n)) joined.add(n);
    }
    partNets.push({
      nets: [...joined],
      reactive: emission.cards.some((c) => /^[CL]/i.test(c)),
    });
  }

  // ── 5. Board GPIO sources ─────────────────────────────────────────────────
  // Hyphens are kept in the V-source name (NetlistBuilder regex on line 206
  // captures `[_\w-]*`), so ngspice itself can parse + load the source and
  // expose the branch current as `v_<board>-<pin>#branch` — visible in the
  // canvas voltmeters / branch-current map. BUT ngspice's *interactive*
  // `alter` command treats `-` as an operator and silently no-ops on
  // hyphenated source names — making MCU pin transitions stop propagating
  // after the very first solve. So MixedModeScheduler.onMcuPinChange must
  // build the same sanitized name we emit here. See sanitizeSpiceId().
  // Set when an internal pull-up is stamped to vcc_rail but no wired pin
  // referenced VCC — we must still emit the rail source (step 6) or the
  // pull-up would hang off a dead node and the input would read LOW anyway.
  let vccRailNeeded = false;
  // The nodes between a pin's source and its output impedance.
  const padNodes = new Set<string>();
  for (const board of boards) {
    for (const [pinName, state] of Object.entries(board.pins)) {
      const net = netLookup(board.id, pinName);
      if (state.type === 'input') {
        // Internal pull-up / pull-down (INPUT_PULLUP / INPUT_PULLDOWN): a weak
        // resistor to the rail so the idle level is correct. 45 kΩ matches the
        // ESP32 internal pull and is weak enough that any real external driver
        // or pull (<= 10 kΩ) dominates. An input is never driven otherwise.
        if (state.pull && net && !isRailNet(net)) {
          const rail = state.pull === 1 ? 'vcc_rail' : '0';
          if (state.pull === 1) vccRailNeeded = true;
          cards.push(
            `R_pull_${sanitizeSpiceId(board.id)}_${sanitizeSpiceId(pinName)} ${net} ${rail} 45000`,
          );
          // NOTE: deliberately do NOT add this net to sourcedNets. An internal
          // pull ALONE must not make connectDigitalInputsToMcu drive the pin —
          // else an INPUT_PULLUP pin wired to an event-driven part with no SPICE
          // model (rotary encoder, keypad, …) would be pinned at the idle pull
          // level and clobber the part's own pulses. A net counts as
          // source-backed only when a real component card / rail also touches it
          // (button switch, divider, cross-board output). The pull resistor is
          // still stamped so component-driven nets read the correct idle level.
        }
        continue;
      }
      if (!net) continue;
      const v = state.type === 'digital' ? state.v : state.duty * board.vcc;
      const source = `V_${sanitizeSpiceId(board.id)}_${sanitizeSpiceId(pinName)}`;
      const ohms = board.pinOutputOhms ?? 0;
      if (ohms > 0) {
        // A real output pin: its driver behind the pin's output impedance
        // (velxio/velxio-prod#140). The source keeps its name, so the
        // scheduler's alters and the branch current, which is the pin's
        // current, are unchanged; its own node sits between the two. A pin on
        // a rail gets its driver too: driven HIGH into GND it is the short it
        // is on hardware, which the run checks (verify/pinCurrent).
        const pad = `pad_${sanitizeSpiceId(board.id)}_${sanitizeSpiceId(pinName)}`;
        cards.push(`${source} ${pad} 0 DC ${v}`);
        cards.push(`R_${sanitizeSpiceId(board.id)}_${sanitizeSpiceId(pinName)}_out ${pad} ${net} ${ohms}`);
        padNodes.add(pad);
        if (!isRailNet(net)) sourcedNets.add(net);
        continue;
      }
      if (isRailNet(net)) continue; // already served by a rail source
      cards.push(`${source} ${net} 0 DC ${v}`);
      sourcedNets.add(net); // board GPIO V-source drives this net (e.g. cross-board input)
    }
  }

  // A pin that loads its net inside the chip (BoardForSpice.pinLoads): an
  // ATmega's AREF, the 32 kOhm input of its ADC reference. Only where a wire
  // lands on it; a rail is held by its own source.
  for (const board of boards) {
    for (const [pinName, ohms] of Object.entries(board.pinLoads ?? {})) {
      const net = netLookup(board.id, pinName);
      if (!net || isRailNet(net) || !(ohms > 0)) continue;
      cards.push(`R_${sanitizeSpiceId(board.id)}_${sanitizeSpiceId(pinName)}_load ${net} 0 ${ohms}`);
      sourcedNets.add(net);
    }
  }

  // ── 6. Vcc rail source (if any pin referenced it, or a card uses it) ─────
  // A card can name the rail without any wired pin on it: an internal
  // pull-up, or an LM358 whose V+ pin is unwired (its macro-model takes
  // `vcc_rail` as its supply). On a canvas with no board nothing else named
  // the rail, no source was emitted, and the op-amp's supply floated: every
  // op-amp example in the analog gallery solved to nonsense
  // (velxio/velxio-prod#126).
  const vccRailEmitted =
    hasNet(netNames, 'vcc_rail') || vccRailNeeded || cards.some((c) => VCC_RAIL_TOKEN.test(c));
  if (vccRailEmitted) {
    cards.unshift(`V_VCC_RAIL vcc_rail 0 DC ${dominantVcc}`);
  }
  // One ideal source per referenced aux rail, at ITS voltage — so a VIN/5V
  // pin on a 3.3 V board solves at 5 V instead of being clamped to the main
  // rail, and vice versa on 5 V Arduinos' 3.3 V pin.
  //
  // Except a board's power INPUT that a part powers. VIN / 5V of a 3.3 V
  // board is where the board takes power in: its USB 5 V arrives there
  // through a Schottky diode (the Pico's VBUS -> VSYS, a DevKit's VIN), and a
  // supply, a battery or a regulator wired there with its return on the
  // board's GND feeds the same pin. The higher of the two powers the board.
  // As an ideal 5 V source the rail fought the part instead: a 9 V supply on
  // an ESP32's VIN read 5 V and sat at its current limit, which blocked Run
  // whatever the limit (velxio/velxio-prod#96). So there the board's 5 V is
  // emitted behind that diode: a part above it powers the pin at its own
  // voltage, one below it is held off and back-driven, which the circuit
  // check names. The board's logic rail (3V3) and a 5 V board's 3.3 V pin are
  // its regulators' outputs and keep their ideal source, and so does an input
  // wired to one: an ESP32-CAM's 5V and an Uno's 5V on one breadboard rail
  // are a single net, and a 9 V battery there back-feeds the Uno's regulator.
  for (const board of boards) {
    const auxIsOutput = board.auxVolts !== undefined && board.auxVolts <= board.vcc;
    const auxPins = new Set(board.auxVolts !== undefined ? (board.auxPinNames ?? []) : []);
    const outputs = [
      ...(board.vccPinNames ?? []),
      ...(auxIsOutput ? auxPins : []),
      // The pins step 2 puts on the logic rail by their name.
      ...pinsReferencedByWires(board.id, wires).filter((p) => !auxPins.has(p) && VCC_PIN_RE.test(p)),
    ];
    for (const pin of outputs) {
      const key = pinKey(board.id, pin);
      if (uf.has(key)) inputRails.delete(uf.find(key));
    }
  }
  const powered = poweredBy(inputRails, powering, partConnections);
  for (const [auxNet, volts] of auxRailVolts) {
    if (!hasNet(netNames, auxNet)) continue;
    const name = `V_${auxNet.toUpperCase()}`;
    if (powered.has(auxNet)) {
      const own = `board_${auxNet}`;
      cards.unshift(`D_${auxNet.toUpperCase()} ${own} ${auxNet} ${BOARD_INPUT_DIODE}`);
      cards.unshift(`${name} ${own} 0 DC ${volts}`);
      modelLines.add(BOARD_INPUT_DIODE_MODEL);
    } else {
      cards.unshift(`${name} ${auxNet} 0 DC ${volts}`);
    }
  }

  // ── 6.5. Wire resistance (Phase 4) ───────────────────────────────────────
  // Wires marked with length_cm get a resistor between their endpoint nets.
  // R = 0.01 ohm/cm — order-of-magnitude correct for AWG 22 copper hookup
  // wire — enough to show voltage drop on long buses without dominating
  // ordinary circuit behaviour.  Emitted before pull-down detection so the
  // resistors count as DC paths between their endpoints.
  for (const w of resistiveWires) {
    const cm = w.length_cm ?? 0;
    if (cm <= 0) continue;
    const ohms = Math.max(0.01, 0.01 * cm);
    const a = netLookup(w.start.componentId, w.start.pinName);
    const b = netLookup(w.end.componentId, w.end.pinName);
    if (!a || !b) continue;
    cards.push(`R_wire_${w.id} ${a} ${b} ${ohms}`);
    sourcedNets.add(a);
    sourcedNets.add(b);
    partNets.push({ nets: [a, b].filter((n) => !isRailNet(n)), reactive: false });
  }

  // ── 6.6. Board pads that drive a static load ──────────────────────────────
  // A pad's network is every net it reaches through the parts wired to it. A
  // supply rail or ground is a fixed potential, not a path: a decoupling
  // capacitor across 5V/GND does not make an LED on a pad reactive. Coarse on
  // purpose — a part joins all its nets — so the doubt falls on the reactive
  // side, where the pad keeps today's mean-voltage model.
  const padGroup = new Map<string, string>();
  const groupOf = (n: string): string => {
    let r = n;
    while (padGroup.has(r) && padGroup.get(r) !== r) r = padGroup.get(r)!;
    padGroup.set(n, r);
    return r;
  };
  for (const { nets } of partNets) {
    for (let i = 1; i < nets.length; i++) {
      const a = groupOf(nets[0]!);
      const b = groupOf(nets[i]!);
      if (a !== b) padGroup.set(b, a);
    }
  }
  const reactiveGroups = new Set<string>();
  for (const { nets, reactive } of partNets) {
    if (reactive && nets.length > 0) reactiveGroups.add(groupOf(nets[0]!));
  }
  const staticPads = new Set<string>();
  for (const board of boards) {
    for (const [pinName, state] of Object.entries(board.pins)) {
      if (state.type === 'input') continue;
      const net = netLookup(board.id, pinName);
      if (!net || isRailNet(net)) continue;
      if (reactiveGroups.has(groupOf(net))) continue;
      staticPads.add(`v_${sanitizeSpiceId(board.id)}_${sanitizeSpiceId(pinName)}`.toLowerCase());
    }
  }

  // ── 7. Auto pull-downs for floating nets ─────────────────────────────────
  const floating = detectFloatingNets(netNames, cards, padNodes);
  for (const net of floating) {
    cards.push(`R_autopull_${net} ${net} 0 100Meg`);
  }

  // ── 8. Compose netlist ────────────────────────────────────────────────────
  const lines: string[] = [`* Velxio circuit @ ${new Date().toISOString()}`];
  lines.push(...cards);
  lines.push(...modelLines);
  // Latch seeds: where each latch net was at the last solve, or a power-up
  // state (the first gate of each loop low, the next high, ...).
  const nodeMemoryCells: NodeMemoryCell[] = latch.outputs.map((o) => {
    const remembered = memory?.nodes?.get(o.key);
    const seed =
      remembered !== undefined && Number.isFinite(remembered)
        ? Math.round(remembered * 1000) / 1000
        : o.powerUpHigh
          ? dominantVcc
          : 0;
    return { key: o.key, net: o.net, threshold: dominantVcc / 2, seed };
  });
  if (nodeMemoryCells.length > 0) {
    lines.push(`.nodeset ${nodeMemoryCells.map((c) => `V(${c.net})=${c.seed}`).join(' ')}`);
  }
  lines.push(...extraCards);

  // A transient that asked to settle runs the circuit's start-up first,
  // computed but not stored (TSTART), sized from the deck's own cards, when
  // its operating point at t = 0 is not its steady state (settleTime.ts).
  let resolved: AnalysisMode = analysis;
  if (analysis.kind === 'tran' && analysis.settle && startsAwayFromSteadyState(cards)) {
    const stepS = parseValueWithUnits(analysis.step);
    const windowS = parseValueWithUnits(analysis.stop);
    const startS = settleSeconds(largestTimeConstant(cards), stepS, analysis.period);
    if (startS > 0 && windowS > 0) {
      // A diode's conduction pulses want a finer step than the window's.
      const runStepS = settledStepS(cards, stepS);
      resolved = {
        ...analysis,
        ...(runStepS !== stepS ? { step: runStepS.toExponential(3) } : {}),
        start: startS.toExponential(6),
        stop: (startS + windowS).toExponential(6),
      };
    }
  }
  switch (resolved.kind) {
    case 'op':
      lines.push('.op');
      break;
    case 'tran':
      lines.push(
        resolved.start
          ? `.tran ${resolved.step} ${resolved.stop} ${resolved.start}`
          : `.tran ${resolved.step} ${resolved.stop}`,
      );
      break;
    case 'ac': {
      const kind = resolved.type ?? 'dec';
      const points = resolved.points ?? 20;
      const fstart = resolved.fstart ?? 1;
      const fstop = resolved.fstop ?? 1e6;
      lines.push(`.ac ${kind} ${points} ${fstart} ${fstop}`);
      break;
    }
  }
  lines.push('.end');

  // ── 9. Build (component|board) pin → net map from the same UF ────────────
  // Every wire endpoint is in the UF. Including component-pin entries (not
  // just board pins) lets the MixedModeScheduler bridge route SPICE voltages
  // to component subscribers downstream of active devices. Legacy ADC
  // injection still works — it only looks up board-prefixed keys.
  const pinNetMap = new Map<string, string>();
  for (const w of wires) {
    for (const endpoint of [w.start, w.end]) {
      const key = pinKey(endpoint.componentId, endpoint.pinName);
      if (!uf.has(key)) continue;
      const netName = netNames.get(uf.find(key));
      if (netName) pinNetMap.set(key, netName);
    }
  }

  // ── 10. Enumerate every net + voltage source for the solve options ───────
  // Distinct, non-ground nets — every node the solver should report. A rail
  // only a card names (step 6) is a node too.
  const nets = Array.from(new Set(netNames.values())).filter((n) => n !== '0');
  if (vccRailEmitted && !nets.includes('vcc_rail')) nets.push('vcc_rail');
  // Voltage sources are any card starting with `V` (uppercase) followed
  // by an underscore or digit.  ngspice's case-insensitive match means
  // both `Vname` and `vname` count.  We emit only uppercase prefixes
  // from componentToSpice + NetlistBuilder, so this regex is safe.
  //
  // The character class MUST include `-` (hyphen). Component ids in
  // examples and user-drawn circuits commonly contain hyphens
  // (`led-builtin`, `led-red`, auto-generated `led-1717…-abc`), and
  // SPICE itself happily parses identifiers with hyphens. If the regex
  // doesn't accept them it truncates the captured name at the first
  // hyphen ⇒ wrong voltageSources entry ⇒ CircuitSimulationService
  // asks ngspice for the WRONG branch-current vector ⇒ branchCurrents
  // lookup returns undefined ⇒ LED brightness stays at zero even though
  // the circuit conducts correctly. Single-character fix, but it
  // unblocks every hyphenated id across every existing project.
  const voltageSources: string[] = [];
  for (const card of cards) {
    const m = card.match(/^([Vv][_\w-]*)\s/);
    if (m) voltageSources.push(m[1]);
  }

  // ── 11. Board pins a part powers (BuildNetlistResult.partPoweredNets) ────
  const boardPinNets = new Set<string>();
  for (const board of boards) {
    for (const pinName of pinsReferencedByWires(board.id, wires)) {
      const net = netLookup(board.id, pinName);
      if (net && !isRailNet(net)) boardPinNets.add(net);
    }
  }

  return {
    netlist: lines.join('\n'),
    pinNetMap,
    nets,
    voltageSources,
    sourcedNets,
    partPoweredNets: poweredBy(boardPinNets, powering, partConnections),
    staticPads,
    analysis: resolved,
    memoryCells,
    nodeMemoryCells,
  };
}

/**
 * The logic gates on a feedback loop: a gate whose output reaches one of its
 * own inputs through other gates (an SR latch is two). Returns the nets those
 * outputs drive and, in component order, each output pin with the net and
 * its power-up state: alternately low and high around each loop, so a
 * two-gate latch powers up with its first gate's output low.
 */
function findLatches(
  components: ReadonlyArray<ComponentForSpice>,
  netOf: (componentId: string, pinName: string) => string | null,
): { nets: Set<string>; outputs: Array<{ key: string; net: string; powerUpHigh: boolean }> } {
  const edges = new Map<string, Set<string>>();
  const drivers: Array<{ key: string; net: string }> = [];
  for (const comp of components) {
    for (const gate of logicGateLinks(comp.metadataId) ?? []) {
      const out = netOf(comp.id, gate.output);
      if (!out || isRailNet(out)) continue;
      drivers.push({ key: `${comp.id}:${gate.output}`, net: out });
      for (const pin of gate.inputs) {
        const inp = netOf(comp.id, pin);
        if (!inp || isRailNet(inp)) continue;
        if (!edges.has(inp)) edges.set(inp, new Set());
        edges.get(inp)!.add(out);
      }
    }
  }
  if (drivers.length === 0) return { nets: new Set(), outputs: [] };
  // Strongly connected components (Tarjan): a net is on a loop when its
  // component has more than one net, or it feeds itself.
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const sccOf = new Map<string, number>();
  let counter = 0;
  let sccCount = 0;
  const strong = (v: string): void => {
    index.set(v, counter);
    low.set(v, counter);
    counter++;
    stack.push(v);
    onStack.add(v);
    for (const w of edges.get(v) ?? []) {
      if (!index.has(w)) {
        strong(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v)!, index.get(w)!));
      }
    }
    if (low.get(v) === index.get(v)) {
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        sccOf.set(w, sccCount);
      } while (w !== v);
      sccCount++;
    }
  };
  for (const v of edges.keys()) if (!index.has(v)) strong(v);
  const size = new Map<number, number>();
  for (const c of sccOf.values()) size.set(c, (size.get(c) ?? 0) + 1);
  const onLoop = (net: string): boolean => {
    const c = sccOf.get(net);
    if (c === undefined) return false;
    return (size.get(c) ?? 0) > 1 || (edges.get(net)?.has(net) ?? false);
  };
  const nets = new Set<string>();
  const outputs: Array<{ key: string; net: string; powerUpHigh: boolean }> = [];
  const seen = new Map<number, number>();
  const seenNets = new Set<string>();
  for (const d of drivers) {
    if (!onLoop(d.net) || seenNets.has(d.net)) continue;
    seenNets.add(d.net);
    nets.add(d.net);
    const c = sccOf.get(d.net)!;
    const k = seen.get(c) ?? 0;
    seen.set(c, k + 1);
    outputs.push({ key: d.key, net: d.net, powerUpHigh: k % 2 === 1 });
  }
  return { nets, outputs };
}

// ── Helpers ────────────────────────────────────────────────────────────────

function pinsReferencedByWires(componentId: string, wires: WireForSpice[]): string[] {
  const pins = new Set<string>();
  for (const w of wires) {
    if (w.start.componentId === componentId) pins.add(w.start.pinName);
    if (w.end.componentId === componentId) pins.add(w.end.pinName);
  }
  return [...pins];
}

function assignDeterministicNetNames(uf: UnionFind): Map<string, string> {
  const reps = [...uf.nets()].sort();
  const out = new Map<string, string>();
  let counter = 0;
  for (const rep of reps) {
    if (isRailNet(rep)) {
      out.set(rep, rep);
    } else {
      // Strip characters ngspice doesn't like from auto-names
      out.set(rep, `n${counter++}`);
    }
  }
  return out;
}

/** Card letters whose first two nodes conduct DC between them. */
const SERIES_CARD = /^[RLDVSBEH]/i;

/** A V card's value says it holds no voltage: a series sense source. */
const ZERO_VOLTS = /^(dc\s+)?0+(\.0*)?$/i;

/**
 * The union-find roots of the nets an explicit supply reaches, where a part's
 * VCC pin is powered by what is wired to it and must not join the logic rail.
 *
 * Supplies reach through series parts: a board rail, or a net a part
 * declares it powers (a battery's or a bench supply's positive terminal, a
 * generator's output, a regulator's VOUT), and every net those reach through
 * the parts' own cards (resistors, switches, diodes, sense sources, a
 * transistor's channel), stopping at ground. Other outputs (an op-amp's OUT,
 * a logic gate's Y, a custom chip's pin: a V, B, E or H card, or a declared
 * `drives` net) count only on their own net: through its feedback resistors
 * an op-amp output reached the pot that sets its input, and the pot lost the
 * rail it runs from.
 *
 * The parts are emitted once with provisional net names for this. A part
 * that supplies or drives a net never conducts here (a battery would
 * otherwise carry its positive net through itself onto its negative side),
 * and neither does a subcircuit (an LM358 would join its inputs to its
 * supply pins).
 */
function suppliedRoots(
  uf: UnionFind,
  components: ReadonlyArray<ComponentForSpice>,
  resistiveWires: ReadonlyArray<WireForSpice>,
  pinKey: (componentId: string, pinName: string) => string,
  vcc: number,
): Set<string> {
  // Provisional names: the rails and ground keep theirs, every other net a
  // token no mapper can mistake for anything else.
  const tokenOfRoot = new Map<string, string>();
  const token = (key: string): string => {
    const name = uf.find(key);
    if (isRailNet(name)) return name;
    const root = uf.root(key);
    let t = tokenOfRoot.get(root);
    if (!t) tokenOfRoot.set(root, (t = `__net${tokenOfRoot.size}`));
    return t;
  };
  // Nodes outside any one part: wired nets, and ground as cards write it.
  const external = new Set<string>(['0']);
  const adj = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    if (a === b) return;
    if (!adj.has(a)) adj.set(a, new Set());
    if (!adj.has(b)) adj.set(b, new Set());
    adj.get(a)!.add(b);
    adj.get(b)!.add(a);
  };
  const supplies = new Set<string>();
  const driven = new Set<string>();

  for (const comp of components) {
    const emission = componentToSpice(
      comp,
      (pinName) => {
        const key = pinKey(comp.id, pinName);
        if (!uf.has(key)) return null;
        const t = token(key);
        external.add(t);
        return t;
      },
      { vcc },
    );
    if (!emission) continue;
    const own = new Set([...(emission.supplies ?? []), ...(emission.drives ?? [])]);
    for (const n of emission.supplies ?? []) supplies.add(n);
    const pairs: Array<[string, string]> = [];
    for (const card of emission.cards) {
      const t = card.trim().split(/\s+/);
      const kind = (t[0] ?? '').charAt(0).toUpperCase();
      if (kind === 'Q') {
        pairs.push([t[1]!, t[3]!], [t[2]!, t[3]!]); // C-E channel, B-E junction
        continue;
      }
      if (kind === 'M') {
        pairs.push([t[1]!, t[3]!]); // the D-S channel; the gate is insulated
        continue;
      }
      if (!SERIES_CARD.test(kind) || t.length < 3) continue;
      const value = t.slice(3).join(' ');
      // A behavioural source written as a current (I = ...) holds no voltage.
      if (kind === 'B' && !/^v\s*=/i.test(value)) continue;
      pairs.push([t[1]!, t[2]!]);
      // A V card holds a voltage unless it is a 0 V sense source in series
      // with the part (one end inside the part); a 0 V source between two
      // wired nets (a generator turned to 0 V) still pins them together.
      const holds =
        kind === 'V'
          ? !ZERO_VOLTS.test(value) || (external.has(t[1]!) && external.has(t[2]!))
          : kind === 'B' || kind === 'E' || kind === 'H';
      if (holds && external.has(t[1]!)) own.add(t[1]!);
    }
    if (own.size > 0) {
      for (const n of own) driven.add(n);
    } else {
      for (const [a, b] of pairs) link(a, b);
    }
  }
  for (const w of resistiveWires) {
    const a = pinKey(w.start.componentId, w.start.pinName);
    const b = pinKey(w.end.componentId, w.end.pinName);
    if (uf.has(a) && uf.has(b)) link(token(a), token(b));
  }

  // Board rails supply what they reach, as a source's output does.
  for (const name of uf.nets()) if (isRailNet(name) && name !== '0') supplies.add(name);
  const reached = new Set<string>([...driven].filter((n) => n !== '0'));
  const queue = [...supplies];
  const spread = new Set<string>();
  while (queue.length) {
    const n = queue.shift()!;
    if (n === '0' || spread.has(n)) continue;
    spread.add(n);
    reached.add(n);
    for (const m of adj.get(n) ?? []) if (!spread.has(m)) queue.push(m);
  }
  const out = new Set<string>();
  for (const [root, t] of tokenOfRoot) if (reached.has(t)) out.add(root);
  return out;
}

/** Card letters that tie their first two nodes together, for poweredBy. */
const HOLDING_CARD = /^[RLVBEH]$/;

/**
 * The diode a board's USB 5 V reaches its VIN / 5V pin through, when a part
 * powers that pin too: a 1 A Schottky of the kind dev boards fit (SS14,
 * B5819W, MBR120), 0.32 V at 0.1 A and 0.48 V at 1 A, 1 µA backwards.
 */
const BOARD_INPUT_DIODE = 'D_BOARD_INPUT';
const BOARD_INPUT_DIODE_MODEL = `.model ${BOARD_INPUT_DIODE} D(Is=1e-6 N=1.05 Rs=0.1)`;

/**
 * A series resistance this small is a connection, not a load: the netlist's
 * own closed switch contacts and button legs are 10 mΩ, an ammeter's shunt
 * 1 mΩ. Under 10 mV at 1 A, less than a bench supply's own output resistance.
 */
const CONNECTION_OHMS = 0.01;

/**
 * Node pairs a netlist joins with no voltage or load of its own: a 0 V sense
 * source (an ammeter's, an LED's, a regulator's), or a resistance of at most
 * CONNECTION_OHMS (a closed switch, an ammeter's shunt, a 1 cm wire). Takes
 * card lines; anything else (comments, models, directives) is skipped.
 */
export function connectionPairs(lines: readonly string[]): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const line of lines) {
    const t = line.trim().split(/\s+/);
    if (t.length < 4) continue;
    const kind = (t[0] ?? '').charAt(0).toUpperCase();
    const value = t.slice(3).join(' ');
    if (kind === 'V' && ZERO_VOLTS.test(value)) out.push([t[1]!, t[2]!]);
    else if (kind === 'R' && t.length === 4 && Math.abs(parseValueWithUnits(t[3], Infinity)) <= CONNECTION_OHMS) {
      out.push([t[1]!, t[2]!]);
    }
  }
  return out;
}

/** A part that declares the nets it powers, with its own cards (step 4). */
interface PoweringPart {
  id: string;
  supplies: readonly string[];
  cards: readonly string[];
}

/** The connections (connectionPairs) of one part's own cards. */
interface PartConnections {
  id: string;
  pairs: ReadonlyArray<[string, string]>;
}

/**
 * Which of `nets` a part powers, and which parts: net -> their ids. A part
 * powers a net when it declares one it supplies (a battery's or a bench
 * supply's +, a generator's output, a regulator's VOUT) that is that net or
 * is joined to it by other parts' connections (connectionPairs: an ammeter,
 * a closed switch), and its own cards hold that supply net against ground
 * through the same kind of connections. A part whose return does not reach
 * ground that way, through a resistor say, holds the net against nothing;
 * nor does one behind an open switch.
 *
 * One rule for two questions: whether a part powers a 3.3 V board's VIN / 5V
 * input (step 6, where the board's own 5 V then sits behind its USB diode),
 * and whether a part drives a board pin, which is then the input it is
 * (BuildNetlistResult.partPoweredNets). The connections are the parts' own
 * (step 4), so a pin the sketch drives LOW is not a wire to ground; and a
 * part's own cards never say where its output sits, so a generator set to
 * DC 0 V (a 0 V card, which reads as a wire) still drives its pin.
 */
function poweredBy(
  nets: Iterable<string>,
  powering: readonly PoweringPart[],
  partConnections: () => readonly PartConnections[],
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const candidates = [...nets];
  if (candidates.length === 0 || powering.length === 0) return out;
  const fields = (card: string) => card.trim().split(/\s+/);
  const connections = partConnections();
  for (const part of powering) {
    // `joined`: the nets as the other parts' connections join them.
    // `held`: the same with this part's own cards, which hold its output.
    const joined = new UnionFind();
    const held = new UnionFind();
    for (const { id, pairs } of connections) {
      for (const [a, b] of pairs) {
        held.union(a, b);
        if (id !== part.id) joined.union(a, b);
      }
    }
    for (const card of part.cards) {
      const t = fields(card);
      const kind = (t[0] ?? '').charAt(0).toUpperCase();
      if (!HOLDING_CARD.test(kind) || t.length < 3) continue;
      // A behavioural source written as a current (I = ...) holds no voltage.
      if (kind === 'B' && !/^v\s*=/i.test(t.slice(3).join(' '))) continue;
      held.union(t[1]!, t[2]!);
    }
    const ground = held.find('0');
    const outputs = new Set<string>();
    for (const net of part.supplies) {
      if (joined.find(net) !== joined.find('0') && held.find(net) === ground) outputs.add(joined.find(net));
    }
    if (outputs.size === 0) continue;
    for (const net of candidates) {
      if (!outputs.has(joined.find(net))) continue;
      const ids = out.get(net) ?? [];
      if (!ids.includes(part.id)) ids.push(part.id);
      out.set(net, ids);
    }
  }
  return out;
}

function hasNet(netNames: Map<string, string>, name: string): boolean {
  for (const v of netNames.values()) if (v === name) return true;
  return false;
}

/** Index of a card's last token that is not a `param=value`: a device's model or a subcircuit's name. */
function lastNameIndex(t: readonly string[]): number {
  for (let i = t.length - 1; i > 0; i--) if (!t[i]!.includes('=')) return i;
  return -1;
}

/**
 * The nodes a netlist card joins by a DC path, read by the syntax of its
 * element letter, whatever the nodes are called. A part's internal node (a
 * supply's or a battery's `<id>_int`, an ammeter's `amm_<id>_mid`, an LED's
 * `<id>_sense_mid`) is a node like any other: the walk used to read a card's
 * nodes only while they were canvas nets, so one of those ended the card,
 * and every net reached only through such a part got a pull-down it did not
 * need. Two ammeters in one loop then disagreed and a MOSFET gate drew
 * 100 nA through its 100 MOhm (velxio/velxio-prod#99).
 *
 *   - R, L, V, I, B, F, H, W: their two nodes. A current source (I, F, a B
 *     written as I = ...) holds no voltage; it has always counted as a path.
 *   - E, G: their two output nodes. S: the switch's two nodes (Ron or Roff
 *     between them). The control nodes of these are only sensed.
 *   - D: anode and cathode. Q: collector, base and emitter. J, Z: drain,
 *     gate and source. SPICE stamps GMIN across every pn junction, so a node
 *     reached only through a junction is never singular and needs no
 *     pull-down: an LED held off by a transistor carried 35 nA through one.
 *   - M: drain and source (the channel, and a VDMOS's body diode), with the
 *     bulk when the card has one (its junctions). The gate is insulated.
 *   - X: every node before the subcircuit's name (optimistic: a subcircuit
 *     is taken to join its pins).
 *   - C and anything else: none. A capacitor is open at DC.
 */
function dcPathNodes(card: string): string[] {
  const t = card.trim().split(/\s+/);
  if (t.length < 3) return [];
  switch (t[0]!.charAt(0).toUpperCase()) {
    case 'R':
    case 'L':
    case 'V':
    case 'I':
    case 'B':
    case 'F':
    case 'H':
    case 'W':
    case 'E':
    case 'G':
    case 'S':
    case 'D':
      return [t[1]!, t[2]!];
    case 'Q':
    case 'J':
    case 'Z':
      return t.length >= 5 ? [t[1]!, t[2]!, t[3]!] : [];
    case 'M': {
      const model = lastNameIndex(t);
      if (model < 4) return [];
      return model >= 5 ? [t[1]!, t[3]!, t[4]!] : [t[1]!, t[3]!];
    }
    case 'X': {
      const name = lastNameIndex(t);
      return name > 1 ? t.slice(1, name) : [];
    }
    default:
      return [];
  }
}

/**
 * Detect nets that lack a DC path to ground.
 *
 * Does a graph walk starting from node "0" and "vcc_rail" (both have a
 * hard-wired source in every circuit that references them), traversing the
 * DC paths of every card (dcPathNodes): resistors, inductors, sources,
 * switches, junctions, a MOSFET's channel, subcircuits. A part's internal
 * nodes join the walk like any other node, but only canvas nets are ever
 * reported.
 *
 * Capacitors (C...) are intentionally NOT conductive in this walk — they are
 * OPEN at DC, so a net connected only via a C to another node is still
 * floating; and so is one reached only through a MOSFET's gate or the
 * control input of a controlled source.
 *
 * An older version of this function used a "touched-by-R" heuristic: a net
 * was marked safe if ANY resistor terminal referenced it. That was wrong for
 * topologies like `V0-R1-n0-R2-n1-C-0` where n0 and n1 are chained through
 * R's but neither has a DC path to ground (shipping RC-low-pass example).
 * The graph walk fixes that — it only considers a net safe when a DC path
 * actually traces back to node "0".
 *
 * Returns the set of nets that should receive an auto 100 MΩ pull-down.
 */
function detectFloatingNets(
  netNames: Map<string, string>,
  cards: string[],
  internalNodes: ReadonlySet<string> = new Set(),
): Set<string> {
  // Internal nodes (a pin's driver behind its output impedance) are paths
  // like any net, so a load reached through one is not floating.
  const nets = new Set([...netNames.values(), ...internalNodes]);

  // Build an undirected adjacency list over the DC paths of every card: the
  // nodes a card joins (dcPathNodes) are all connected to one another.
  const adj = new Map<string, Set<string>>();
  function ensure(n: string) {
    if (!adj.has(n)) adj.set(n, new Set());
    return adj.get(n)!;
  }
  function link(a: string, b: string) {
    if (a === b) return;
    ensure(a).add(b);
    ensure(b).add(a);
  }

  for (const line of cards) {
    const nodes = dcPathNodes(line);
    for (let i = 1; i < nodes.length; i++) link(nodes[0]!, nodes[i]!);
  }

  // BFS from node "0" plus every present rail ("vcc_rail" / "aux_rail_*" —
  // each has a V_..._RAIL → 0 source edge whenever it is referenced).
  const reachable = new Set<string>();
  const queue: string[] = ['0'];
  if (adj.has('vcc_rail')) queue.push('vcc_rail');
  for (const n of adj.keys()) {
    if (isAuxRailNet(n)) queue.push(n);
  }
  while (queue.length) {
    const n = queue.shift()!;
    if (reachable.has(n)) continue;
    reachable.add(n);
    const neigh = adj.get(n);
    if (!neigh) continue;
    for (const m of neigh) if (!reachable.has(m)) queue.push(m);
  }

  const floating = new Set<string>();
  for (const net of nets) {
    if (isRailNet(net)) continue;
    if (!reachable.has(net)) floating.add(net);
  }
  return floating;
}

/**
 * Build a wireId → netName map: the net of each wire's start pin, exactly as
 * buildNetlist names it. Lightweight (no SPICE call) — suitable for the
 * overlay to look up voltages.
 *
 * This used to repeat buildNetlist's union-find and drifted from it more
 * than once (a wire with a length, a board GND pin missing from its list):
 * the n0/n1 names are positional, so any drift made a consumer read a
 * neighbouring node. The rails a part's VCC pin joins now depend on the
 * supplies wired to it (velxio/velxio-prod#102), so it asks buildNetlist.
 */
export function buildWireNetMap(
  input: Pick<BuildNetlistInput, 'components' | 'wires' | 'boards'>,
): Map<string, string> {
  const { pinNetMap } = buildNetlist({ ...input, analysis: { kind: 'op' } });
  const result = new Map<string, string>();
  for (const w of input.wires) {
    const netName = pinNetMap.get(`${w.start.componentId}:${w.start.pinName}`);
    if (netName) result.set(w.id, netName);
  }
  return result;
}


/** Re-export types for callers. */
export type { BuildNetlistInput, ComponentForSpice, BoardForSpice, WireForSpice } from './types';
