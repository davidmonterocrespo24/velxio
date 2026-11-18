/**
 * Chip-to-chip net identity — Phase 0 of the multi-chip digital bus track
 * (see project/multichip-bus/ in the velxio-prod repo).
 *
 * THE PROBLEM (root cause A, 00-problem-analysis.md section 2): a digital net
 * is keyed by ONE integer pin number in the per-board PinManager. A board pin
 * (Uno D7 = 7) is net-symmetric — everyone on the net shares the number. But a
 * chip-to-chip net is keyed per-endpoint by `syntheticChipPin(chipId, pinName)`,
 * so the two chips on one wire resolve to two DIFFERENT keys and never share a
 * net. Each chip writes into a key the other never reads.
 *
 * THE FIX: assign every electrically-connected net a single canonical id via
 * union-find over the wire graph, and mint ONE shared `syntheticNetPin(netId)`
 * for any net that has two or more chip endpoints and no board pin. Every
 * endpoint on that net resolves to the same key, so a write on one chip is
 * visible to another through the existing synchronous PinManager fan-out.
 *
 * SCOPE (D-006, never-clone boundary): this module ONLY decides the shared key
 * for pure chip-to-chip nets. It returns null for:
 *   - nets with a board pin  -> traceDetailed's rule 1 (board priority) handles it
 *   - nets with <2 chip endpoints -> traceDetailed's rules 2/3 (single-chip own
 *     synthetic) handle the chip-to-component case unchanged
 * Board emulation never enters this path; the regression surface is the
 * existing chip-to-component examples, gated behind the `chipbus` flag (D-007).
 */
import { UnionFind } from '../spice/unionFind';
import { isBoardComponent, boardPinToNumber } from '../../utils/boardPinMapping';
import { syntheticNetPin } from './syntheticPins';
import { breadboardGroupKey } from '../../utils/breadboardNets';

// Structural view of the slice of simulator state this module needs. The real
// useSimulatorStore state is a superset, so it satisfies this shape directly —
// declaring it structurally keeps the module pure and unit-testable without
// pulling in React / the Zustand store.
interface NetEndpointRef {
  componentId: string;
  pinName: string;
}
interface WireLike {
  start: NetEndpointRef;
  end: NetEndpointRef;
}
interface ComponentLike {
  id: string;
  metadataId: string;
}
interface BoardLike {
  id: string;
  boardKind: string;
}
export interface ChipNetState {
  wires: readonly WireLike[];
  components: readonly ComponentLike[];
  boards: readonly BoardLike[];
}

// Endpoint key = `${componentId}::${pinName}`. velxio chip ids
// (`custom_chip_<ts>_<rand>`) and chip.json pin names are identifier-like and
// never contain `::`, so the split back to (componentId, pinName) is exact.
const SEP = '::';
function epKey(componentId: string, pinName: string): string {
  return `${componentId}${SEP}${pinName}`;
}
function parseEpKey(key: string): { componentId: string; pinName: string } {
  const i = key.indexOf(SEP);
  return { componentId: key.slice(0, i), pinName: key.slice(i + SEP.length) };
}

interface NetInfo {
  /** Lexicographically-smallest endpoint key in the net — stable canonical id
   *  independent of union order, so the minted net pin number does not churn
   *  between resolve passes. */
  canonical: string;
  /** True if any endpoint on the net is a board pin that resolves to a real
   *  GPIO number (board priority defers to traceDetailed's rule 1). */
  hasBoardPin: boolean;
  /** Distinct custom-chip endpoint keys on the net. */
  chipEndpoints: Set<string>;
  /** Board component ids with a numbered pin on this net. Used to work out
   *  which board owns a chip, and so whether a chip-to-chip net crosses two
   *  backend workers (see resolveChipNetMembers). */
  boardIds: Set<string>;
}

interface ChipNetIndex {
  /** Net representative for an endpoint key, or undefined if not on any wire. */
  rootOf(key: string): string | undefined;
  nets: Map<string, NetInfo>;
}

// ── Feature flag (D-007) ─────────────────────────────────────────────────────
//
// Off by default. Enable with `?chipbus=on` or
// `localStorage.velxio.chipbus = 'on'`, mirroring sim-mixedmode's `?mixedmode`.
// Guards every browser global so the module is safe under vitest/node.

let testOverride: boolean | null = null;
/** Test seam: force the flag on/off, or pass null to restore real detection. */
export function setChipBusEnabledForTest(v: boolean | null): void {
  testOverride = v;
}

export function chipBusEnabled(): boolean {
  if (testOverride !== null) return testOverride;
  try {
    if (typeof window !== 'undefined' && window.location) {
      const q = new URLSearchParams(window.location.search).get('chipbus');
      if (q === 'on' || q === '1' || q === 'true') return true;
      if (q === 'off' || q === '0' || q === 'false') return false;
    }
    if (typeof localStorage !== 'undefined') {
      const v = localStorage.getItem('velxio.chipbus');
      if (v === 'on' || v === '1' || v === 'true') return true;
      if (v === 'off' || v === '0' || v === 'false') return false;
    }
  } catch {
    /* SecurityError on localStorage, missing globals in tests — fall through */
  }
  // On by default: chip-to-chip buses are a core capability now. Single-chip and
  // board nets are unaffected (they never take this path), so the only thing
  // this enables is multi-chip buses, which were simply broken before. Override
  // with ?chipbus=off or localStorage.velxio.chipbus = 'off'.
  return true;
}

// ── Net index (memoized by wire/component fingerprint) ───────────────────────

let cache: { sig: string; index: ChipNetIndex } | null = null;

function fingerprint(state: ChipNetState): string {
  const w = state.wires
    .map(
      (x) =>
        `${x.start.componentId}${SEP}${x.start.pinName}|${x.end.componentId}${SEP}${x.end.pinName}`,
    )
    .join(',');
  const c = state.components.map((x) => `${x.id}:${x.metadataId}`).join(',');
  const b = state.boards.map((x) => `${x.id}:${x.boardKind}`).join(',');
  return `${w}#${c}#${b}`;
}

function buildIndex(state: ChipNetState): ChipNetIndex {
  const uf = new UnionFind();
  for (const wire of state.wires) {
    const a = epKey(wire.start.componentId, wire.start.pinName);
    const b = epKey(wire.end.componentId, wire.end.pinName);
    uf.union(a, b);
  }

  const compById = new Map(state.components.map((c) => [c.id, c]));

  // Holes of one breadboard strip (a 5-hole column, a whole rail) are one
  // node, exactly as the SPICE netlist and the pin trace treat them. Without
  // this a chip plugged into the strip of a board pin was on no board's net:
  // only a wire straight to the board joined them, and a board plugged into
  // the breadboard reaches its parts through strips alone.
  const stripFirst = new Map<string, string>();
  for (const wire of state.wires) {
    for (const ep of [wire.start, wire.end]) {
      const comp = compById.get(ep.componentId);
      if (!comp) continue;
      const group = breadboardGroupKey(comp.metadataId, ep.pinName);
      if (group === null) continue;
      const strip = `${ep.componentId}${SEP}${group}`;
      const key = epKey(ep.componentId, ep.pinName);
      const first = stripFirst.get(strip);
      if (first === undefined) stripFirst.set(strip, key);
      else uf.union(first, key);
    }
  }

  const boardById = new Map(state.boards.map((b) => [b.id, b]));
  const nets = new Map<string, NetInfo>();

  for (const [key, root] of uf.entries()) {
    let info = nets.get(root);
    if (!info) {
      info = {
        canonical: key,
        hasBoardPin: false,
        chipEndpoints: new Set(),
        boardIds: new Set(),
      };
      nets.set(root, info);
    }
    if (key < info.canonical) info.canonical = key;

    const { componentId, pinName } = parseEpKey(key);
    const board = boardById.get(componentId);
    if (board || isBoardComponent(componentId)) {
      const kind = board?.boardKind ?? componentId;
      // A real numbered board pin (including -1 power/GND) means a board owns
      // this net; defer to traceDetailed's board-priority rule.
      if (boardPinToNumber(kind, pinName) !== null) {
        info.hasBoardPin = true;
        info.boardIds.add(componentId);
      }
    } else if (compById.get(componentId)?.metadataId === 'custom-chip') {
      info.chipEndpoints.add(key);
    }
  }

  return {
    rootOf: (k) => (uf.has(k) ? uf.find(k) : undefined),
    nets,
  };
}

function getChipNetIndex(state: ChipNetState): ChipNetIndex {
  const sig = fingerprint(state);
  if (cache && cache.sig === sig) return cache.index;
  const index = buildIndex(state);
  cache = { sig, index };
  return index;
}

/** Test seam: drop the memoized index (the fingerprint already invalidates it
 *  on real input changes; this is only for deterministic unit tests). */
export function resetChipNetIndexForTest(): void {
  cache = null;
}

// ── Public resolver ──────────────────────────────────────────────────────────

/**
 * Shared net-canonical key for a chip pin on a pure chip-to-chip net, or null
 * when the legacy resolver rules should handle it (flag off; board on the net;
 * fewer than two chip endpoints). When non-null, EVERY endpoint of the same net
 * gets the identical key, so writes and reads land on one PinManager slot.
 */
export function resolveChipNetKey(
  state: ChipNetState,
  componentId: string,
  pinName: string,
): number | null {
  if (!chipBusEnabled()) return null;
  const idx = getChipNetIndex(state);
  const root = idx.rootOf(epKey(componentId, pinName));
  if (root === undefined) return null;
  const info = idx.nets.get(root);
  if (!info || info.hasBoardPin || info.chipEndpoints.size < 2) return null;
  return syntheticNetPin(info.canonical);
}

// ── Backend (ESP32) net description ──────────────────────────────────────────
//
// The browser chip runtime gets its chip-to-chip nets from resolveChipNetKey
// above: one shared PinManager key and the synchronous fan-out that key already
// has. A chip on an ESP32 board runs in the backend QEMU worker instead, which
// sees only the `pin_map` the frontend sends it, so a pin with no board GPIO
// arrives with nothing to stand on. These members are the same union-find
// answer in a form the worker can act on.

export interface ChipNetMember {
  /** chip.json pin name on this chip. */
  pin: string;
  /** Net id shared by every endpoint on the net, stable across resolves. */
  net: string;
  /** True when another chip on this net is owned by a different board, so the
   *  two ends live in different QEMU workers and the net has to be bridged. */
  remote: boolean;
}

/** Board that owns a chip: the board on any net the chip's pins reach. Ties
 *  resolve to the lexicographically smallest id so the answer does not depend
 *  on Map iteration order. */
function chipOwnerBoard(idx: ChipNetIndex, chipId: string): string | null {
  let owner: string | null = null;
  for (const info of idx.nets.values()) {
    let touches = false;
    for (const ep of info.chipEndpoints) {
      if (parseEpKey(ep).componentId === chipId) {
        touches = true;
        break;
      }
    }
    if (!touches) continue;
    for (const b of info.boardIds) if (owner === null || b < owner) owner = b;
  }
  return owner;
}

/**
 * The board a chip belongs to: the board its pins reach through the wires.
 * Null for a chip wired to no board at all (a board-less canvas, or a chip
 * wired only to other chips). Used to pick the UART pin table for the chip's
 * board and to tell a cross-worker net from a local one.
 */
export function resolveChipOwnerBoardId(
  state: ChipNetState,
  componentId: string,
): string | null {
  return chipOwnerBoard(getChipNetIndex(state), componentId);
}

/**
 * Every pin of `componentId` that shares a net with another chip pin, with the
 * net id the worker keys its fan-out on. Unlike resolveChipNetKey this does NOT
 * skip nets that carry a board pin: on the backend the GPIO behaviour stays and
 * the chip members are driven as well, which is what lets one board's firmware
 * and two chips sit on one line.
 */
export function resolveChipNetMembers(
  state: ChipNetState,
  componentId: string,
): ChipNetMember[] {
  if (!chipBusEnabled()) return [];
  const idx = getChipNetIndex(state);
  const owners = new Map<string, string | null>();
  const ownerOf = (chipId: string): string | null => {
    if (!owners.has(chipId)) owners.set(chipId, chipOwnerBoard(idx, chipId));
    return owners.get(chipId) ?? null;
  };

  const out: ChipNetMember[] = [];
  for (const info of idx.nets.values()) {
    if (info.chipEndpoints.size < 2) continue;
    const mine: string[] = [];
    const boardsOnNet = new Set<string>();
    for (const ep of info.chipEndpoints) {
      const { componentId: cid, pinName } = parseEpKey(ep);
      if (cid === componentId) mine.push(pinName);
      const owner = ownerOf(cid);
      if (owner !== null) boardsOnNet.add(owner);
    }
    if (mine.length === 0) continue;
    const remote = boardsOnNet.size > 1;
    for (const pin of mine) out.push({ pin, net: info.canonical, remote });
  }
  out.sort((a, b) => (a.pin < b.pin ? -1 : a.pin > b.pin ? 1 : 0));
  return out;
}

// ── Cross-board nets ─────────────────────────────────────────────────────────
//
// A pure chip-to-chip net (no board pin on it) whose chips belong to two or
// more boards. Inside one board every browser-hosted endpoint already shares
// the PinManager key `syntheticNetPin(net)`, and a worker-hosted board keeps
// its own bus; nothing joined the boards. Interconnect.ts mirrors the level
// between the boards on this list: PinManager to PinManager for the browser
// side, `chip_net` events for a worker side.

export interface CrossBoardChipNet {
  /** Net id, the canonical endpoint key both the browser and the workers use. */
  net: string;
  /** The PinManager key every browser-hosted endpoint of this net resolves to. */
  pin: number;
  /** Boards that own a chip on the net (two or more, sorted). */
  boards: string[];
}

export function resolveCrossBoardChipNets(state: ChipNetState): CrossBoardChipNet[] {
  if (!chipBusEnabled()) return [];
  const idx = getChipNetIndex(state);
  const owners = new Map<string, string | null>();
  const ownerOf = (chipId: string): string | null => {
    if (!owners.has(chipId)) owners.set(chipId, chipOwnerBoard(idx, chipId));
    return owners.get(chipId) ?? null;
  };
  const out: CrossBoardChipNet[] = [];
  for (const info of idx.nets.values()) {
    if (info.hasBoardPin || info.chipEndpoints.size < 2) continue;
    const boards = new Set<string>();
    for (const ep of info.chipEndpoints) {
      const owner = ownerOf(parseEpKey(ep).componentId);
      if (owner !== null) boards.add(owner);
    }
    if (boards.size < 2) continue;
    out.push({ net: info.canonical, pin: syntheticNetPin(info.canonical), boards: [...boards].sort() });
  }
  out.sort((a, b) => (a.net < b.net ? -1 : a.net > b.net ? 1 : 0));
  return out;
}
