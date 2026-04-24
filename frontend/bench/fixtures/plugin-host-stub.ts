/**
 * Bench fixture — mock plugin-host listeners for measuring the host-side
 * cost the simulator pays when N plugins subscribe to `pin:change`.
 *
 * The simulator hot path (AVRSimulator.firePinChangeWithTime) does:
 *   if (bus.hasListeners('pin:change')) bus.emit('pin:change', payload);
 *
 * Each subscribed plugin installs a listener that ultimately calls
 * `RpcChannel.emitEvent(topic, payload)` — a queue-and-microtask-flush
 * with `pin:change`-key coalescing. The microtask flush itself runs
 * AFTER the bench iteration ends, so the per-emit cost the simulator
 * actually pays is:
 *
 *   - the EventBus listener closure call
 *   - `defaultCoalesceKey(msg)` (string concat for `pin:change`)
 *   - `Map.set` on the coalesce index (one entry per plugin's queue)
 *   - `Array.push` on the queue
 *
 * This module wires REAL `RpcChannel` instances against a noop endpoint
 * so what we measure is the production code path, not a hand-rolled
 * approximation. The stub endpoint discards messages — fine because we
 * never assert on what the worker would have received; we only care
 * about the cost on the main thread.
 */

import { RpcChannel, type RpcEndpoint, type RpcMessage } from '../../src/plugins/runtime/rpc';
import type { HostEventBus } from '../../src/simulation/EventBus';

/**
 * No-op RpcEndpoint: postMessage is a noop, addEventListener never
 * fires (the bench never delivers replies). This isolates the SEND
 * side, which is what the simulator pays per emit.
 */
function makeStubEndpoint(): RpcEndpoint {
  return {
    postMessage(_msg: RpcMessage): void {
      /* discard */
    },
    addEventListener(_type: 'message', _listener: (event: MessageEvent<RpcMessage>) => void): void {
      /* never invoked; the stub has no incoming traffic */
    },
    removeEventListener(_type: 'message', _listener: (event: MessageEvent<RpcMessage>) => void): void {
      /* noop */
    },
  };
}

export interface MockPluginHandle {
  /** The RPC channel the listener is forwarding into. */
  readonly channel: RpcChannel;
  /** Detach the EventBus listener and dispose the channel. */
  readonly dispose: () => void;
}

/**
 * Subscribe one mock plugin listener to `pin:change`. The listener calls
 * `channel.emitEvent('pin:change', payload)` exactly the way
 * `PluginHost.subscribeEvent()` does in production.
 *
 * `componentId` defaults to a unique-per-plugin string so coalescing
 * across plugins behaves the same way as a real install (each plugin
 * sees its own queue, with its own per-key coalesce slot).
 */
export function installMockPluginListener(
  bus: HostEventBus,
  pluginIndex: number,
): MockPluginHandle {
  const channel = new RpcChannel(makeStubEndpoint());
  const unsub = bus.on('pin:change', (payload) => {
    channel.emitEvent('pin:change', payload);
  });
  return {
    channel,
    dispose: () => {
      try { unsub(); } catch { /* ignore */ }
      try { channel.dispose(); } catch { /* ignore */ }
    },
  };
  // pluginIndex is reserved for future per-plugin payload tagging; today
  // every plugin sees the same payload object so we don't read it.
  void pluginIndex;
}

/**
 * Install N mock plugin listeners. Returns a single dispose() that
 * tears them all down in reverse order.
 */
export function installMockPluginListeners(
  bus: HostEventBus,
  n: number,
): { handles: readonly MockPluginHandle[]; dispose: () => void } {
  const handles: MockPluginHandle[] = [];
  for (let i = 0; i < n; i++) {
    handles.push(installMockPluginListener(bus, i));
  }
  return {
    handles,
    dispose: () => {
      for (let i = handles.length - 1; i >= 0; i--) {
        handles[i]!.dispose();
      }
    },
  };
}
