// @vitest-environment jsdom
/**
 * RPC layer tests — `frontend/src/plugins/runtime/rpc.ts`.
 *
 * Uses two `MessageChannel` ports as the transport — same surface as
 * a real Worker, no Worker bootstrap needed. Covers:
 *   - request/response round-trip
 *   - error serialization across the wire
 *   - timeout rejection (and ignored late response)
 *   - fire-and-forget event dispatch
 *   - backpressure: oldest-drop + drop counter
 *   - coalescing of pin:change events
 *   - ping/pong liveness
 *   - dispose tears down pending requests
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  RpcChannel,
  RpcDisposedError,
  RpcTimeoutError,
  type RpcEndpoint,
} from '../plugins/runtime/rpc';

/**
 * Wrap a `MessagePort` so `start()` is called automatically — required
 * for explicit-port channels. Without this, messages don't flow.
 */
function endpoint(port: MessagePort): RpcEndpoint {
  port.start();
  return {
    postMessage: (msg, transfer) => port.postMessage(msg, (transfer ?? []) as Transferable[]),
    addEventListener: (type, listener) => port.addEventListener(type, listener as EventListener),
    removeEventListener: (type, listener) => port.removeEventListener(type, listener as EventListener),
  };
}

let channel: MessageChannel;
let host: RpcChannel;
let worker: RpcChannel;

beforeEach(() => {
  channel = new MessageChannel();
  host = new RpcChannel(endpoint(channel.port1));
  worker = new RpcChannel(endpoint(channel.port2));
});

afterEach(() => {
  host.dispose();
  worker.dispose();
  channel.port1.close();
  channel.port2.close();
});

describe('RPC · request/response', () => {
  it('round-trips a simple request', async () => {
    worker.setHandlers({
      request: (method, args) => {
        expect(method).toBe('add');
        return (args[0] as number) + (args[1] as number);
      },
    });
    const result = await host.request<number>('add', [2, 3]);
    expect(result).toBe(5);
  });

  it('rehydrates errors thrown on the other side', async () => {
    worker.setHandlers({
      request: () => { throw new TypeError('bad arg'); },
    });
    await expect(host.request('boom')).rejects.toMatchObject({
      name: 'TypeError',
      message: 'bad arg',
    });
  });

  it('returns a no-handler error if the responder did not setHandlers', async () => {
    // worker has no request handler
    await expect(host.request('whatever')).rejects.toThrow(/No request handler/);
  });

  it('rejects with RpcTimeoutError when no response arrives', async () => {
    worker.setHandlers({
      request: () => new Promise<never>(() => { /* never resolves */ }),
    });
    await expect(host.request('hang', [], { timeoutMs: 50 })).rejects.toBeInstanceOf(RpcTimeoutError);
  });

  it('ignores late responses after timeout', async () => {
    let resolveLate!: (v: unknown) => void;
    worker.setHandlers({
      request: () => new Promise<unknown>((resolve) => { resolveLate = resolve; }),
    });
    const p = host.request('slow', [], { timeoutMs: 30 });
    await expect(p).rejects.toBeInstanceOf(RpcTimeoutError);
    // Simulate the worker finally responding — should be silently dropped.
    resolveLate('late');
    await new Promise((r) => setTimeout(r, 10));
    // No further error; pending count is 0.
    expect(host.getStats().pendingRequests).toBe(0);
  });
});

describe('RPC · fire-and-forget events', () => {
  it('delivers events to the receiver event handler', async () => {
    const received: Array<[string, unknown]> = [];
    worker.setHandlers({
      event: (topic, payload) => { received.push([topic, payload]); },
    });
    host.emitEvent('pin:change', { componentId: 'led1', pinName: 'A', state: 1 });
    host.emitEvent('serial:tx', { port: 0, data: new Uint8Array([1, 2, 3]) });
    await flushMicrotasks();
    expect(received.length).toBe(2);
    expect(received[0]?.[0]).toBe('pin:change');
    expect(received[1]?.[0]).toBe('serial:tx');
  });

  it('isolates a throwing event handler', async () => {
    const errors: unknown[] = [];
    const w = new RpcChannel(endpoint(new MessageChannel().port2), {
      onError: (e) => errors.push(e),
    });
    // Don't actually need a real channel; simulate a throwing handler
    // directly on the existing worker.
    worker.setHandlers({
      event: () => { throw new Error('boom'); },
    });
    host.emitEvent('pin:change', { componentId: 'a', pinName: 'b', state: 0 });
    await flushMicrotasks();
    // Subsequent events still flow
    let count = 0;
    worker.setHandlers({
      event: () => { count++; },
    });
    host.emitEvent('serial:tx', { port: 0, data: new Uint8Array() });
    await flushMicrotasks();
    expect(count).toBe(1);
    w.dispose();
  });
});

describe('RPC · backpressure + coalescing', () => {
  it('coalesces same-key pin:change events', async () => {
    const received: Array<{ state: unknown }> = [];
    worker.setHandlers({
      event: (_, payload) => {
        received.push(payload as { state: unknown });
      },
    });
    // Burst 5 events on the same (component, pin) before the microtask
    // flush — should be coalesced into 1 with the LATEST state.
    for (let i = 0; i < 5; i++) {
      host.emitEvent('pin:change', { componentId: 'led1', pinName: 'A', state: i });
    }
    await flushMicrotasks();
    expect(received.length).toBe(1);
    expect(received[0]?.state).toBe(4);
    expect(host.getStats().coalesced).toBe(4);
  });

  it('drops oldest when the queue is full', async () => {
    const dropped: number[] = [];
    const small = new RpcChannel(endpoint(channel.port1), {
      queueCapacity: 3,
      onDrop: (msg) => {
        if (msg.kind === 'event') dropped.push((msg.payload as { i: number }).i);
      },
    });
    // Don't await flushMicrotasks until we've enqueued more than capacity
    // synchronously. Use `serial:tx` to avoid coalescing.
    for (let i = 0; i < 5; i++) {
      small.emitEvent('serial:tx', { port: 0, i });
    }
    expect(small.getStats().dropped).toBe(2);
    expect(dropped).toEqual([0, 1]);
    small.dispose();
  });
});

describe('RPC · ping', () => {
  it('default auto-pong responds without explicit handler', async () => {
    // worker has no enableAutoPong, but the default behavior is to bounce.
    await expect(host.ping(500)).resolves.toBeUndefined();
  });

  it('rejects ping on timeout', async () => {
    // Replace worker port with a sink that drops everything.
    worker.dispose();
    await expect(host.ping(50)).rejects.toBeInstanceOf(RpcTimeoutError);
  });
});

describe('RPC · dispose', () => {
  it('rejects pending requests with RpcDisposedError', async () => {
    worker.setHandlers({
      request: () => new Promise(() => { /* never */ }),
    });
    const p = host.request('hang', [], { timeoutMs: 0 });
    host.dispose();
    await expect(p).rejects.toBeInstanceOf(RpcDisposedError);
  });

  it('silently drops further sends after dispose', async () => {
    host.dispose();
    // No throw, no resolve.
    host.emitEvent('pin:change', { componentId: 'a', pinName: 'b', state: 0 });
    expect(host.getStats().sent).toBe(0);
  });
});

// ── helpers ──────────────────────────────────────────────────────────────

async function flushMicrotasks(): Promise<void> {
  // Two macrotask trips clear all microtask queues + cross-port deliveries.
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

// keep vi alive for tooling
void vi;
