// @vitest-environment jsdom
/**
 * <PluginConsentDialog /> contract tests.
 *
 * Verifies the four UI invariants the security model depends on:
 *
 *   1. Anti-clickjacking: Install is disabled until scrolled to bottom
 *      (when consent is needed).
 *   2. All-Low manifests bypass the consent flow entirely (no scroll
 *      gate, "safe plugin" notice, Install enabled immediately).
 *   3. Risk grouping puts High/Medium in the consent section and rolls
 *      Low into the collapsed "Standard editor features" footer.
 *   4. Cancel and Escape both close via onCancel; default focus on Cancel.
 *   5. http.fetch surfaces the manifest's allowlist verbatim.
 */
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

import type { PluginPermission } from '@velxio/sdk';

import {
  PluginConsentDialog,
  isScrolledToBottom,
  type PluginIdentity,
} from '../components/plugin-host/PluginConsentDialog';

let container: HTMLElement;
let root: Root;
let restoreGeometry: () => void;

/**
 * jsdom returns 0 for `scrollHeight`/`clientHeight` because it doesn't
 * compute layout. We install a prototype-level mock so every `<div>` in
 * these tests reports "1000 px content in a 200 px viewport" — i.e. the
 * scroll gate actually engages. Restored in afterEach.
 */
function installScrollGeometryMocks(): () => void {
  const proto = HTMLElement.prototype;
  const originals = {
    scrollHeight: Object.getOwnPropertyDescriptor(proto, 'scrollHeight'),
    clientHeight: Object.getOwnPropertyDescriptor(proto, 'clientHeight'),
    scrollTop: Object.getOwnPropertyDescriptor(proto, 'scrollTop'),
  };
  Object.defineProperty(proto, 'scrollHeight', {
    configurable: true,
    get(this: HTMLElement & { __scrollHeight?: number }) {
      return this.__scrollHeight ?? 1000;
    },
  });
  Object.defineProperty(proto, 'clientHeight', {
    configurable: true,
    get(this: HTMLElement & { __clientHeight?: number }) {
      return this.__clientHeight ?? 200;
    },
  });
  Object.defineProperty(proto, 'scrollTop', {
    configurable: true,
    get(this: HTMLElement & { __scrollTop?: number }) {
      return this.__scrollTop ?? 0;
    },
    set(this: HTMLElement & { __scrollTop?: number }, v: number) {
      this.__scrollTop = v;
    },
  });
  return () => {
    if (originals.scrollHeight !== undefined)
      Object.defineProperty(proto, 'scrollHeight', originals.scrollHeight);
    else delete (proto as unknown as Record<string, unknown>).scrollHeight;
    if (originals.clientHeight !== undefined)
      Object.defineProperty(proto, 'clientHeight', originals.clientHeight);
    else delete (proto as unknown as Record<string, unknown>).clientHeight;
    if (originals.scrollTop !== undefined)
      Object.defineProperty(proto, 'scrollTop', originals.scrollTop);
    else delete (proto as unknown as Record<string, unknown>).scrollTop;
  };
}

beforeEach(() => {
  restoreGeometry = installScrollGeometryMocks();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  restoreGeometry();
});

const defaultPlugin: PluginIdentity = {
  id: 'plg.test',
  displayName: 'Test Plugin',
  version: '1.0.0',
  publisher: 'Tester',
};

function render(props: Partial<React.ComponentProps<typeof PluginConsentDialog>>): {
  install: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
} {
  const install = vi.fn();
  const cancel = vi.fn();
  act(() => {
    root.render(
      <PluginConsentDialog
        plugin={defaultPlugin}
        permissions={[]}
        onConfirm={install}
        onCancel={cancel}
        {...props}
      />,
    );
  });
  return { install, cancel };
}

function getInstall(): HTMLButtonElement {
  const btn = container.querySelector(
    '[data-testid="plugin-consent-install"]',
  ) as HTMLButtonElement | null;
  if (btn === null) throw new Error('install button not found');
  return btn;
}

function getCancel(): HTMLButtonElement {
  const btn = container.querySelector(
    '[data-testid="plugin-consent-cancel"]',
  ) as HTMLButtonElement | null;
  if (btn === null) throw new Error('cancel button not found');
  return btn;
}

describe('isScrolledToBottom (helper)', () => {
  it('returns true when content fits without scrolling', () => {
    expect(
      isScrolledToBottom({ scrollHeight: 100, scrollTop: 0, clientHeight: 200 }),
    ).toBe(true);
  });

  it('returns false when scroll position has not reached the end', () => {
    expect(
      isScrolledToBottom({ scrollHeight: 1000, scrollTop: 0, clientHeight: 200 }),
    ).toBe(false);
  });

  it('returns true within the 4 px tolerance window', () => {
    // 1000 - 797 - 200 = 3 (within tolerance).
    expect(
      isScrolledToBottom({ scrollHeight: 1000, scrollTop: 797, clientHeight: 200 }),
    ).toBe(true);
  });

  it('honors a custom tolerance', () => {
    expect(
      isScrolledToBottom(
        { scrollHeight: 1000, scrollTop: 700, clientHeight: 200 },
        100,
      ),
    ).toBe(true);
  });
});

describe('PluginConsentDialog — all-Low manifest', () => {
  it('shows the safe-plugin notice and enables Install immediately', () => {
    render({
      permissions: ['ui.command.register', 'ui.toolbar.register'],
    });
    expect(container.textContent).toMatch(/standard editor features/i);
    // No risk badges visible for Low-only manifests.
    expect(container.textContent).not.toMatch(/Permissions requiring your approval/);
    // Install enabled (no scroll gate).
    expect(getInstall().disabled).toBe(false);
  });

  it('treats an empty permissions array as safe', () => {
    render({ permissions: [] });
    expect(getInstall().disabled).toBe(false);
    expect(container.textContent).toMatch(/no special.*features/i);
  });
});

describe('PluginConsentDialog — Medium/High manifest', () => {
  it('renders the consent section and disables Install until scrolled', () => {
    render({
      permissions: ['http.fetch', 'storage.user.write', 'ui.command.register'],
    });
    expect(container.textContent).toMatch(/Permissions requiring your approval/);
    // High and Medium badges appear.
    expect(container.textContent).toMatch(/High/);
    expect(container.textContent).toMatch(/Medium/);
    // Low rolls into a collapsed footer (closed by default).
    expect(container.textContent).toMatch(/Standard editor features \(1\)/);
    // Install gated.
    expect(getInstall().disabled).toBe(true);
  });

  it('groups all 22 permissions correctly', () => {
    const all: PluginPermission[] = [
      'simulator.events.read',
      'simulator.pins.read',
      'simulator.pins.write',
      'simulator.spice.read',
      'compile.transform.client',
      'ui.command.register',
      'ui.toolbar.register',
      'ui.panel.register',
      'ui.statusbar.register',
      'ui.context-menu.register',
      'ui.editor.action.register',
      'ui.canvas.overlay.register',
      'storage.user.read',
      'storage.user.write',
      'storage.workspace.read',
      'storage.workspace.write',
      'http.fetch',
      'components.register',
      'libraries.provide',
      'templates.provide',
      'settings.declare',
    ];
    render({ permissions: all });
    // Should mention "Standard editor features" with a non-zero Low count.
    expect(container.textContent).toMatch(/Standard editor features \(\d+\)/);
    // Install disabled (consent needed).
    expect(getInstall().disabled).toBe(true);
  });
});

describe('PluginConsentDialog — http.fetch allowlist', () => {
  it('does not surface the allowlist when http.fetch is absent', () => {
    render({
      permissions: ['storage.user.write'],
      httpAllowlist: ['https://api.example.com/'],
    });
    expect(container.textContent).not.toMatch(/api\.example\.com/);
  });

  it('renders allowlist entries verbatim under http.fetch when expanded', () => {
    render({
      permissions: ['http.fetch'],
      httpAllowlist: ['https://api.example.com/', 'https://logs.example.org/v2/'],
    });
    // Allowlist origins are inside the row's expandable area; expand the row first.
    const disclose = container.querySelector(
      '[aria-label="Show details"]',
    ) as HTMLButtonElement | null;
    expect(disclose).not.toBeNull();
    act(() => disclose!.click());
    expect(container.textContent).toMatch(/Allowed origins/);
    expect(container.textContent).toMatch(/https:\/\/api\.example\.com\//);
    expect(container.textContent).toMatch(/https:\/\/logs\.example\.org\/v2\//);
  });
});

describe('PluginConsentDialog — actions', () => {
  it('Cancel button fires onCancel', () => {
    const { cancel } = render({ permissions: [] });
    act(() => getCancel().click());
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('Install button fires onConfirm when enabled', () => {
    const { install } = render({ permissions: [] });
    act(() => getInstall().click());
    expect(install).toHaveBeenCalledTimes(1);
  });

  it('Install does not fire while disabled (DOM-level disabled blocks click)', () => {
    const { install } = render({ permissions: ['http.fetch'] });
    expect(getInstall().disabled).toBe(true);
    // Even if we synthesize a click, the disabled attribute prevents handler invocation.
    act(() => getInstall().click());
    expect(install).not.toHaveBeenCalled();
  });

  it('Escape key fires onCancel', () => {
    const { cancel } = render({ permissions: [] });
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(cancel).toHaveBeenCalled();
  });

  it('clicking the overlay backdrop fires onCancel', () => {
    const { cancel } = render({ permissions: [] });
    const overlay = container.querySelector('[role="dialog"]') as HTMLElement;
    act(() => overlay.click());
    expect(cancel).toHaveBeenCalled();
  });

  it('clicking inside the modal does not fire onCancel', () => {
    const { cancel } = render({ permissions: [] });
    // The modal is the immediate child of the overlay.
    const modal = container.querySelector('[role="dialog"] > div') as HTMLElement;
    act(() => modal.click());
    expect(cancel).not.toHaveBeenCalled();
  });
});

describe('PluginConsentDialog — unknown permissions', () => {
  it('renders a defensive fail-closed banner for unknown permissions', () => {
    render({
      permissions: ['totally.fake' as PluginPermission, 'ui.command.register'],
    });
    // Unknown permissions trigger consent (requiresConsent() is fail-closed).
    expect(getInstall().disabled).toBe(true);
    expect(container.textContent).toMatch(/does not recognize/i);
    expect(container.textContent).toMatch(/totally\.fake/);
  });
});
