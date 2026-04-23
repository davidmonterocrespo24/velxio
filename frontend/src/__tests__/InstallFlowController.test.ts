/**
 * InstallFlowController — host-side singleton for consent + update-diff
 * dialogs (SDK-008c). Pure logic, no React: tests run in plain Vitest
 * without jsdom.
 *
 * Coverage:
 *   - install path: silent (Low only), consent confirmed, consent cancelled,
 *     consent dialog mounts/clears via subscribe + getActiveDialog
 *   - update path: auto-approve, auto-approve-with-toast (toast emitted),
 *     requires-consent (Update / Skip / Uninstall / Cancel)
 *   - skipped versions: Skip path calls sinks.markVersionSkipped
 *   - busy guard: requestX while a dialog is open throws InstallFlowBusyError
 *   - subscribe fan-out: opening + closing fires listeners
 *   - cancelActive: synchronously closes any open dialog
 *   - faulty listener does not break sibling listeners
 */
import { describe, expect, it, vi } from 'vitest';

import {
  createInstallFlowControllerForTests,
  InstallFlowBusyError,
  type InstallFlowSinks,
  type InstallToastEvent,
} from '../plugin-host/InstallFlowController';
import type { PluginManifest } from '@velxio/sdk';

// ── helpers ──────────────────────────────────────────────────────────────

function manifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    schemaVersion: 1,
    id: 'p',
    name: 'Plugin P',
    version: '1.0.0',
    sdkVersion: '0.1.0',
    permissions: [],
    ...overrides,
  } as PluginManifest;
}

function makeSinks(): InstallFlowSinks & {
  toasts: InstallToastEvent[];
  skips: Array<{ id: string; version: string }>;
} {
  const toasts: InstallToastEvent[] = [];
  const skips: Array<{ id: string; version: string }> = [];
  return {
    markVersionSkipped: (id, version) => skips.push({ id, version }),
    emitToast: (event) => toasts.push(event),
    toasts,
    skips,
  };
}

// ── install path ─────────────────────────────────────────────────────────

describe('InstallFlowController.requestInstall', () => {
  it('resolves silently when manifest declares only low-risk permissions', async () => {
    const sinks = makeSinks();
    const ctl = createInstallFlowControllerForTests(sinks);
    const m = manifest({ permissions: ['simulator.events.read'] });
    const decision = await ctl.requestInstall(m);
    expect(decision).toEqual({ kind: 'confirmed' });
    expect(ctl.getActiveDialog()).toBeNull();
  });

  it('mounts a consent dialog when permissions include Medium/High', async () => {
    const sinks = makeSinks();
    const ctl = createInstallFlowControllerForTests(sinks);
    const m = manifest({ permissions: ['http.fetch'], http: { allowlist: ['https://api.x.com/'] } as never });

    // Fire and capture the still-pending dialog before user interaction.
    const pending = ctl.requestInstall(m, { httpAllowlist: ['https://api.x.com/'] });
    const active = ctl.getActiveDialog();
    expect(active?.kind).toBe('install');
    expect(active && active.kind === 'install' ? active.httpAllowlist : null).toEqual([
      'https://api.x.com/',
    ]);

    // Confirm.
    if (active && active.kind === 'install') active.onConfirm();
    await expect(pending).resolves.toEqual({ kind: 'confirmed' });
    expect(ctl.getActiveDialog()).toBeNull();
  });

  it('cancel resolves with cancelled', async () => {
    const sinks = makeSinks();
    const ctl = createInstallFlowControllerForTests(sinks);
    const m = manifest({ permissions: ['http.fetch'] });
    const pending = ctl.requestInstall(m);
    const active = ctl.getActiveDialog();
    if (active && active.kind === 'install') active.onCancel();
    await expect(pending).resolves.toEqual({ kind: 'cancelled' });
    expect(ctl.getActiveDialog()).toBeNull();
  });

  it('overlapping requestInstall throws InstallFlowBusyError', async () => {
    const ctl = createInstallFlowControllerForTests(makeSinks());
    const m = manifest({ permissions: ['http.fetch'] });
    const first = ctl.requestInstall(m);
    expect(() => ctl.requestInstall(manifest({ id: 'q', permissions: ['http.fetch'] }))).toThrow(
      InstallFlowBusyError,
    );
    // Resolve the first promise so it does not leak.
    const active = ctl.getActiveDialog();
    if (active && active.kind === 'install') active.onCancel();
    await first;
  });
});

// ── update path ──────────────────────────────────────────────────────────

describe('InstallFlowController.requestUpdate', () => {
  it('auto-approve: identical permissions resolve as updated, no dialog', async () => {
    const ctl = createInstallFlowControllerForTests(makeSinks());
    const installed = { manifest: manifest({ permissions: ['simulator.events.read'] }) };
    const latest = { manifest: manifest({ version: '1.1.0', permissions: ['simulator.events.read'] }) };
    const decision = await ctl.requestUpdate(installed, latest);
    expect(decision).toEqual({ kind: 'updated' });
    expect(ctl.getActiveDialog()).toBeNull();
  });

  it('auto-approve-with-toast: emits toast + resolves updated, no dialog', async () => {
    const sinks = makeSinks();
    const ctl = createInstallFlowControllerForTests(sinks);
    const installed = { manifest: manifest({ permissions: [] }) };
    const latest = { manifest: manifest({ version: '1.1.0', permissions: ['simulator.events.read'] }) };

    const decision = await ctl.requestUpdate(installed, latest);
    expect(decision).toEqual({ kind: 'updated' });
    expect(sinks.toasts).toHaveLength(1);
    expect(sinks.toasts[0]).toMatchObject({
      pluginId: 'p',
      fromVersion: '1.0.0',
      toVersion: '1.1.0',
    });
    expect(ctl.getActiveDialog()).toBeNull();
  });

  it('emitToast missing: auto-approve-with-toast still resolves updated', async () => {
    const ctl = createInstallFlowControllerForTests({
      markVersionSkipped: () => {},
    });
    const installed = { manifest: manifest({ permissions: [] }) };
    const latest = { manifest: manifest({ version: '1.1.0', permissions: ['simulator.events.read'] }) };
    await expect(ctl.requestUpdate(installed, latest)).resolves.toEqual({ kind: 'updated' });
  });

  it('requires-consent: Update button resolves as updated', async () => {
    const ctl = createInstallFlowControllerForTests(makeSinks());
    const installed = { manifest: manifest({ permissions: [] }) };
    const latest = { manifest: manifest({ version: '2.0.0', permissions: ['http.fetch'] }) };
    const pending = ctl.requestUpdate(installed, latest);
    const active = ctl.getActiveDialog();
    expect(active?.kind).toBe('update');
    if (active && active.kind === 'update') active.onUpdate();
    await expect(pending).resolves.toEqual({ kind: 'updated' });
    expect(ctl.getActiveDialog()).toBeNull();
  });

  it('requires-consent: Skip persists the version + resolves skipped', async () => {
    const sinks = makeSinks();
    const ctl = createInstallFlowControllerForTests(sinks);
    const installed = { manifest: manifest({ permissions: [] }) };
    const latest = { manifest: manifest({ version: '2.0.0', permissions: ['http.fetch'] }) };
    const pending = ctl.requestUpdate(installed, latest);
    const active = ctl.getActiveDialog();
    if (active && active.kind === 'update') active.onSkipVersion();
    await expect(pending).resolves.toEqual({ kind: 'skipped', version: '2.0.0' });
    expect(sinks.skips).toEqual([{ id: 'p', version: '2.0.0' }]);
    expect(ctl.getActiveDialog()).toBeNull();
  });

  it('requires-consent: Uninstall resolves as uninstalled', async () => {
    const ctl = createInstallFlowControllerForTests(makeSinks());
    const installed = { manifest: manifest({ permissions: [] }) };
    const latest = { manifest: manifest({ version: '2.0.0', permissions: ['http.fetch'] }) };
    const pending = ctl.requestUpdate(installed, latest);
    const active = ctl.getActiveDialog();
    if (active && active.kind === 'update') active.onUninstall();
    await expect(pending).resolves.toEqual({ kind: 'uninstalled' });
  });

  it('requires-consent: Cancel resolves as cancelled (no skip persisted)', async () => {
    const sinks = makeSinks();
    const ctl = createInstallFlowControllerForTests(sinks);
    const installed = { manifest: manifest({ permissions: [] }) };
    const latest = { manifest: manifest({ version: '2.0.0', permissions: ['http.fetch'] }) };
    const pending = ctl.requestUpdate(installed, latest);
    const active = ctl.getActiveDialog();
    if (active && active.kind === 'update') active.onCancel();
    await expect(pending).resolves.toEqual({ kind: 'cancelled' });
    expect(sinks.skips).toEqual([]);
  });

  it('overlapping requestUpdate throws InstallFlowBusyError', async () => {
    const ctl = createInstallFlowControllerForTests(makeSinks());
    const installed = { manifest: manifest({ permissions: [] }) };
    const latest = { manifest: manifest({ version: '2.0.0', permissions: ['http.fetch'] }) };
    const first = ctl.requestUpdate(installed, latest);
    expect(() => ctl.requestUpdate(installed, latest)).toThrow(InstallFlowBusyError);
    const active = ctl.getActiveDialog();
    if (active && active.kind === 'update') active.onCancel();
    await first;
  });

  it('install + update cannot be open at once', async () => {
    const ctl = createInstallFlowControllerForTests(makeSinks());
    const m = manifest({ permissions: ['http.fetch'] });
    const installPending = ctl.requestInstall(m);
    expect(() =>
      ctl.requestUpdate(
        { manifest: m },
        { manifest: { ...m, version: '1.1.0', permissions: ['http.fetch', 'storage.write'] } as PluginManifest },
      ),
    ).toThrow(InstallFlowBusyError);
    const active = ctl.getActiveDialog();
    if (active && active.kind === 'install') active.onCancel();
    await installPending;
  });
});

// ── subscribe + cancelActive ─────────────────────────────────────────────

describe('InstallFlowController.subscribe', () => {
  it('fires on open and on close', async () => {
    const ctl = createInstallFlowControllerForTests(makeSinks());
    const calls: number[] = [];
    const stop = ctl.subscribe(() => calls.push(calls.length));

    const pending = ctl.requestInstall(manifest({ permissions: ['http.fetch'] }));
    expect(calls).toHaveLength(1);
    const active = ctl.getActiveDialog();
    if (active && active.kind === 'install') active.onConfirm();
    await pending;
    expect(calls).toHaveLength(2);
    stop();
  });

  it('unsubscribed listener is not called', async () => {
    const ctl = createInstallFlowControllerForTests(makeSinks());
    let calls = 0;
    const stop = ctl.subscribe(() => calls++);
    stop();
    const pending = ctl.requestInstall(manifest({ permissions: ['http.fetch'] }));
    const active = ctl.getActiveDialog();
    if (active && active.kind === 'install') active.onCancel();
    await pending;
    expect(calls).toBe(0);
  });

  it('a throwing listener does not break sibling listeners', async () => {
    const ctl = createInstallFlowControllerForTests(makeSinks());
    let goodCalls = 0;
    ctl.subscribe(() => { throw new Error('boom'); });
    ctl.subscribe(() => { goodCalls += 1; });
    const pending = ctl.requestInstall(manifest({ permissions: ['http.fetch'] }));
    const active = ctl.getActiveDialog();
    if (active && active.kind === 'install') active.onCancel();
    await pending;
    expect(goodCalls).toBeGreaterThanOrEqual(2);
  });
});

describe('InstallFlowController.cancelActive', () => {
  it('synchronously cancels an open install dialog', async () => {
    const ctl = createInstallFlowControllerForTests(makeSinks());
    const pending = ctl.requestInstall(manifest({ permissions: ['http.fetch'] }));
    expect(ctl.getActiveDialog()?.kind).toBe('install');
    ctl.cancelActive();
    await expect(pending).resolves.toEqual({ kind: 'cancelled' });
    expect(ctl.getActiveDialog()).toBeNull();
  });

  it('synchronously cancels an open update dialog', async () => {
    const ctl = createInstallFlowControllerForTests(makeSinks());
    const installed = { manifest: manifest({ permissions: [] }) };
    const latest = { manifest: manifest({ version: '2.0.0', permissions: ['http.fetch'] }) };
    const pending = ctl.requestUpdate(installed, latest);
    ctl.cancelActive();
    await expect(pending).resolves.toEqual({ kind: 'cancelled' });
    expect(ctl.getActiveDialog()).toBeNull();
  });

  it('no-op when no dialog is open', () => {
    const ctl = createInstallFlowControllerForTests(makeSinks());
    expect(() => ctl.cancelActive()).not.toThrow();
  });
});

// ── singleton helper ─────────────────────────────────────────────────────

describe('configureInstallFlow / getInstallFlowController', () => {
  it('getInstallFlowController throws before configure', async () => {
    const mod = await import('../plugin-host/InstallFlowController');
    mod.setInstallFlowControllerForTests(null);
    expect(() => mod.getInstallFlowController()).toThrow(/not configured/);
  });

  it('configureInstallFlow returns the same instance as getInstallFlowController', async () => {
    const mod = await import('../plugin-host/InstallFlowController');
    const sinks = makeSinks();
    const a = mod.configureInstallFlow(sinks);
    const b = mod.getInstallFlowController();
    expect(a).toBe(b);
    mod.setInstallFlowControllerForTests(null);
  });

  it('configureInstallFlow is idempotent — re-calling replaces the singleton', async () => {
    const mod = await import('../plugin-host/InstallFlowController');
    const sinks1 = makeSinks();
    const sinks2 = makeSinks();
    const a = mod.configureInstallFlow(sinks1);
    const b = mod.configureInstallFlow(sinks2);
    expect(b).not.toBe(a);
    expect(mod.getInstallFlowController()).toBe(b);
    mod.setInstallFlowControllerForTests(null);
  });
});

// Quiet down "vi" unused-import warnings in environments where Vitest's
// module mock helpers are not actually used.
void vi;
