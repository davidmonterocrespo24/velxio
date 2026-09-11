/**
 * Board compile helpers shared by the toolbar (Compile / Run) and the
 * Flash dialog (compile-before-flash), so both build the SAME request for
 * a board: same file set, same per-board options, same fingerprint rules.
 */
import { compileCode, type CompileExtras, type SketchFile } from '../services/compilation';
import { isChipProgramFile } from '../services/romCompileService';
import { useEditorStore } from '../store/useEditorStore';
import { useSimulatorStore } from '../store/useSimulatorStore';
import { useProjectStore } from '../store/useProjectStore';
import { fqbnForLanguage, type BoardInstance } from '../types/board';
import { isNoiseBuildLine } from './compilationLogger';
import { publishCompileOutput } from '../lib/intellisenseRegistry';
import { fingerprintSources } from './sourceFingerprint';

/** Per-board compile extras (ESP32 options, SPIFFS, manifest, language, analytics). */
export function compileOptionsForBoard(
  board: BoardInstance | undefined,
  more: Pick<CompileExtras, 'initiatedBy'> = {},
): CompileExtras {
  return {
    boardOptions: board?.boardOptions,
    spiffsFiles: board?.spiffsFiles,
    boardKind: board?.boardKind ?? undefined,
    exampleId: useProjectStore.getState().currentExampleId,
    // P2.4 — THIS board's declared manifest (compile scope). Per-board so
    // two boards can use different libraries without clashing.
    // Three-state (see manifestFieldFor): undefined = never declared,
    // [] = declared empty, else the list. Not coerced here.
    libraries: board?.libraries,
    // Pure ESP-IDF mode (issue #139): compile the user's app_main() sources
    // without the arduino-esp32 component.
    language: board?.languageMode === 'espidf' ? 'espidf' : undefined,
    ...more,
  };
}

/**
 * The board's workspace files as sketch sources, minus custom-chip program
 * files (a chip's `programFile`, or .s/.asm/.hex/.bin): those compile to
 * ROM for the simulated chip, not with the sketch, and avr-gcc chokes on
 * SDCC syntax such as `__at()`.
 */
export function collectSketchFilesForBoard(board: BoardInstance): SketchFile[] {
  const chipProgramFiles = new Set<string>();
  for (const c of useSimulatorStore.getState().components) {
    if (c.metadataId !== 'custom-chip') continue;
    const pf = String((c.properties as Record<string, unknown> | undefined)?.programFile ?? '').trim();
    if (pf) chipProgramFiles.add(pf);
  }
  return useEditorStore
    .getState()
    .getGroupFiles(board.activeFileGroupId)
    .filter((f) => !chipProgramFiles.has(f.name) && !isChipProgramFile(f.name))
    .map((f) => ({ name: f.name, content: f.content }));
}

/** Fingerprint of the board's CURRENT sources (compare with compiledSourceHash). */
export function currentSourceFingerprint(board: BoardInstance): string {
  return fingerprintSources(
    board,
    useEditorStore.getState().getGroupFiles(board.activeFileGroupId),
  );
}

/**
 * True when the board has a program but the code (or build options) changed
 * after it was compiled. A program recorded before fingerprints existed
 * (no compiledSourceHash) is treated as fresh: no evidence either way.
 */
export function isCompiledProgramStale(board: BoardInstance): boolean {
  if (!board.compiledProgram || board.compiledProgram === 'micropython-loaded') return false;
  if (!board.compiledSourceHash) return false;
  return board.compiledSourceHash !== currentSourceFingerprint(board);
}

export type BoardCompileOutcome =
  | { ok: true; program: string; uf2: string | null; elapsedMs: number }
  | { ok: false; error: string; elapsedMs: number };

export interface BoardCompileOptions {
  /** Build for this FQBN instead of the kind's own (a hardware revision). */
  fqbn?: string;
  /**
   * Record the program on the board (default true). False for a build the
   * simulator must not run, e.g. an RP2040 image for a board the emulator
   * runs as RP2350: the caller keeps the result.
   */
  record?: boolean;
}

/**
 * Compile one board's sketch and record the program on the board (same
 * store update the toolbar performs), streaming build output line by line.
 * Arduino / ESP-IDF boards only — MicroPython and Pi boards never compile.
 */
export async function compileBoardForFlash(
  board: BoardInstance,
  onLine: (line: string) => void,
  opts: BoardCompileOptions = {},
): Promise<BoardCompileOutcome> {
  const t0 = performance.now();
  const fqbn = opts.fqbn ?? fqbnForLanguage(board.boardKind, board.languageMode);
  if (!fqbn) {
    return { ok: false, error: `No FQBN for board kind: ${board.boardKind}`, elapsedMs: 0 };
  }
  const files = collectSketchFilesForBoard(board);
  onLine(`$ compile ${fqbn} (${files.map((f) => f.name).join(', ')})`);
  let streamed = 0;
  try {
    const result = await compileCode(
      files,
      fqbn,
      useProjectStore.getState().currentProject?.id ?? null,
      ({ stdout }) => {
        if (stdout.length <= streamed) return;
        const delta = stdout.slice(streamed);
        streamed = stdout.length;
        for (const line of delta.split('\n')) {
          if (line.trim() && !isNoiseBuildLine(line)) onLine(line);
        }
      },
      compileOptionsForBoard(board),
    );
    // Intellisense seam: file:line markers in the editor (cleared on green).
    publishCompileOutput(
      result.success ? '' : [result.stderr, result.error].filter(Boolean).join('\n'),
    );
    const elapsedMs = performance.now() - t0;
    if (!result.success) {
      const text = [result.stderr, result.error].filter(Boolean).join('\n').trim();
      for (const line of text.split('\n')) if (line.trim()) onLine(line);
      return { ok: false, error: result.error || 'Compilation failed', elapsedMs };
    }
    const program = result.hex_content ?? result.binary_content ?? null;
    if (!program) {
      return { ok: false, error: 'Compilation produced no program', elapsedMs };
    }
    const uf2 = result.uf2_content ?? null;
    if (opts.record !== false) {
      const sim = useSimulatorStore.getState();
      sim.compileBoardProgram(board.id, program, { uf2 });
      if (result.has_wifi !== undefined) sim.updateBoard(board.id, { hasWifi: result.has_wifi });
    }
    return { ok: true, program, uf2, elapsedMs };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      elapsedMs: performance.now() - t0,
    };
  }
}
