/**
 * PinTrace — "which board pin is this component pin wired to?"
 *
 * The wire graph is not a chain of point-to-point links: a NET is every pin
 * the wires transitively join, and a component pin can carry more than one
 * wire. This walk answers, for one (component, pin), the board GPIO that owns
 * its net — tracing through 2-terminal passives (a resistor in series is
 * electrically transparent to the digital layer), through breadboard strips,
 * and through a socket a board is seated on.
 *
 * It used to live inside components/DynamicComponent.tsx. It moved here so the
 * store can use the SAME answer when it pre-registers backend sensors: two
 * copies of "find the board pin" that disagreed is exactly how an HC-SR04
 * behind a level-shifting divider ended up with an echo pin nobody had wired
 * (see the sensor pre-registration in useSimulatorStore.startBoard).
 *
 * Dependency-light on purpose (no React, no store VALUE import) so both the
 * renderer and the store can import it.
 */
import type { useSimulatorStore } from '../store/useSimulatorStore';
import { isBoardComponent, boardPinToNumber } from '../utils/boardPinMapping';
import { isBoardSeated } from '../utils/socketSnap';
import { isActiveDevice } from './PinResolver';
import { breadboardGroupKey } from '../utils/breadboardNets';
import { syntheticChipPin, SYNTHETIC_CHIP_PIN_BASE } from './customChips/syntheticPins';
import { resolveChipNetKey } from './customChips/chipNets';
import { isChipLikePad } from './customChips/chipLikePads';

// Map metadataId → [pinA, pinB] for 2-terminal passives.
// "Tracing through" means: if the caller arrived on pinA, continue from pinB
// (and vice-versa).
//
// NOTE: diodes / transistors / op-amps are NOT traced through as passives —
// they have polarity / Vf / non-linear behaviour that the digital layer
// cannot interpret as "same pin". BJTs are an explicit shortcut for the
// canonical "Arduino digital pin controls a load via transistor" pattern so
// 7-segment multiplex circuits with BJT digit drivers still resolve.
const PASSIVE_PIN_PAIRS_BASE: Record<string, [string, string]> = {
  resistor: ['1', '2'],
  'resistor-us': ['1', '2'],
  capacitor: ['1', '2'],
  'capacitor-electrolytic': ['+', '−'],
  inductor: ['1', '2'],
  'analog-resistor': ['A', 'B'],
  'analog-capacitor': ['A', 'B'],
  'analog-inductor': ['A', 'B'],
  'bjt-2n2222': ['C', 'B'],
  'bjt-bc547': ['C', 'B'],
  'bjt-2n3055': ['C', 'B'],
  'bjt-2n3906': ['C', 'B'],
  'bjt-bc557': ['C', 'B'],
};
// Preset variants of the generic passives share their parent's tag and pin
// layout. Mirrors the PASSIVE_PRESETS map in spice/componentToSpice.ts.
const PRESET_TO_BASE: Record<string, string> = {
  'resistor-220': 'resistor',
  'resistor-330': 'resistor',
  'resistor-470': 'resistor',
  'resistor-1k': 'resistor',
  'resistor-2k2': 'resistor',
  'resistor-4k7': 'resistor',
  'resistor-10k': 'resistor',
  'resistor-22k': 'resistor',
  'resistor-47k': 'resistor',
  'resistor-100k': 'resistor',
  'resistor-1m': 'resistor',
  'cap-10p': 'capacitor',
  'cap-22p': 'capacitor',
  'cap-100p': 'capacitor',
  'cap-1n': 'capacitor',
  'cap-10n': 'capacitor',
  'cap-100n': 'capacitor',
  'cap-1u': 'capacitor',
  'cap-elec-1u': 'capacitor-electrolytic',
  'cap-elec-10u': 'capacitor-electrolytic',
  'cap-elec-47u': 'capacitor-electrolytic',
  'cap-elec-100u': 'capacitor-electrolytic',
  'cap-elec-470u': 'capacitor-electrolytic',
  'cap-elec-1000u': 'capacitor-electrolytic',
  'ind-100u': 'inductor',
  'ind-1m': 'inductor',
  'ind-10m': 'inductor',
};
export const PASSIVE_PIN_PAIRS: Record<string, [string, string]> = {
  ...PASSIVE_PIN_PAIRS_BASE,
};
for (const [preset, base] of Object.entries(PRESET_TO_BASE)) {
  PASSIVE_PIN_PAIRS[preset] = PASSIVE_PIN_PAIRS_BASE[base];
}

export type TraceState = ReturnType<typeof useSimulatorStore.getState>;

export interface TraceResult {
  /** >=0 board pin (or a synthetic chip pin), -1 supply/GND pad, null unreached. */
  arduinoPin: number | null;
  /** True iff the trace passed through a BJT/MOSFET/op-amp/diode. */
  crossedActiveDevice: boolean;
  /** Id of the board the pin belongs to, when one was reached. */
  boardId?: string;
}

/** boardPinToNumber's answer for a supply / GND / reset pad. */
const RAIL = -1;

/** How many COMPONENTS the walk may cross. Same-node hops are free: they do
 *  not leave the net, so a long strip cannot exhaust the budget. */
const MAX_HOPS = 6;

/** A REAL board pin. A synthetic chip pin is also >= 0 but is a much weaker
 *  answer — treating the two alike is how a chip one hop away used to end the
 *  search before a GPIO on the same net was ever looked at. */
function isBoardPin(pin: number | null): pin is number {
  return pin !== null && pin >= 0 && pin < SYNTHETIC_CHIP_PIN_BASE;
}

const pinKey = (componentId: string, pinName: string) => `${componentId}\u0000${pinName}`;

type WireLike = TraceState['wires'][number];
type WireEnd = WireLike['start'];
type ComponentLike = TraceState['components'][number];

/**
 * Wires indexed by the pin they land on, built once per wires array.
 *
 * The walk asks this question once per pin per frame, and it now walks the
 * WHOLE node rather than a single chain, so the old `state.wires.filter(...)`
 * per frame turned a ground plane into an O(n^2) sweep — on a canvas where
 * every part traces every pin on every re-render. The index is keyed by the
 * array identity, so it is rebuilt exactly when the wires actually change.
 */
const wireIndexCache = new WeakMap<object, Map<string, WireLike[]>>();

/** Components by id, rebuilt only when the components array changes. The walk
 *  asks for a component on every pin of a node, and `Array.find` over a canvas
 *  full of parts is what turned a shared ground rail into a hot loop. */
const componentIndexCache = new WeakMap<object, Map<string, ComponentLike>>();

function componentById(
  components: TraceState['components'],
  id: string,
): ComponentLike | undefined {
  let index = componentIndexCache.get(components as unknown as object);
  if (!index) {
    index = new Map();
    for (const c of components) index.set(c.id, c);
    componentIndexCache.set(components as unknown as object, index);
  }
  return index.get(id);
}

/**
 * True when (metadataId, pinName) may act as rule 5's pin source: every pin of
 * a custom chip, plus a pad a part registered as chip-like. The two are the
 * same case — a pin the part drives that no wire joins to a board GPIO — so
 * the walk mints one synthetic number for either.
 */
function isChipPinSource(metadataId: string | undefined, pinName: string): boolean {
  return metadataId === 'custom-chip' || isChipLikePad(metadataId, pinName);
}

/**
 * Wired holes per breadboard group, so continuing along a strip does not
 * re-scan every wire on the canvas for every hole it passes through.
 * Keyed by the wires array and invalidated when the components array changes
 * too, since the group key depends on each component's metadataId.
 */
const groupIndexCache = new WeakMap<
  object,
  { components: object; groups: Map<string, string[]> }
>();

function groupHoles(
  state: TraceState,
  componentId: string,
  metadataId: string,
  groupKey: string,
): string[] {
  const wiresRef = state.wires as unknown as object;
  const compsRef = state.components as unknown as object;
  let entry = groupIndexCache.get(wiresRef);
  if (!entry || entry.components !== compsRef) {
    const groups = new Map<string, string[]>();
    for (const w of state.wires) {
      for (const ep of [w.start, w.end]) {
        const comp = componentById(state.components, ep.componentId);
        if (!comp) continue;
        const g = breadboardGroupKey(comp.metadataId, ep.pinName);
        if (!g) continue;
        const k = `${ep.componentId}\u0000${g}`;
        const list = groups.get(k);
        if (!list) groups.set(k, [ep.pinName]);
        else if (!list.includes(ep.pinName)) list.push(ep.pinName);
      }
    }
    entry = { components: compsRef, groups };
    groupIndexCache.set(wiresRef, entry);
  }
  return entry.groups.get(`${componentId}\u0000${groupKey}`) ?? [];
}

function wiresAtPin(wires: TraceState['wires'], componentId: string, pinName: string): WireLike[] {
  let index = wireIndexCache.get(wires as unknown as object);
  if (!index) {
    index = new Map();
    for (const w of wires) {
      for (const ep of [w.start, w.end]) {
        const k = `${ep.componentId}\u0000${ep.pinName}`;
        const list = index.get(k);
        if (list) list.push(w);
        else index.set(k, [w]);
      }
    }
    wireIndexCache.set(wires as unknown as object, index);
  }
  return index.get(`${componentId}\u0000${pinName}`) ?? [];
}

/**
 * Resolve a component pad through a SEATED board rather than a wire.
 *
 * Sockets are a real electrical connection with nothing to draw: the board's
 * pads sit on the component's pads. `boardSocket` (read off the element, the
 * rule-6a way) says the component is a socket; isBoardSeated says a board is
 * actually in it; and the shared pad NAME is the contract that makes the two
 * grids one net — which is exactly why a socket's pinInfo uses the board's own
 * names. Returns null for anything that is not a seated socket pad.
 */
function traceThroughSocket(
  state: TraceState,
  componentId: string,
  pinName: string,
): { pin: number; boardId: string } | null {
  if (typeof document === 'undefined') return null;
  const el = document.getElementById(componentId) as
    | (HTMLElement & { boardSocket?: { anchorPin: string; accepts: string[] } })
    | null;
  const sock = el?.boardSocket;
  if (!sock || !Array.isArray(sock.accepts)) return null;
  for (const b of state.boards) {
    if (!sock.accepts.some((prefix) => b.boardKind.startsWith(prefix))) continue;
    if (!isBoardSeated(b.id, b.boardKind, b.x, b.y, state.components)) continue;
    const pin = boardPinToNumber(b.boardKind, pinName);
    if (pin !== null) return { pin, boardId: b.id };
  }
  return null;
}

/**
 * A NET is a set of pins, not a path through them.
 *
 * That sentence is the whole fix. The walk used to follow one chain of wires
 * and answer with the first thing it bumped into, so the answer depended on
 * which wire the user drew first, and a pin one wire away from the MCU was
 * invisible if some other branch reached a rail sooner. What a net is:
 *
 *   NODE   — every pin joined without crossing a component: the wires between
 *            them, and the holes of one breadboard strip. Same electrical
 *            point, so the walk collects the whole set before judging it.
 *   HOP    — crossing a 2-terminal passive to its far pin lands on a DIFFERENT
 *            node, one step further from the start, and costs one of MAX_HOPS.
 *
 * With the node in hand the answer is a property of the set, in this order:
 *
 *   1. a driven board pin ON this node — a real GPIO, wins outright;
 *   2. a supply/GND pad on this node: the node IS the rail, and the walk stops
 *      there. It must never continue out the far side, or a cathode on the
 *      ground plane would resolve to whatever GPIO a button's pull-down hangs
 *      off — the plane joins them, the signal does not;
 *   3. a driven pin one or more HOPS away — this is what makes a level-shifted
 *      sensor work: the walk crosses the divider's top resistor and finds the
 *      MCU on the tap;
 *   4. a rail one or more hops away (a pull-up, the divider's low leg) — real,
 *      but weaker than any driven pin anywhere;
 *   5. a custom-chip pin: the net-canonical key when several chips share the
 *      net (the chip bus), else the neighbour's own synthetic pin. A pad a
 *      part registered as CHIP-LIKE (a relay contact, a driver's screw
 *      terminal — see customChips/chipLikePads) counts as one of these: the
 *      part drives it without any wire joining it to a board pin, so it is a
 *      pin source in the same sense a chip's output pin is.
 *
 * `crossedActiveDevice` reports whether a hop went through a BJT / MOSFET /
 * op-amp / diode, which is what makes the resolver pick its SPICE-resolved
 * flavour over the digital fast path.
 */
export function traceDetailed(
  state: TraceState,
  fromId: string,
  fromPin: string,
  depth = 0,
  activeSeen = false,
): TraceResult {
  return walk(state, fromId, fromPin, depth, activeSeen, new Map(), true, undefined);
}

/**
 * The recursion behind traceDetailed / traceBoardGpio.
 *
 *  - `seen` records each visit WITH its depth: a node first reached deep,
 *    where the hop budget cut its continuations short, must still be walkable
 *    when a shorter route arrives later.
 *  - `isRoot` marks the outermost frame, the only one allowed to mint a
 *    chip-net / own-chip-pin fallback (rule 5) — `depth === 0` used to say
 *    that, and cannot now that a node is collected rather than walked.
 *  - `preferBoard` breaks a tie between driven pads of DIFFERENT boards on one
 *    node, so a caller asking about a specific board gets that board's pad
 *    when the net reaches both (a sensor shared by two MCUs).
 */
function walk(
  state: TraceState,
  fromId: string,
  fromPin: string,
  depth: number,
  activeSeen: boolean,
  seen: Map<string, number>,
  isRoot: boolean,
  preferBoard: string | undefined,
): TraceResult {
  const selfKey = pinKey(fromId, fromPin);
  const seenAt = seen.get(selfKey);
  if (seenAt !== undefined && seenAt <= depth) {
    return { arduinoPin: null, crossedActiveDevice: activeSeen };
  }
  if (depth > MAX_HOPS) return { arduinoPin: null, crossedActiveDevice: activeSeen };

  const node = collectNode(state, fromId, fromPin, seen, depth, preferBoard);

  // ── Rules 1 and 2: the pads on this node ─────────────────────────────────
  if (node.drivenHit) return { ...node.drivenHit, crossedActiveDevice: activeSeen };
  if (node.boardHits.length) {
    return { ...node.boardHits[0], crossedActiveDevice: activeSeen };
  }

  // ── Rules 3 and 4: across the passives sitting on this node ──────────────
  let crossedRail: TraceResult | null = null;
  let chipHit: TraceResult | null = null;
  for (const p of node.pins) {
    const pair = p.comp && PASSIVE_PIN_PAIRS[p.comp.metadataId];
    if (!pair || !p.comp) continue;
    const farPin = p.pinName === pair[0] ? pair[1] : pair[0];
    const nowActive = activeSeen || isActiveDevice(p.comp.metadataId);
    const across = walk(state, p.comp.id, farPin, depth + 1, nowActive, seen, false, preferBoard);
    if (isBoardPin(across.arduinoPin)) return across;
    if (across.arduinoPin === RAIL) crossedRail ??= across;
    else if (across.arduinoPin !== null) chipHit ??= across;
  }
  if (crossedRail) return crossedRail;

  // ── Rule 5: chips ────────────────────────────────────────────────────────
  // Multi-chip digital bus (chipbus flag, Phase 0 of project/multichip-bus/):
  // when this net has two or more chip endpoints and no board pin, collapse
  // every endpoint onto ONE net-canonical synthetic key so a write on one chip
  // is visible to another through the synchronous PinManager fan-out (fixes
  // root cause A: per-endpoint keys never matching). resolveChipNetKey returns
  // null when the flag is off, when a board owns the net, or when there is a
  // single chip endpoint. It must be asked BEFORE the per-endpoint fallback
  // below, and only at the root: a nested frame answering with its own
  // neighbour's key is exactly how the two chips stopped sharing one key.
  if (isRoot) {
    const netKey = resolveChipNetKey(state, fromId, fromPin);
    if (netKey !== null) return { arduinoPin: netKey, crossedActiveDevice: activeSeen };
  }
  if (node.chipPin) {
    return {
      arduinoPin: syntheticChipPin(node.chipPin.id, node.chipPin.pin),
      crossedActiveDevice: activeSeen,
    };
  }
  if (chipHit) return chipHit;
  if (isRoot && isChipPinSource(componentById(state.components, fromId)?.metadataId, fromPin)) {
    return { arduinoPin: syntheticChipPin(fromId, fromPin), crossedActiveDevice: activeSeen };
  }
  return { arduinoPin: null, crossedActiveDevice: activeSeen };
}

/** Every pin joined to (fromId, fromPin) without crossing a component. */
interface NodeInfo {
  /** Component pins on the node, with their component when it is one. */
  pins: Array<{ componentId: string; pinName: string; comp: ComponentLike | undefined }>;
  /** The first DRIVEN pad found. Collection stops there: rule 1 wins outright,
   *  so the rest of the node cannot change the answer. */
  drivenHit: TraceResult | null;
  /** Board pads the node lands on, driven or rail, in no particular order. */
  boardHits: TraceResult[];
  /** A custom-chip pin (or a registered chip-like pad) on the node, if any —
   *  rule 5's per-endpoint fallback. */
  chipPin: { id: string; pin: string } | null;
}

function collectNode(
  state: TraceState,
  fromId: string,
  fromPin: string,
  seen: Map<string, number>,
  depth: number,
  preferBoard: string | undefined,
): NodeInfo {
  const pins: NodeInfo['pins'] = [];
  const boardHits: TraceResult[] = [];
  // A driven pad of the preferred board ends collection at once; one of any
  // other board is kept and only wins if the preferred board never shows up.
  let drivenHit: TraceResult | null = null;
  let chipPin: NodeInfo['chipPin'] = null;
  const takeDriven = (hit: TraceResult): boolean => {
    if (preferBoard === undefined || hit.boardId === preferBoard) {
      drivenHit = hit;
      return true;
    }
    drivenHit ??= hit;
    return false;
  };
  const local = new Set<string>();
  const queue: Array<{ componentId: string; pinName: string }> = [
    { componentId: fromId, pinName: fromPin },
  ];

  while (queue.length) {
    const cur = queue.pop()!;
    const key = pinKey(cur.componentId, cur.pinName);
    if (local.has(key)) continue;
    local.add(key);
    // The whole node is now "visited at this depth": a later branch arriving
    // from further away has nothing new to learn here, while a SHORTER route
    // still may (see the depth compare in traceDetailed).
    const prev = seen.get(key);
    if (prev === undefined || prev > depth) seen.set(key, depth);

    const comp = componentById(state.components, cur.componentId);
    pins.push({ ...cur, comp });

    // A board SEATED on a socket component is connected without any wire —
    // that is what seating means, and it is how the hardware ships: a XIAO
    // pushed into a shield's header, a Pi HAT dropped onto the 40-pin. The
    // shared pad NAME is the contract, which is why a socket's pinInfo uses
    // the board's own names.
    const socket = traceThroughSocket(state, cur.componentId, cur.pinName);
    if (socket) {
      const hit = { arduinoPin: socket.pin, crossedActiveDevice: false, boardId: socket.boardId };
      if (isBoardPin(socket.pin)) {
        if (takeDriven(hit)) return { pins, boardHits, drivenHit, chipPin };
      } else {
        boardHits.push(hit);
      }
    }

    // Breadboards join N holes per internal group (5-hole strip / power rail):
    // one node, no component in between. Continue from every OTHER wired hole
    // of the same group — including the arrival hole itself, since two wires
    // may legitimately share one hole (a seated pin plus a jumper landing in
    // that same hole, which is how the agent bridges strips).
    const group = comp && breadboardGroupKey(comp.metadataId, cur.pinName);
    if (group && comp) {
      for (const hole of groupHoles(state, comp.id, comp.metadataId, group)) {
        if (!local.has(pinKey(comp.id, hole))) {
          queue.push({ componentId: comp.id, pinName: hole });
        }
      }
    }

    for (const w of wiresAtPin(state.wires, cur.componentId, cur.pinName)) {
      const selfEp =
        w.start.componentId === cur.componentId && w.start.pinName === cur.pinName
          ? w.start
          : w.end;
      const otherEp = selfEp === w.start ? w.end : w.start;
      // A board endpoint is recognised by the LIVE boards list first.
      // `isBoardComponent` matches static id prefixes ('arduino-uno', …), which
      // only covers the default board — every board added at runtime (the agent
      // mints UUID ids) failed the check, so tracing treated it as an unknown
      // component and returned null. Symptom: an ESP32 clock whose QEMU was
      // emitting hundreds of GPIO edges/second at a display that stayed dark,
      // because no resolver ever attached.
      const boardEp = state.boards.find((b) => b.id === otherEp.componentId);
      if (boardEp || isBoardComponent(otherEp.componentId)) {
        const boardKind = boardEp?.boardKind ?? otherEp.componentId;
        const pin = boardPinToNumber(boardKind, otherEp.pinName);
        // The board id travels with the pin: a QEMU-Linux board has no MCU
        // simulator, so an input part needs to know WHICH board's bridge to
        // push the level into (see the pi-aware simulator in DynamicComponent).
        if (pin !== null) {
          const hit = {
            arduinoPin: pin,
            crossedActiveDevice: false,
            boardId: boardEp?.id ?? otherEp.componentId,
          };
          // A driven pad ends the search for this node — and, on a big shared
          // rail, ends a walk of every leg hanging off it.
          if (isBoardPin(pin)) {
            if (takeDriven(hit)) return { pins, boardHits, drivenHit, chipPin };
          } else {
            boardHits.push(hit);
          }
        }
        continue;
      }
      const otherComp = componentById(state.components, otherEp.componentId);
      if (!chipPin && isChipPinSource(otherComp?.metadataId, otherEp.pinName)) {
        chipPin = { id: otherEp.componentId, pin: otherEp.pinName };
      }
      if (!local.has(pinKey(otherEp.componentId, otherEp.pinName))) {
        queue.push({ componentId: otherEp.componentId, pinName: otherEp.pinName });
      }
    }
  }
  return { pins, boardHits, drivenHit, chipPin };
}

/**
 * The board GPIO owning this component pin, or null when the walk reached a
 * supply pad, a custom-chip net, or nothing at all. This is the shape a caller
 * that wants to talk to REAL hardware wants: a rail and a synthetic chip pin
 * are both "not a GPIO on this board".
 *
 * `boardId` is a PREFERENCE the walk honours on the node, not just a filter on
 * the way out: when one net reaches two boards' GPIOs (a sensor shared by two
 * MCUs) the caller asking about board A gets A's pad, and only a net that
 * truly never reaches A answers null for it.
 */
export function traceBoardGpio(
  state: TraceState,
  componentId: string,
  pinName: string,
  boardId?: string,
): number | null {
  const hit = walk(state, componentId, pinName, 0, false, new Map(), true, boardId);
  if (hit.arduinoPin === null) return null;
  if (hit.arduinoPin < 0 || hit.arduinoPin >= SYNTHETIC_CHIP_PIN_BASE) return null;
  if (boardId !== undefined && hit.boardId !== undefined && hit.boardId !== boardId) return null;
  return hit.arduinoPin;
}
