/**
 * Fixed wire routes for gallery examples.
 *
 * An example wire written without corners used to open as a plain elbow from
 * pin to pin, straight across whatever sat in between: the board, a display,
 * the sensor the wire belongs to. The corners that keep each wire clear are
 * computed ONCE, offline, by routing every example in a real browser (the
 * velxio-prod generator `scripts/route-example-wires.mjs`), and stored here as
 * data. Opening an example never routes anything: it reads these corners, so
 * every visitor sees the same drawing, and the drawing is the one that was
 * checked.
 *
 * A table entry carries the example's layout key, a hash of everything that
 * decides where a pin sits (boards, parts and their properties, wire ends).
 * When an example is edited after its routes were made, the key no longer
 * matches and the stale corners are ignored: the example opens with the old
 * elbows instead of corners that point at pins that moved. The velxio-prod
 * gate test lists such examples so they get routed again.
 *
 * Corners written in the example itself (`wires[i].waypoints`) always win.
 * Tables are lazy: each is its own chunk, fetched on the first example open,
 * not with the app.
 */
import type { ExampleProject } from '../data/examples';

export interface WirePoint {
  x: number;
  y: number;
}

/**
 * One example's routes. `wires[i]` belongs to `example.wires[i]`, flattened
 * as [x0, y0, x1, y1, ...]; an empty array keeps that wire as it is.
 */
export interface ExampleWireRouteEntry {
  key: string;
  wires: number[][];
}

export interface ExampleWireRouteTable {
  examples: Record<string, ExampleWireRouteEntry>;
}

type TableLoader = () => Promise<ExampleWireRouteTable>;

const loaders: TableLoader[] = [
  () => import('../data/example-wire-routes').then((m) => m.default),
];
let merged: Promise<Record<string, ExampleWireRouteEntry>> | null = null;

/**
 * Overlay seam: a private build adds the routes of the examples it registers.
 * Call it before those examples can be opened (next to `registerProExamples`).
 */
export function registerExampleWireRoutes(load: TableLoader): void {
  loaders.push(load);
  merged = null;
}

function allRoutes(): Promise<Record<string, ExampleWireRouteEntry>> {
  if (!merged) {
    merged = Promise.all(
      loaders.map((load) =>
        load().catch(() => ({ examples: {} }) as ExampleWireRouteTable),
      ),
    ).then((tables) => Object.assign({}, ...tables.map((t) => t.examples ?? {})));
  }
  return merged;
}

/** FNV-1a, 32 bit, as 8 hex digits: stable in Node and in every browser. */
function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * Hash of what places the example's pins: the board(s), every part with its
 * properties (a rotation or a size option moves pins), and both ends of every
 * wire in order. Code, text and tags are left out, so editing a sketch keeps
 * the routes.
 */
export function exampleLayoutKey(example: ExampleProject): string {
  return fnv1a(
    JSON.stringify([
      example.boardType ?? null,
      example.boardFilter ?? null,
      (example.boards ?? []).map((b) => [b.boardKind, b.x, b.y]),
      (example.components ?? []).map((c) => [c.id, c.type, c.x, c.y, c.properties ?? {}]),
      (example.wires ?? []).map((w) => [
        w.id,
        w.start.componentId,
        w.start.pinName,
        w.end.componentId,
        w.end.pinName,
      ]),
    ]),
  );
}

/** Corners of one entry, aligned with `example.wires`; null when it does not apply. */
export function cornersFromEntry(
  example: ExampleProject,
  entry: ExampleWireRouteEntry | undefined,
): Array<WirePoint[] | undefined> | null {
  if (!entry || entry.key !== exampleLayoutKey(example)) return null;
  const wires = example.wires ?? [];
  if (entry.wires.length !== wires.length) return null;
  return entry.wires.map((flat) => {
    if (!flat.length) return undefined;
    const pts: WirePoint[] = [];
    for (let i = 0; i + 1 < flat.length; i += 2) pts.push({ x: flat[i], y: flat[i + 1] });
    return pts;
  });
}

/**
 * The stored corners for an example's wires, or null when there are none (no
 * table entry, a stale one, or a table that failed to load).
 */
export async function exampleWireCorners(
  example: ExampleProject,
): Promise<Array<WirePoint[] | undefined> | null> {
  if (!example.wires?.length) return null;
  try {
    const routes = await allRoutes();
    return cornersFromEntry(example, routes[example.id]);
  } catch {
    return null;
  }
}
