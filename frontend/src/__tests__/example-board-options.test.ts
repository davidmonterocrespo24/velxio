// @vitest-environment jsdom
/**
 * An example can say which Board Options it is written for (flash mode and
 * speed, PSRAM, ...), and loading it puts them on the board.
 *
 * Why: the board kept the generic defaults, so an example flashed to a real
 * XIAO ESP32-S3 went out with DIO flash at 40 MHz while the board's own
 * Arduino core uses QIO at 80 MHz, and a game written for the board ran far
 * slower on it than it should (Skythread, measured on the hardware,
 * 2026-11-27). The simulator, a download and a flash all build from the
 * board's options, so they are where the example's settings must land.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { useSimulatorStore } from '../store/useSimulatorStore';
import { exampleBoardOptions, loadExample } from '../utils/loadExample';
import type { ExampleProject } from '../data/examples';
import { registerProBoards, type ProBoardDef } from '../lib/proBoardRegistry';
import type { ESP32BoardOptions } from '../types/boardOptions';

function resetStores() {
  const sim = useSimulatorStore.getState();
  for (const id of sim.boards.map((b) => b.id)) sim.removeBoard(id);
}

function example(boardOptions?: Partial<ESP32BoardOptions>): ExampleProject {
  return {
    id: 'test-example-board-options',
    title: 'Board options test',
    description: 'test',
    category: 'basics',
    difficulty: 'beginner',
    boardType: 'esp32-s3',
    code: '',
    boards: [
      {
        boardKind: 'esp32-s3',
        x: 100,
        y: 100,
        code: 'void setup() {}\nvoid loop() {}\n',
        ...(boardOptions ? { boardOptions } : {}),
      },
    ],
    components: [],
    wires: [],
  } as unknown as ExampleProject;
}

const board = () => useSimulatorStore.getState().boards.find((b) => b.boardKind === 'esp32-s3');

describe('an example board carries its Board Options', () => {
  beforeEach(resetStores);

  it('puts the options the example names on the board', async () => {
    await loadExample(example({ flashMode: 'qio', flashFreqMHz: '80', arduinoRunsOnCore: 1 }));
    expect(board()?.boardOptions).toEqual({ flashMode: 'qio', flashFreqMHz: '80', arduinoRunsOnCore: 1 });
  });

  it('stores only the keys named, so the compiler keeps its own defaults for the rest', async () => {
    await loadExample(example({ flashMode: 'qio' }));
    // No partitionScheme here: the dialog's default (min_spiffs) is not the
    // compiler's (huge_app), and filling it in would repartition the board.
    expect(Object.keys(board()?.boardOptions ?? {})).toEqual(['flashMode']);
  });

  it('leaves a board alone when the example names none', async () => {
    await loadExample(example());
    expect(board()).toBeDefined();
    expect(board()?.boardOptions).toBeUndefined();
  });

  it('replaces the options a previous example left on the board', async () => {
    await loadExample(example({ flashMode: 'qio', flashFreqMHz: '80' }));
    await loadExample(example());
    expect(board()?.boardOptions).toBeUndefined();
  });
});

describe('exampleBoardOptions', () => {
  it("keeps what the board kind declares under what the example asks for", () => {
    const def: ProBoardDef = {
      kind: 'test-s3-module-octal',
      label: 'Test S3 module',
      fqbn: 'esp32:esp32:esp32s3',
      description: 'test',
      tag: 'velxio-test-s3-module',
      size: { w: 10, h: 10 },
      esp32Family: 'esp32-s3',
      defaultBoardOptions: { flashSize: '8MB', cpuFreqMHz: 240 },
    } as unknown as ProBoardDef;
    registerProBoards([def]);
    expect(exampleBoardOptions('test-s3-module-octal', { flashMode: 'qio', flashSize: '16MB' })).toEqual({
      flashSize: '16MB', // the example wins
      cpuFreqMHz: 240, // the module's own, kept
      flashMode: 'qio',
    });
  });
});
