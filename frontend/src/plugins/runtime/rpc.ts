/**
 * Worker ⇄ Host RPC protocol for the plugin runtime.
 *
 * This module is **transport-agnostic**: it operates on any object that
 * implements `RpcEndpoint` (a thin `postMessage` + `onmessage` shape),
 * which means the same code drives:
 *   - production: a real `Worker` on each side
 *   - tests:      a `MessageChannel` port pair (Node + jsdom)
 *
 * Why a hand-rolled protocol instead of Comlink:
 *   1. **Fire-and-forget on the hot path.** Comlink wraps every call in
 *      `await`. The host pushes thousands of `pin:change` events per
 *      second; await-ing every one would either throttle the simulator
 *      (unacceptable, principle #0) or balloon memory with pending
 *      promises. We need explicit fire-and-forget semantics with a
 *      bounded queue and drop counter — Comlink does not give us that.
 *   2. **Worker→host vs host→worker have different policies.**
 *      Worker→host is request/response with a 5 s timeout (the worker
 *      is asking for data). Host→worker is fire-and-forget with
 *      coalescing (the host is pushing a stream). One mechanism,
 *      different defaults.
 *   3. **Callback proxying.** Plugin code passes functions to register
 *      methods (`commands.register({ handler })`). Functions cannot
 *      cross postMessage. We strip them to opaque numeric ids
 *      (`{ __cb: 42 }`), the host invokes them via reverse RPC.
 *      Comlink does this, but we need *our* serialization rules
 *      (specifically: drop unknown function fields rather than throw).
 *   4. **5 KB of code is cheaper than a 5 KB dependency we don't fully
 *      understand.** The protocol surface fits on one screen.
 *
 * --- Wire format ---
 *
 * Every message is a tagged union (`kind` field). Three categories:
 *
 *   • Request / Response — worker asks host for something. `id` is a
 *     monotonic counter on the requester side. Response carries the
 *     same id back. Timeout = 5 s by default (configurable per call).
 *
 *   • Invoke-callback — host invokes a worker-registered callback.
 *     Always fire-and-forget. `cbId` was minted by the worker when it
 *     called a register method.
 *
 *   • Event / Log — fire-and-forget broadcast. Host→worker for events,
 *     worker→host for logs. No id, no response.
 *
 * --- Backpressure ---
 *
 * The sender side keeps a bounded queue (default 1024 messages). When
 * the queue is full, the OLDEST message is dropped (so latest state
 * wins for `pin:change`-style streams) and a counter increments. The
 * counter is exposed via `getStats()` for the Installed Plugins UI.
 *
 * --- Errors ---
 *
 * `Error` instances are serialized to `{ name, message, stack }`. On
 * the receiving side, `deserializeError()` rehydrates them back into
 * `Error` so `try/catch` in plugin code works as expected.
 */

// ── Wire types ───────────────────────────────────────────────────────────

/** Marker placed in serialized args where a function used to be. */
export interface CallbackHandle {
  readonly __cb: number;
}

/** Marker placed in serialized return values where a Disposable used to be. */
export interface DisposableHandle {
  readonly __disp: number;
}

export interface SerializedError {
  readonly name: string;
  readonly message: string;
  readonly stack?: string;
}

export type RpcMessage =
  | RequestMessage
  | ResponseMessage
  | InvokeCallbackMessage
  | EventMessage
  | LogMessage
  | PingMessage
  | PongMessage;

export interface RequestMessage {
  readonly kind: 'request';
  readonly id: number;
  readonly method: string;
  readonly args: readonly unknown[];
}

export type ResponseMessage =
  | { readonly kind: 'response'; readonly id: number; readonly ok: true; readonly value: unknown }
  | { readonly kind: 'response'; readonly id: number; readonly ok: false; readonly error: SerializedError };

export interface InvokeCallbackMessage {
  readonly kind: 'invoke-callback';
  readonly cbId: number;
  readonly args: readonly unknown[];
}

export interface EventMessage {
  readonly kind: 'event';
  readonly topic: string;
  readonly payload: unknown;
}

export interface LogMessage {
  readonly kind: 'log';
  readonly level: 'debug' | 'info' | 'warn' | 'error';
  readonly args: readonly unknown[];
}

export interface PingMessage {
  readonly kind: 'ping';
  readonly id: number;
}

export interface PongMessage {
  readonly kind: 'pong';
  readonly id: number;
}

// ── Endpoint abstraction ─────────────────────────────────────────────────

/**
 * Minimal duck-type surface that both `Worker` and `MessagePort`
 * implement. The RPC layer doesn't care which one it has.
 */
export interface RpcEndpoint {
  postMessage(message: RpcMessage, transfer?: Transferable[]): void;
  addEventListener(type: 'message', listener: (event: MessageEvent<RpcMessage>) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent<RpcMessage>) => void): void;
}

// ── Stats ────────────────────────────────────────────────────────────────

export interface RpcStats {
  readonly sent: number;
  readonly received: number;
  /** Queue-full drops on this side (oldest message evicted). */
  readonly dropped: number;
  /** Pending requests awaiting a response. */
  readonly pendingRequests: number;
  /** Coalesced messages elided from the queue (same key). */
  readonly coalesced: number;
}

// ── Options ──────────────────────────────────────────────────────────────

export interface RpcOptions {
  /** Bounded send-queue capacity. Default 1024. */
  readonly queueCapacity?: number;
  /** Default request timeout, ms. Default 5000. */
  readonly requestTimeoutMs?: number;
  /** Called when a message is dropped due to queue full. */
  readonly onDrop?: (msg: RpcMessage) => void;
  /** Called on send/receive errors. */
  readonly onError?: (err: unknown) => void;
}

const DEFAULT_QUEUE = 1024;
const DEFAULT_TIMEOUT_MS = 5000;

// ── Coalesce key ─────────────────────────────────────────────────────────

/**
 * Build a coalesce key from an outgoing message. Returns `null` for
 * messages that should not be coalesced.
 *
 * Currently coalesces `pin:change` events by `(componentId, pinName)` —
 * only the latest pin state matters when the worker is behind. Other
 * events are not coalesced (they have semantics, not just state).
 */
export function defaultCoalesceKey(msg: RpcMessage): string | null {
  if (msg.kind !== 'event') return null;
  if (msg.topic !== 'pin:change') return null;
  const p = msg.payload as { componentId?: unknown; pinName?: unknown } | null;
  if (!p || typeof p.componentId !== 'string' || typeof p.pinName !== 'string') return null;
  return `pin:change:${p.componentId}:${p.pinName}`;
}

// ── RpcChannel — the one bidirectional endpoint ──────────────────────────

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (err: unknown) => void;
  readonly timer: ReturnType<typeof setTimeout> | null;
}

export type RequestHandler = (method: string, args: readonly unknown[]) => unknown | Promise<unknown>;
export type EventHandler = (topic: string, payload: unknown) => void;
export type InvokeCallbackHandler = (cbId: number, args: readonly unknown[]) => void;
export type LogHandler = (level: LogMessage['level'], args: readonly unknown[]) => void;

/**
 * Bidirectional RPC channel over a single `RpcEndpoint`.
 *
 * Both ends instantiate one of these. Each one decides which message
 * categories it answers via the handlers passed in `setHandlers()`.
 * The host installs `{ request, log }` handlers; the worker installs
 * `{ event, invokeCallback, request }` handlers.
 */
export class RpcChannel {
  private readonly endpoint: RpcEndpoint;
  private readonly options: Required<Omit<RpcOptions, 'onDrop' | 'onError'>> & Pick<RpcOptions, 'onDrop' | 'onError'>;
  private nextRequestId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly queue: RpcMessage[] = [];
  private readonly coalesceIndex = new Map<string, number>(); // key → index in queue
  private flushScheduled = false;
  private disposed = false;
  private stats = { sent: 0, received: 0, dropped: 0, coalesced: 0 };

  private requestHandler: RequestHandler | null = null;
  private eventHandler: EventHandler | null = null;
  private invokeCallbackHandler: InvokeCallbackHandler | null = null;
  private logHandler: LogHandler | null = null;
  private pingResponder: ((id: number) => void) | null = null;

  private readonly listener = (event: MessageEvent<RpcMessage>) => {
    this.handleIncoming(event.data);
  };

  constructor(endpoint: RpcEndpoint, options: RpcOptions = {}) {
    this.endpoint = endpoint;
    this.options = {
      queueCapacity: options.queueCapacity ?? DEFAULT_QUEUE,
      requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS,
      onDrop: options.onDrop,
      onError: options.onError,
    };
    endpoint.addEventListener('message', this.listener);
  }

  setHandlers(handlers: {
    request?: RequestHandler;
    event?: EventHandler;
    invokeCallback?: InvokeCallbackHandler;
    log?: LogHandler;
  }): void {
    if (handlers.request !== undefined) this.requestHandler = handlers.request;
    if (handlers.event !== undefined) this.eventHandler = handlers.event;
    if (handlers.invokeCallback !== undefined) this.invokeCallbackHandler = handlers.invokeCallback;
    if (handlers.log !== undefined) this.logHandler = handlers.log;
  }

  /**
   * Send a request and wait for a response. Rejects with a `RpcTimeoutError`
   * if no response arrives within the configured timeout.
   */
  request<T = unknown>(method: string, args: readonly unknown[] = [], opts?: { timeoutMs?: number }): Promise<T> {
    if (this.disposed) {
      return Promise.reject(new RpcDisposedError(method));
    }
    const id = this.nextRequestId++;
    const timeoutMs = opts?.timeoutMs ?? this.options.requestTimeoutMs;
    return new Promise<T>((resolve, reject) => {
      const timer = timeoutMs > 0
        ? setTimeout(() => {
            this.pending.delete(id);
            reject(new RpcTimeoutError(method, timeoutMs));
          }, timeoutMs)
        : null;
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      });
      this.send({ kind: 'request', id, method, args });
    });
  }

  /** Fire-and-forget event push. Drops oldest on queue overflow. */
  emitEvent(topic: string, payload: unknown, transfer?: Transferable[]): void {
    if (this.disposed) return;
    this.send({ kind: 'event', topic, payload }, transfer);
  }

  /** Fire-and-forget callback invocation (host → worker). */
  invokeCallback(cbId: number, args: readonly unknown[]): void {
    if (this.disposed) return;
    this.send({ kind: 'invoke-callback', cbId, args });
  }

  /** Fire-and-forget log shipment (worker → host). */
  log(level: LogMessage['level'], args: readonly unknown[]): void {
    if (this.disposed) return;
    this.send({ kind: 'log', level, args });
  }

  /** Send a ping; returns a promise that resolves on pong. */
  ping(timeoutMs = 1000): Promise<void> {
    if (this.disposed) return Promise.reject(new RpcDisposedError('ping'));
    const id = this.nextRequestId++;
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcTimeoutError('ping', timeoutMs));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: () => resolve(),
        reject,
        timer,
      });
      this.send({ kind: 'ping', id });
    });
  }

  /** Auto-reply pongs to pings; tests use this on the worker stub. */
  enableAutoPong(): void {
    this.pingResponder = (id) => this.send({ kind: 'pong', id });
  }

  getStats(): RpcStats {
    return {
      sent: this.stats.sent,
      received: this.stats.received,
      dropped: this.stats.dropped,
      coalesced: this.stats.coalesced,
      pendingRequests: this.pending.size,
    };
  }

  /**
   * Tear down. Pending requests reject with `RpcDisposedError`. Future
   * sends are silently dropped.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.endpoint.removeEventListener('message', this.listener);
    for (const [, p] of this.pending) {
      if (p.timer !== null) clearTimeout(p.timer);
      p.reject(new RpcDisposedError('pending'));
    }
    this.pending.clear();
    this.queue.length = 0;
    this.coalesceIndex.clear();
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private send(msg: RpcMessage, transfer?: Transferable[]): void {
    // Coalesce: replace existing same-key message in the queue. This keeps
    // the latest state but does not change queue position — fairness for
    // other event streams interleaved with the coalescing one.
    const key = defaultCoalesceKey(msg);
    if (key !== null) {
      const existingIdx = this.coalesceIndex.get(key);
      if (existingIdx !== undefined) {
        this.queue[existingIdx] = msg;
        this.stats.coalesced++;
        this.scheduleFlush(transfer);
        return;
      }
    }

    if (this.queue.length >= this.options.queueCapacity) {
      // Drop OLDEST. Latest data is more useful than ancient backlog,
      // especially for event streams. Stale coalesce-index entry will
      // get harmlessly overwritten next time.
      const dropped = this.queue.shift();
      if (dropped !== undefined) {
        this.stats.dropped++;
        this.options.onDrop?.(dropped);
        // Walk the coalesceIndex and decrement indices > 0; cheaper to
        // just rebuild for typical small-ish queues.
        if (this.coalesceIndex.size > 0) {
          this.rebuildCoalesceIndex();
        }
      }
    }

    if (key !== null) this.coalesceIndex.set(key, this.queue.length);
    this.queue.push(msg);
    this.scheduleFlush(transfer);
  }

  private scheduleFlush(transfer?: Transferable[]): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    // Microtask flush: batch synchronous bursts into a single drain
    // without changing event ordering visible to the receiver.
    queueMicrotask(() => {
      this.flushScheduled = false;
      this.flush(transfer);
    });
  }

  private flush(transfer?: Transferable[]): void {
    if (this.disposed) return;
    while (this.queue.length > 0) {
      const msg = this.queue.shift()!;
      try {
        if (transfer && transfer.length > 0 && this.queue.length === 0) {
          // Transfer list applies to the LAST message only — the typical
          // case is a single Uint8Array attached to one event.
          this.endpoint.postMessage(msg, transfer);
        } else {
          this.endpoint.postMessage(msg);
        }
        this.stats.sent++;
      } catch (err) {
        this.options.onError?.(err);
      }
    }
    this.coalesceIndex.clear();
  }

  private rebuildCoalesceIndex(): void {
    this.coalesceIndex.clear();
    for (let i = 0; i < this.queue.length; i++) {
      const k = defaultCoalesceKey(this.queue[i]!);
      if (k !== null) this.coalesceIndex.set(k, i);
    }
  }

  private handleIncoming(msg: RpcMessage): void {
    this.stats.received++;
    switch (msg.kind) {
      case 'request':
        this.handleRequest(msg);
        return;
      case 'response':
        this.handleResponse(msg);
        return;
      case 'event':
        try {
          this.eventHandler?.(msg.topic, msg.payload);
        } catch (err) {
          this.options.onError?.(err);
        }
        return;
      case 'invoke-callback':
        try {
          this.invokeCallbackHandler?.(msg.cbId, msg.args);
        } catch (err) {
          this.options.onError?.(err);
        }
        return;
      case 'log':
        try {
          this.logHandler?.(msg.level, msg.args);
        } catch (err) {
          this.options.onError?.(err);
        }
        return;
      case 'ping':
        if (this.pingResponder) {
          this.pingResponder(msg.id);
        } else {
          // Default behaviour: bounce back even without explicit enable.
          this.send({ kind: 'pong', id: msg.id });
        }
        return;
      case 'pong': {
        const p = this.pending.get(msg.id);
        if (p === undefined) return;
        this.pending.delete(msg.id);
        if (p.timer !== null) clearTimeout(p.timer);
        p.resolve(undefined);
        return;
      }
    }
  }

  private async handleRequest(msg: RequestMessage): Promise<void> {
    const handler = this.requestHandler;
    if (handler === null || handler === undefined) {
      this.send({
        kind: 'response',
        id: msg.id,
        ok: false,
        error: serializeError(new Error(`No request handler for "${msg.method}"`)),
      });
      return;
    }
    try {
      const value = await handler(msg.method, msg.args);
      this.send({ kind: 'response', id: msg.id, ok: true, value });
    } catch (err) {
      this.send({ kind: 'response', id: msg.id, ok: false, error: serializeError(err) });
    }
  }

  private handleResponse(msg: ResponseMessage): void {
    const p = this.pending.get(msg.id);
    if (p === undefined) return; // late response after timeout — ignore
    this.pending.delete(msg.id);
    if (p.timer !== null) clearTimeout(p.timer);
    if (msg.ok) {
      p.resolve(msg.value);
    } else {
      p.reject(deserializeError(msg.error));
    }
  }
}

// ── Errors ───────────────────────────────────────────────────────────────

export class RpcTimeoutError extends Error {
  constructor(method: string, timeoutMs: number) {
    super(`RPC "${method}" timed out after ${timeoutMs}ms`);
    this.name = 'RpcTimeoutError';
  }
}

export class RpcDisposedError extends Error {
  constructor(method: string) {
    super(`RPC channel disposed before "${method}" could complete`);
    this.name = 'RpcDisposedError';
  }
}

// ── Error serialization ──────────────────────────────────────────────────

export function serializeError(err: unknown): SerializedError {
  if (err instanceof Error) {
    const out: SerializedError = {
      name: err.name,
      message: err.message,
      ...(err.stack !== undefined ? { stack: err.stack } : {}),
    };
    return out;
  }
  if (typeof err === 'string') {
    return { name: 'Error', message: err };
  }
  try {
    return { name: 'Error', message: JSON.stringify(err) };
  } catch {
    return { name: 'Error', message: String(err) };
  }
}

export function deserializeError(s: SerializedError): Error {
  const err = new Error(s.message);
  err.name = s.name;
  if (s.stack !== undefined) err.stack = s.stack;
  return err;
}
