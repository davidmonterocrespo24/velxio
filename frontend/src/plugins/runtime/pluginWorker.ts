/**
 * Worker bootstrap for a single plugin.
 *
 * The host loads this file via `new Worker(..., { type: 'module' })`.
 * The worker waits for an init message containing `{ manifest,
 * bundleUrl, integrity? }`, then:
 *
 *   1. Optionally verifies the bundle's SHA-256 against `integrity`
 *      (re-fetch + hash; integrity verification on the URL load
 *      itself happens at the SRI layer when the loader from CORE-007
 *      fetches the bundle into a Blob URL).
 *   2. Imports the bundle dynamically.
 *   3. Builds a `PluginContext` stub backed by RPC to the host.
 *   4. Calls the bundle's default-exported `activate(ctx)`.
 *   5. Reports success or failure via RPC.
 *
 * Worker isolation:
 *   - No `document`. No `window`. (Worker globals.)
 *   - Network access is limited to `connect-src` from the host CSP.
 *   - `eval` and `new Function` are blocked by the strict CSP set on
 *     the worker script (unsafe-eval not granted).
 *
 * This file is consumed only by the main `PluginManager`. Plugins
 * never import it.
 */

import type { PluginManifest } from '@velxio/sdk';

import { buildContextStub } from './ContextStub';
import { RpcChannel, type RpcEndpoint } from './rpc';

export interface InitMessage {
  readonly kind: 'init';
  readonly manifest: PluginManifest;
  readonly bundleUrl: string;
  /** Hex-encoded SHA-256 of the bundle bytes. Optional. */
  readonly integrity?: string;
}

export interface ReadyMessage {
  readonly kind: 'ready';
}

export interface InitErrorMessage {
  readonly kind: 'init-error';
  readonly error: { name: string; message: string; stack?: string };
}

type BootMessage = InitMessage;
type BootResponse = ReadyMessage | InitErrorMessage;

/**
 * Boot a worker. Exported for tests — production code calls this from
 * the worker entry script (the `if` at the bottom).
 */
export async function bootWorker(scope: RpcEndpoint & { close?: () => void }): Promise<void> {
  // Wait for the init message before doing anything else. Use a
  // one-shot listener to avoid pulling in RpcChannel before we have a
  // manifest.
  const init = await new Promise<InitMessage>((resolve, reject) => {
    const listener = (event: MessageEvent<BootMessage>) => {
      const data = event.data;
      if (data?.kind !== 'init') {
        reject(new Error('Worker received non-init message before init'));
        return;
      }
      scope.removeEventListener('message', listener);
      resolve(data);
    };
    scope.addEventListener('message', listener);
  });

  try {
    const bundle = await loadAndVerifyBundle(init.bundleUrl, init.integrity);
    const exported = (bundle as { default?: unknown; activate?: unknown }).default ?? bundle;
    const activate = pickActivate(exported);
    if (typeof activate !== 'function') {
      throw new Error('Plugin bundle does not export an activate(ctx) function');
    }

    const rpc = new RpcChannel(scope);
    const stub = buildContextStub({ manifest: init.manifest, rpc });
    rpc.enableAutoPong();

    // Plugin authors may return a Disposable from activate() — track it
    // so the host's terminate() flow can clean up via the worker side
    // disposable store. We rely on the SDK contract that the returned
    // value is `{ dispose }` or void.
    const result = await Promise.resolve(activate(stub.context));
    if (result !== null && typeof result === 'object' && typeof (result as { dispose?: unknown }).dispose === 'function') {
      stub.context.subscriptions.add(result as { dispose: () => void });
    }

    const ready: ReadyMessage = { kind: 'ready' };
    scope.postMessage(ready as never);
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    const out: InitErrorMessage = {
      kind: 'init-error',
      error: { name: e.name, message: e.message, ...(e.stack !== undefined ? { stack: e.stack } : {}) },
    };
    scope.postMessage(out as never);
    // Don't close — the host may want to inspect the error before
    // calling terminate(). Worker stays idle.
  }
}

function pickActivate(exported: unknown): unknown {
  if (typeof exported === 'function') return exported;
  if (typeof exported === 'object' && exported !== null && 'activate' in exported) {
    return (exported as { activate: unknown }).activate;
  }
  return undefined;
}

async function loadAndVerifyBundle(url: string, integrity?: string): Promise<unknown> {
  if (integrity !== undefined) {
    // Fetch + hash + import-from-blob. The double fetch (once here,
    // once in import()) is unfortunate but unavoidable without a
    // blob:-based import; doing the blob: dance imports the verified
    // bytes only.
    const res = await fetch(url, { credentials: 'omit' });
    if (!res.ok) throw new Error(`Bundle fetch failed: ${res.status} ${res.statusText}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const hashBytes = await crypto.subtle.digest('SHA-256', bytes);
    const hashHex = bufToHex(hashBytes);
    if (hashHex !== integrity.toLowerCase()) {
      throw new Error(`Bundle integrity mismatch: expected ${integrity}, got ${hashHex}`);
    }
    const blob = new Blob([bytes], { type: 'text/javascript' });
    const blobUrl = URL.createObjectURL(blob);
    try {
      return await import(/* @vite-ignore */ blobUrl);
    } finally {
      URL.revokeObjectURL(blobUrl);
    }
  }
  return import(/* @vite-ignore */ url);
}

function bufToHex(buf: ArrayBuffer): string {
  const view = new Uint8Array(buf);
  let out = '';
  for (let i = 0; i < view.length; i++) {
    out += view[i]!.toString(16).padStart(2, '0');
  }
  return out;
}

// ── Worker entry ─────────────────────────────────────────────────────────

declare const self: DedicatedWorkerGlobalScope | undefined;

// Only run the entry-point side-effect when this module is loaded inside
// an actual worker (where `self` exists and has `postMessage`). When
// imported from a test file in the main thread, just expose `bootWorker`
// without doing anything.
if (typeof self !== 'undefined' && typeof (self as DedicatedWorkerGlobalScope).postMessage === 'function' && typeof (self as DedicatedWorkerGlobalScope & { document?: unknown }).document === 'undefined') {
  // `self` in a worker IS the RpcEndpoint (postMessage + addEventListener).
  void bootWorker(self as unknown as RpcEndpoint & { close?: () => void });
}
