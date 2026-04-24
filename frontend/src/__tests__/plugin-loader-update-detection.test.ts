// @vitest-environment jsdom
/**
 * SDK-008d — `PluginLoader.checkForUpdates()` end-to-end.
 *
 * The loader pre-classifies the diff locally so a `requires-consent` row
 * never auto-mounts the modal. Auto-approve / auto-approve-with-toast
 * paths route through the controller (so the toast sink fires uniformly)
 * then unload + reload the worker. `requires-consent` returns immediately
 * — the badge handles the user click.
 *
 * The test surface here covers:
 *   1. happy path classifications (4 decisions + skipped + no-manifest + no-drift)
 *   2. controller throws `InstallFlowBusyError` → decision=`busy`
 *   3. resolver throw → decision=`error`
 *   4. reload error is surfaced via `outcome.reload`
 *   5. `Promise.allSettled` fan-out: one bad plugin doesn't poison siblings
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PluginManifest, PluginPermission } from '@velxio/sdk';

import {
  computeBundleHash,
  MemoryCacheBackend,
  PluginCache,
  PluginLoader,
  type InstalledPlugin,
} from '../plugins/loader';
import {
  createInstallFlowControllerForTests,
  type InstallFlowController,
} from '../plugin-host/InstallFlowController';
import type {
  LoadOptions,
  PluginEntry,
  PluginManager,
} from '../plugins/runtime/PluginManager';

// ── stubs ────────────────────────────────────────────────────────────────

class StubManager {
  readonly loaded: PluginManifest[] = [];
  readonly unloaded: string[] = [];
  async load(manifest: PluginManifest, _opts: LoadOptions): Promise<PluginEntry> {
    this.loaded.push(manifest);
    return { id: manifest.id, manifest, status: 'active' };
  }
  unload(id: string): void { this.unloaded.push(id); }
  list(): readonly PluginEntry[] { return []; }
  get(): PluginEntry | undefined { return undefined; }
  subscribe(): () => void { return () => {}; }
}

function manifest(
  id: string,
  version: string,
  permissions: PluginPermission[] = [],
): PluginManifest {
  return {
    schemaVersion: 1,
    id,
    name: id,
    version,
    publisher: { name: 'Tester' },
    description: 'update detection test',
    icon: 'https://example.com/icon.svg',
    license: 'MIT',
    category: 'utility',
    tags: [],
    type: ['ui-extension'],
    entry: { module: 'index.js' },
    permissions,
    pricing: { model: 'free' },
    refundPolicy: 'none',
  } as PluginManifest;
}

function bytes(s: string): Uint8Array { return new TextEncoder().encode(s); }
function ok(b: Uint8Array): Response { return new Response(b, { status: 200 }); }

let cache: PluginCache;
let mgr: StubManager;

beforeEach(() => {
  cache = new PluginCache({ backend: new MemoryCacheBackend() });
  mgr = new StubManager();
});

afterEach(() => { vi.useRealTimers(); });

async function buildLoader(opts: {
  body?: Uint8Array;
  hash?: string;
  controller?: InstallFlowController | null;
} = {}): Promise<{ loader: PluginLoader; hash: string }> {
  const body = opts.body ?? bytes('plugin');
  const hash = opts.hash ?? await computeBundleHash(body);
  const fetchImpl = vi.fn().mockResolvedValue(ok(body));
  const loader = new PluginLoader({
    cache,
    fetchOptions: { fetchImpl: fetchImpl as unknown as typeof fetch, preferDevServer: false, baseDelayMs: 1 },
    manager: mgr as unknown as PluginManager,
    ...(opts.controller !== undefined && opts.controller !== null
      ? { installFlowController: opts.controller }
      : {}),
  });
  return { loader, hash };
}

// ── tests ────────────────────────────────────────────────────────────────

describe('PluginLoader · checkForUpdates · classifications', () => {
  it('no-drift when latest equals installed', async () => {
    const { loader, hash } = await buildLoader();
    const installed: InstalledPlugin[] = [
      { manifest: manifest('a', '1.0.0'), bundleHash: hash },
    ];
    const [out] = await loader.checkForUpdates(installed, {
      getLatestManifest: () => manifest('a', '1.0.0'),
    });
    expect(out?.decision).toBe('no-drift');
    expect(out?.latestVersion).toBe('1.0.0');
    expect(mgr.unloaded).toEqual([]);
    expect(mgr.loaded).toEqual([]);
  });

  it('no-manifest when resolver returns null', async () => {
    const { loader, hash } = await buildLoader();
    const [out] = await loader.checkForUpdates(
      [{ manifest: manifest('a', '1.0.0'), bundleHash: hash }],
      { getLatestManifest: () => null },
    );
    expect(out?.decision).toBe('no-manifest');
    expect(out?.latestVersion).toBeUndefined();
  });

  it('skipped when latest matches the user-skipped cursor', async () => {
    const { loader, hash } = await buildLoader();
    const [out] = await loader.checkForUpdates(
      [{ manifest: manifest('a', '1.0.0'), bundleHash: hash }],
      {
        getLatestManifest: () => manifest('a', '1.1.0'),
        isVersionSkipped: (id, v) => id === 'a' && v === '1.1.0',
      },
    );
    expect(out?.decision).toBe('skipped');
    expect(mgr.unloaded).toEqual([]);
  });

  it('auto-approve when no permission diff — silent reload', async () => {
    const { loader, hash } = await buildLoader();
    const installed: InstalledPlugin[] = [
      { manifest: manifest('a', '1.0.0'), bundleHash: hash },
    ];
    const [out] = await loader.checkForUpdates(installed, {
      getLatestManifest: () => manifest('a', '1.1.0'),
    });
    expect(out?.decision).toBe('auto-approve');
    expect(mgr.unloaded).toEqual(['a']);
    expect(mgr.loaded.length).toBe(1);
    expect(mgr.loaded[0]?.version).toBe('1.1.0');
    expect(out?.reload?.status).toBe('active');
  });

  it('auto-approve-with-toast when only Low-risk added', async () => {
    const toasts: unknown[] = [];
    const controller = createInstallFlowControllerForTests({
      markVersionSkipped: () => {},
      emitToast: (e) => toasts.push(e),
    });
    const { loader, hash } = await buildLoader({ controller });
    const installed: InstalledPlugin[] = [
      { manifest: manifest('a', '1.0.0'), bundleHash: hash },
    ];
    // 'simulator.events.read' is a Low-risk permission per docs/PLUGIN_PERMISSIONS.md
    const [out] = await loader.checkForUpdates(installed, {
      getLatestManifest: () => manifest('a', '1.1.0', ['simulator.events.read']),
    });
    expect(out?.decision).toBe('auto-approve-with-toast');
    expect(toasts.length).toBe(1);
    expect(mgr.unloaded).toEqual(['a']);
    expect(mgr.loaded[0]?.version).toBe('1.1.0');
  });

  it('requires-consent when High-risk added — does not auto-mount or reload', async () => {
    const onRequest = vi.fn();
    const controller = createInstallFlowControllerForTests({
      markVersionSkipped: () => {},
    });
    // Spy on requestUpdate so we can prove it was never called.
    const origRequest = controller.requestUpdate.bind(controller);
    controller.requestUpdate = (...args) => {
      onRequest(...args);
      return origRequest(...args);
    };
    const { loader, hash } = await buildLoader({ controller });
    const installed: InstalledPlugin[] = [
      { manifest: manifest('a', '1.0.0'), bundleHash: hash },
    ];
    // 'http.fetch' is a High-risk permission.
    const [out] = await loader.checkForUpdates(installed, {
      getLatestManifest: () => manifest('a', '1.1.0', ['http.fetch']),
    });
    expect(out?.decision).toBe('requires-consent');
    expect(onRequest).not.toHaveBeenCalled();
    expect(mgr.unloaded).toEqual([]);
    expect(mgr.loaded).toEqual([]);
    expect(out?.latestVersion).toBe('1.1.0');
  });
});

describe('PluginLoader · checkForUpdates · failure paths', () => {
  it('decision=busy when controller is mid-flow', async () => {
    // Trigger busy by holding an active install request open.
    const controller = createInstallFlowControllerForTests({
      markVersionSkipped: () => {},
    });
    // Open and DON'T resolve a request to wedge the controller.
    void controller.requestInstall(manifest('held', '1.0.0', ['http.fetch']));
    const { loader, hash } = await buildLoader({ controller });
    const installed: InstalledPlugin[] = [
      { manifest: manifest('a', '1.0.0'), bundleHash: hash },
    ];
    const [out] = await loader.checkForUpdates(installed, {
      getLatestManifest: () => manifest('a', '1.1.0'),
    });
    expect(out?.decision).toBe('busy');
    expect(mgr.unloaded).toEqual([]);
  });

  it('decision=error when resolver throws', async () => {
    const { loader, hash } = await buildLoader();
    const installed: InstalledPlugin[] = [
      { manifest: manifest('a', '1.0.0'), bundleHash: hash },
    ];
    const [out] = await loader.checkForUpdates(installed, {
      getLatestManifest: () => { throw new Error('catalog 500'); },
    });
    expect(out?.decision).toBe('error');
    expect(out?.error?.message).toBe('catalog 500');
    expect(mgr.unloaded).toEqual([]);
  });

  it('one bad plugin does not block the rest (Promise.allSettled fan-out)', async () => {
    const { loader, hash } = await buildLoader();
    const installed: InstalledPlugin[] = [
      { manifest: manifest('good', '1.0.0'), bundleHash: hash },
      { manifest: manifest('bad', '1.0.0'), bundleHash: hash },
    ];
    const outcomes = await loader.checkForUpdates(installed, {
      getLatestManifest: (id) => {
        if (id === 'bad') throw new Error('catalog 404');
        return manifest('good', '1.1.0');
      },
    });
    const goodOut = outcomes.find((o) => o.id === 'good');
    const badOut = outcomes.find((o) => o.id === 'bad');
    expect(goodOut?.decision).toBe('auto-approve');
    expect(badOut?.decision).toBe('error');
    expect(badOut?.error?.message).toBe('catalog 404');
    expect(mgr.unloaded).toEqual(['good']);
  });

  it('loader has no controller wired → still auto-reloads (headless mode)', async () => {
    const { loader, hash } = await buildLoader();
    const installed: InstalledPlugin[] = [
      { manifest: manifest('a', '1.0.0'), bundleHash: hash },
    ];
    const [out] = await loader.checkForUpdates(installed, {
      getLatestManifest: () => manifest('a', '1.1.0', ['simulator.events.read']),
    });
    expect(out?.decision).toBe('auto-approve-with-toast');
    expect(mgr.loaded[0]?.version).toBe('1.1.0');
  });
});
