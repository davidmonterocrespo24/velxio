// @vitest-environment jsdom
/**
 * <PluginUpdateDiffDialog /> contract tests.
 *
 * The dialog is driven by an `UpdateDiffDecision` (already classified by
 * `classifyUpdateDiff`). These tests assert the three rendering modes,
 * the scroll gate (only on `requires-consent`), the four action handlers,
 * and the helper `shouldShowUpdateDiffDialog` / `decisionNeedsScrollGate`.
 */
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

import {
  classifyUpdateDiff,
  diffPermissions,
  type PluginPermission,
  type UpdateDiffDecision,
} from '@velxio/sdk';

import {
  PluginUpdateDiffDialog,
  shouldShowUpdateDiffDialog,
  decisionNeedsScrollGate,
} from '../components/plugin-host/PluginUpdateDiffDialog';
import type { PluginIdentity } from '../components/plugin-host/PluginConsentDialog';

let container: HTMLElement;
let root: Root;
let restoreGeometry: () => void;

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
  version: '1.1.0',
  publisher: 'Tester',
};

interface RenderOptions {
  decision: UpdateDiffDecision;
  fromVersion?: string;
  toVersion?: string;
  httpAllowlist?: ReadonlyArray<string>;
}

function render(opts: RenderOptions): {
  update: ReturnType<typeof vi.fn>;
  skip: ReturnType<typeof vi.fn>;
  uninstall: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
} {
  const update = vi.fn();
  const skip = vi.fn();
  const uninstall = vi.fn();
  const cancel = vi.fn();
  act(() => {
    root.render(
      <PluginUpdateDiffDialog
        plugin={defaultPlugin}
        fromVersion={opts.fromVersion ?? '1.0.0'}
        toVersion={opts.toVersion ?? '1.1.0'}
        decision={opts.decision}
        httpAllowlist={opts.httpAllowlist}
        onUpdate={update}
        onSkipVersion={skip}
        onUninstall={uninstall}
        onCancel={cancel}
      />,
    );
  });
  return { update, skip, uninstall, cancel };
}

function btn(testid: string): HTMLButtonElement {
  const el = container.querySelector(
    `[data-testid="${testid}"]`,
  ) as HTMLButtonElement | null;
  if (el === null) throw new Error(`button ${testid} not found`);
  return el;
}

// ── helpers ────────────────────────────────────────────────────────────

describe('shouldShowUpdateDiffDialog', () => {
  it('returns false for auto-approve (caller should install silently)', () => {
    const decision = classifyUpdateDiff(
      diffPermissions(['ui.command.register'], ['ui.command.register']),
    );
    expect(decision.kind).toBe('auto-approve');
    expect(shouldShowUpdateDiffDialog(decision)).toBe(false);
  });

  it('returns true for auto-approve-with-toast', () => {
    const decision = classifyUpdateDiff(
      diffPermissions([], ['ui.command.register', 'ui.toolbar.register']),
    );
    expect(decision.kind).toBe('auto-approve-with-toast');
    expect(shouldShowUpdateDiffDialog(decision)).toBe(true);
  });

  it('returns true for requires-consent', () => {
    const decision = classifyUpdateDiff(
      diffPermissions([], ['http.fetch']),
    );
    expect(decision.kind).toBe('requires-consent');
    expect(shouldShowUpdateDiffDialog(decision)).toBe(true);
  });
});

describe('decisionNeedsScrollGate', () => {
  it('only requires-consent gates the Update button', () => {
    const auto = classifyUpdateDiff({ added: [], removed: [] });
    const toast = classifyUpdateDiff({
      added: ['ui.command.register'],
      removed: [],
    });
    const consent = classifyUpdateDiff({ added: ['http.fetch'], removed: [] });
    expect(decisionNeedsScrollGate(auto)).toBe(false);
    expect(decisionNeedsScrollGate(toast)).toBe(false);
    expect(decisionNeedsScrollGate(consent)).toBe(true);
  });
});

// ── auto-approve mode ───────────────────────────────────────────────────

describe('PluginUpdateDiffDialog — auto-approve (defensive render)', () => {
  it('shows the no-changes notice and enables Update immediately', () => {
    render({
      decision: { kind: 'auto-approve' },
    });
    expect(container.textContent).toMatch(/does not request any new permissions/i);
    expect(btn('plugin-update-confirm').disabled).toBe(false);
  });
});

// ── auto-approve-with-toast mode ────────────────────────────────────────

describe('PluginUpdateDiffDialog — auto-approve-with-toast', () => {
  it('renders an informational toast for added Low permissions', () => {
    const decision = classifyUpdateDiff(
      diffPermissions([], ['ui.command.register', 'ui.toolbar.register']),
    );
    render({ decision });
    expect(container.textContent).toMatch(/2 new low-risk features/i);
    expect(container.textContent).toMatch(/ui\.command\.register/);
    expect(container.textContent).toMatch(/ui\.toolbar\.register/);
    // No scroll gate.
    expect(btn('plugin-update-confirm').disabled).toBe(false);
    // No "New permissions requested" header (that's reserved for requires-consent).
    expect(container.textContent).not.toMatch(/New permissions requested/);
  });

  it('uses the singular form when exactly one permission was added', () => {
    const decision = classifyUpdateDiff(
      diffPermissions([], ['ui.command.register']),
    );
    render({ decision });
    expect(container.textContent).toMatch(/1 new low-risk feature\b/i);
    expect(container.textContent).not.toMatch(/low-risk features\b/i);
  });
});

// ── requires-consent mode ───────────────────────────────────────────────

describe('PluginUpdateDiffDialog — requires-consent', () => {
  it('renders the New permissions header and gates the Update button', () => {
    const decision = classifyUpdateDiff(
      diffPermissions(['ui.command.register'], [
        'ui.command.register',
        'http.fetch',
        'storage.user.write',
      ]),
    );
    render({ decision });
    expect(container.textContent).toMatch(/New permissions requested/);
    expect(container.textContent).toMatch(/High/);
    expect(container.textContent).toMatch(/Medium/);
    expect(container.textContent).toMatch(/NEW/); // per-row badge
    expect(btn('plugin-update-confirm').disabled).toBe(true);
  });

  it('surfaces the http.allowlist when http.fetch is newly added', () => {
    const decision = classifyUpdateDiff(
      diffPermissions([], ['http.fetch']),
    );
    render({
      decision,
      httpAllowlist: ['https://api.example.com/'],
    });
    const disclose = container.querySelector(
      '[aria-label="Show details"]',
    ) as HTMLButtonElement | null;
    expect(disclose).not.toBeNull();
    act(() => disclose!.click());
    expect(container.textContent).toMatch(/Allowed origins/);
    expect(container.textContent).toMatch(/api\.example\.com/);
  });

  it('renders the unknown-permissions banner defensively', () => {
    const decision = classifyUpdateDiff(
      diffPermissions([], ['totally.fake' as PluginPermission, 'ui.command.register']),
    );
    expect(decision.kind).toBe('requires-consent');
    render({ decision });
    expect(container.textContent).toMatch(/does not recognize/i);
    expect(container.textContent).toMatch(/totally\.fake/);
    expect(btn('plugin-update-confirm').disabled).toBe(true);
  });

  it('summarizes added Low permissions on a separate line', () => {
    const decision = classifyUpdateDiff(
      diffPermissions([], ['http.fetch', 'ui.command.register', 'ui.toolbar.register']),
    );
    render({ decision });
    expect(container.textContent).toMatch(/2 new standard editor features/);
  });
});

// ── removed section ─────────────────────────────────────────────────────

describe('PluginUpdateDiffDialog — removed permissions', () => {
  it('shows a collapsed Permissions removed footer when present', () => {
    // requires-consent decision carries removed info; auto-approve does not.
    const decision = classifyUpdateDiff(
      diffPermissions(['storage.user.write'], ['http.fetch']),
    );
    expect(decision.kind).toBe('requires-consent');
    render({ decision });
    expect(container.textContent).toMatch(/Permissions removed in this update \(1\)/);
    // Collapsed by default — the actual perm name is not visible yet.
    expect(container.textContent).not.toMatch(/Permissions removed[^(]*\(1\)\s*storage\.user\.write/);
  });

  it('expands the removed list on click', () => {
    const decision = classifyUpdateDiff(
      diffPermissions(['storage.user.write'], ['http.fetch']),
    );
    render({ decision });
    const target = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Permissions removed'),
    );
    expect(target).toBeDefined();
    act(() => (target as HTMLButtonElement).click());
    expect(container.textContent).toMatch(/storage\.user\.write/);
  });

  it('hides the removed footer when nothing was removed', () => {
    const decision = classifyUpdateDiff(
      diffPermissions(['ui.command.register'], ['ui.command.register', 'http.fetch']),
    );
    render({ decision });
    expect(container.textContent).not.toMatch(/Permissions removed/);
  });
});

// ── action wiring ───────────────────────────────────────────────────────

describe('PluginUpdateDiffDialog — actions', () => {
  it('Update fires onUpdate when not gated', () => {
    const { update } = render({
      decision: classifyUpdateDiff({ added: ['ui.command.register'], removed: [] }),
    });
    act(() => btn('plugin-update-confirm').click());
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('Skip fires onSkipVersion', () => {
    const { skip } = render({
      decision: classifyUpdateDiff({ added: ['http.fetch'], removed: [] }),
    });
    act(() => btn('plugin-update-skip').click());
    expect(skip).toHaveBeenCalledTimes(1);
  });

  it('Uninstall fires onUninstall', () => {
    const { uninstall } = render({
      decision: classifyUpdateDiff({ added: ['http.fetch'], removed: [] }),
    });
    act(() => btn('plugin-update-uninstall').click());
    expect(uninstall).toHaveBeenCalledTimes(1);
  });

  it('Cancel fires onCancel', () => {
    const { cancel } = render({
      decision: classifyUpdateDiff({ added: ['http.fetch'], removed: [] }),
    });
    act(() => btn('plugin-update-cancel').click());
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('Escape fires onCancel', () => {
    const { cancel } = render({
      decision: classifyUpdateDiff({ added: ['http.fetch'], removed: [] }),
    });
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(cancel).toHaveBeenCalled();
  });

  it('Update is blocked while scroll gate is active', () => {
    const { update } = render({
      decision: classifyUpdateDiff({ added: ['http.fetch'], removed: [] }),
    });
    expect(btn('plugin-update-confirm').disabled).toBe(true);
    act(() => btn('plugin-update-confirm').click());
    expect(update).not.toHaveBeenCalled();
  });
});
