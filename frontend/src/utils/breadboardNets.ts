/**
 * Breadboard internal-connectivity helpers.
 *
 * A solderless breadboard electrically joins holes in fixed groups:
 *   - each terminal-strip column of 5 holes is one net
 *     (full board: rows a-e form the top bank, f-j the bottom bank), and
 *   - each power rail (full board only) is one net running the whole length.
 *
 * Pin names follow the Wokwi convention so imported diagram.json wires work
 * verbatim (e.g. "18t.d" = column 18, top bank, row d; "bn.15" = bottom
 * negative rail, hole 15):
 *   holes:  `${col}t.${a-e}`   |   `${col}b.${f-j}`
 *   rails:  `tp.N` / `tn.N` (top +/-)   |   `bp.N` / `bn.N` (bottom +/-)
 *
 * Consumers (NetlistBuilder union-find, DynamicComponent digital trace) use
 * `breadboardGroupKey` to decide which pins are internally shorted: two pins
 * on the same breadboard belong to the same net iff their group keys match.
 *
 * The same question — "which of this part's pins are the same node?" — comes
 * up for any part that shorts some of its own pins: an I2C hub or
 * multiplexer whose downstream sockets are one bus, a terminal breakout.
 * `registerInternalNetGroups` lets a part answer it without this file
 * knowing anything about the part.
 */

const BREADBOARD_IDS = new Set(['breadboard', 'breadboard-mini']);

/**
 * True for a SEAT wire: the invisible zero-length wire that joins a pin
 * plugged into a breadboard (a part's, or a board's) to the hole under it.
 * Electrically real, so the netlist and every trace keep it; but it is not a
 * wire the user drew, so counts, labels and "N wires" messages leave it out.
 */
export function isSeatWire(w: { bb?: boolean }): boolean {
  return w.bb === true;
}

/** True when the metadataId is one of the breadboard parts. */
export function isBreadboard(metadataId: string): boolean {
  return BREADBOARD_IDS.has(metadataId);
}

/**
 * Pin name -> group key, or null when the pin is not part of any internal
 * net. Pins of one component with equal keys are the same electrical node.
 */
export type InternalNetGroupFn = (pinName: string) => string | null;

const internalNets = new Map<string, InternalNetGroupFn>();

/**
 * Declare that a part shorts some of its own pins together — a hub, a
 * multiplexer, a terminal breakout. Registered at load time by whoever owns
 * the part (overlays included); calling twice for one id replaces the entry.
 */
export function registerInternalNetGroups(metadataId: string, fn: InternalNetGroupFn): void {
  internalNets.set(metadataId, fn);
}

/** True when a part has internal nets at all — a breadboard or a registrant. */
export function hasInternalNets(metadataId: string): boolean {
  return isBreadboard(metadataId) || internalNets.has(metadataId);
}

const HOLE_RE = /^(\d+)([tb])\.([a-j])$/;
const RAIL_RE = /^([tb][pn])\.(\d+)$/;

/**
 * Group key for a breadboard pin, or null when the pin name is not a valid
 * breadboard hole/rail. Pins with equal keys are internally connected.
 */
export function breadboardGroupKey(metadataId: string, pinName: string): string | null {
  const registered = internalNets.get(metadataId);
  if (registered) return registered(pinName);
  if (!isBreadboard(metadataId)) return null;
  const hole = HOLE_RE.exec(pinName);
  if (hole) return `col${hole[1]}${hole[2]}`; // e.g. "col18t" — one 5-hole strip
  const rail = RAIL_RE.exec(pinName);
  if (rail) return `rail${rail[1]}`; // e.g. "railbn" — the whole rail is one net
  return null;
}
