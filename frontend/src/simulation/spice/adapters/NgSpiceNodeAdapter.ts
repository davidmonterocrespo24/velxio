/**
 * NgSpiceNodeAdapter — SolverPort implementation that runs the
 * vendored ngspice WASM directly in the Vitest Node process, no
 * Web Worker required.
 *
 * Architecture:
 *   loadNgSpiceForNode → emscripten Module (with _velxio_fs et al.
 *   patched on)
 *   ↓
 *   stageFilesystem — write the .cm files + spinit to the WASM FS
 *   ↓
 *   bindApi — Module.cwrap the C functions we need
 *   ↓
 *   initialiseNgspice — register callbacks, call ngSpice_Init,
 *   set xspice, source /spinit
 *
 * Once initialised, SolverPort methods translate domain calls to
 * ngspice commands and read results via ngGet_Vec_Info.
 *
 * Concurrency: ngspice C API is not thread-safe; this adapter
 * serialises every call.  Vitest's worker-per-test-file isolation
 * means each test file gets a fresh process and adapter.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  initialConditionCommands,
  type SolverPort,
  type SolveAnalysis,
  type SolveResult,
  type SolveOptions,
  type SolveVector,
} from '../ports/SolverPort';
export type { SolveVector } from '../ports/SolverPort';
import {
  loadNgSpiceForNode,
  type NgSpiceEmscriptenModule,
} from './node/loadNgSpiceForNode';

const MODEL_FILES = [
  'analog.cm',
  'digital.cm',
  'spice2poly.cm',
  'table.cm',
  'tlines.cm',
  'xtradev.cm',
  'xtraevt.cm',
];

// ngspice vector_info struct field offsets (32-bit pointers).
// Confirmed against the live struct dump from the vendored build.
const VECTOR_INFO_FLAGS_OFFSET = 8;
const VECTOR_INFO_REALDATA_OFFSET = 12;
const VECTOR_INFO_IMAGDATA_OFFSET = 16;
const VECTOR_INFO_LENGTH_OFFSET = 20;
const VECTOR_FLAG_COMPLEX = 1 << 1;

interface NgSpiceApi {
  init: (
    print: number,
    status: number,
    exit: number,
    data: number,
    dataInit: number,
    bg: number,
    arg: number,
  ) => number;
  command: (cmd: string) => number;
  circ: (linesPtr: number) => number;
  allVecs: (plot: string) => number;
  curPlot: () => string;
  getVecInfo: (name: string) => number;
  reset: () => number;
  nospiceinit: () => number;
  setInputPath: (path: string) => number;
}

function defaultWasmDir(): string {
  const here = fileURLToPath(import.meta.url);
  return path.resolve(here, '../../../../../public/wasm/ngspice-interactive');
}

export class NgSpiceNodeAdapter implements SolverPort {
  private module: NgSpiceEmscriptenModule | null = null;
  private api: NgSpiceApi | null = null;
  private initialised = false;
  private initPromise: Promise<void> | null = null;
  private readonly wasmDir: string;
  private stdoutBuffer: string[] = [];
  private stderrBuffer: string[] = [];
  private callbackPointers: number[] = [];

  constructor(opts: { wasmDir?: string } = {}) {
    this.wasmDir = opts.wasmDir ?? defaultWasmDir();
  }

  async init(): Promise<void> {
    if (this.initialised) return;
    if (this.initPromise) return this.initPromise;
    this.initPromise = (async () => {
      this.module = await loadNgSpiceForNode({
        wasmDir: this.wasmDir,
        onStdout: (text) => this.stdoutBuffer.push(text),
        onStderr: (text) => this.stderrBuffer.push(text),
      });
      this.bindApi();
      this.registerCallbacks();
      this.stageFilesystem();
      this.initialiseNgspice();
      this.initialised = true;
    })();
    return this.initPromise;
  }

  private bindApi(): void {
    if (!this.module) throw new Error('Module not ready');
    const M = this.module;
    this.api = {
      init: M.cwrap('ngSpice_Init', 'number', [
        'number', 'number', 'number', 'number', 'number', 'number', 'number',
      ]),
      command: M.cwrap('ngSpice_Command', 'number', ['string']),
      circ: M.cwrap('ngSpice_Circ', 'number', ['number']),
      allVecs: M.cwrap('ngSpice_AllVecs', 'number', ['string']),
      curPlot: M.cwrap('ngSpice_CurPlot', 'string', []),
      getVecInfo: M.cwrap('ngGet_Vec_Info', 'number', ['string']),
      reset: M.cwrap('ngSpice_Reset', 'number', []),
      nospiceinit: M.cwrap('ngSpice_nospiceinit', 'number', []),
      setInputPath: M.cwrap('ngCM_Input_Path', 'number', ['string']),
    };
  }

  private registerCallbacks(): void {
    if (!this.module) throw new Error('Module not ready');
    const M = this.module;
    // ngspice C callback signatures (from sharedspice.h):
    //   SendChar(char*, int, void*)             → 4 ints (i ptr, i id, ptr) but emscripten counts ptrs as i
    //   SendStat(char*, int, void*)             → iiii
    //   ControlledExit(int, bool, bool, int, void*) → iiiiii
    //   SendData(vecvaluesall*, int, int, void*) → iiiii
    //   SendInitData(vecinfoall*, int, void*)   → iiii
    //   BGThreadRunning(bool, int, void*)       → iiii
    const noop = () => 0;
    this.callbackPointers = [
      M.addFunction(noop, 'iiii'),    // print
      M.addFunction(noop, 'iiii'),    // status
      M.addFunction(noop, 'iiiiii'),  // exit
      M.addFunction(noop, 'iiiii'),   // data
      M.addFunction(noop, 'iiii'),    // dataInit
      M.addFunction(noop, 'iiii'),    // bg
    ];
  }

  private stageFilesystem(): void {
    const M = this.module;
    if (!M || !M._velxio_fs) throw new Error('Module FS not ready');
    const FS = M._velxio_fs;
    // Recursive mkdir — emscripten FS.mkdir is one level at a time
    // and the default mounted root only has `/`.
    const ensureDir = (full: string): void => {
      const parts = full.split('/').filter((p) => p.length > 0);
      let cur = '';
      for (const p of parts) {
        cur += '/' + p;
        try { FS.mkdir(cur); } catch { /* exists */ }
      }
    };
    ensureDir('/usr/local/lib/ngspice');
    ensureDir('/usr/local/share/ngspice/scripts');

    for (const name of MODEL_FILES) {
      const data = readFileSync(path.join(this.wasmDir, name));
      FS.writeFile(`/usr/local/lib/ngspice/${name}`, new Uint8Array(data));
    }
    const spinit = readFileSync(path.join(this.wasmDir, 'spinit'), 'utf8');
    FS.writeFile('/usr/local/share/ngspice/scripts/spinit', spinit);
    FS.writeFile('/spinit', spinit);
  }

  private initialiseNgspice(): void {
    if (!this.api) throw new Error('API not ready');
    this.api.nospiceinit();
    const rc = this.api.init(0, 0, 0, 0, 0, 0, 0);
    if (rc !== 0) throw new Error(`ngSpice_Init returned ${rc}`);
    this.api.setInputPath('/');
    this.api.command('set xspice_enabled');
    this.api.command('source /spinit');
    // Convergence helpers — relaxed gmin lets op-amp + diode circuits
    // bias correctly without needing `.option gmin=...` in every
    // user netlist.  Method=gear maxord=2 stabilises stiff transient
    // solves involving B-source clamps and reactive networks.
    this.api.command('set noaskquit');
    this.api.command('option gmin=1e-10 gminsteps=20 sourcesteps=10 method=gear maxord=2');
  }

  async loadCircuit(netlist: string): Promise<void> {
    await this.init();
    if (!this.module || !this.api || !this.module._velxio_fs) throw new Error('not ready');
    this.api.command('remcirc');
    // Strip any inline analysis directives so the engine does NOT
    // auto-run them during `source` — the SolverPort owns analysis
    // timing.  Running them twice (once via source, once via the
    // explicit `solve()` command) leaves the second pass with an
    // empty plot.
    const stripped = netlist
      .split('\n')
      .filter((line) => {
        const l = line.trim().toLowerCase();
        return !(l.startsWith('.op') || l.startsWith('.tran ') || l.startsWith('.ac '));
      })
      .join('\n');
    this.module._velxio_fs.writeFile('/circuit.spc', stripped);
    const rc = this.api.command('source /circuit.spc');
    if (rc !== 0) throw new Error(`source /circuit.spc returned ${rc}`);
  }

  async solve(analysis: SolveAnalysis, options: SolveOptions): Promise<SolveResult> {
    await this.init();
    if (!this.api) throw new Error('not ready');
    const t0 = performance.now();
    this.stderrBuffer.length = 0;
    this.stdoutBuffer.length = 0;

    // ngspice has two ways to run an analysis:
    //   .control / .endc block in the netlist (ran by 'source')
    //   bare `op` / `tran ...` / `ac ...` commands after sourcing
    // Bare commands often fail silently in interactive mode unless
    // a circuit is "current"; the safer pattern is to inject the
    // analysis directive INTO the netlist before source. But since
    // the source already ran, we issue `run` which runs whatever
    // last `.tran` / `.op` directive was in the netlist + falls
    // back to our manual analysis card.
    const cmd = (() => {
      switch (analysis.kind) {
        case 'op': return 'op';
        case 'tran': return `tran ${analysis.step} ${analysis.stop}${analysis.uic ? ' uic' : ''}`;
        case 'ac': return `ac ${analysis.sweep} ${analysis.points} ${analysis.fstart} ${analysis.fstop}`;
      }
    })();
    for (const ic of initialConditionCommands(analysis)) this.api.command(ic);
    const rc = this.api.command(cmd);
    if (rc !== 0) throw new Error(`ngspice command '${cmd}' returned ${rc}`);


    const vectors = new Map<string, SolveVector>();
    let timeAxis: Float64Array = new Float64Array(0);

    for (const name of options.vectorsOfInterest) {
      const vec = this.readVector(name);
      if (vec) vectors.set(name.toLowerCase(), vec);
    }
    if (analysis.kind === 'tran') {
      const t = this.readVector('time');
      if (t) timeAxis = t.real;
    }

    const solveMs = performance.now() - t0;
    return {
      analysis,
      vectors,
      timeAxis,
      solveMs,
      warnings: [...this.stderrBuffer, ...this.stdoutBuffer.map((s) => `stdout: ${s}`)],
    };
  }

  async alterSource(name: string, dcValue: number): Promise<void> {
    await this.init();
    if (!this.api) throw new Error('not ready');
    this.api.command(`alter ${name} dc ${dcValue}`);
  }

  /**
   * Read every vector in the current plot.  Called AFTER an analysis
   * has run — does not re-run the analysis, which is critical
   * because re-running creates a new plot and invalidates pointers
   * from listCurrentVectors.
   *
   * Returns the result in the same shape as `solve()` so the test
   * shim can use a unified path.
   */
  readAllCurrentVectors(): { vectors: Map<string, SolveVector>; rawNames: string[] } {
    const rawNames = this.listCurrentVectors();
    const vectors = new Map<string, SolveVector>();
    for (const name of rawNames) {
      const vec = this.readVector(name);
      if (vec) vectors.set(name.toLowerCase(), vec);
    }
    return { vectors, rawNames };
  }

  /**
   * Enumerate vector names in the current plot.  Returns case-
   * preserved names — getVecInfo lookup IS case-sensitive for
   * source-current vectors like "V_src#branch".
   *
   * NOT part of SolverPort — adapter-specific helper used by the
   * legacy-test compatibility shim while we migrate the suite off
   * eecircuit-engine.  Once all tests opt into explicit
   * vectorsOfInterest lists, this can go away.
   */
  listCurrentVectors(): string[] {
    if (!this.module || !this.api) return [];
    const plot = this.api.curPlot();
    if (!plot) return [];
    const arrPtr = this.api.allVecs(plot);
    if (!arrPtr) return [];
    const heapu32 = this.module._velxio_heapu32;
    if (!heapu32) return [];
    const names: string[] = [];
    // ngSpice_AllVecs returns a NULL-terminated array of char*.
    // Keep original case — getVecInfo lookup is case-sensitive for
    // source-current vectors like "V_src#branch".
    for (let i = 0; ; i++) {
      const ptr = heapu32[(arrPtr >> 2) + i];
      if (!ptr) break;
      names.push(this.module.UTF8ToString(ptr));
      if (i > 4096) break; // safety
    }
    return names;
  }

  dispose(): void {
    if (this.api) {
      try { this.api.reset(); } catch { /* ignore */ }
    }
    this.initialised = false;
    this.initPromise = null;
  }

  private readVector(name: string): SolveVector | null {
    if (!this.module || !this.api) return null;
    const M = this.module;
    let infoPtr = this.api.getVecInfo(name);
    if (!infoPtr && !name.includes('.')) {
      const plot = this.api.curPlot();
      if (plot) infoPtr = this.api.getVecInfo(`${plot}.${name}`);
    }
    if (!infoPtr) return null;
    const heap32 = M._velxio_heap32;
    const heapu32 = M._velxio_heapu32;
    const heapf64 = M._velxio_heapf64;
    if (!heap32 || !heapu32 || !heapf64) return null;
    const realDataPtr = heapu32[(infoPtr + VECTOR_INFO_REALDATA_OFFSET) >> 2]!;
    const compDataPtr = heapu32[(infoPtr + VECTOR_INFO_IMAGDATA_OFFSET) >> 2]!;
    const length = heap32[(infoPtr + VECTOR_INFO_LENGTH_OFFSET) >> 2]!;
    const flags = heap32[(infoPtr + VECTOR_INFO_FLAGS_OFFSET) >> 2]!;
    const complex = (flags & VECTOR_FLAG_COMPLEX) !== 0;
    if (length <= 0) return null;
    // Real vectors store doubles in realDataPtr.  Complex vectors
    // (.ac results) store INTERLEAVED [re, im, re, im, ...] doubles
    // in compDataPtr — realDataPtr is null.
    if (!complex) {
      if (!realDataPtr) return null;
      const real = new Float64Array(heapf64.buffer, realDataPtr, length).slice();
      return { name: name.toLowerCase(), real, imag: null };
    }
    if (!compDataPtr) return null;
    const interleaved = new Float64Array(heapf64.buffer, compDataPtr, length * 2);
    const real = new Float64Array(length);
    const imag = new Float64Array(length);
    for (let i = 0; i < length; i++) {
      real[i] = interleaved[i * 2]!;
      imag[i] = interleaved[i * 2 + 1]!;
    }
    return { name: name.toLowerCase(), real, imag };
  }
}
