/**
 * NgSpiceInteractive — TypeScript client for the interactive ngspice
 * worker.  Phase 1a of the mixed-mode simulator project
 * (see project/sim-mixedmode/phase-01-mixed-mode-coupling.md in the
 * velxio-prod repo).
 *
 * Wraps the vendored `ngspice-interactive-worker.js` with a Promise-based
 * API.  Each public method posts a uniquely-id'd message to the worker
 * and awaits a matching response.  Stdout/stderr lines that flow during
 * a command execution are buffered into the response of that command,
 * AND optionally streamed live to subscribers.
 *
 * Usage:
 *
 *     const ng = new NgSpiceInteractive({
 *       assetBaseUrl: '/wasm/ngspice-interactive/',
 *     });
 *     await ng.init();
 *     await ng.loadNetlist(`
 *       Vsrc 1 0 DC 5
 *       R1 1 2 1k
 *       C1 2 0 1u
 *       .tran 1us 10ms
 *     `);
 *     await ng.command('tran');                  // run the analysis
 *     const v_cap = await ng.readVec('v(2)');    // full waveform of node 2
 *     console.log(v_cap.real);                   // Float64Array of samples
 *
 *     // Mid-simulation source change (Phase 1b will use real bg_halt/
 *     // bg_resume; Phase 1a workaround is to do partial trans + alter):
 *     await ng.command('alter Vsrc dc 3.3');
 *     await ng.command('tran');                  // continues from saved state
 *
 *     ng.dispose();
 *
 * THREAD MODEL CAVEAT (Phase 1a): the vendored WASM is single-threaded
 * (no `-sUSE_PTHREADS=1` in the build).  This means ngspice's `bg_run`
 * runs synchronously and blocks the worker until completion — there is
 * no useful "background" mode in this build.  For mixed-mode operation
 * we use the alternative pattern: short `.tran` invocations with
 * `alter` between them.  Phase 1b will investigate whether a pthread-
 * enabled WASM rebuild is worth the SharedArrayBuffer / cross-origin-
 * isolation overhead.
 */

interface InitConfig {
  /** URL prefix where the WASM artifacts live (must end with '/'). */
  assetBaseUrl?: string;
  /** Optional override for the worker URL (defaults to the vendored worker). */
  workerUrl?: string;
}

interface VecResult {
  name: string;
  real: Float64Array;
  imag: Float64Array | null;
  complex: boolean;
  unit: string;
}

/** One entry of `readVecs`: the vector, or why it could not be read. */
export interface BatchVecEntry {
  name: string;
  real?: Float64Array;
  imag?: Float64Array | null;
  error?: string;
}

interface CommandResult {
  rc: number;
  stdout: string[];
  stderr: string[];
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  expectedType: string;
}

interface SubscriberCallbacks {
  onStdout?: (line: string) => void;
  onStderr?: (line: string) => void;
}

const DEFAULT_ASSET_BASE = '/wasm/ngspice-interactive/';

export class NgSpiceInteractive {
  private worker: Worker | null = null;
  private initPromise: Promise<void> | null = null;
  private requestId = 0;
  private pending = new Map<number, PendingRequest>();
  private subscribers: SubscriberCallbacks = {};
  private readonly assetBaseUrl: string;
  private readonly workerUrl: string;

  constructor(config: InitConfig = {}) {
    this.assetBaseUrl = config.assetBaseUrl ?? DEFAULT_ASSET_BASE;
    // Vite-flavored worker URL: resolves to the bundled worker at build
    // time. When running in tests with `vitest` + a JSDOM/node env this
    // import.meta.url scheme also works.
    this.workerUrl = config.workerUrl ?? new URL(
      './ngspice-interactive-worker.js',
      import.meta.url,
    ).href;
  }

  /**
   * Subscribe to stdout/stderr lines emitted by ngspice during command
   * execution.  Multiple subscriptions overwrite each other — for the
   * library's first version we don't need a fan-out registry.
   */
  setSubscribers(subs: SubscriberCallbacks): void {
    this.subscribers = subs;
  }

  /**
   * Initialise the worker + WASM module.  Idempotent — subsequent calls
   * return the same promise.
   */
  init(): Promise<void> {
    if (this.initPromise) return this.initPromise;

    this.worker = new Worker(this.workerUrl);
    this.worker.addEventListener('message', this.handleMessage);
    this.worker.addEventListener('error', this.handleError);

    this.initPromise = this.request('init', { config: { assetBaseUrl: this.assetBaseUrl } }, 'ready')
      .then(() => undefined);
    return this.initPromise;
  }

  /** Submit a netlist to ngspice.  Does NOT auto-run any analyses —
   *  subsequent `command()` calls do that. */
  async loadNetlist(netlist: string): Promise<void> {
    await this.init();
    await this.request('loadNetlist', { netlist }, 'loaded');
  }

  /**
   * Send a raw ngspice command and capture its stdout/stderr.  Useful
   * commands: `tran 1us 10ms`, `alter Vsrc dc 5`, `display`, `print
   * v(out)`, `quit`, `reset`.  See the ngspice manual chapter 17
   * for the full list.
   */
  async command(cmd: string): Promise<CommandResult> {
    await this.init();
    return this.request<CommandResult>('command', { command: cmd }, 'command-result');
  }

  /**
   * Convenience wrapper for `alter <name> dc <value>` — typical use
   * during mixed-mode is to update a voltage source representing an
   * MCU pin's digital state.
   */
  async alter(sourceName: string, dcValue: number): Promise<CommandResult> {
    return this.command(`alter ${sourceName} dc ${dcValue}`);
  }

  /**
   * Read the current state of a vector.  For `.op` analyses this is a
   * scalar (length-1 Float64Array); for `.tran` it's the full time
   * series captured so far.  Reads block until the worker responds.
   */
  async readVec(name: string): Promise<VecResult> {
    await this.init();
    return this.request<VecResult>('readVec', { name }, 'vec');
  }

  /**
   * Read several vectors with one round trip. Entries for vectors the
   * plot does not have carry `error` instead of data, so one missing
   * vector (a disconnected pin) does not fail the rest. One message per
   * vector cost more than the solve itself on a deck of a few dozen nets.
   */
  async readVecs(names: readonly string[]): Promise<Array<BatchVecEntry>> {
    await this.init();
    if (names.length === 0) return [];
    const res = await this.request<{ vectors: BatchVecEntry[] }>('readVecs', { names: [...names] }, 'vecs');
    return res.vectors ?? [];
  }

  /** Run several commands in order with one round trip. */
  async commands(cmds: readonly string[]): Promise<CommandResult[]> {
    await this.init();
    if (cmds.length === 0) return [];
    const res = await this.request<{ results: CommandResult[] }>('commands', { commands: [...cmds] }, 'commands-result');
    return res.results ?? [];
  }

  /**
   * Enumerate every vector name in the current plot.  Returns
   * case-preserved names — `ngGet_Vec_Info` lookups are
   * case-sensitive for source-current vectors like `V_src#branch`.
   *
   * The worker reads via `ngSpice_AllVecs(curPlot)` and walks the
   * NUL-terminated char** array.  Used by `NgSpiceWorkerAdapter` so
   * the production path doesn't have to heuristic-parse netlist
   * strings (Phase 1d #6).
   */
  async listVectors(): Promise<string[]> {
    await this.init();
    const res = await this.request<{ names: string[] }>(
      'listVectors',
      {},
      'vector-list',
    );
    return res.names;
  }

  /** Reset the engine to a clean state (drops netlist + plots). */
  async reset(): Promise<void> {
    await this.init();
    await this.request('reset', {}, 'reset-done');
  }

  /** Terminate the worker. */
  dispose(): void {
    if (this.worker) {
      try { this.worker.terminate(); } catch { /* ignore */ }
      this.worker = null;
    }
    for (const [, req] of this.pending) {
      try { req.reject(new Error('NgSpiceInteractive disposed')); } catch { /* ignore */ }
    }
    this.pending.clear();
    this.initPromise = null;
  }

  // ── Private plumbing ────────────────────────────────────────────────

  private request<T = unknown>(
    type: string,
    body: Record<string, unknown>,
    expectedType: string,
  ): Promise<T> {
    if (!this.worker) throw new Error('Worker not initialised. Call init() first.');
    const id = ++this.requestId;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        expectedType,
      });
      this.worker!.postMessage({ type, requestId: id, ...body });
    });
  }

  private handleMessage = (ev: MessageEvent): void => {
    const data = ev.data as { type: string; requestId?: number; message?: string; line?: string } &
      Record<string, unknown>;

    // Streaming stdout/stderr events — not tied to a request resolve
    if (data.type === 'stdout') {
      this.subscribers.onStdout?.(String(data.line ?? ''));
      return;
    }
    if (data.type === 'stderr') {
      this.subscribers.onStderr?.(String(data.line ?? ''));
      return;
    }

    // Status / progress / debug events from the worker — ignored at this
    // level (no request to resolve). UI-level callers can extend
    // SubscriberCallbacks later.
    if (data.type === 'status' || data.type === 'progress' || data.type === 'debug') {
      return;
    }

    const id = data.requestId;
    if (typeof id !== 'number') return;
    const pending = this.pending.get(id);
    if (!pending) return;

    if (data.type === 'error') {
      this.pending.delete(id);
      pending.reject(new Error(String(data.message ?? 'worker error')));
      return;
    }

    if (data.type === pending.expectedType) {
      this.pending.delete(id);
      pending.resolve(data);
    }
  };

  private handleError = (ev: ErrorEvent): void => {
    const err = new Error(ev.message || 'Worker error');
    for (const [, req] of this.pending) {
      try { req.reject(err); } catch { /* ignore */ }
    }
    this.pending.clear();
  };
}
