/**
 * Wokwi zip import/export
 *
 * Converts between Wokwi's diagram.json format and Velxio's internal
 * component/wire format, bundling everything into a .zip file.
 *
 * Wokwi zip structure:
 *   diagram.json     — parts + connections
 *   sketch.ino       — main sketch (or projectname.ino)
 *   *.h / *.cpp      — additional files
 *   libraries.txt    — optional library list
 *   wokwi-project.txt — optional metadata
 */

import JSZip from 'jszip';
import type { Wire } from '../types/wire';

// ── Type definitions ──────────────────────────────────────────────────────────

interface WokwiPart {
  type: string;
  id: string;
  top: number;
  left: number;
  rotate?: number;
  attrs: Record<string, unknown>;
}

interface WokwiDiagram {
  version: number;
  author: string;
  editor: string;
  parts: WokwiPart[];
  connections: [string, string, string, string[]][];
}

export interface VelxioComponent {
  id: string;
  metadataId: string;
  x: number;
  y: number;
  properties: Record<string, unknown>;
}

export interface ImportResult {
  /**
   * The board kind the diagram declares, or null when it declares none.
   *
   * A plain string, not the BoardKind union: the overlay registers its board
   * kinds at runtime (proBoardRegistry), so a closed union here would make
   * every pro board unimportable by construction. Null rather than a default:
   * answering 'arduino-uno' for anything unrecognised is what made an ESP32
   * project come back as an Uno (#268).
   */
  boardType: string | null;
  boardPosition: { x: number; y: number };
  components: VelxioComponent[];
  wires: Wire[];
  files: Array<{ name: string; content: string }>;
  /** Library names parsed from libraries.txt. Includes both standard Arduino Library Manager names and Wokwi-hosted entries in the form "LibName@wokwi:hash". */
  libraries: string[];
  /**
   * What the import could not do faithfully, in words a user can act on.
   * Everything here used to happen silently.
   */
  warnings: string[];
}

// ── Board mappings ────────────────────────────────────────────────────────────

/**
 * Boards a real Wokwi element draws, and the Wokwi part type written for them.
 *
 * The membership rule is not taste, it is pin names. A diagram's connections
 * are `partId:pinName`, and the pin names Velxio wires carry are whatever the
 * element on the canvas calls its pins. These four render through
 * wokwi-elements, so their names ARE Wokwi's — an Uno wire says `GND.2`, `A4`,
 * `5V` — and a file naming them opens correctly over there.
 *
 * Every other board renders through a `velxio-*` element with our own names:
 * our ESP32 calls a pin `34` where Wokwi's esp32-devkit-v1 calls it `D34`.
 * Claiming a Wokwi board type for one of those would produce a file that loads
 * in Wokwi and silently attaches every wire to a pin that does not exist —
 * the same class of quiet wrongness this table caused in issue #268. So they
 * get a Velxio type instead, and the file is honest about what it is.
 *
 * The split is visible elsewhere: BOARD_TAG in ComponentPickerModal.tsx names
 * exactly these four with a `wokwi-` tag and everything else with `velxio-`.
 */
const WOKWI_NATIVE_BOARDS: Record<string, { type: string; id: string }> = {
  'arduino-uno': { type: 'wokwi-arduino-uno', id: 'uno' },
  'arduino-nano': { type: 'wokwi-arduino-nano', id: 'nano' },
  'arduino-mega': { type: 'wokwi-arduino-mega', id: 'mega' },
  // Velxio draws its Pico with wokwi-nano-rp2040-connect, but the type written
  // here has always been wokwi-raspberry-pi-pico. Kept verbatim so zips
  // exported before this change still import.
  'raspberry-pi-pico': { type: 'wokwi-raspberry-pi-pico', id: 'pico' },
};

/**
 * Part type for every other board — the ESP32 family, the STM32s, the Pi
 * boards, and the overlay's boards, which are runtime-registered strings the
 * OSS build has never heard of. `board-` is Wokwi's own prefix for a custom
 * board; the `velxio-` namespace says whose it is, and the kind rides along so
 * the round trip is exact for a board nothing in this file knows about.
 */
const VELXIO_BOARD_TYPE_PREFIX = 'board-velxio-';

/** The Wokwi part type to write for a Velxio board kind. Never guesses. */
export function boardKindToWokwiType(kind: string): string {
  return WOKWI_NATIVE_BOARDS[kind]?.type ?? `${VELXIO_BOARD_TYPE_PREFIX}${kind}`;
}

/** The part id to write for a Velxio board kind (Wokwi's short names). */
export function boardKindToWokwiPartId(kind: string): string {
  return WOKWI_NATIVE_BOARDS[kind]?.id ?? kind;
}

/**
 * Board part types registered at runtime, consulted only after everything
 * this file knows for itself.
 *
 * The four boards above are the ones a wokwi-element draws, and the
 * `board-velxio-<kind>` spelling covers every board a Velxio export names.
 * What neither covers is a diagram written by Wokwi for a board Velxio also
 * simulates under a different name — `board-esp32-s3-devkitc-1` is their
 * spelling of our `esp32-s3`. That correspondence is a moving list about
 * boards this build may not even have, so it is not data this file should
 * own; the consumer that has the list registers it.
 *
 * Empty (nothing registered) is the OSS default and imports behave exactly
 * as they did: those types resolve to null and the part is not a board.
 */
const registeredBoardKinds = new Map<string, string>();

/**
 * Teach the importer that a Wokwi board part type denotes a Velxio board
 * kind. Rows are additive and last-write-wins; a row can never shadow one of
 * the native types above, so registering cannot change how an existing
 * Velxio/Wokwi file imports. The export side is untouched: a board still
 * writes its native type or `board-velxio-<kind>`, never a registered one.
 */
export function registerWokwiBoardMappings(rows: Array<{ type: string; kind: string }>): void {
  for (const row of rows) {
    if (!row || !row.type || !row.kind) continue;
    registeredBoardKinds.set(row.type, row.kind);
  }
}

/**
 * The Velxio board kind a Wokwi part type denotes, or null when the part is
 * not a board. Null is the point: the old code answered 'arduino-uno' for
 * everything it did not recognise, so importing an ESP32 project produced an
 * Uno and the real board vanished (#268).
 */
export function wokwiTypeToBoardKind(type: string): string | null {
  if (type.startsWith(VELXIO_BOARD_TYPE_PREFIX)) {
    return type.slice(VELXIO_BOARD_TYPE_PREFIX.length) || null;
  }
  for (const [kind, entry] of Object.entries(WOKWI_NATIVE_BOARDS)) {
    if (entry.type === type) return kind;
  }
  return registeredBoardKinds.get(type) ?? null;
}

// ── Pin name aliases ─────────────────────────────────────────────────────────

// Maps Wokwi connection "signal" pin names to wokwi-element physical pin names.
// Wokwi boards (e.g. board-ssd1306) use different naming than the bare elements.
const COMPONENT_PIN_ALIASES: Record<string, Record<string, string>> = {
  ssd1306: {
    SDA: 'DATA',
    SCL: 'CLK',
    VCC: 'VIN',
  },
};

function normalizePinName(metadataId: string, pinName: string): string {
  return COMPONENT_PIN_ALIASES[metadataId]?.[pinName] ?? pinName;
}

// ── Color helpers ─────────────────────────────────────────────────────────────

const COLOR_NAME_TO_HEX: Record<string, string> = {
  red: '#ff0000',
  black: '#000000',
  green: '#00c800',
  blue: '#0000ff',
  yellow: '#ffff00',
  orange: '#ff8800',
  white: '#ffffff',
  gray: '#808080',
  grey: '#808080',
  purple: '#800080',
  pink: '#ff69b4',
  cyan: '#00ffff',
  gold: '#ffd700',
  brown: '#8b4513',
  magenta: '#ff00ff',
  lime: '#00ff00',
  violet: '#ee82ee',
  maroon: '#800000',
  navy: '#000080',
  teal: '#008080',
};

const HEX_TO_COLOR_NAME: Record<string, string> = {
  '#ff0000': 'red',
  '#000000': 'black',
  '#00ff00': 'green',
  '#00c800': 'green',
  '#0000ff': 'blue',
  '#ffff00': 'yellow',
  '#ff8800': 'orange',
  '#ffffff': 'white',
  '#808080': 'gray',
  '#800080': 'purple',
  '#00ffff': 'cyan',
  '#ffd700': 'gold',
};

function colorToHex(color: string): string {
  if (!color) return '#888888';
  if (color.startsWith('#')) return color.toLowerCase();
  return COLOR_NAME_TO_HEX[color.toLowerCase()] ?? '#888888';
}

function hexToColorName(hex: string): string {
  return HEX_TO_COLOR_NAME[hex.toLowerCase()] ?? hex;
}

// ── Type conversion ───────────────────────────────────────────────────────────

function wokwiTypeToMetadataId(type: string): string {
  // Velxio has no half-size breadboard element; the full board is a strict
  // superset of its hole names (columns 1-30 exist on both), so every
  // connection stays valid — the part just renders longer.
  if (type === 'wokwi-breadboard-half') return 'breadboard';
  if (type.startsWith('wokwi-')) return type.slice(6);
  if (type.startsWith('board-')) return type.slice(6);
  return type;
}

function metadataIdToWokwiType(metadataId: string): string {
  return `wokwi-${metadataId}`;
}

// ── Custom chips (Wokwi `chip-<name>` parts + <name>.chip.c/.chip.json) ──────

/**
 * Deterministic per-chip export name: slug of the chip's display name, with
 * `-2`, `-3`… suffixes when two chips share one. Keyed by component id so
 * the diagram part (`chip-<name>`) and the zip files (`<name>.chip.c/json`)
 * always agree.
 */
export function assignChipExportNames(
  components: readonly VelxioComponent[],
): Map<string, string> {
  const names = new Map<string, string>();
  const used = new Map<string, number>();
  for (const c of components) {
    if (c.metadataId !== 'custom-chip') continue;
    const base =
      String((c.properties as Record<string, unknown>)?.chipName ?? 'chip')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'chip';
    const n = (used.get(base) ?? 0) + 1;
    used.set(base, n);
    names.set(c.id, n === 1 ? base : `${base}-${n}`);
  }
  return names;
}

// ── Library list parser ───────────────────────────────────────────────────────

/**
 * Parse the contents of a Wokwi libraries.txt file.
 * - Strips blank lines and # comments
 * - Includes Wokwi-hosted entries in the form  name@wokwi:hash
 *   so the backend can download and install them from wokwi.com
 */
export function parseLibrariesTxt(content: string): string[] {
  const libs: string[] = [];
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    libs.push(line);
  }
  return libs;
}

// ── Export ────────────────────────────────────────────────────────────────────

/**
 * The diagram a project becomes, as a value.
 *
 * Split out of exportToWokwiZip so the conversion can be tested at all: the
 * export function returns void and downloads through the DOM, so for its whole
 * life nothing could assert on what it produced — which is why a board silently
 * exporting as the wrong Arduino went unnoticed (#268).
 */
export function buildWokwiDiagram(
  components: VelxioComponent[],
  wires: Wire[],
  boardType: string,
  boardPosition: { x: number; y: number } = { x: 50, y: 50 },
  /**
   * The board's id ON THE CANVAS, which is what its wires name. addBoard gives
   * the first board of a kind the kind itself and later ones `${kind}-2`
   * (useSimulatorStore.ts:1508), so the kind is the right default but not a
   * safe assumption — the caller knows. The old code compared against three
   * hardcoded ids, one of them ('nano-rp2040') no longer issued to anything
   * and one board ('arduino-mega') missing outright, so those boards' wires
   * were written pointing at a part id the diagram never defines.
   */
  boardCanvasId: string = boardType,
  /**
   * The canvas ids of the OTHER boards in this project.
   *
   * The format stores one board, so a wire touching a different board cannot
   * be represented — and writing it anyway was worse than dropping it. The
   * board being exported takes the part id its KIND maps to, which for every
   * non-Arduino family IS the first-of-kind canvas id, so a second ESP32's
   * wires collided with it and both boards' components came back attached to
   * the same chip. Silently, because the file was internally consistent.
   */
  foreignBoardIds: readonly string[] = [],
): WokwiDiagram {
  const boardWokwiType = boardKindToWokwiType(boardType);
  const boardId = boardKindToWokwiPartId(boardType);

  // Build parts — board first, then user components
  // Subtract boardPosition so coords are relative to the board
  const chipNames = assignChipExportNames(components);
  const parts: WokwiPart[] = [
    { type: boardWokwiType, id: boardId, top: 0, left: 0, attrs: {} },
    ...components.map((c) => {
      // Rotation travels as Wokwi's top-level `rotate`, never as an attr.
      const { rotation, ...attrs } = (c.properties ?? {}) as Record<string, unknown>;
      const rotate = Number(rotation) || 0;
      // A custom chip becomes a Wokwi `chip-<name>` part; its sources travel
      // as <name>.chip.c/.chip.json files (exportToWokwiZip writes them) and
      // only the attribute VALUES ride the part attrs — never the multi-KB
      // sourceC/wasmBase64 blobs.
      if (c.metadataId === 'custom-chip') {
        const chipAttrs = (attrs.attrs ?? {}) as Record<string, unknown>;
        return {
          type: `chip-${chipNames.get(c.id)}`,
          id: c.id,
          top: Math.round(c.y - boardPosition.y),
          left: Math.round(c.x - boardPosition.x),
          ...(rotate ? { rotate } : {}),
          attrs: Object.fromEntries(
            Object.entries(chipAttrs).filter(([, v]) => typeof v === 'number' || typeof v === 'string'),
          ) as Record<string, unknown>,
        };
      }
      return {
        type: metadataIdToWokwiType(c.metadataId),
        id: c.id,
        top: Math.round(c.y - boardPosition.y),
        left: Math.round(c.x - boardPosition.x),
        ...(rotate ? { rotate } : {}),
        attrs,
      };
    }),
  ];

  // Build connections
  const foreign = new Set(foreignBoardIds.filter((id) => id !== boardCanvasId));
  const connections: [string, string, string, string[]][] = wires
    .filter((w) => !foreign.has(w.start.componentId) && !foreign.has(w.end.componentId))
    .map((w) => {
    // An endpoint on the board is rewritten to the board's part id; everything
    // else keeps its component id, which is the same on both sides.
    const startId = w.start.componentId === boardCanvasId ? boardId : w.start.componentId;
    const endId = w.end.componentId === boardCanvasId ? boardId : w.end.componentId;
    // Breadboard seating wires round-trip as Wokwi's hidden `["$bb"]` entries.
    if (w.bb) {
      return [`${startId}:${w.start.pinName}`, `${endId}:${w.end.pinName}`, '', ['$bb']];
    }
    return [
      `${startId}:${w.start.pinName}`,
      `${endId}:${w.end.pinName}`,
      hexToColorName(w.color ?? '#888888'),
      [],
    ];
  });

  return {
    version: 1,
    author: 'Velxio',
    editor: 'wokwi',
    parts,
    connections,
  };
}

export async function exportToWokwiZip(
  files: Array<{ name: string; content: string }>,
  components: VelxioComponent[],
  wires: Wire[],
  boardType: string,
  projectName: string,
  boardPosition: { x: number; y: number } = { x: 50, y: 50 },
  boardCanvasId: string = boardType,
  /**
   * Library names to declare. The importer has always read libraries.txt and
   * offered to install what it finds; the exporter never wrote one, so a
   * project's libraries did not survive its own round trip.
   */
  libraries: string[] = [],
  /** The other boards on the canvas — see buildWokwiDiagram. */
  foreignBoardIds: readonly string[] = [],
): Promise<void> {
  const zip = new JSZip();
  const diagram = buildWokwiDiagram(
    components,
    wires,
    boardType,
    boardPosition,
    boardCanvasId,
    foreignBoardIds,
  );

  zip.file('diagram.json', JSON.stringify(diagram, null, 2));
  zip.file(
    'wokwi-project.txt',
    `Exported from Velxio\n\nSimulate this project on https://velxio.dev\n`,
  );
  if (libraries.length > 0) {
    zip.file(
      'libraries.txt',
      `# Wokwi Library List\n# See https://docs.wokwi.com/guides/libraries\n\n${libraries.join('\n')}\n`,
    );
  }

  for (const f of files) {
    zip.file(f.name, f.content);
  }

  // Custom chip sources in the Wokwi layout: <name>.chip.c + <name>.chip.json
  // next to diagram.json, matching the `chip-<name>` part types the diagram
  // declares.
  const chipNames = assignChipExportNames(components);
  for (const c of components) {
    const name = chipNames.get(c.id);
    if (!name) continue;
    const props = (c.properties ?? {}) as Record<string, unknown>;
    const sourceC = String(props.sourceC ?? '');
    const chipJson = String(props.chipJson ?? '');
    if (sourceC) zip.file(`${name}.chip.c`, sourceC);
    if (chipJson) zip.file(`${name}.chip.json`, chipJson);
  }

  const blob = await zip.generateAsync({ type: 'blob' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${(projectName || 'velxio-project').replace(/[^a-z0-9_-]/gi, '-')}.zip`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Point the board's wires at the id the board actually got.
 *
 * importFromWokwiZip names them by the board's KIND; the canvas may have
 * called it something else — a second board of that kind is `${kind}-2`, and a
 * project imported onto an existing board keeps that board's id whatever its
 * new kind. Wires naming an id nothing answers to is the failure this whole
 * issue is made of.
 */
export function retargetBoardWires(wires: Wire[], fromId: string, toId: string): Wire[] {
  if (!fromId || fromId === toId) return wires;
  return wires.map((w) => ({
    ...w,
    start: w.start.componentId === fromId ? { ...w.start, componentId: toId } : w.start,
    end: w.end.componentId === fromId ? { ...w.end, componentId: toId } : w.end,
  }));
}

// ── Import ────────────────────────────────────────────────────────────────────

export async function importFromWokwiZip(file: File): Promise<ImportResult> {
  const zip = await JSZip.loadAsync(file);

  // diagram.json is required
  const diagramEntry = zip.file('diagram.json');
  if (!diagramEntry) throw new Error('No diagram.json found in the zip file.');

  const diagramText = await diagramEntry.async('string');
  const diagram: WokwiDiagram = JSON.parse(diagramText);

  const warnings: string[] = [];

  // Detect the board. Parts that name a board come first; anything else is a
  // component.
  const boardParts = diagram.parts.filter((p) => wokwiTypeToBoardKind(p.type) !== null);
  const boardPart = boardParts[0] ?? null;
  const boardType = boardPart ? wokwiTypeToBoardKind(boardPart.type) : null;

  if (!boardPart) {
    // Do NOT invent an Uno. A diagram whose board type we do not know is a
    // diagram whose board we would silently replace, and the user would see a
    // circuit wired to the wrong chip with no hint why.
    const unknown = [...new Set(diagram.parts.map((p) => p.type))].join(', ');
    warnings.push(
      diagram.parts.length === 0
        ? 'The diagram has no parts, so no board could be identified.'
        : `No board recognised in the diagram (parts: ${unknown}). The circuit was imported; add the board yourself and its wires will attach.`,
    );
  }
  if (boardParts.length > 1) {
    // Velxio canvases hold several boards, but this format writes one, and the
    // extras used to be dropped without a word — not even as components.
    warnings.push(
      `The diagram declares ${boardParts.length} boards; only the first (${boardType}) was imported.`,
    );
  }

  const boardId = boardPart?.id ?? '';

  // Wires that touched the board are named by its KIND, which is the id
  // addBoard gives the first board of a kind (useSimulatorStore.ts:1508).
  // Whoever applies this result knows the id the board really ends up with and
  // finishes the job with retargetBoardWires — the importer cannot, because
  // the kind is not known until the diagram is parsed. The old code used a
  // hardcoded map that answered 'nano-rp2040' for a Pico, an id nothing has
  // been issued since boards became instances, so every imported Pico wire
  // attached to a component that does not exist.
  const velxioBoardId = boardType ?? '';

  // Board position from diagram. Apply a minimum offset so the board is never
  // crammed against the canvas top-left corner (Wokwi diagrams often use 0,0).
  // With no board part there is no origin to measure from, so the components
  // keep their own coordinates and boardPosition follows them. Defaulting the
  // raw origin to MIN_OFFSET while leaving the offsets at 0 (what this did
  // before) put the board 50px from the corner and the circuit somewhere else.
  const MIN_OFFSET = 50;
  const rawBoardX = boardPart?.left ?? 0;
  const rawBoardY = boardPart?.top ?? 0;
  const offsetX = rawBoardX < MIN_OFFSET ? MIN_OFFSET - rawBoardX : 0;
  const offsetY = rawBoardY < MIN_OFFSET ? MIN_OFFSET - rawBoardY : 0;
  const boardPosition = {
    x: rawBoardX + offsetX,
    y: rawBoardY + offsetY,
  };

  // Custom chip sources: a `chip-<name>` part's code lives in sibling
  // <name>.chip.c / <name>.chip.json files. Load them up front so the part
  // mapping below can be synchronous.
  const chipFiles = new Map<string, { c?: string; json?: string }>();
  for (const [filename, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;
    const basename = filename.split('/').pop() ?? filename;
    const m = basename.match(/^(.+)\.chip\.(c|json)$/);
    if (!m) continue;
    const slot = chipFiles.get(m[1]) ?? {};
    if (m[2] === 'c') slot.c = await entry.async('string');
    else slot.json = await entry.async('string');
    chipFiles.set(m[1], slot);
  }

  // Convert non-board parts to Velxio components.
  // Apply the same offset so components keep their relative position to the board.
  const components: VelxioComponent[] = diagram.parts
    .filter((p) => wokwiTypeToBoardKind(p.type) === null)
    .map((p) => {
      // Wokwi custom chip part → Velxio custom-chip component. The part's
      // attrs are the chip's attribute VALUES; the sources come from the
      // matching .chip.c/.chip.json. wasmBase64 stays empty — Run compiles
      // it (Wokwi's precompiled .wasm would target their ABI anyway).
      if (p.type.startsWith('chip-')) {
        const name = p.type.slice(5);
        const src = chipFiles.get(name);
        if (!src?.c) {
          warnings.push(
            `Custom chip "${name}" has no ${name}.chip.c in the zip — imported without source; edit its chip.c before running.`,
          );
        }
        return {
          id: p.id,
          metadataId: 'custom-chip',
          x: p.left + offsetX,
          y: p.top + offsetY,
          properties: {
            chipName: name,
            sourceC: src?.c ?? '',
            chipJson: src?.json ?? JSON.stringify({ name, pins: [] }),
            wasmBase64: '',
            ...(Object.keys(p.attrs ?? {}).length ? { attrs: { ...p.attrs } } : {}),
            ...(p.rotate ? { rotation: p.rotate } : {}),
          },
        };
      }
      return {
        id: p.id,
        metadataId: wokwiTypeToMetadataId(p.type),
        x: p.left + offsetX,
        y: p.top + offsetY,
        // Wokwi stores rotation as a top-level `rotate` (degrees), not an
        // attr — map it onto properties.rotation or every rotated part
        // imports lying flat.
        properties: {
          ...p.attrs,
          ...(p.rotate ? { rotation: p.rotate } : {}),
        },
      };
    });

  // Wokwi names its own instruments with a leading '$': `$serialMonitor` is
  // the serial monitor, wired to the board's TX/RX in almost every Wokwi
  // project. They are not parts of the circuit (Velxio's serial monitor
  // needs no wire), so their connections are dropped here: imported, they
  // were wires to nothing, and they set off the missing-part warning below.
  const isInstrumentRef = (ref: string) => ref.startsWith('$');
  const connections = diagram.connections.filter(
    ([a, b]) => !isInstrumentRef(a) && !isInstrumentRef(b),
  );

  // Convert connections to Velxio wires
  const wires: Wire[] = connections.map((conn, i) => {
    const [startStr, endStr, color, path] = conn;
    // Wokwi persists parts seated ON a breadboard as one hidden connection
    // per pin: empty color + the special "$bb" token in the path slot.
    // Import them as velxio breadboard-seating wires (bb: true) so they
    // stay invisible and re-seat when the part moves.
    const isSeating = (Array.isArray(path) && path[0] === '$bb') || color === '';
    const colonA = startStr.indexOf(':');
    const colonB = endStr.indexOf(':');
    const startCompRaw = colonA >= 0 ? startStr.slice(0, colonA) : startStr;
    const startPin = colonA >= 0 ? startStr.slice(colonA + 1) : '';
    const endCompRaw = colonB >= 0 ? endStr.slice(0, colonB) : endStr;
    const endPin = colonB >= 0 ? endStr.slice(colonB + 1) : '';

    // Remap board part id → Velxio internal board id
    const startId = startCompRaw === boardId ? velxioBoardId : startCompRaw;
    const endId = endCompRaw === boardId ? velxioBoardId : endCompRaw;

    // Normalize pin names: Wokwi uses signal names (SDA, SCL, VCC) while
    // wokwi-elements use physical/board pin names (DATA, CLK, VIN).
    const startMetadataId = components.find((c) => c.id === startId)?.metadataId ?? '';
    const endMetadataId = components.find((c) => c.id === endId)?.metadataId ?? '';
    const normalizedStartPin = normalizePinName(startMetadataId, startPin);
    const normalizedEndPin = normalizePinName(endMetadataId, endPin);

    return {
      id: `wire-${i}-${Date.now()}`,
      start: { componentId: startId, pinName: normalizedStartPin, x: 0, y: 0 },
      end: { componentId: endId, pinName: normalizedEndPin, x: 0, y: 0 },
      waypoints: [],
      color: isSeating ? '#000000' : colorToHex(color),
      ...(isSeating ? { bb: true as const } : {}),
    };
  });

  // A connection naming a part the diagram never defines attaches to nothing.
  // Diagrams written by Velxio before #268 are exactly this: the board part
  // says `uno` while the connections say `esp32`, because the export wrote the
  // board's type from one table and the wires' ids from another. Importing one
  // is not recoverable — the real board is not in the file — but arriving with
  // half a circuit and no explanation is worse than being told.
  //
  // Checked against the RAW diagram, not the wires built above. Those have
  // already had the board's id rewritten to the board KIND, and seeding the
  // allowed set with that kind (what this did first) let a wire that literally
  // names the kind pass as defined — which is exactly the wire a second board
  // on the canvas writes. The check went quiet on the one case worth catching.
  const definedIds = new Set(diagram.parts.map((p) => p.id));
  const dangling = new Set<string>();
  for (const [a, b] of connections) {
    for (const ref of [a, b]) {
      const id = ref.includes(':') ? ref.slice(0, ref.indexOf(':')) : ref;
      if (id && !definedIds.has(id)) dangling.add(id);
    }
  }
  if (dangling.size > 0) {
    warnings.push(
      `Some wires refer to parts the diagram does not contain (${[...dangling].join(', ')}); they were imported but attach to nothing.`,
    );
  }

  // Read code files. The export writes every file in the project verbatim, so
  // this list is the one that decides what comes back — and it used to admit
  // only the Arduino four, which meant a MicroPython project round-tripped
  // with an empty editor. Deliberately not '.txt': libraries.txt and
  // wokwi-project.txt are metadata, read separately.
  const CODE_EXTS = new Set(['.ino', '.h', '.hpp', '.cpp', '.cc', '.cxx', '.c', '.py', '.s']);
  const files: Array<{ name: string; content: string }> = [];

  for (const [filename, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;
    const basename = filename.split('/').pop() ?? filename;
    // Chip sources belong to their chip's file group (loaded above), not to
    // the board sketch — without this exclusion every <name>.chip.c would
    // also land in the editor AND get fed to arduino-cli.
    if (/\.chip\.(c|json)$/.test(basename)) continue;
    const ext = '.' + basename.split('.').pop()!.toLowerCase();
    if (CODE_EXTS.has(ext)) {
      const content = await entry.async('string');
      files.push({ name: basename, content });
    }
  }

  // Sort: .ino first, then alphabetically
  files.sort((a, b) => {
    const aIno = a.name.endsWith('.ino');
    const bIno = b.name.endsWith('.ino');
    if (aIno && !bIno) return -1;
    if (!aIno && bIno) return 1;
    return a.name.localeCompare(b.name);
  });

  // Parse libraries.txt
  const libraries: string[] = [];
  const libEntry = zip.file('libraries.txt');
  if (libEntry) {
    libraries.push(...parseLibrariesTxt(await libEntry.async('string')));
  }

  return { boardType, boardPosition, components, wires, files, libraries, warnings };
}
