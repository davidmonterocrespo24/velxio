// @vitest-environment jsdom

/**
 * `<InstallFlowOverlay />` smoke — verifies the React subscription
 * contract works end-to-end (controller open → overlay mounts the
 * matching dialog → controller close → overlay unmounts).
 *
 * The dialogs themselves have their own coverage in
 * `PluginConsentDialog.test.tsx` / `PluginUpdateDiffDialog.test.tsx`;
 * here we only assert the *outlet* lights up correctly.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';

import { InstallFlowOverlay } from '../components/plugin-host/InstallFlowOverlay';
import {
  createInstallFlowControllerForTests,
  type InstallFlowController,
} from '../plugin-host/InstallFlowController';
import type { PluginManifest } from '@velxio/sdk';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  container = null;
  root = null;
});

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

function makeController(): InstallFlowController {
  return createInstallFlowControllerForTests({
    markVersionSkipped: () => {},
  });
}

describe('<InstallFlowOverlay />', () => {
  it('renders nothing while no flow is pending', () => {
    const ctl = makeController();
    act(() => {
      root!.render(<InstallFlowOverlay controller={ctl} />);
    });
    expect(container!.querySelector('[role="dialog"]')).toBeNull();
  });

  it('mounts the consent dialog when requestInstall opens', async () => {
    const ctl = makeController();
    act(() => {
      root!.render(<InstallFlowOverlay controller={ctl} />);
    });
    let pending: Promise<unknown>;
    act(() => {
      pending = ctl.requestInstall(manifest({ permissions: ['http.fetch'] }));
    });
    expect(container!.querySelector('[data-testid="plugin-consent-cancel"]')).not.toBeNull();
    // Tear down to avoid leaking a pending promise.
    act(() => {
      ctl.cancelActive();
    });
    await pending!;
    expect(container!.querySelector('[role="dialog"]')).toBeNull();
  });

  it('mounts the update dialog when requestUpdate opens (requires-consent)', async () => {
    const ctl = makeController();
    act(() => {
      root!.render(<InstallFlowOverlay controller={ctl} />);
    });
    let pending: Promise<unknown>;
    act(() => {
      pending = ctl.requestUpdate(
        { manifest: manifest({ permissions: [] }) },
        { manifest: manifest({ version: '2.0.0', permissions: ['http.fetch'] }) },
      );
    });
    expect(container!.querySelector('[data-testid="plugin-update-cancel"]')).not.toBeNull();
    act(() => {
      ctl.cancelActive();
    });
    await pending!;
    expect(container!.querySelector('[role="dialog"]')).toBeNull();
  });

  it('does NOT mount a dialog for an auto-approve update', async () => {
    const ctl = makeController();
    act(() => {
      root!.render(<InstallFlowOverlay controller={ctl} />);
    });
    let pending: Promise<unknown>;
    act(() => {
      pending = ctl.requestUpdate(
        { manifest: manifest({ permissions: ['simulator.events.read'] }) },
        { manifest: manifest({ version: '1.1.0', permissions: ['simulator.events.read'] }) },
      );
    });
    await pending!;
    expect(container!.querySelector('[role="dialog"]')).toBeNull();
  });
});
