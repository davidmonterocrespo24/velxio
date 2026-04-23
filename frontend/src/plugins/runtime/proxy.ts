/**
 * Callback / Disposable proxy serialization for the worker boundary.
 *
 * Functions cannot cross `postMessage`. So when plugin code does:
 *
 *   ctx.commands.register({ id: 'hello', title: 'Hi', handler: () => alert('hi') })
 *
 * the worker side has to **strip** the function out and replace it with
 * an opaque numeric id (`{ __cb: 42 }`). The host side rehydrates the
 * marker back into a real function — one that does
 * `rpc.invokeCallback(42, args)` to call back into the worker.
 *
 * The reverse direction (host returning a `Disposable` to a register
 * call) uses `{ __disp: id }` markers — the worker rehydrates them
 * into objects with a `dispose()` method that issues an RPC.
 *
 * Why both directions need a registry:
 *   - Worker keeps a `cbId → function` table so it can route incoming
 *     `invoke-callback` messages to the right closure.
 *   - Host keeps a `dispId → Disposable` table so it can route
 *     incoming `disposable.dispose` requests to the right host handle.
 *
 * Lifetime:
 *   - When the worker terminates / the plugin unloads, both tables
 *     are dropped. The host also explicitly disposes every
 *     outstanding host-side disposable — so a misbehaving plugin
 *     can't leave half-registered commands hanging around.
 */

import type { CallbackHandle, DisposableHandle, RpcChannel } from './rpc';

const CB_MARKER = '__cb' as const;
const DISP_MARKER = '__disp' as const;

export function isCallbackHandle(v: unknown): v is CallbackHandle {
  return typeof v === 'object' && v !== null && CB_MARKER in v && typeof (v as Record<string, unknown>)[CB_MARKER] === 'number';
}

export function isDisposableHandle(v: unknown): v is DisposableHandle {
  return typeof v === 'object' && v !== null && DISP_MARKER in v && typeof (v as Record<string, unknown>)[DISP_MARKER] === 'number';
}

// ── Outbound: strip functions / Disposables before sending ───────────────

/**
 * A registry that mints ids for outbound functions or Disposables and
 * keeps the original behind the id so it can be invoked when the
 * other side calls back.
 *
 * Generic `T` so the same class works for `Function` (callbacks) and
 * `Disposable` (disposables) — the table mechanics are identical.
 */
export class HandleTable<T> {
  private nextId = 1;
  private readonly table = new Map<number, T>();

  register(value: T): number {
    const id = this.nextId++;
    this.table.set(id, value);
    return id;
  }

  get(id: number): T | undefined {
    return this.table.get(id);
  }

  delete(id: number): boolean {
    return this.table.delete(id);
  }

  clear(): void {
    this.table.clear();
  }

  get size(): number {
    return this.table.size;
  }

  /** Walk every entry (used by host to dispose all on plugin unload). */
  drain(): IterableIterator<[number, T]> {
    const entries = Array.from(this.table.entries());
    this.table.clear();
    return entries[Symbol.iterator]();
  }
}

/**
 * Walk a value tree and replace every function with a `{__cb}` marker.
 * Mutates a plain copy — the original is left intact (defensive).
 *
 * Limits:
 *   - max depth 8 (matches storage caps; deeper structures are
 *     vanishingly rare in plugin payloads, and infinite loops on
 *     cycles are far worse than a thrown error)
 *   - cycles throw — postMessage would also throw, so we'd rather
 *     surface the error early with a clear message
 */
export function stripFunctions(
  value: unknown,
  cbTable: HandleTable<(...args: unknown[]) => unknown>,
  maxDepth = 8,
): unknown {
  return walk(value, cbTable, maxDepth, new WeakSet());
}

function walk(
  value: unknown,
  cbTable: HandleTable<(...args: unknown[]) => unknown>,
  depth: number,
  seen: WeakSet<object>,
): unknown {
  if (depth < 0) {
    throw new Error('Plugin RPC payload exceeds max depth (8)');
  }
  if (typeof value === 'function') {
    const id = cbTable.register(value as (...args: unknown[]) => unknown);
    const handle: CallbackHandle = { __cb: id };
    return handle;
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
    // Pass through binary as-is; postMessage handles them (and Uint8Array
    // is structured-clone friendly).
    return value;
  }
  if (seen.has(value as object)) {
    throw new Error('Plugin RPC payload contains a cycle');
  }
  seen.add(value as object);

  if (Array.isArray(value)) {
    return value.map((v) => walk(v, cbTable, depth - 1, seen));
  }

  // Plain object: iterate own enumerable keys
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = walk(v, cbTable, depth - 1, seen);
  }
  return out;
}

// ── Inbound: rehydrate markers into functions / Disposables ──────────────

/**
 * Walk an inbound value tree and replace every `{__cb}` marker with a
 * function that calls `invoker(cbId, args)`, and every `{__disp}`
 * marker with `{ dispose: () => disposer(dispId) }`.
 */
export function rehydrate(
  value: unknown,
  invoker: (cbId: number, args: readonly unknown[]) => void,
  disposer?: (dispId: number) => void,
): unknown {
  return walkRehydrate(value, invoker, disposer, 16, new WeakSet());
}

function walkRehydrate(
  value: unknown,
  invoker: (cbId: number, args: readonly unknown[]) => void,
  disposer: ((dispId: number) => void) | undefined,
  depth: number,
  seen: WeakSet<object>,
): unknown {
  if (depth < 0) return value;
  if (value === null || typeof value !== 'object') return value;
  if (isCallbackHandle(value)) {
    const id = value.__cb;
    return (...args: unknown[]) => invoker(id, args);
  }
  if (isDisposableHandle(value)) {
    const id = value.__disp;
    if (disposer === undefined) {
      // No disposer wired (rare — should only happen on host-side
      // rehydrate where Disposables can't flow inbound). Return a noop.
      return { dispose: () => {} };
    }
    return { dispose: () => disposer(id) };
  }
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) return value;
  if (seen.has(value as object)) return value;
  seen.add(value as object);

  if (Array.isArray(value)) {
    return value.map((v) => walkRehydrate(v, invoker, disposer, depth - 1, seen));
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = walkRehydrate(v, invoker, disposer, depth - 1, seen);
  }
  return out;
}

// ── Host-side helper: wrap a request that returns a Disposable ───────────

/**
 * Convenience: when a host-side handler returns an SDK `Disposable`,
 * register it in the host's disposable table and return a
 * `{__disp}` marker for the wire.
 */
export function diskposalToHandle(
  d: { dispose(): void },
  table: HandleTable<{ dispose(): void }>,
): DisposableHandle {
  const id = table.register(d);
  return { __disp: id };
}

/**
 * Helper used on the worker side: bind a `RpcChannel` to a
 * `HandleTable<Function>` so incoming `invoke-callback` messages
 * route to the right closure.
 */
export function attachInvokeRouter(
  rpc: RpcChannel,
  cbTable: HandleTable<(...args: unknown[]) => unknown>,
  onMissingCallback?: (id: number) => void,
): void {
  rpc.setHandlers({
    invokeCallback: (cbId, args) => {
      const fn = cbTable.get(cbId);
      if (fn === undefined) {
        onMissingCallback?.(cbId);
        return;
      }
      try {
        fn(...(args as unknown[]));
      } catch {
        // Swallow — host already forwards exceptions via the log channel
        // when the plugin's own logger is invoked. Re-throwing here would
        // crash the worker for a single bad callback.
      }
    },
  });
}
