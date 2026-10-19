// @vitest-environment jsdom
/**
 * Issue #268 — "import project doesn't work": export a project to .zip, import
 * it back, and the board is gone. Two reporters; the second noticed it "only
 * works with wokwi components", which is the shape of it — the passives are
 * real Wokwi part types and survive, the board was not.
 *
 * The bug was in the EXPORT. wokwiZip knew four boards and silently wrote
 * `wokwi-arduino-uno`/`uno` for anything else, while the connections kept the
 * real board's canvas id. The attached repro is exactly that: parts declare an
 * `uno`, connections name `esp32`.
 *
 * These tests round-trip EVERY board kind, because that is the assertion the
 * module never had: it was written when Velxio had four boards and nothing
 * failed when it grew to thirty.
 */
import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import {
  buildWokwiDiagram,
  importFromWokwiZip,
  boardKindToWokwiType,
  wokwiTypeToBoardKind,
  retargetBoardWires,
} from '../utils/wokwiZip';
import type { VelxioComponent } from '../utils/wokwiZip';
import type { Wire } from '../types/wire';
import { BOARD_KIND_LABELS, isKnownBoardKind, type BoardKind } from '../types/board';

const ALL_KINDS = Object.keys(BOARD_KIND_LABELS) as BoardKind[];

/** A board wired to a resistor and an LED — the reporter's circuit. */
function project(boardCanvasId: string) {
  const components: VelxioComponent[] = [
    { id: 'r-led', metadataId: 'resistor', x: 270, y: 155, properties: { value: '220' } },
    { id: 'led-ext', metadataId: 'led', x: 420, y: 140, properties: { color: 'red' } },
  ];
  const wire = (
    id: string,
    a: [string, string],
    b: [string, string],
    color: string,
  ): Wire => ({
    id,
    start: { componentId: a[0], pinName: a[1], x: 0, y: 0 },
    end: { componentId: b[0], pinName: b[1], x: 0, y: 0 },
    waypoints: [],
    color,
  });
  const wires: Wire[] = [
    wire('w1', [boardCanvasId, '4'], ['r-led', '1'], '#e74c3c'),
    wire('w2', ['r-led', '2'], ['led-ext', 'A'], '#e74c3c'),
    wire('w3', ['led-ext', 'C'], [boardCanvasId, 'GND'], '#2c3e50'),
  ];
  return { components, wires };
}

async function zipOf(diagram: unknown): Promise<File> {
  const zip = new JSZip();
  zip.file('diagram.json', JSON.stringify(diagram));
  zip.file('sketch.ino', 'void setup(){}\nvoid loop(){}\n');
  const blob = await zip.generateAsync({ type: 'blob' });
  return new File([blob], 'sketch.zip', { type: 'application/zip' });
}

describe('issue #268 — a project survives export and re-import', () => {
  it.each(ALL_KINDS)('%s keeps its board and its wiring', async (kind) => {
    const { components, wires } = project(kind);
    const diagram = buildWokwiDiagram(components, wires, kind, { x: 50, y: 50 }, kind);

    // The board must never be written as some other board.
    const boardPart = diagram.parts[0];
    expect(wokwiTypeToBoardKind(boardPart.type)).toBe(kind);

    // Every connection must name a part the diagram actually defines. This is
    // the reporter's zip in one assertion: it declared `uno` and wired `esp32`.
    const partIds = new Set(diagram.parts.map((p) => p.id));
    for (const [a, b] of diagram.connections) {
      expect(partIds).toContain(a.slice(0, a.indexOf(':')));
      expect(partIds).toContain(b.slice(0, b.indexOf(':')));
    }

    const result = await importFromWokwiZip(await zipOf(diagram));
    expect(result.boardType).toBe(kind);
    expect(result.warnings).toEqual([]);
    // The board is not left lying around as a component.
    expect(result.components.map((c) => c.id).sort()).toEqual(['led-ext', 'r-led']);
    // And the wires point back at the board.
    const onBoard = result.wires.filter(
      (w) => w.start.componentId === kind || w.end.componentId === kind,
    );
    expect(onBoard).toHaveLength(2);
  });

  it('lands the wires on the board that is actually on the canvas', async () => {
    // Importing an ESP32 project onto a canvas whose board answers to
    // 'arduino-uno' (a fresh project, re-kinded in place) must attach the
    // wires to THAT id — setBoardType changes a board's kind, never its id.
    const { components, wires } = project('esp32');
    const diagram = buildWokwiDiagram(components, wires, 'esp32', { x: 50, y: 50 }, 'esp32');
    const result = await importFromWokwiZip(await zipOf(diagram));
    expect(result.boardType).toBe('esp32');
    const retargeted = retargetBoardWires(result.wires, result.boardType!, 'arduino-uno');
    const ids = retargeted.flatMap((w) => [w.start.componentId, w.end.componentId]);
    expect(ids).toContain('arduino-uno');
    expect(ids).not.toContain('esp32');
    // And the components are left alone.
    expect(ids.filter((i) => i === 'r-led')).toHaveLength(2);
  });

  it('never answers with a board the file did not name', async () => {
    // The old importer returned 'arduino-uno' for any diagram it did not
    // recognise, which is how an ESP32 project came back as an Uno.
    const diagram = {
      version: 1,
      author: 'someone',
      editor: 'wokwi',
      parts: [{ type: 'wokwi-something-unheard-of', id: 'x', top: 0, left: 0, attrs: {} }],
      connections: [],
    };
    const result = await importFromWokwiZip(await zipOf(diagram));
    expect(result.boardType).toBeNull();
    expect(result.warnings.join(' ')).toMatch(/No board recognised/);
  });

  it('says so when a diagram declares more than one board', async () => {
    const diagram = {
      version: 1,
      author: 'Velxio',
      editor: 'wokwi',
      parts: [
        { type: boardKindToWokwiType('esp32'), id: 'esp32', top: 0, left: 0, attrs: {} },
        { type: boardKindToWokwiType('arduino-uno'), id: 'uno', top: 0, left: 200, attrs: {} },
      ],
      connections: [],
    };
    const result = await importFromWokwiZip(await zipOf(diagram));
    expect(result.boardType).toBe('esp32');
    expect(result.warnings.join(' ')).toMatch(/2 boards/);
  });

  it('still writes the Wokwi part type for boards a Wokwi element draws', () => {
    // These four render through wokwi-elements, so their pin names are Wokwi's
    // and the file genuinely opens over there. Changing them would break that.
    expect(boardKindToWokwiType('arduino-uno')).toBe('wokwi-arduino-uno');
    expect(boardKindToWokwiType('arduino-nano')).toBe('wokwi-arduino-nano');
    expect(boardKindToWokwiType('arduino-mega')).toBe('wokwi-arduino-mega');
    expect(boardKindToWokwiType('raspberry-pi-pico')).toBe('wokwi-raspberry-pi-pico');
  });

  it('round-trips a board this build has never heard of', async () => {
    // Overlay boards are runtime-registered strings; the OSS module cannot
    // enumerate them, so the type carries the kind instead of guessing.
    const kind = 'some-pro-board-2350';
    const diagram = buildWokwiDiagram([], [], kind, { x: 50, y: 50 }, kind);
    expect(diagram.parts[0].type).toBe('board-velxio-some-pro-board-2350');
    const result = await importFromWokwiZip(await zipOf(diagram));
    expect(result.boardType).toBe(kind);
  });
});

describe('#268 — what else the round trip was quietly dropping', () => {
  it('brings a MicroPython project back with its code', async () => {
    // CODE_EXTS admitted only the Arduino four, so a .py project imported
    // into an empty editor. The export had been writing the files all along.
    const zip = new JSZip();
    zip.file('diagram.json', JSON.stringify(buildWokwiDiagram([], [], 'esp32', { x: 50, y: 50 }, 'esp32')));
    zip.file('main.py', 'print("hello")\n');
    zip.file('lib.hpp', '#pragma once\n');
    const blob = await zip.generateAsync({ type: 'blob' });
    const result = await importFromWokwiZip(new File([blob], 's.zip', { type: 'application/zip' }));
    expect(result.files.map((f) => f.name).sort()).toEqual(['lib.hpp', 'main.py']);
  });

  it('does not mistake metadata for source', async () => {
    const zip = new JSZip();
    zip.file('diagram.json', JSON.stringify(buildWokwiDiagram([], [], 'esp32', { x: 50, y: 50 }, 'esp32')));
    zip.file('wokwi-project.txt', 'Exported from Velxio\n');
    zip.file('libraries.txt', 'Adafruit GFX Library\n');
    const blob = await zip.generateAsync({ type: 'blob' });
    const result = await importFromWokwiZip(new File([blob], 's.zip', { type: 'application/zip' }));
    expect(result.files).toEqual([]);
    expect(result.libraries).toEqual(['Adafruit GFX Library']);
  });

  it('refuses board kinds that are only there because of the prototype chain', () => {
    // The kind comes out of a file someone sent you. `in` would have said yes
    // to every one of these.
    for (const bogus of ['toString', 'constructor', 'valueOf', '__proto__', 'hasOwnProperty']) {
      expect(isKnownBoardKind(bogus)).toBe(false);
      // …and the type still round-trips them as data, which is the point of
      // validating separately from parsing.
      expect(wokwiTypeToBoardKind(`board-velxio-${bogus}`)).toBe(bogus);
    }
    expect(isKnownBoardKind('esp32')).toBe(true);
    expect(isKnownBoardKind('arduino-uno')).toBe(true);
  });
});

describe('#268 — the limit this fix does not lift', () => {
  const led = (id: string, y: number): VelxioComponent => ({
    id, metadataId: 'led', x: 300, y, properties: {},
  });
  const to = (id: string, boardId: string, pin: string): Wire => ({
    id,
    start: { componentId: boardId, pinName: pin, x: 0, y: 0 },
    end: { componentId: id.replace('w', 'led'), pinName: 'A', x: 0, y: 0 },
    waypoints: [], color: '#ff0000',
  });

  it('leaves another board\'s wires out instead of re-attaching them to this one', async () => {
    // The failure this replaced was not a loss, it was a corruption: a second
    // board of the SAME kind takes the part id this board's kind maps to, so
    // led2 came back on led1's chip — on the same pin — and the file was
    // internally consistent, so nothing complained. Verified across all 30
    // kinds during review.
    const components = [led('led1', 100), led('led2', 200)];
    const wires = [to('w1', 'esp32', '4'), to('w2', 'esp32-2', '4')];
    const diagram = buildWokwiDiagram(
      components, wires, 'esp32', { x: 50, y: 50 }, 'esp32-2', ['esp32'],
    );
    const refs = diagram.connections.flatMap(([a, b]) => [a, b]);
    // Only the exported board's own wire is written.
    expect(refs).toContain('esp32:4');
    expect(refs.filter((r) => r.startsWith('esp32:'))).toHaveLength(1);
    expect(refs).toContain('led2:A');
    expect(refs).not.toContain('led1:A');

    const result = await importFromWokwiZip(await zipOf(diagram));
    // led1 is still on the canvas as a part; what it must NOT do is arrive
    // wired to a board it was never connected to.
    const onBoard = result.wires.filter(
      (w) => w.start.componentId === 'esp32' || w.end.componentId === 'esp32',
    );
    expect(onBoard).toHaveLength(1);
    expect(onBoard[0].end.componentId).toBe('led2');
  });

  it('announces the wires it cannot honour when a canvas had more than one board', async () => {
    // Two boards of DIFFERENT kinds: the other one's wires name a part the
    // diagram does not define, and the import says so.
    const components = [led('led1', 100), led('led2', 200)];
    const wires = [to('w1', 'esp32', '4'), to('w2', 'arduino-uno', '5')];
    // Nothing declared foreign here — this is a file written before the
    // export learned to leave them out.
    const diagram = buildWokwiDiagram(components, wires, 'esp32', { x: 50, y: 50 }, 'esp32');
    const result = await importFromWokwiZip(await zipOf(diagram));
    expect(result.boardType).toBe('esp32');
    expect(result.warnings.join(' ')).toMatch(/arduino-uno/);
    expect(result.warnings.join(' ')).toMatch(/attach to nothing/);
  });

  it('catches a same-kind stray too, which the first version of this check missed', async () => {
    // The check used to allow the board KIND as a defined id, so a wire that
    // literally names it — what a second board writes — passed as attached.
    const diagram = {
      version: 1,
      author: 'Velxio',
      editor: 'wokwi',
      parts: [
        { type: boardKindToWokwiType('esp32'), id: 'esp32', top: 0, left: 0, attrs: {} },
        { type: 'wokwi-led', id: 'led2', top: 100, left: 300, attrs: {} },
      ],
      connections: [['esp32-2:4', 'led2:A', 'red', []]],
    };
    const result = await importFromWokwiZip(await zipOf(diagram));
    expect(result.warnings.join(' ')).toMatch(/esp32-2/);
  });

  it('drops the wires to Wokwi\'s serial monitor without calling them missing parts', async () => {
    // Almost every project downloaded from Wokwi wires the board's TX/RX to
    // `$serialMonitor`, an instrument and not a part. A reporter's FreeRTOS +
    // OLED project arrived with "Some wires refer to parts the diagram does
    // not contain ($serialMonitor)".
    const diagram = {
      version: 1,
      author: 'Taylor Wang',
      editor: 'wokwi',
      parts: [
        { type: 'wokwi-esp32-devkit-v1', id: 'esp', top: 0, left: 0, attrs: {} },
        { type: 'wokwi-servo', id: 'servo1', top: 0, left: 300, attrs: {} },
      ],
      connections: [
        ['esp:TX0', '$serialMonitor:RX', '', []],
        ['esp:RX0', '$serialMonitor:TX', '', []],
        ['servo1:PWM', 'esp:D13', 'green', ['h0']],
      ],
    };
    const result = await importFromWokwiZip(await zipOf(diagram));
    expect(result.warnings.join(' ')).not.toMatch(/serialMonitor|attach to nothing/);
    expect(result.wires).toHaveLength(1);
    expect(result.wires[0].start.componentId).toBe('servo1');
  });
});
