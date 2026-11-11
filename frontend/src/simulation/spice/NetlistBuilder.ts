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
import { componentToSpice } from './componentToSpice';
import { auxRailNetName, isAuxRailNet } from './boardPinGroups';
import { hasInternalNets, breadboardGroupKey } from '../../utils/breadboardNets';
import type { BuildNetlistInput, ComponentForSpice, BoardForSpice, WireForSpice } from './types';

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
}

export function buildNetlist(input: BuildNetlistInput): BuildNetlistResult {
  const { components, wires, boards, analysis, extraCards = [] } = input;

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

  for (const comp of components) {
    const localLookup = (pinName: string) => netLookup(comp.id, pinName);
    const emission = componentToSpice(comp, localLookup, { vcc: dominantVcc });
    if (!emission) continue;
    cards.push(...emission.cards);
    for (const m of emission.modelsUsed) modelLines.add(m);
    // Every net this component connects to now has a real SPICE element on it.
    for (const pinName of pinsReferencedByWires(comp.id, wires)) {
      const n = netLookup(comp.id, pinName);
      if (n) sourcedNets.add(n);
    }
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
      if (isRailNet(net)) continue; // already served by a rail source
      const v = state.type === 'digital' ? state.v : state.duty * board.vcc;
      cards.push(`V_${sanitizeSpiceId(board.id)}_${sanitizeSpiceId(pinName)} ${net} 0 DC ${v}`);
      sourcedNets.add(net); // board GPIO V-source drives this net (e.g. cross-board input)
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
  for (const [auxNet, volts] of auxRailVolts) {
    if (hasNet(netNames, auxNet)) {
      cards.unshift(`V_${auxNet.toUpperCase()} ${auxNet} 0 DC ${volts}`);
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
  }

  // ── 7. Auto pull-downs for floating nets ─────────────────────────────────
  const floating = detectFloatingNets(netNames, cards);
  for (const net of floating) {
    cards.push(`R_autopull_${net} ${net} 0 100Meg`);
  }

  // ── 8. Compose netlist ────────────────────────────────────────────────────
  const lines: string[] = [`* Velxio circuit @ ${new Date().toISOString()}`];
  lines.push(...cards);
  lines.push(...modelLines);
  lines.push(...extraCards);

  switch (analysis.kind) {
    case 'op':
      lines.push('.op');
      break;
    case 'tran':
      lines.push(`.tran ${analysis.step} ${analysis.stop}`);
      break;
    case 'ac': {
      const kind = analysis.type ?? 'dec';
      const points = analysis.points ?? 20;
      const fstart = analysis.fstart ?? 1;
      const fstop = analysis.fstop ?? 1e6;
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

  return {
    netlist: lines.join('\n'),
    pinNetMap,
    nets,
    voltageSources,
    sourcedNets,
  };
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

function hasNet(netNames: Map<string, string>, name: string): boolean {
  for (const v of netNames.values()) if (v === name) return true;
  return false;
}

/**
 * Detect nets that lack a DC path to ground.
 *
 * Does a graph walk starting from node "0" and "vcc_rail" (both have a
 * hard-wired source in every circuit that references them), traversing only
 * DC-conducting cards:
 *   - resistor (R...)
 *   - voltage source (V...)           — V-source is a DC short for connectivity
 *   - current source (I...)
 *   - inductor (L... — treated as DC short)
 *   - switch (S...)
 *   - behavioral source (B...)         — also connects output to ground via its KCL stamp
 *   - MNA-controlled source (E..., G..., F..., H...)
 *   - subckt instance (X...)           — optimistic: assume any X instance exposes DC paths
 *
 * Capacitors (C...) are intentionally NOT conductive in this walk — they are
 * OPEN at DC, so a net connected only via a C to another node is still floating.
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
function detectFloatingNets(netNames: Map<string, string>, cards: string[]): Set<string> {
  const nets = new Set(netNames.values());

  // Build an undirected adjacency list over DC-conducting elements.
  // For a 2-terminal element the two nets on it become connected.
  // For 3+ terminal (E/G/F/H, S, X) we connect every pair of listed nets —
  // this is conservative (over-connects), which is the safe side for a
  // "does this net have SOME DC path to ground" question.
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

  // Cards that define a DC path between their listed nets. Capacitor ('C')
  // is deliberately excluded.
  const DC_PREFIXES = 'RLVISBEGFHX';

  for (const line of cards) {
    const prefix = line[0];
    if (DC_PREFIXES.indexOf(prefix) < 0) continue;
    const tokens = line.split(/\s+/);
    // tokens[0] is the element name (e.g. "R_r1", "V_VCC_RAIL"). The nets
    // appear next; stop at the first token that isn't a valid net name.
    const pinNets: string[] = [];
    for (let i = 1; i < tokens.length; i++) {
      const t = tokens[i];
      if (!nets.has(t) && t !== '0' && t !== 'vcc_rail') break;
      pinNets.push(t);
    }
    // Connect every pair of pins — handles both 2-terminal and N-terminal.
    for (let i = 0; i < pinNets.length; i++) {
      for (let j = i + 1; j < pinNets.length; j++) {
        link(pinNets[i], pinNets[j]);
      }
    }
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
