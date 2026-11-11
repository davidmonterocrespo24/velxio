/**
 * circuitVerifier — pre-flight safety check run when the user presses Run.
 *
 * Runs a one-shot ngspice solve against the current canvas and inspects the
 * branch currents for real-world fault conditions:
 *
 *   - **Short circuit**: any voltage source delivering current well above what
 *     a sensible circuit needs (default threshold: 500 mA). Catches the
 *     classic "5 V tied straight to GND" bug.
 *   - **LED overcurrent**: forward current above the datasheet absolute max
 *     (20 mA for standard 5 mm LEDs). Catches missing or undersized series
 *     resistors.
 *   - **Resistor overpower**: I²·R > rated power (1/4 W default). Catches
 *     load resistors that would burn out in the real world.
 *   - **Disconnected indicator**: an LED that's fully wired but carries
 *     zero current — usually means the user forgot a switch / power tie.
 *
 * Results are split into `errors` (severe enough to block the user with a
 * confirm dialog) and `warnings` (non-blocking — the simulation can proceed).
 *
 * The verifier never throws; if ngspice fails to converge it returns a
 * single solver-error warning and the rest of the rules are skipped.
 */
import { lineGaps } from '../line/requestLine';
import { GROUND_PIN_RE, buildNetlist, connectionPairs, sanitizeSpiceId } from '../spice/NetlistBuilder';
import { MIN_SUPPLY_LIMIT_A } from '../spice/componentToSpice';
import { runNetlist as runSpice } from '../spice/runNetlist';
import { UnionFind } from '../spice/unionFind';
import { BOARD_PIN_GROUPS, auxRailNetName, railVolts } from '../spice/boardPinGroups';
import { breadboardGroupKey, hasInternalNets, isBreadboard } from '../../utils/breadboardNets';
import type { BuildNetlistInput, ElectricalSolveResult } from '../spice/types';
import { readValueField, unreadableValues } from '../spice/valueFields';
import { formatQuantity } from '../spice/valueParser';
import { COMPONENT_RATINGS } from './componentRatings';
import { LED_UNLIMITED_AMPS } from '../ledLimits';

export type WarningSeverity = 'error' | 'warning';
export type WarningCode =
  | 'solver-failed'
  | 'invalid-value'
  | 'source-conflict'
  | 'unstable-solve'
  | 'short-circuit'
  | 'source-overload'
  | 'supply-on-rail'
  | 'led-overcurrent'
  | 'over-voltage'
  | 'reverse-polarity'
  | 'missing-connection'
  | 'power-short'
  | 'shorted-component'
  | 'resistor-overpower'
  | 'led-no-current'
  | 'unsupported-sensor'
  | 'unpowered-net'
  | 'no-return-path'
  | 'voltage-mismatch'
  | 'bus-off-pins';

export interface CircuitWarning {
  severity: WarningSeverity;
  code: WarningCode;
  /** Component this warning is attached to (when applicable). */
  componentId?: string;
  /** Human-readable message — already includes units and the actual value. */
  message: string;
  /** Extra diagnostic value (current in A, power in W, …). */
  metric?: number;
}

export interface VerificationResult {
  errors: CircuitWarning[];
  warnings: CircuitWarning[];
  /** Number of components inspected — useful for "nothing to check" UI. */
  componentsChecked: number;
  /** The full solve result, surfaced so callers can do extra checks. */
  solve?: ElectricalSolveResult;
}

// ── Rule thresholds (overridable per call) ────────────────────────────────

export interface VerifierConfig {
  /** Source current above this is flagged as a probable short circuit (A). */
  shortCircuitAmps: number;
  /** LED forward current above this is flagged as overcurrent (A). */
  ledMaxAmps: number;
  /** Default resistor power rating, W. Used when no property override. */
  resistorMaxWatts: number;
  /** Below this the LED is "wired but dark" — surface a hint. */
  ledMinAmps: number;
  /**
   * `${boardId}:${pinName}` of the board sources the PRE-FLIGHT invented
   * (every wired GPIO assumed HIGH). Only set by verifyCircuitFromStore; the
   * live solver never synthesizes. Used to word a conflict honestly.
   */
  synthesizedPins?: ReadonlySet<string>;
}


export const DEFAULT_CONFIG: VerifierConfig = {
  shortCircuitAmps: 0.5,
  ledMaxAmps: 0.02,
  resistorMaxWatts: 0.25,
  ledMinAmps: 1e-6,
};

// ── What joins a supply pin to ground (power-short) ──────────────────────

/** A breadboard group key as a person finds it on the canvas. */
function stripLabel(componentId: string, metadataId: string, key: string): string {
  if (isBreadboard(metadataId)) {
    const col = /^col(\d+)([tb])$/.exec(key);
    if (col) return `strip ${col[1]}${col[2]} of breadboard ${componentId} (column ${col[1]}, holes ${col[2] === 't' ? 'a-e' : 'f-j'})`;
    const rail = /^rail([tb])([pn])$/.exec(key);
    if (rail) return `the ${rail[1] === 't' ? 'top' : 'bottom'} ${rail[2] === 'p' ? '+' : '−'} rail of breadboard ${componentId}`;
  }
  return `the internally joined pins ${key} of ${componentId}`;
}

/** "lcd1's GND, VCC, SDA and SCL pins", grouped per part in the order met. */
function pinList(pins: Array<[string, string]>): string {
  const byPart = new Map<string, string[]>();
  for (const [comp, pin] of pins) {
    const list = byPart.get(comp) ?? [];
    if (!list.includes(pin)) list.push(pin);
    byPart.set(comp, list);
  }
  const and = (xs: string[]): string =>
    xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
  return and(
    Array.from(byPart, ([comp, names]) => `${comp}'s ${and(names)} pin${names.length > 1 ? 's' : ''}`),
  );
}

/**
 * The power-short message for `pin` of `boardId`, whose net is ground: what
 * joins it to a ground pin on the shortest path through the wires, and when
 * that path runs through a breadboard strip (or a part that joins some of its
 * own pins), the strip and every part pin it holds. A header pushed down one
 * strip shorts all its pins, and "the 3V3 pin is wired to ground" alone
 * named nothing the user could find (velxio/velxio-prod#21).
 */
function powerShortMessage(input: BuildNetlistInput, boardId: string, pin: string): string {
  const fallback = `Power is shorted to ground — the ${pin} supply pin of ${boardId} is wired to ground (GND). Remove that connection; it would dump the full supply current through the wire.`;
  const meta = new Map<string, string>();
  for (const c of input.components) meta.set(c.id, c.metadataId);
  const boardGround = new Map<string, Set<string>>();
  for (const b of input.boards) boardGround.set(b.id, new Set(b.groundPinNames ?? []));
  const adj = new Map<string, string[]>();
  const link = (a: string, b: string) => {
    (adj.get(a) ?? adj.set(a, []).get(a)!).push(b);
    (adj.get(b) ?? adj.set(b, []).get(b)!).push(a);
  };
  // `group|<comp>|<key>` stands for a strip: every hole of it a wire touches.
  const groupOf = (comp: string, pinName: string): string | null => {
    const m = meta.get(comp);
    if (!m || !hasInternalNets(m)) return null;
    const key = breadboardGroupKey(m, pinName);
    return key ? `group|${comp}|${key}` : null;
  };
  const holders = new Map<string, Array<[string, string]>>();
  for (const wire of input.wires) {
    const a = `${wire.start.componentId}:${wire.start.pinName}`;
    const b = `${wire.end.componentId}:${wire.end.pinName}`;
    link(a, b);
    for (const [end, other] of [
      [wire.start, wire.end],
      [wire.end, wire.start],
    ] as const) {
      const g = groupOf(end.componentId, end.pinName);
      if (!g) continue;
      link(`${end.componentId}:${end.pinName}`, g);
      if (other.componentId !== end.componentId) {
        (holders.get(g) ?? holders.set(g, []).get(g)!).push([other.componentId, other.pinName]);
      }
    }
  }
  const isGround = (key: string): boolean => {
    if (key.startsWith('group|')) return false;
    const i = key.indexOf(':');
    const comp = key.slice(0, i);
    const name = key.slice(i + 1);
    const m = meta.get(comp);
    if (m && (hasInternalNets(m) || m.startsWith('instr-'))) return false;
    return boardGround.get(comp)?.has(name) === true || GROUND_PIN_RE.test(name);
  };
  const start = `${boardId}:${pin}`;
  const parent = new Map<string, string | null>([[start, null]]);
  const queue = [start];
  let hit: string | null = null;
  while (queue.length && !hit) {
    const at = queue.shift()!;
    for (const next of adj.get(at) ?? []) {
      if (parent.has(next)) continue;
      parent.set(next, at);
      if (isGround(next)) {
        hit = next;
        break;
      }
      queue.push(next);
    }
  }
  if (!hit) return fallback;
  const strips: string[] = [];
  for (let at: string | null = hit; at; at = parent.get(at) ?? null) {
    if (at.startsWith('group|')) strips.unshift(at);
  }
  const i = hit.indexOf(':');
  const ground = `${hit.slice(0, i)}'s ${hit.slice(i + 1)} pin`;
  if (strips.length === 0) {
    return `Power is shorted to ground — the ${pin} supply pin of ${boardId} is wired to ground (${ground}). Remove that connection; it would dump the full supply current through the wire.`;
  }
  const label = (g: string): string => {
    const [, comp, key] = g.split('|');
    return stripLabel(comp, meta.get(comp) ?? '', key);
  };
  // Every strip the path crosses, in order: a wire from one strip to another
  // carries the short on, and naming only the first one (with the supply pin
  // as all it "joins") pointed at nothing wrong.
  const last = strips[strips.length - 1];
  const held = holders.get(last) ?? [];
  // One pin on the last strip that is the ground pin itself is said already.
  const where =
    held.length > 1
      ? `, which joins ${pinList(held)}`
      : held.length === 1 && `${held[0][0]}:${held[0][1]}` !== hit
        ? `, where ${pinList(held)} is`
        : '';
  const [, comp] = last.split('|');
  const onBreadboard = strips.every((g) => isBreadboard(meta.get(g.split('|')[1]) ?? ''));
  const advice =
    strips.length > 1
      ? 'A wire between two strips joins them into one connection: remove the wire that carries the supply across, or move those pins apart.'
      : onBreadboard
        ? 'All the holes of a breadboard strip or rail are one connection: put those pins in separate strips, or remove the wire that joins them.'
        : `${comp} joins those pins itself: remove the wire that brings the supply to them.`;
  return (
    `Power is shorted to ground — the ${pin} supply pin of ${boardId} reaches ground (${ground}) through ` +
    `${strips.map(label).join(', then a wire to ')}${where}. ${advice}`
  );
}

// ── Public API ───────────────────────────────────────────────────────────

/** Build a netlist, solve, and return any safety warnings. */
export async function verifyCircuit(
  input: BuildNetlistInput,
  partialConfig: Partial<VerifierConfig> = {},
): Promise<VerificationResult> {
  const config = { ...DEFAULT_CONFIG, ...partialConfig };
  const errors: CircuitWarning[] = [];
  const warnings: CircuitWarning[] = [];

  // Branch-current vectors that the solver returned as NaN / Infinity.
  // A non-finite branch current is not "no current" — it means ngspice
  // could not find a stable operating point for that source (the classic
  // case: a forward-biased LED with no series resistor, or a dead short).
  // We must NOT silently treat these as 0 A; they get surfaced as a
  // blocking "cannot emulate" fault below.
  const nonFiniteBranches = new Set<string>();

  // ── Line-owning sensors the wired board cannot host (no solve) ────────
  // A DHT22 or an HC-SR04 asks the board it is wired to for the line
  // contract when it mounts (simulation/line/requestLine). A board that
  // cannot honour it refuses with a reason, and that reason is the only thing
  // standing between the user and a sensor that silently never answers: the
  // Pi family reads its pins over a serial link, the STM32 worker has no
  // single-wire handlers, a QEMU engine that does not exist for this chip.
  // Surfaced here, at Run, next to the electrical checks. Non-blocking: the
  // rest of the circuit may be fine.
  for (const gap of lineGaps()) {
    if (gap.componentId && !input.components.some((c) => c.id === gap.componentId)) continue;
    warnings.push({
      severity: 'warning',
      code: 'unsupported-sensor',
      componentId: gap.componentId,
      // A board with no analog input refuses a pot or a joystick the same
      // way, but "will not answer" is the wrong sentence for it: the part is
      // fine, the pin cannot measure. Its `why` already names the converter.
      // ...and an e-paper panel that refreshed blank is wired correctly and
      // did answer: what is wrong is where the driver sent the picture.
      message:
        gap.code === 'no-adc'
          ? `${gap.sensorType} on GPIO ${gap.pin}: ${gap.why}`
          : gap.code === 'epaper-old-plane-only'
            ? `e-paper panel: ${gap.why}`
            : `${gap.sensorType} on GPIO ${gap.pin} will not answer here: ${gap.why}`,
    });
  }

  // ── Fields whose text is not a value (no solve) ───────────────────────
  // A resistance, a capacitance, a supply voltage or a generator frequency
  // the value parser cannot read ("4,7k", "1 000", "5 V DC") is simulated
  // with the field's default, so the circuit on screen is not the one that
  // runs. Say which field and what it runs with. Before the shared parser
  // such a text became some other number ("4,7k" was 4k) or NaN, and one
  // NaN made ngspice reject the whole circuit with a bare "circuit not
  // parsed" (velxio/velxio-prod#105, #118). Blocking, with Run anyway.
  //
  // An EMPTY field says no number the default would contradict: the part
  // runs with the value a new one has, as it always did for a resistor, so
  // that is a warning, and the inspector keeps its note under the field. A
  // field the part's mode does not read (a DC supply's frequency) is never
  // reported at all (unreadableValues).
  for (const comp of input.components) {
    for (const bad of unreadableValues(comp)) {
      const fallback = formatQuantity(bad.field.fallback, bad.field.unit);
      if (bad.empty) {
        warnings.push({
          severity: 'warning',
          code: 'invalid-value',
          componentId: comp.id,
          message:
            `${comp.metadataId} ${comp.id}: its ${bad.field.label} is empty, so it runs with ${fallback}, ` +
            `the part's default. Type a value to set it.`,
        });
        continue;
      }
      errors.push({
        severity: 'error',
        code: 'invalid-value',
        componentId: comp.id,
        message:
          `${comp.metadataId} ${comp.id}: its ${bad.field.label} "${String(bad.raw)}" is not a value ` +
          `the simulator can read (${bad.why}). It runs with ${fallback} until the field is fixed.`,
      });
    }
  }

  // ── Buses a Raspberry Pi has only on fixed pins (no solve) ────────────
  // Same placement as the line gaps above, for the same reason: pure wiring,
  // reported even when the netlist cannot be built.
  warnings.push(...piBusPinWarnings(input));

  // Reported BEFORE the netlist is built, on purpose. This loop reads nothing
  // but input.components, and buildNetlist throws on a canvas the emitter
  // cannot express — verifyCircuitFromStore then returns null and the toolbar
  // treats null as "proceed, say nothing". Ordered after it, an unrelated
  // netlist failure elsewhere on the canvas swallowed the one warning telling
  // the user their sensor will never answer.
  // Run a forced .op solve so currents are scalar and deterministic.
  const opInput: BuildNetlistInput = { ...input, analysis: { kind: 'op' } };
  const { netlist, pinNetMap, nets } = buildNetlist(opInput);

  // ── Ideal sources fighting over one net (graph-based, no solve) ────────
  // Two ideal voltage sources on the same pair of nodes make the .op matrix
  // singular. ngspice then rejects the whole deck and the live solver publishes
  // no voltages at all: every meter reads 0 V, every LED goes dark, and until
  // 2026-09-05 nothing said why (a 7805's VOUT wired into a XIAO's 5V pin was
  // reported as "my 9 V battery reads 0 V"). Detected from the netlist itself
  // so both sides get named; blocking, because nothing on the canvas solves.
  errors.push(...findSourceConflicts(netlist, input, config.synthesizedPins));


  // ── Board over-voltage (graph-based, no solve) ─────────────────────────
  // Runs BEFORE the solve so it still reports even when an external source on
  // a board's vcc rail makes the .op singular. A board's supply pins collapse
  // to self-driven rail nets (main pins → `vcc_rail`, off-voltage pins →
  // `aux_rail_*`), each held at its nominal voltage, so an over-voltage can't
  // be read from node voltages — instead check the wiring directly: a power
  // source wired to a board supply pin whose nominal voltage exceeds that
  // pin's rating. Non-blocking.
  const boardWarned = new Set<string>();
  for (const board of input.boards) {
    if (!board.boardKind) continue;
    const rating = COMPONENT_RATINGS[board.boardKind];
    if (!rating) continue;
    for (const wire of input.wires) {
      if (boardWarned.has(board.id)) break;
      for (const [boardEnd, srcEnd] of [
        [wire.start, wire.end],
        [wire.end, wire.start],
      ] as const) {
        if (boardEnd.componentId !== board.id) continue;
        const sp = rating.supplyPins.find((p) => p.name === boardEnd.pinName);
        if (!sp) continue;
        const src = input.components.find((c) => c.id === srcEnd.componentId);
        if (!src) continue;
        const info = sourceInfo(src);
        if (!info || !info.posPins.includes(srcEnd.pinName)) continue;
        if (info.volts > sp.absMaxVoltage) {
          boardWarned.add(board.id);
          warnings.push({
            severity: 'warning',
            code: 'over-voltage',
            componentId: board.id,
            message: `${rating.label} ${board.id} has ${formatVolts(info.volts)} wired to its ${sp.name} pin — above its ${formatVolts(
              sp.absMaxVoltage,
            )} maximum. Real hardware would likely be damaged. Use the correct supply voltage (a regulator or level shifter).`,
            metric: info.volts,
          });
          break;
        }
      }
    }
  }

  // ── Wiring ERC (graph-based, no solve) ─────────────────────────────────
  // Bad-connection checks that don't need a solve, so they run even when the
  // circuit is too incomplete to solve. Build a per-component set of wired pin
  // names from the wires first.
  const wiredPins = new Map<string, Set<string>>();
  for (const wire of input.wires) {
    for (const end of [wire.start, wire.end]) {
      let s = wiredPins.get(end.componentId);
      if (!s) {
        s = new Set();
        wiredPins.set(end.componentId, s);
      }
      s.add(end.pinName);
    }
  }
  const pinWired = (set: Set<string> | undefined, name: string): boolean => {
    if (!set) return false;
    if (set.has(name)) return true;
    // Tolerate ASCII '-' vs the Unicode minus on an electrolytic cap's "−" pin.
    if (name === '−' && set.has('-')) return true;
    if (name === '-' && set.has('−')) return true;
    return false;
  };

  // Missing power: a rated peripheral wired into the circuit but missing its
  // supply or ground connection won't work. (Boards live in input.boards, not
  // input.components, so they're correctly excluded — a board self-powers.)
  for (const comp of input.components) {
    const rating = COMPONENT_RATINGS[comp.metadataId];
    if (!rating) continue;
    const set = wiredPins.get(comp.id);
    if (!set || set.size === 0) continue; // not connected yet — not a mistake
    if (!rating.supplyPins.some((sp) => pinWired(set, sp.name))) {
      warnings.push({
        severity: 'warning',
        code: 'missing-connection',
        componentId: comp.id,
        message: `${rating.label} ${comp.id} is wired up but its power (VCC) pin isn't connected — connect it to a supply or it won't work.`,
      });
    }
    if (!rating.gndPins.some((g) => pinWired(set, g))) {
      warnings.push({
        severity: 'warning',
        code: 'missing-connection',
        componentId: comp.id,
        message: `${rating.label} ${comp.id} is wired up but its ground (GND) pin isn't connected — connect GND or it won't work.`,
      });
    }
  }

  // Dangling two-terminal part: a resistor / LED / capacitor / diode connected
  // on only one side has no current path through it.
  for (const comp of input.components) {
    const pins = twoTerminalPins(comp.metadataId);
    if (!pins) continue;
    const set = wiredPins.get(comp.id);
    if (!set) continue;
    if (pinWired(set, pins[0]) !== pinWired(set, pins[1])) {
      warnings.push({
        severity: 'warning',
        code: 'missing-connection',
        componentId: comp.id,
        message: `${comp.metadataId} ${comp.id} is connected on only one side — its other terminal is floating, so no current can flow through it.`,
      });
    }
  }

  // Power rail tied to ground: a board supply pin (one the board declares as
  // its rail or aux rail, or a wired pin named like one) whose net is ground
  // shorts that supply. When a board drives the rail and no battery/signal-
  // generator source is present, the current-based short-circuit rule (which
  // only inspects those sources) misses it — so name it structurally here.
  // Judged on the nets, not on the pin names of a wire's two ends: those
  // flagged a potentiometer wired with its power pins swapped, whose 10 kOhm
  // track sits between the rails and shorts nothing (velxio/velxio-prod#21).
  // Blocking error.
  const VCC_PIN_RE = /^(vcc|vdd|vcc_rail|5v|3v3|3\.3v)$/i;
  powerShort: for (const board of input.boards) {
    const supplyPins = new Set([
      ...(board.vccPinNames ?? []),
      ...(board.auxVolts !== undefined ? (board.auxPinNames ?? []) : []),
    ]);
    for (const wire of input.wires) {
      for (const end of [wire.start, wire.end]) {
        if (end.componentId === board.id && VCC_PIN_RE.test(end.pinName)) supplyPins.add(end.pinName);
      }
    }
    for (const pin of supplyPins) {
      if (pinNetMap.get(`${board.id}:${pin}`) !== '0') continue;
      errors.push({
        severity: 'error',
        code: 'power-short',
        message: powerShortMessage(input, board.id, pin),
      });
      break powerShort;
    }
  }

  // Two-terminal part shorted across itself: both terminals on the same net, so
  // it carries no voltage and has no effect on the circuit. Non-blocking hint.
  for (const comp of input.components) {
    const pins = twoTerminalPins(comp.metadataId);
    if (!pins) continue;
    const n0 = pinNetMap.get(`${comp.id}:${pins[0]}`) ?? (pins[0] === '−' ? pinNetMap.get(`${comp.id}:-`) : undefined);
    const n1 = pinNetMap.get(`${comp.id}:${pins[1]}`) ?? (pins[1] === '−' ? pinNetMap.get(`${comp.id}:-`) : undefined);
    if (n0 !== undefined && n1 !== undefined && n0 === n1) {
      warnings.push({
        severity: 'warning',
        code: 'shorted-component',
        componentId: comp.id,
        message: `${comp.metadataId} ${comp.id} has both terminals on the same node — it is shorted out and has no effect on the circuit.`,
      });
    }
  }

  // ── Audit rules (2026-07): unpowered nets / missing return path / relay
  //    coil voltage mismatch ────────────────────────────────────────────────
  // Graph-based, no solve — they fire even on circuits ngspice cannot solve.
  // All three are non-blocking warnings: the goal is that the user (and the
  // agent's pre-flight) SEE the fault, not a hard stop. Motivated by real
  // audited circuits the verifier previously blessed with zero findings:
  // a battery with only one pole wired, a MOSFET switching a rail nothing
  // powers, a 12 V-coil relay fed from 5 V, and "power" nets with no source.
  {
    const boardIds = new Set(input.boards.map((b) => b.id));
    const compById = new Map(input.components.map((c) => [c.id, c] as const));
    // Board kinds double as component metadataIds in some flows (gallery
    // sweeps, tests pass boards inside `components`): treat those components
    // as self-powered boards. Keyed by kind → logic voltage.
    const boardVccByKind = new Map<string, number>(
      Object.entries(BOARD_PIN_GROUPS)
        .filter(([kind]) => kind !== 'default')
        .map(([kind, group]) => [kind, group.vcc] as const),
    );
    // Canvas element type of the esp32 board — appears as a component
    // metadataId in the gallery flows.
    if (!boardVccByKind.has('esp32-devkit-v1')) {
      boardVccByKind.set('esp32-devkit-v1', boardVccByKind.get('esp32') ?? 3.3);
    }
    // Programmable custom chips are active, self-powered parts (their pins
    // drive) — never report them or their nets as unpowered.
    const isActiveChip = (metadataId: string): boolean => metadataId === 'custom-chip';
    const dcSourceIds = new Set(
      input.components.filter((c) => sourceInfo(c) !== null).map((c) => c.id),
    );

    const netOf = (entityId: string, pinName: string): string | undefined =>
      pinNetMap.get(`${entityId}:${pinName}`) ??
      (pinName === '−'
        ? pinNetMap.get(`${entityId}:-`)
        : pinName === '-'
          ? pinNetMap.get(`${entityId}:−`)
          : undefined);

    // Return-side nets: the canonical ground plus every net a discrete
    // source's negative terminal sits on. Everything in a circuit rides its
    // return net, so treating it as a conductor would merge unrelated
    // sub-circuits and mask dead branches — for POWER reachability these are
    // barriers, for RETURN reachability they are the highway.
    const NEG_PIN_NAMES = ['−', '-', 'GND'];
    const returnNets = new Set<string>(['0']);
    for (const src of input.components) {
      if (!dcSourceIds.has(src.id)) continue;
      for (const pinName of wiredPins.get(src.id) ?? []) {
        if (!NEG_PIN_NAMES.includes(pinName)) continue;
        const net = netOf(src.id, pinName);
        if (net) returnNets.add(net);
      }
    }

    // Which pins of a part conduct to each other internally. Most parts join
    // all their wired pins (over-approximating conduction keeps false
    // positives down); transistors only conduct through their channel (a
    // MOSFET gate does not power its drain), and a relay's coil is
    // galvanically isolated from its contacts.
    const conductionGroups = (metadataId: string, pins: string[]): string[][] => {
      if (/^mosfet-/.test(metadataId)) return [['D', 'S']];
      if (/^bjt-/.test(metadataId)) return [['C', 'E']];
      if (metadataId === 'relay') return [['COIL+', 'COIL-'], ['COM', 'NO', 'NC']];
      return [pins];
    };

    // Region analysis: nets are nodes, entities join the nets their pins sit
    // on. `power: true` asks "which nets can a power source actually reach?"
    // (return nets don't bridge, sources don't conduct internally);
    // `power: false` asks "are these nets connected at all?" (everything
    // conducts — used for the return-path check).
    const buildRegions = (opts: { excludeId?: string; power: boolean }): UnionFind => {
      const uf2 = new UnionFind();
      const usable = (net: string | undefined): net is string =>
        net !== undefined && !(opts.power && returnNets.has(net));
      for (const [entityId, pins] of wiredPins) {
        if (entityId === opts.excludeId) continue;
        if (opts.power && dcSourceIds.has(entityId)) continue;
        const comp = compById.get(entityId);
        // A part that shorts its own pins (breadboard, carrier board) has
        // that connectivity already folded into the nets.
        if (comp && hasInternalNets(comp.metadataId)) continue;
        // Channel-only conduction applies to POWER reachability (a MOSFET
        // gate cannot power the drain rail). For RETURN reachability every
        // pin joins: voltage-driven inputs (BJT base, MOSFET gate) are
        // legitimate signal sinks and must not read as broken loops.
        const groups = comp && opts.power
          ? conductionGroups(comp.metadataId, [...pins])
          : [[...pins]]; // boards and unknown entities conduct across all pins
        for (const group of groups) {
          let anchor: string | undefined;
          for (const pinName of group) {
            const net = netOf(entityId, pinName);
            if (!usable(net)) continue;
            uf2.add(net);
            if (anchor === undefined) anchor = net;
            else uf2.union(anchor, net);
          }
        }
      }
      // Wires join their endpoint nets (only length-modelled wires actually
      // split endpoints into two nets; for the rest this is a no-op union).
      for (const wire of input.wires) {
        const a = netOf(wire.start.componentId, wire.start.pinName);
        const b = netOf(wire.end.componentId, wire.end.pinName);
        if (usable(a) && usable(b)) {
          uf2.add(a);
          uf2.add(b);
          uf2.union(a, b);
        }
      }
      return uf2;
    };

    // Nets that genuinely inject power: discrete sources' positive terminals,
    // every non-ground board pin (GPIOs drive, supply pins supply), and the
    // shared VCC rail — but the rail only when a board actually defines it.
    // VCC-named component pins wired together WITHOUT any board form a
    // phantom rail that nothing powers (the audited "power net, no source").
    const positiveSourceNets = new Set<string>();
    const addEntitySourceNets = (entityId: string) => {
      for (const pinName of wiredPins.get(entityId) ?? []) {
        const net = netOf(entityId, pinName);
        if (net && !returnNets.has(net)) positiveSourceNets.add(net);
      }
    };
    for (const b of input.boards) addEntitySourceNets(b.id);
    for (const entityId of wiredPins.keys()) {
      // Endpoints belonging to no known component/board: be conservative and
      // treat them as power-capable rather than invent findings about them.
      if (!compById.has(entityId) && !boardIds.has(entityId)) addEntitySourceNets(entityId);
    }
    for (const c of input.components) {
      if (boardVccByKind.has(c.metadataId) || isActiveChip(c.metadataId)) {
        addEntitySourceNets(c.id);
      }
      const info = sourceInfo(c);
      if (!info) continue;
      for (const pinName of wiredPins.get(c.id) ?? []) {
        if (!info.posPins.includes(pinName)) continue;
        const net = netOf(c.id, pinName);
        if (net && !returnNets.has(net)) positiveSourceNets.add(net);
      }
    }
    const railDriven =
      input.boards.length > 0 || input.components.some((c) => boardVccByKind.has(c.metadataId));
    if (railDriven) {
      positiveSourceNets.add('vcc_rail');
      // Aux rails (VIN / 5V on 3.3 V boards, 3V3 on 5 V boards) are board
      // -driven positive supplies too — Rule A1 must see them as sources.
      for (const b of input.boards) {
        if (b.auxVolts !== undefined) positiveSourceNets.add(auxRailNetName(b.auxVolts));
      }
    }

    const skipForAudit = (c: BuildNetlistInput['components'][number]): boolean =>
      dcSourceIds.has(c.id) ||
      boardVccByKind.has(c.metadataId) ||
      isActiveChip(c.metadataId) ||
      hasInternalNets(c.metadataId) ||
      c.metadataId.startsWith('instr-');

    const powerRegions = buildRegions({ power: true });
    const poweredRoots = new Set<string>();
    for (const net of positiveSourceNets) poweredRoots.add(powerRegions.find(net));

    // ── Rule A1: a power-input pin on a net no source reaches ─────────────
    // The part's own body must not bridge power onto its supply pin (a
    // sensor's VCC is not powered by its SDA), so each part is checked
    // against a region map built WITHOUT itself.
    const POWER_INPUT_PIN_RE = /^(vcc\d*|vdd|vin|v\+|avcc|coil\+)$/i;
    const flaggedUnpowered = new Set<string>();
    for (const comp of input.components) {
      if (skipForAudit(comp)) continue;
      const rated = new Set(COMPONENT_RATINGS[comp.metadataId]?.supplyPins.map((p) => p.name) ?? []);
      const pins = wiredPins.get(comp.id);
      if (!pins) continue;
      for (const pinName of pins) {
        if (!rated.has(pinName) && !POWER_INPUT_PIN_RE.test(pinName)) continue;
        const net = netOf(comp.id, pinName);
        if (!net || returnNets.has(net)) continue;
        const solo = buildRegions({ excludeId: comp.id, power: true });
        const root = solo.find(net);
        if ([...positiveSourceNets].some((s) => solo.find(s) === root)) continue;
        flaggedUnpowered.add(comp.id);
        warnings.push({
          severity: 'warning',
          code: 'unpowered-net',
          componentId: comp.id,
          message: `${comp.metadataId} ${comp.id} has its ${pinName} pin on a net with no power source — no battery, power supply, or board supply pin reaches that net, so the part stays unpowered. Wire the net to a real supply.`,
        });
        break; // one unpowered warning per part
      }
    }

    // ── Rule A2: whole sub-circuits no power source reaches ───────────────
    // Judged per conduction group so a relay whose contacts are fine still
    // reports its dead coil. One warning per stranded region, naming the
    // parts on it.
    const strandedByRoot = new Map<string, string[]>();
    for (const comp of input.components) {
      if (flaggedUnpowered.has(comp.id) || skipForAudit(comp)) continue;
      const pins = wiredPins.get(comp.id);
      if (!pins) continue;
      for (const group of conductionGroups(comp.metadataId, [...pins])) {
        const roots = new Set<string>();
        for (const pinName of group) {
          const net = netOf(comp.id, pinName);
          if (!net || returnNets.has(net)) continue; // ground pins don't count
          roots.add(powerRegions.find(net));
        }
        if (roots.size === 0) continue;
        if ([...roots].some((r) => poweredRoots.has(r))) continue;
        const anchor = [...roots][0]!;
        const list = strandedByRoot.get(anchor) ?? [];
        if (!list.includes(comp.id)) list.push(comp.id);
        strandedByRoot.set(anchor, list);
      }
    }
    for (const ids of strandedByRoot.values()) {
      const shown = ids
        .slice(0, 3)
        .map((id) => `${compById.get(id)?.metadataId ?? 'component'} ${id}`)
        .join(', ');
      const suffix = ids.length > 3 ? ` (+${ids.length - 3} more)` : '';
      warnings.push({
        severity: 'warning',
        code: 'unpowered-net',
        componentId: ids[0],
        message: `No power source reaches ${shown}${suffix} — that part of the circuit never connects to a battery, power supply, or board pin, so no current can flow through it.`,
      });
    }

    // ── Rule B: source without a return path ──────────────────────────────
    // Current needs a closed loop. A battery with a single pole wired, or a
    // source whose + side never reconnects to its − side, drives nothing —
    // the audited "floating battery" circuit ran with zero findings.
    for (const src of input.components) {
      const info = sourceInfo(src);
      if (!info) continue;
      const set = wiredPins.get(src.id);
      if (!set || set.size === 0) continue; // fully unwired — not a mistake yet
      const posPin = [...set].find((p) => info.posPins.includes(p));
      const negPin = [...set].find((p) => NEG_PIN_NAMES.includes(p));
      if (!posPin !== !negPin) {
        const wired = posPin ? 'positive (+)' : 'negative (−)';
        const missing = posPin ? 'negative (−)' : 'positive (+)';
        warnings.push({
          severity: 'warning',
          code: 'no-return-path',
          componentId: src.id,
          message: `${src.metadataId} ${src.id} has only its ${wired} terminal wired. Current needs a closed loop back into the ${missing} terminal — with it floating, no current can flow anywhere in this circuit.`,
        });
        continue;
      }
      if (!posPin || !negPin) continue;
      const posNet = netOf(src.id, posPin);
      const negNet = netOf(src.id, negPin);
      if (!posNet || !negNet || posNet === negNet) continue; // short: other rules
      const returnRegions = buildRegions({ excludeId: src.id, power: false });
      if (returnRegions.find(posNet) !== returnRegions.find(negNet)) {
        warnings.push({
          severity: 'warning',
          code: 'no-return-path',
          componentId: src.id,
          message: `Current leaving ${src.metadataId} ${src.id}'s ${posPin} terminal has no path back to its ${negPin} terminal — the loop never closes, so no current can flow. Check the return (GND) side of the circuit for a missing wire.`,
        });
      }
    }

    // ── Rule C: relay coil voltage vs the supply actually feeding it ──────
    // A 12 V-coil relay on a 5 V rail sits far below its ~60% pull-in
    // threshold and never actuates (audited case); the reverse overdrives
    // and burns the coil. Compare coil_voltage against the nominal voltage
    // of the supply on the coil nets (falling back to the coil's power
    // region for coils fed through a switch or transistor).
    const dominantVcc =
      input.boards[0]?.vcc ??
      (() => {
        const bk = input.components.find((c) => boardVccByKind.has(c.metadataId));
        return bk ? boardVccByKind.get(bk.metadataId)! : 5;
      })();
    const nominalOnNets = (nets: ReadonlySet<string>): number | undefined => {
      let best: number | undefined;
      const consider = (v: number) => {
        if (Number.isFinite(v) && v > 0 && (best === undefined || v > best)) best = v;
      };
      if (nets.has('vcc_rail') && railDriven) consider(dominantVcc);
      // Aux rails carry their own nominal voltage (a relay coil fed from VIN
      // sees 5 V, not the board's 3.3 V logic rail).
      for (const b of input.boards) {
        if (b.auxVolts !== undefined && nets.has(auxRailNetName(b.auxVolts))) {
          consider(b.auxVolts);
        }
      }
      for (const c of input.components) {
        const info = sourceInfo(c);
        if (info) {
          for (const pinName of wiredPins.get(c.id) ?? []) {
            if (!info.posPins.includes(pinName)) continue;
            const net = netOf(c.id, pinName);
            if (net && !returnNets.has(net) && nets.has(net)) consider(info.volts);
          }
        }
        if (boardVccByKind.has(c.metadataId)) {
          for (const pinName of wiredPins.get(c.id) ?? []) {
            const net = netOf(c.id, pinName);
            if (net && !returnNets.has(net) && net !== 'vcc_rail' && nets.has(net)) {
              consider(boardVccByKind.get(c.metadataId)!);
            }
          }
        }
      }
      for (const b of input.boards) {
        for (const pinName of wiredPins.get(b.id) ?? []) {
          const net = netOf(b.id, pinName);
          if (!net || returnNets.has(net) || !nets.has(net)) continue;
          const state = b.pins[pinName];
          consider(state?.type === 'digital' ? state.v : b.vcc);
        }
      }
      return best;
    };
    for (const comp of input.components) {
      if (comp.metadataId !== 'relay') continue;
      const coilV = readValueField(comp, 'coil_voltage');
      if (!Number.isFinite(coilV) || coilV <= 0) continue;
      const coilNets = new Set<string>();
      for (const pinName of ['COIL+', 'COIL-']) {
        const net = netOf(comp.id, pinName);
        if (net && !returnNets.has(net)) coilNets.add(net);
      }
      if (coilNets.size === 0) continue;
      let supplyV = nominalOnNets(coilNets);
      if (supplyV === undefined) {
        const roots = new Set([...coilNets].map((n) => powerRegions.find(n)));
        const reachable = new Set<string>();
        for (const net of new Set(pinNetMap.values())) {
          if (!returnNets.has(net) && roots.has(powerRegions.find(net))) reachable.add(net);
        }
        supplyV = nominalOnNets(reachable);
      }
      if (supplyV === undefined) continue; // unpowered coil — Rule A covers it
      if (supplyV < coilV * 0.6) {
        warnings.push({
          severity: 'warning',
          code: 'voltage-mismatch',
          componentId: comp.id,
          metric: supplyV,
          message: `Relay ${comp.id} has a ${formatVolts(coilV)} coil (coil_voltage = ${coilV}) but its coil is fed from a ${formatVolts(supplyV)} supply — below the ~60% pull-in threshold, so the relay will never energise. Use a relay with a ${formatVolts(supplyV)} coil, or feed the coil ${formatVolts(coilV)}.`,
        });
      } else if (supplyV > coilV * 1.5) {
        warnings.push({
          severity: 'warning',
          code: 'voltage-mismatch',
          componentId: comp.id,
          metric: supplyV,
          message: `Relay ${comp.id} has a ${formatVolts(coilV)} coil (coil_voltage = ${coilV}) but its coil is fed from ${formatVolts(supplyV)} — far above its rating. A real coil would overheat and burn out; use a ${formatVolts(supplyV)}-rated coil or the matching ${formatVolts(coilV)} supply.`,
        });
      }
    }
  }

  let solve: ElectricalSolveResult | undefined;
  try {
    const cooked = await runSpice(netlist);
    // ngspice does not throw on a rejected deck: `source` returns 0, the
    // analysis runs on nothing and the plot is empty. A circuit with nets but
    // not one v(...) vector is that case — say so instead of waving it through
    // with zero warnings (which is what the 2026-09-05 report saw in `[verify]`).
    if (nets.length > 0 && !cooked.variableNames.some((n) => n.startsWith('v('))) {
      const reason = cooked.warnings[0] ?? 'ngspice returned no node voltages';
      errors.push({
        severity: 'error',
        code: 'solver-failed',
        message: `The circuit solver rejected this circuit (${reason.trim()}). Nothing on the canvas will solve until it is fixed. Check for voltage sources wired against each other.`,
      });
      return { errors, warnings, componentsChecked: 0, solve };
    }
    // Re-shape into the same flat dictionaries that the live store uses.
    const nodeVoltages: Record<string, number> = { '0': 0 };
    const branchCurrents: Record<string, number> = {};
    for (const name of cooked.variableNames) {
      if (name.startsWith('v(')) {
        const v = cooked.dcValue(name);
        if (Number.isFinite(v)) nodeVoltages[name.slice(2, -1)] = v;
      } else if (name.startsWith('i(')) {
        const v = cooked.dcValue(name);
        const key = name.slice(2, -1);
        if (Number.isFinite(v)) branchCurrents[key] = v;
        else nonFiniteBranches.add(key);
      }
    }
    solve = {
      nodeVoltages,
      branchCurrents,
      converged: true,
      error: null,
      solveMs: 0,
      submittedNetlist: netlist,
      pinNetMap: new Map(),
      analysisMode: 'op',
    };
  } catch (err) {
    warnings.push({
      severity: 'warning',
      code: 'solver-failed',
      message: `Circuit solver could not converge (${
        err instanceof Error ? err.message : String(err)
      }). Pre-flight checks were skipped.`,
    });
    return { errors, warnings, componentsChecked: 0, solve };
  }

  const branchCurrents = solve.branchCurrents;

  // ── Rule 1: short circuit / power source overload ──────────────────────
  // Every voltage source (battery / signal-generator / power-supply) emits
  // a branch current `i(v_<id>)`. SPICE convention: V-source's current is
  // measured + → − INTERNALLY, so external current draw is the absolute
  // value.
  //
  // power-supply components carry a per-instance `currentLimit` property
  // that overrides the global short-circuit threshold. The supply's model
  // (componentToSpice) holds its voltage up to that limit and then holds the
  // current, so a supply asked for more sits AT the limit: the reading is
  // the limit plus a hair (setpoint / gain), or a hair under it from the
  // solver's tolerance. Flag it from 0.1 % under the limit (#96).
  //
  // A supply wired straight onto a board pin that the board's own ideal
  // source holds (its 3V3 regulator output, a 5 V board's 3.3 V pin) is at
  // its limit for another reason: the two sources fight over the pin, and
  // the limit says nothing about the load. That one is named as what it is,
  // a warning, not an overload (supplyOnRailWarning). A supply wired into a
  // 3.3 V board's VIN / 5V powers the board and meets no rail there
  // (NetlistBuilder, poweredInputRails).
  const rails = boardRailsOf(netlist);
  const sourceComponents = input.components.filter((c) =>
    /^(battery|signal-generator|power-supply)/.test(c.metadataId),
  );
  for (const src of sourceComponents) {
    // A non-finite source current means ngspice could not find a stable
    // operating point — treat it as a blocking "cannot emulate" fault
    // rather than waving the circuit through as 0 A.
    if (nonFiniteBranches.has(`v_${src.id}`)) {
      errors.push({
        severity: 'error',
        code: 'unstable-solve',
        componentId: src.id,
        message: `Could not solve a stable current for ${src.metadataId} ${src.id} — the circuit has no stable operating point. This usually means a short circuit, or a part driven with no current limit (for example an LED with no series resistor). Check the wiring or add a series resistor.`,
      });
      continue;
    }
    const i = Math.abs(branchCurrents[`v_${src.id}`] ?? 0);
    const isPsu = src.metadataId === 'power-supply';
    // The limit the netlist was built with (valueFields): "500m" is 0.5 A,
    // and never under the floor the model applies.
    const threshold = isPsu
      ? Math.max(MIN_SUPPLY_LIMIT_A, readValueField(src, 'currentLimit'))
      : config.shortCircuitAmps;
    if (isPsu ? i >= threshold * (1 - 1e-3) : i >= threshold) {
      const onRail = isPsu
        ? supplyOnRailWarning(src, threshold, branchCurrents[`v_${src.id}`] ?? 0, rails, pinNetMap, input)
        : null;
      if (onRail) {
        warnings.push(onRail);
        continue;
      }
      errors.push({
        severity: 'error',
        code: isPsu ? 'source-overload' : 'short-circuit',
        componentId: src.id,
        message: isPsu
          ? `Power supply ${src.id} is at its ${formatAmps(threshold)} current limit: the load asks for more, so the supply holds ${formatAmps(i)} and lets its voltage drop (constant current). Raise the currentLimit or add more series resistance to the load.`
          : `Possible short circuit — ${src.metadataId} ${src.id} is delivering ${formatAmps(i)} (threshold ${formatAmps(threshold)}). Check for power tied directly to GND.`,
        metric: i,
      });
    }
  }

  // ── Rule 2: LED forward current above absolute max ─────────────────────
  // Every LED emits a 0V sense source: `V_<id>_sense`. The branch current of
  // that source is the LED forward current.
  const leds = input.components.filter((c) => c.metadataId === 'led');
  for (const led of leds) {
    if (nonFiniteBranches.has(`v_${led.id}_sense`)) {
      errors.push({
        severity: 'error',
        code: 'unstable-solve',
        componentId: led.id,
        message: `LED ${led.id} could not be solved — its forward current has no stable value. This almost always means the LED is wired with no series resistor (a near-short across the supply). Add a series resistor between the supply and the LED.`,
      });
      continue;
    }
    const i = Math.abs(branchCurrents[`v_${led.id}_sense`] ?? 0);
    if (i > config.ledMaxAmps) {
      errors.push({
        severity: 'error',
        code: 'led-overcurrent',
        componentId: led.id,
        // Past LED_UNLIMITED_AMPS the figure means nothing: an ideal source
        // (the pre-flight's GPIO, a bench supply) across a bare LED solves at
        // trillions of amperes (velxio/velxio-prod#21).
        message:
          i > LED_UNLIMITED_AMPS
            ? `LED ${led.id} has nothing limiting its current (no series resistor) — a real LED would burn out at once. Add a series resistor.`
            : `LED ${led.id} is carrying ${formatAmps(i)} — above the 20 mA absolute maximum. Add or increase the series resistor.`,
        metric: i,
      });
    } else if (i > 0 && i < config.ledMinAmps) {
      warnings.push({
        severity: 'warning',
        code: 'led-no-current',
        componentId: led.id,
        message: `LED ${led.id} appears wired but is carrying almost no current (${formatAmps(
          i,
        )}). It will not light visibly.`,
        metric: i,
      });
    }
  }

  // ── Rule 3: resistor power above its rating ────────────────────────────
  // Resistors don't have a built-in sense source, so we recover their
  // current from the voltage drop across their two terminals and the
  // resistance value. Pin → net resolution piggy-backs on the netlist
  // text via a quick scan of the emitted R_<id> card.
  const resistorPattern = /^R_(\S+)\s+(\S+)\s+(\S+)\s+(\S+)/gm;
  let m: RegExpExecArray | null;
  while ((m = resistorPattern.exec(netlist)) !== null) {
    const [, id, n1, n2, valStr] = m;
    // Skip the sense / internal helpers (e.g. R_<comp>_sense).
    if (id.endsWith('_sense') || id.endsWith('_load') || id.endsWith('_esr')) continue;
    const comp = input.components.find((c) => c.id === id);
    if (!comp || comp.metadataId !== 'resistor') continue;
    const R = parseResistance(valStr);
    if (!Number.isFinite(R) || R <= 0) continue;
    const v1 = solve.nodeVoltages[n1] ?? 0;
    const v2 = solve.nodeVoltages[n2] ?? 0;
    const power = Math.pow(v1 - v2, 2) / R;
    const rating =
      typeof comp.properties.power === 'number'
        ? (comp.properties.power as number)
        : config.resistorMaxWatts;
    if (power > rating) {
      // Severity 'warning' (not 'error'): SPICE doesn't physically burn the
      // part out, and many teaching-circuit examples deliberately use a
      // small fixed load resistor across higher rails for clarity. We
      // surface it as a non-blocking hint so the user knows their physical
      // build needs a beefier resistor, but they can still click Run.
      warnings.push({
        severity: 'warning',
        code: 'resistor-overpower',
        componentId: id,
        message: `Resistor ${id} (${formatResistance(R)}) is dissipating ${formatPower(
          power,
        )} — above the ${formatPower(rating)} rating. A real ${formatResistance(R)} resistor at this current would overheat; pick a higher-power part or larger resistance.`,
        metric: power,
      });
    }
  }

  // ── Rule 4: over-voltage on a rated supply pin ─────────────────────────
  // Components with a rated input voltage (sensors, displays, NeoPixels, …)
  // warn when their supply pin carries more than the datasheet absolute
  // maximum — the "fed too much voltage" mistake (e.g. a 3.3 V module wired to
  // a 9 V battery). Non-blocking: the solve is still meaningful, but the real
  // part would be damaged, so we surface it and flag that this operating point
  // isn't emulated accurately. (Boards aren't checked yet — BoardForSpice
  // doesn't carry its boardKind; that's a follow-up.)
  for (const comp of input.components) {
    const rating = COMPONENT_RATINGS[comp.metadataId];
    if (!rating) continue;
    // Ground reference: first wired gnd pin, else circuit ground (0 V).
    let gndV = 0;
    for (const g of rating.gndPins) {
      const gnet = pinNetMap.get(`${comp.id}:${g}`);
      if (gnet !== undefined) {
        gndV = gnet === '0' ? 0 : (solve.nodeVoltages[gnet] ?? 0);
        break;
      }
    }
    for (const sp of rating.supplyPins) {
      const net = pinNetMap.get(`${comp.id}:${sp.name}`);
      if (net === undefined || net === '0') continue; // pin not wired / tied to GND
      const sv = solve.nodeVoltages[net];
      if (sv === undefined || !Number.isFinite(sv)) continue; // net floating / unsolved
      const v = Math.abs(sv - gndV);
      if (v > sp.absMaxVoltage) {
        warnings.push({
          severity: 'warning',
          code: 'over-voltage',
          componentId: comp.id,
          message: `${rating.label} ${comp.id} is seeing ${formatVolts(v)} on its ${sp.name} pin — above its ${formatVolts(
            sp.absMaxVoltage,
          )} absolute maximum. Real hardware would likely be damaged; this voltage is not emulated accurately. Use a level shifter or the correct supply voltage.`,
          metric: v,
        });
        break; // one over-voltage warning per part is enough
      }
    }
  }

  // ── Rule 6: electrolytic capacitor over-voltage / reverse polarity ─────
  // Electrolytic caps have a voltage rating (over it they vent / burst) and a
  // polarity (reverse-biasing destroys them). Their +/- pins are normal nets,
  // so the DC voltage across them is read straight from the solve.
  for (const c of input.components) {
    if (!isElectrolyticCap(c.metadataId)) continue;
    const posNet = pinNetMap.get(`${c.id}:+`);
    const negNet = pinNetMap.get(`${c.id}:−`) ?? pinNetMap.get(`${c.id}:-`);
    if (posNet === undefined || negNet === undefined) continue; // not fully wired
    const vPos = posNet === '0' ? 0 : solve.nodeVoltages[posNet];
    const vNeg = negNet === '0' ? 0 : solve.nodeVoltages[negNet];
    if (vPos === undefined || vNeg === undefined || !Number.isFinite(vPos) || !Number.isFinite(vNeg)) {
      continue; // a terminal net is floating / unsolved
    }
    const v = vPos - vNeg;
    const rating = parseVolts(c.properties.voltage) ?? 25;
    if (v > rating) {
      warnings.push({
        severity: 'warning',
        code: 'over-voltage',
        componentId: c.id,
        message: `Electrolytic capacitor ${c.id} has ${formatVolts(v)} across it — above its ${formatVolts(
          rating,
        )} rating. A real capacitor would vent or burst; use a higher-voltage part.`,
        metric: v,
      });
    } else if (v < -0.5) {
      warnings.push({
        severity: 'warning',
        code: 'reverse-polarity',
        componentId: c.id,
        message: `Electrolytic capacitor ${c.id} is reverse-biased (${formatVolts(
          Math.abs(v),
        )} backwards). Polarized capacitors are destroyed when connected backwards — swap its + and - terminals.`,
        metric: v,
      });
    }
  }

  return {
    errors,
    warnings,
    componentsChecked: input.components.length,
    solve,
  };
}

/** Nominal positive-output voltage + positive pin names of a power source. */
function sourceInfo(
  comp: BuildNetlistInput['components'][number],
): { posPins: string[]; volts: number } | null {
  const id = comp.metadataId;
  if (id === 'battery-9v') return { posPins: ['+'], volts: 9 };
  if (id === 'battery-aa') return { posPins: ['+'], volts: 1.5 };
  if (id === 'battery-coin-cell') return { posPins: ['+'], volts: 3 };
  // The numbers the netlist was built with (valueFields), so "12V" is 12.
  if (id === 'power-supply') {
    return { posPins: ['+', 'SIG', 'VCC'], volts: Math.abs(readValueField(comp, 'voltage')) };
  }
  if (id === 'signal-generator') {
    const off = readValueField(comp, 'offset');
    const amp = String(comp.properties.waveform ?? 'sine').toLowerCase() === 'dc'
      ? 0
      : readValueField(comp, 'amplitude');
    return { posPins: ['SIG', '+'], volts: Math.abs(off) + Math.abs(amp) };
  }
  return null;
}

function isElectrolyticCap(metadataId: string): boolean {
  return metadataId === 'capacitor-electrolytic' || metadataId.startsWith('cap-elec');
}

/** The two terminal pin names of a 2-terminal part, or null if not 2-terminal. */
function twoTerminalPins(id: string): [string, string] | null {
  if (id === 'capacitor-electrolytic' || id.startsWith('cap-elec')) return ['+', '−'];
  if (
    id === 'resistor' ||
    id.startsWith('resistor-') ||
    id === 'capacitor' ||
    (id.startsWith('cap-') && !id.startsWith('cap-elec')) ||
    id === 'inductor'
  ) {
    return ['1', '2'];
  }
  if (id === 'analog-resistor' || id === 'analog-capacitor' || id === 'analog-inductor') {
    return ['A', 'B'];
  }
  if (id === 'led' || id === 'diode' || id.startsWith('diode-') || id.startsWith('zener-')) {
    return ['A', 'C'];
  }
  return null;
}

/** Parse a voltage rating like '25', '25V', '6.3' → volts (null if unparseable). */
function parseVolts(raw: unknown): number | null {
  if (raw === undefined || raw === null) return null;
  const m = /^\s*([0-9]*\.?[0-9]+)/.exec(String(raw));
  return m ? parseFloat(m[1]!) : null;
}

// ── Formatting helpers ────────────────────────────────────────────────────

function formatAmps(a: number): string {
  if (a >= 1) return `${a.toFixed(2)} A`;
  if (a >= 1e-3) return `${(a * 1e3).toFixed(1)} mA`;
  if (a >= 1e-6) return `${(a * 1e6).toFixed(1)} µA`;
  return `${a.toExponential(2)} A`;
}

function formatVolts(v: number): string {
  if (v >= 1) return `${v.toFixed(1)} V`;
  if (v >= 1e-3) return `${(v * 1e3).toFixed(0)} mV`;
  return `${v.toExponential(2)} V`;
}

function formatPower(w: number): string {
  if (w >= 1) return `${w.toFixed(2)} W`;
  return `${(w * 1e3).toFixed(0)} mW`;
}

function formatResistance(r: number): string {
  if (r >= 1e6) return `${(r / 1e6).toFixed(1)} MΩ`;
  if (r >= 1e3) return `${(r / 1e3).toFixed(1)} kΩ`;
  return `${r.toFixed(0)} Ω`;
}

/** Parse `'10k'`, `'2.2K'`, `'4.7M'`, `'470'` into ohms. */
function parseResistance(raw: string): number {
  const s = raw.trim();
  const m = /^([-+]?[0-9]*\.?[0-9]+)([kKmMgG]?)/.exec(s);
  if (!m) return NaN;
  const base = parseFloat(m[1]);
  const suffix = m[2];
  const mult =
    suffix === 'k' || suffix === 'K' ? 1e3 : suffix === 'M' ? 1e6 : suffix === 'g' || suffix === 'G' ? 1e9 : suffix === 'm' ? 1e-3 : 1;
  return base * mult;
}

/** Netlist source card: name plus its two nodes (V-sources and B-sources). */
interface SourceCard {
  name: string;
  a: string;
  b: string;
}

/**
 * The netlist's ideal sources, with 0 V sources folded away.
 *
 * A `V... DC 0` card fixes no voltage: it is a current sense in series (an
 * ammeter, an LED, a regulator's output). It behaves as a wire, so its two
 * nodes are merged and it is not itself a source. Without that, a regulator
 * (its B source on an internal node, then the sense to VOUT) wired into a
 * supply rail sat on a different node pair than the rail and the conflict
 * went unreported.
 */
function parseSourceCards(netlist: string): SourceCard[] {
  const raw: SourceCard[] = [];
  const parent = new Map<string, string>();
  const find = (n: string): string => {
    let r = n;
    while (parent.has(r)) r = parent.get(r)!;
    return r;
  };
  for (const text of netlist.split('\n')) {
    const line = text.trim();
    if (!line || line.startsWith('*') || line.startsWith('.')) continue;
    const m = /^([VB]\S*)\s+(\S+)\s+(\S+)/.exec(line);
    if (!m) continue;
    if (/^V\S*\s+\S+\s+\S+\s+DC\s+0\s*$/i.test(line)) {
      const x = find(m[2]!);
      const y = find(m[3]!);
      if (x !== y) parent.set(x === '0' ? y : x, x === '0' ? x : y);
      continue;
    }
    raw.push({ name: m[1]!, a: m[2]!, b: m[3]! });
  }
  return raw.map((c) => ({ name: c.name, a: find(c.a), b: find(c.b) }));
}

/** The board rails a netlist holds with a source of the board's own, by net. */
interface BoardRails {
  /** The net a node sits on once connections are taken as wires. */
  fold: (net: string) => string;
  /**
   * Folded net -> the rail's volts, and whether it is a power input the board
   * feeds through its USB diode (NetlistBuilder): a part above it powers the
   * pin, one below it is held off. Otherwise the rail is a regulator's output,
   * an ideal source either way.
   */
  rails: Map<string, { volts: number; input: boolean }>;
}

/**
 * The nets the board's own rail sources hold (V_VCC_RAIL, V_AUX_RAIL_*, the
 * latter behind its D_AUX_RAIL_* diode where a part powers that input), with
 * connections taken as wires (connectionPairs: sense sources, closed
 * switches, an ammeter's shunt), so a supply behind an ammeter on a rail is
 * on that rail.
 */
function boardRailsOf(netlist: string): BoardRails {
  const lines = netlist.split('\n').map((l) => l.trim());
  const uf = new UnionFind();
  for (const [a, b] of connectionPairs(lines)) uf.union(a, b);
  // The board side of a diode-fed input -> the pin it feeds.
  const through = new Map<string, string>();
  for (const line of lines) {
    const diode = /^D_AUX_RAIL_\S+\s+(\S+)\s+(\S+)\s/i.exec(line);
    if (diode) through.set(diode[1]!, diode[2]!);
  }
  const rails = new Map<string, { volts: number; input: boolean }>();
  for (const line of lines) {
    const rail = /^V_(?:VCC_RAIL|AUX_RAIL_\S+)\s+(\S+)\s+0\s+DC\s+(\S+)$/i.exec(line);
    if (!rail || !Number.isFinite(Number(rail[2]))) continue;
    const pin = through.get(rail[1]!);
    rails.set(uf.find(pin ?? rail[1]!), { volts: Number(rail[2]), input: pin !== undefined });
  }
  return { fold: (net) => uf.find(net), rails };
}

/**
 * The warning for a power supply that sits at its limit because a board's own
 * rail holds the pin it is wired to, or null when no rail does, or when the
 * limit is a real overload. On hardware the higher of the two drives the pin:
 * - on a regulator's output (a board's 3V3, a 5 V board's 3.3 V pin), a supply
 *   above it back-feeds the regulator (and past the pin's rated maximum it
 *   would harm the board, which the message says), and one below it is held
 *   off and delivers nothing, since a bench supply cannot sink current. The
 *   netlist keeps the board's ideal rail, so the supply's own current is the
 *   fight, not a load.
 * - on a 3.3 V board's power input (VIN / 5V), a supply above the board's
 *   USB 5 V powers the board (NetlistBuilder feeds that 5 V through its
 *   diode), so at its limit its load really asks for more: an overload. One
 *   below it is held off by the USB 5 V, the same as above.
 * (velxio/velxio-prod#96)
 */
function supplyOnRailWarning(
  src: BuildNetlistInput['components'][number],
  limit: number,
  current: number,
  rails: BoardRails,
  pinNetMap: ReadonlyMap<string, string>,
  input: BuildNetlistInput,
): CircuitWarning | null {
  const netOfPin = (...pins: string[]) => {
    for (const p of pins) {
      const n = pinNetMap.get(`${src.id}:${p}`);
      if (n !== undefined) return rails.fold(n);
    }
    return undefined;
  };
  const pos = netOfPin('+', 'SIG', 'VCC');
  const neg = netOfPin('−', '-', 'GND');
  const onPos = pos !== undefined && rails.rails.has(pos);
  const railNet = onPos ? pos : neg !== undefined && rails.rails.has(neg) ? neg : undefined;
  if (railNet === undefined) return null;
  const rail = rails.rails.get(railNet)!;
  const set = readValueField(src, 'voltage');
  const ac = String(src.properties.mode ?? 'dc').toLowerCase() === 'ac';
  // Delivering current in the direction of its own setting.
  const sourcing = current * (set < 0 ? -1 : 1) > 0;
  if (rail.input && sourcing) return null;
  const v = (x: number) => formatQuantity(x, 'V');
  const holder = rail.input
    ? `where the board's own ${v(rail.volts)} arrives through its USB diode`
    : `which the board's own supply holds at ${v(rail.volts)}`;

  // Which board pin the supply meets the rail at, as the person wired it.
  let where = `a supply rail the simulator holds at ${v(rail.volts)}`;
  let inputHint = '';
  let absMax: number | undefined;
  findPin: for (const board of input.boards) {
    for (const wire of input.wires) {
      for (const end of [wire.start, wire.end]) {
        if (end.componentId !== board.id) continue;
        const net = pinNetMap.get(`${board.id}:${end.pinName}`);
        if (net === undefined || rails.fold(net) !== railNet) continue;
        where = `the ${end.pinName} pin of ${board.id}, ${holder}`;
        absMax = COMPONENT_RATINGS[board.boardKind ?? '']?.supplyPins.find((p) => p.name === end.pinName)?.absMaxVoltage;
        // A 3.3 V board takes power in on its VIN / 5V side.
        if (!rail.input && board.auxVolts !== undefined && board.auxVolts > board.vcc && board.auxPinNames?.length) {
          const pins = board.auxPinNames.filter((p) => !/\.\d+$/.test(p));
          inputHint = `, or wire it to ${board.id}'s ${pins.join(' or ')} pin, where it powers the board`;
        }
        break findPin;
      }
    }
  }

  const reading =
    `in the simulation the board's ${v(rail.volts)} holds the pin and the supply sits at its ` +
    `${formatQuantity(limit, 'A')} current limit, so its own current reading means nothing`;
  let message: string;
  if (ac || !onPos) {
    message = `Power supply ${src.id} is wired to ${where}: the two fight over that pin, and ${reading}.`;
  } else if (sourcing) {
    // The board over-voltage check sees only a supply wired straight to the
    // pin; through a breadboard rail this is the one place that says it.
    const harm =
      absMax !== undefined && Math.abs(set) > absMax
        ? `, above its ${v(absMax)} maximum, which would likely damage the board`
        : '';
    message =
      `Power supply ${src.id} is set to ${v(set)} and wired to ${where}. On hardware it would back-feed that ` +
      `rail and lift the pin to ${v(set)}${harm}; ${reading}. Set it to ${v(rail.volts)}${inputHint}.`;
  } else if (rail.input) {
    message =
      `Power supply ${src.id} is set to ${v(set)} and wired to ${where} and holds the pin above that. ` +
      `A bench supply cannot sink current, so on hardware it would deliver nothing while the board has ` +
      `USB power; ${reading}. Set it above ${v(rail.volts)} to power the board from it, or remove it.`;
  } else {
    message =
      `Power supply ${src.id} is set to ${v(set)} and wired to ${where}, above its setting. A bench supply ` +
      `cannot sink current, so on hardware it would deliver nothing there; ${reading}. ` +
      `Set it to ${v(rail.volts)}, or remove it.`;
  }
  return { severity: 'warning', code: 'supply-on-rail', componentId: src.id, message };
}

/** The sorted node-pair key findSourceConflicts groups ideal sources by. */
export function sourcePairKey(a: string, b: string): string {
  return [a, b].sort().join('|');
}

/**
 * Every node pair an ideal source (V or B card) already sits across in this
 * netlist. The pre-flight consults it BEFORE inventing its worst-case board
 * sources: a wired GPIO whose pair is already held by a component source is
 * an input by construction (a sensor module driving its signal pad, a logic
 * gate's output into a pin the sketch reads), and stamping it HIGH would only
 * manufacture the very conflict this check exists to report.
 */
export function occupiedSourcePairs(netlist: string): Set<string> {
  const out = new Set<string>();
  for (const card of parseSourceCards(netlist)) out.add(sourcePairKey(card.a, card.b));
  return out;
}

/** Say which canvas item a netlist source card belongs to. */
function describeSourceCard(
  card: SourceCard,
  input: BuildNetlistInput,
  synthesizedPins?: ReadonlySet<string>,
): { text: string; componentId?: string } {
  const lower = card.name.toLowerCase();
  if (lower === 'v_vcc_rail') return { text: "the board's main supply rail (5V / VCC / 3V3 pins)" };
  const aux = /^v_aux_rail_(.+)$/.exec(lower);
  if (aux) return { text: `the board's ${railVolts(aux[1]!)} supply pin` };
  for (const board of input.boards) {
    const prefix = `v_${sanitizeSpiceId(board.id)}_`.toLowerCase();
    if (lower.startsWith(prefix)) {
      const pin = Object.keys(board.pins ?? {}).find(
        (p) => `${prefix}${sanitizeSpiceId(p)}`.toLowerCase() === lower,
      );
      const pinName = pin ?? lower.slice(prefix.length);
      // A source the pre-flight itself invented is not "driven by the MCU":
      // nothing has run yet. Say what it is, so a residual conflict reads as
      // "the check assumed this pin is an output", which is the true cause.
      const invented = synthesizedPins?.has(`${board.id}:${pinName}`) ?? false;
      return {
        text: invented
          ? `board ${board.id} pin ${pinName} (assumed HIGH by the circuit check, as an output the sketch may drive)`
          : `board ${board.id} pin ${pinName} (driven by the MCU)`,
        componentId: board.id,
      };
    }
  }
  const body = lower.slice(2); // drop "v_" / "b_"
  for (const comp of input.components) {
    const id = sanitizeSpiceId(comp.id).toLowerCase();
    if (body === id || body.startsWith(`${id}_`)) {
      const role = comp.metadataId.startsWith('reg-')
        ? 'output (VOUT)'
        : comp.metadataId.startsWith('battery') || comp.metadataId === 'power-supply' || comp.metadataId === 'signal-generator'
          ? 'output'
          : comp.metadataId.startsWith('instr-')
            ? 'sense terminal'
            : 'output';
      return { text: `${comp.metadataId} ${comp.id} ${role}`, componentId: comp.id };
    }
  }
  return { text: `source ${card.name}` };
}

/**
 * Two ideal voltage sources across the same pair of nodes, or one source
 * between a node and itself: the .op matrix is singular and ngspice rejects
 * the deck. Exported for tests; `verifyCircuit` runs it before the solve.
 */
export function findSourceConflicts(
  netlist: string,
  input: BuildNetlistInput,
  synthesizedPins?: ReadonlySet<string>,
): CircuitWarning[] {
  const cards = parseSourceCards(netlist);
  const byPair = new Map<string, SourceCard[]>();
  const out: CircuitWarning[] = [];
  for (const card of cards) {
    if (card.a === card.b) {
      const who = describeSourceCard(card, input, synthesizedPins);
      out.push({
        severity: 'error',
        code: 'source-conflict',
        componentId: who.componentId,
        message: `${who.text} is wired back onto its own reference (both terminals on net ${card.a}), so the circuit has no solution. Remove the wire that shorts it.`,
      });
      continue;
    }
    const key = sourcePairKey(card.a, card.b);
    const list = byPair.get(key) ?? [];
    list.push(card);
    byPair.set(key, list);
  }
  for (const [, list] of byPair) {
    if (list.length < 2) continue;
    const parts = list.map((c) => describeSourceCard(c, input, synthesizedPins));
    const names = parts.map((p) => p.text);
    const last = names.pop()!;
    out.push({
      severity: 'error',
      code: 'source-conflict',
      componentId: parts.find((p) => p.componentId)?.componentId,
      message: `${names.join(', ')} and ${last} are both driving the same net, so the circuit has no solution: the simulator cannot solve any voltage on the canvas until one of them is removed. Typical cause: a regulator or battery output wired straight into a board supply pin.`,
    });
  }
  return out;
}


// ── Raspberry Pi header buses ─────────────────────────────────────────────

/** Header boards of the Pi family; the Pico and the UNIHIKER are not. */
const PI_HEADER_KIND = /^raspberry-pi-(zero|1|2|3|4|5)\b/;

/** 40-pin header position -> BCM GPIO, for wires that name the pin by number. */
const PI_HEADER_GPIO: Record<string, number> = {
  '3': 2, '5': 3, '7': 4, '8': 14, '10': 15, '11': 17, '12': 18, '13': 27, '15': 22,
  '16': 23, '18': 24, '19': 10, '21': 9, '22': 25, '23': 11, '24': 8, '26': 7, '27': 0,
  '28': 1, '29': 5, '31': 6, '32': 12, '33': 13, '35': 19, '36': 16, '37': 26, '38': 20,
  '40': 21,
};
const PI_ALIAS_GPIO: Record<string, number> = {
  SDA: 2, SDA1: 2, SCL: 3, SCL1: 3, MOSI: 10, MISO: 9, SCLK: 11, SCK: 11, CE0: 8, CE1: 7,
};

/** The BCM number a Pi pin name refers to, or null for power / ground. */
function piGpioOf(pinName: string): number | null {
  const m = /^GPIO(\d+)$/i.exec(pinName);
  if (m) return Number(m[1]);
  return PI_HEADER_GPIO[pinName] ?? PI_ALIAS_GPIO[pinName.toUpperCase()] ?? null;
}

interface BusRole {
  bus: 'I2C' | 'SPI';
  signal: string;
  gpio: number;
  header: number;
}

const I2C_ROLES: Record<string, BusRole> = {
  SDA: { bus: 'I2C', signal: 'SDA', gpio: 2, header: 3 },
  SCL: { bus: 'I2C', signal: 'SCL', gpio: 3, header: 5 },
};
const SPI_CLOCK = new Set(['SCK', 'SCLK', 'CLK']);
const SPI_MOSI = new Set(['MOSI', 'DIN', 'SDI']);
const SPI_MISO = new Set(['MISO', 'DOUT', 'SDO', 'SO']);
const SPI_ROLE: Record<'clock' | 'mosi' | 'miso', BusRole> = {
  clock: { bus: 'SPI', signal: 'SCLK', gpio: 11, header: 23 },
  mosi: { bus: 'SPI', signal: 'MOSI', gpio: 10, header: 19 },
  miso: { bus: 'SPI', signal: 'MISO', gpio: 9, header: 21 },
};

/**
 * A part on a Pi's I2C or SPI pins that is wired to the wrong GPIO looks
 * connected and never answers: smbus2 opens /dev/i2c-1 and spidev
 * /dev/spidev0.x, and those exist only on the header's hardware pins (I2C on
 * GPIO2/GPIO3, SPI0 on GPIO11/GPIO10/GPIO9). This says which pin the part
 * needs.
 *
 * Deliberately narrow, so it never cries wolf:
 *   - only wires between a PART pin and a Pi header pin (a Pi wired to
 *     another board goes through the Interconnect, not a bus);
 *   - SPI only for a part that looks like SPI, a clock plus a data pin: an
 *     HX711, a TM1637 or an encoder bit-banging CLK on any GPIO is legitimate;
 *   - chip selects and the 1-Wire data line are never checked: any GPIO can
 *     drive a CS by hand, and config.txt moves the w1 pin.
 */
export function piBusPinWarnings(input: Pick<BuildNetlistInput, 'boards' | 'components' | 'wires'>): CircuitWarning[] {
  const piBoards = new Set(
    input.boards.filter((b) => PI_HEADER_KIND.test(b.boardKind ?? '')).map((b) => b.id),
  );
  if (!piBoards.size) return [];
  const partIds = new Set(input.components.map((c) => c.id));

  // Every (part pin -> Pi GPIO) link, per part.
  const links = new Map<string, Array<{ pin: string; gpio: number }>>();
  for (const wire of input.wires) {
    for (const [a, b] of [
      [wire.start, wire.end],
      [wire.end, wire.start],
    ] as const) {
      if (!piBoards.has(a.componentId) || !partIds.has(b.componentId)) continue;
      const gpio = piGpioOf(a.pinName);
      if (gpio === null) continue;
      let list = links.get(b.componentId);
      if (!list) links.set(b.componentId, (list = []));
      list.push({ pin: b.pinName, gpio });
    }
  }

  const out: CircuitWarning[] = [];
  for (const [componentId, list] of links) {
    const names = new Set(list.map((l) => l.pin.toUpperCase()));
    const looksSpi =
      [...names].some((n) => SPI_CLOCK.has(n)) &&
      [...names].some((n) => SPI_MOSI.has(n) || SPI_MISO.has(n));
    const seen = new Set<string>();
    for (const { pin, gpio } of list) {
      const n = pin.toUpperCase();
      const role =
        I2C_ROLES[n] ??
        (looksSpi && SPI_CLOCK.has(n) ? SPI_ROLE.clock : undefined) ??
        (looksSpi && SPI_MOSI.has(n) ? SPI_ROLE.mosi : undefined) ??
        (looksSpi && SPI_MISO.has(n) ? SPI_ROLE.miso : undefined);
      if (!role || gpio === role.gpio || seen.has(n)) continue;
      seen.add(n);
      const lib = role.bus === 'I2C' ? 'smbus2 on /dev/i2c-1' : 'spidev on /dev/spidev0.x';
      out.push({
        severity: 'warning',
        code: 'bus-off-pins',
        componentId,
        message:
          `${componentId} ${pin} is on GPIO${gpio}, but the Raspberry Pi's ${role.bus} ${role.signal} is ` +
          `GPIO${role.gpio} (header pin ${role.header}). ${lib} only reaches that pin: move the wire there` +
          (role.bus === 'SPI' ? ', unless your script bit-bangs the bus on its own pins.' : '.'),
      });
    }
  }
  return out;
}
