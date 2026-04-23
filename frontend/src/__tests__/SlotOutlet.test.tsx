// @vitest-environment jsdom
/**
 * SlotOutlet + HostSlotRegistry contract tests.
 *
 * Two layers under test:
 *   1. `HostSlotRegistry` — pure data aggregator. Exercise without React.
 *   2. `<SlotOutlet />` — React surface. Exercise with `react-dom/client`
 *      directly (no `@testing-library/react` in this repo) and inspect the
 *      DOM that lands.
 *
 * The renderer-correctness criterion the task lists is:
 *   "1000 ticks unrelated to the slot must NOT cause re-renders".
 * We model that with a `renderCount` ref incremented inside the renderer
 * function, and verify it does not move when other slots mutate.
 */
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';

// React's `act` checks this flag on globalThis to know it's running in a
// test environment. Without it, every act(...) call logs a warning.
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
import type {
  CommandDefinition,
  EventBusReader,
  PluginManifest,
  PluginPermission,
  ToolbarItemDefinition,
} from '@velxio/sdk';

import {
  __resetHostSlotRegistry,
  getHostSlotRegistry,
} from '../plugin-host/HostSlotRegistry';
import { ALL_SLOT_IDS, SLOT_ROUTING, type SlotId } from '../plugin-host/SlotIds';
import { createPluginContext } from '../plugin-host/createPluginContext';
import { SlotOutlet } from '../components/plugin-host/SlotOutlet';

const fakeEvents: EventBusReader = {
  on: () => () => {},
  hasListeners: () => false,
  listenerCount: () => 0,
};

function manifest(
  id: string,
  perms: PluginPermission[] = [],
): PluginManifest {
  return {
    schemaVersion: 1,
    id,
    name: id,
    version: '1.0.0',
    publisher: { name: 'Tester' },
    description: 'slot outlet test plugin',
    icon: 'https://example.com/icon.svg',
    license: 'MIT',
    category: 'utility',
    tags: [],
    type: ['ui-extension'],
    entry: { module: 'index.js' },
    permissions: perms,
    pricing: { model: 'free' },
    refundPolicy: 'none',
  } as PluginManifest;
}

beforeEach(() => {
  __resetHostSlotRegistry();
});

// ── 1. SlotIds wholeness ──────────────────────────────────────────────────

describe('SlotIds', () => {
  it('every slot id has a routing entry', () => {
    for (const slotId of ALL_SLOT_IDS) {
      expect(SLOT_ROUTING).toHaveProperty(slotId);
    }
  });

  it('every routing entry maps to a known registry source', () => {
    const known = new Set([
      'commands',
      'toolbar',
      'panels',
      'statusBar',
      'editorActions',
      'canvasOverlays',
      'contextMenu',
    ]);
    for (const slotId of ALL_SLOT_IDS) {
      expect(known.has(SLOT_ROUTING[slotId].source)).toBe(true);
    }
  });
});

// ── 2. HostSlotRegistry aggregation ───────────────────────────────────────

describe('HostSlotRegistry · aggregation', () => {
  it('starts empty for every slot', () => {
    const reg = getHostSlotRegistry();
    for (const slotId of ALL_SLOT_IDS) {
      expect(reg.getEntries(slotId)).toEqual([]);
    }
  });

  it('routes a registered command into the command-palette slot', () => {
    const reg = getHostSlotRegistry();
    const { context } = createPluginContext(
      manifest('p.alpha', ['ui.command.register']),
      { events: fakeEvents },
    );
    context.commands.register({ id: 'cmd.greet', title: 'Greet', run: () => {} });

    const entries = reg.getEntries('command-palette');
    expect(entries).toHaveLength(1);
    expect(entries[0].pluginId).toBe('p.alpha');
    expect((entries[0].item as CommandDefinition).id).toBe('cmd.greet');
  });

  it('routes toolbar items by position into separate slots', () => {
    const reg = getHostSlotRegistry();
    const { context } = createPluginContext(
      manifest('p.beta', ['ui.toolbar.register']),
      { events: fakeEvents },
    );
    context.toolbar.register({
      id: 't.left',
      commandId: 'cmd.x',
      label: 'L',
      position: 'left',
    });
    context.toolbar.register({
      id: 't.center',
      commandId: 'cmd.y',
      label: 'C',
      position: 'center',
    });
    context.toolbar.register({
      id: 't.right',
      commandId: 'cmd.z',
      label: 'R',
      position: 'right',
    });

    expect(reg.getEntries('editor.toolbar.left')).toHaveLength(1);
    expect(reg.getEntries('simulator.toolbar')).toHaveLength(1);
    expect(reg.getEntries('editor.toolbar.right')).toHaveLength(1);
  });

  it('disposes a plugin clears every slot it contributed to', () => {
    const reg = getHostSlotRegistry();
    const { context, dispose } = createPluginContext(
      manifest('p.gamma', ['ui.command.register', 'ui.toolbar.register']),
      { events: fakeEvents },
    );
    context.commands.register({ id: 'cmd.a', title: 'A', run: () => {} });
    context.toolbar.register({
      id: 't.a',
      commandId: 'cmd.a',
      label: 'A',
      position: 'left',
    });

    expect(reg.getEntries('command-palette')).toHaveLength(1);
    expect(reg.getEntries('editor.toolbar.left')).toHaveLength(1);

    dispose();

    expect(reg.getEntries('command-palette')).toHaveLength(0);
    expect(reg.getEntries('editor.toolbar.left')).toHaveLength(0);
  });

  it('disposing one item leaves siblings from the same plugin in place', () => {
    const reg = getHostSlotRegistry();
    const { context } = createPluginContext(
      manifest('p.delta', ['ui.command.register']),
      { events: fakeEvents },
    );
    const a = context.commands.register({ id: 'cmd.a', title: 'A', run: () => {} });
    context.commands.register({ id: 'cmd.b', title: 'B', run: () => {} });

    expect(reg.getEntries('command-palette')).toHaveLength(2);
    a.dispose();

    const remaining = reg.getEntries('command-palette');
    expect(remaining).toHaveLength(1);
    expect((remaining[0].item as CommandDefinition).id).toBe('cmd.b');
  });

  it('two plugins contributing to the same slot show up side by side', () => {
    const reg = getHostSlotRegistry();
    const a = createPluginContext(
      manifest('p.first', ['ui.command.register']),
      { events: fakeEvents },
    );
    const b = createPluginContext(
      manifest('p.second', ['ui.command.register']),
      { events: fakeEvents },
    );
    a.context.commands.register({ id: 'cmd.x', title: 'A.x', run: () => {} });
    b.context.commands.register({ id: 'cmd.x', title: 'B.x', run: () => {} });

    const entries = reg.getEntries('command-palette');
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.pluginId).sort()).toEqual(['p.first', 'p.second']);
  });

  it('returns the same array reference until something changes', () => {
    const reg = getHostSlotRegistry();
    const before = reg.getEntries('command-palette');
    const again = reg.getEntries('command-palette');
    expect(again).toBe(before); // identity stability for useSyncExternalStore

    const { context } = createPluginContext(
      manifest('p.cache', ['ui.command.register']),
      { events: fakeEvents },
    );
    context.commands.register({ id: 'cmd.cache', title: 'Cache', run: () => {} });

    const after = reg.getEntries('command-palette');
    expect(after).not.toBe(before); // identity changes on mutation
  });

  it('subscribers fire only on changes to their slot', () => {
    const reg = getHostSlotRegistry();
    const cmdSpy = vi.fn();
    const toolbarSpy = vi.fn();
    reg.subscribe('command-palette', cmdSpy);
    reg.subscribe('editor.toolbar.left', toolbarSpy);

    const { context } = createPluginContext(
      manifest('p.fan', ['ui.command.register', 'ui.toolbar.register']),
      { events: fakeEvents },
    );
    context.commands.register({ id: 'cmd.x', title: 'X', run: () => {} });

    expect(cmdSpy).toHaveBeenCalledTimes(1);
    expect(toolbarSpy).not.toHaveBeenCalled();

    context.toolbar.register({
      id: 't.left',
      commandId: 'cmd.x',
      label: 'L',
      position: 'left',
    });
    expect(cmdSpy).toHaveBeenCalledTimes(1); // unchanged
    expect(toolbarSpy).toHaveBeenCalledTimes(1);
  });

  it('a faulting subscriber does not break siblings', () => {
    const reg = getHostSlotRegistry();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const good = vi.fn();
    reg.subscribe('command-palette', () => {
      throw new Error('boom');
    });
    reg.subscribe('command-palette', good);

    const { context } = createPluginContext(
      manifest('p.boom', ['ui.command.register']),
      { events: fakeEvents },
    );
    context.commands.register({ id: 'cmd.x', title: 'X', run: () => {} });

    expect(good).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
  });
});

// ── 3. <SlotOutlet /> rendering ───────────────────────────────────────────

describe('<SlotOutlet />', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('renders the fallback when the slot is empty', () => {
    act(() => {
      root.render(
        <SlotOutlet slot="command-palette" fallback={<span data-testid="empty">EMPTY</span>}>
          {(entry) => <span>{(entry.item as CommandDefinition).title}</span>}
        </SlotOutlet>,
      );
    });
    expect(container.querySelector('[data-testid="empty"]')).not.toBeNull();
  });

  it('renders a registered item and updates on dispose', () => {
    const { context } = createPluginContext(
      manifest('p.outlet', ['ui.command.register']),
      { events: fakeEvents },
    );
    const handle = context.commands.register({
      id: 'cmd.hi',
      title: 'Hi',
      run: () => {},
    });

    act(() => {
      root.render(
        <SlotOutlet slot="command-palette">
          {(entry) => (
            <span data-testid="cmd">{(entry.item as CommandDefinition).title}</span>
          )}
        </SlotOutlet>,
      );
    });

    expect(container.querySelector('[data-testid="cmd"]')?.textContent).toBe('Hi');

    act(() => {
      handle.dispose();
    });

    expect(container.querySelector('[data-testid="cmd"]')).toBeNull();
  });

  it('does not re-render when an unrelated slot changes', () => {
    const renders = { count: 0 };
    const renderFn = (entry: { item: unknown }) => {
      renders.count += 1;
      const item = entry.item as CommandDefinition;
      return <span key={item.id}>{item.title}</span>;
    };

    const { context } = createPluginContext(
      manifest('p.noise', ['ui.command.register', 'ui.toolbar.register']),
      { events: fakeEvents },
    );
    context.commands.register({ id: 'cmd.fixed', title: 'Fixed', run: () => {} });

    act(() => {
      root.render(
        <SlotOutlet slot="command-palette">{renderFn}</SlotOutlet>,
      );
    });
    const initialRenders = renders.count;
    expect(initialRenders).toBeGreaterThan(0);

    // Touch an unrelated slot 1000 times — toolbar registrations don't
    // belong to `command-palette`, so the outlet's snapshot identity must
    // not change and the render fn should not be called again.
    act(() => {
      for (let i = 0; i < 1000; i++) {
        const handle = context.toolbar.register({
          id: `t.${i}`,
          commandId: 'cmd.fixed',
          label: 'L',
          position: 'left',
        });
        handle.dispose();
      }
    });

    expect(renders.count).toBe(initialRenders);
  });

  it('a panel with dock=right lands in editor.panel.right not editor.panel.left', () => {
    const { context } = createPluginContext(
      manifest('p.panel', ['ui.panel.register']),
      { events: fakeEvents },
    );
    context.panels.register({
      id: 'panel.x',
      title: 'X',
      dock: 'right',
      mount: () => () => {},
    });

    act(() => {
      root.render(
        <>
          <div data-testid="left">
            <SlotOutlet slot="editor.panel.left">
              {(entry) => <span>{(entry.item as { title: string }).title}</span>}
            </SlotOutlet>
          </div>
          <div data-testid="right">
            <SlotOutlet slot="editor.panel.right">
              {(entry) => (
                <span data-testid="panel">
                  {(entry.item as { title: string }).title}
                </span>
              )}
            </SlotOutlet>
          </div>
        </>,
      );
    });

    expect(container.querySelector('[data-testid="left"]')?.textContent).toBe('');
    expect(container.querySelector('[data-testid="panel"]')?.textContent).toBe('X');
  });

  it('routes a command across plugins so the palette sees both', () => {
    const a = createPluginContext(
      manifest('p.one', ['ui.command.register']),
      { events: fakeEvents },
    );
    const b = createPluginContext(
      manifest('p.two', ['ui.command.register']),
      { events: fakeEvents },
    );
    a.context.commands.register({ id: 'a.cmd', title: 'A', run: () => {} });
    b.context.commands.register({ id: 'b.cmd', title: 'B', run: () => {} });

    act(() => {
      root.render(
        <SlotOutlet slot="command-palette">
          {(entry) => {
            const item = entry.item as CommandDefinition;
            return (
              <span data-testid={`cmd-${entry.pluginId}`}>{item.title}</span>
            );
          }}
        </SlotOutlet>,
      );
    });

    expect(container.querySelector('[data-testid="cmd-p.one"]')?.textContent).toBe('A');
    expect(container.querySelector('[data-testid="cmd-p.two"]')?.textContent).toBe('B');
  });
});

// ── 4. Slot churn under load ──────────────────────────────────────────────

describe('HostSlotRegistry · churn', () => {
  it('register+dispose cycles do not leak entries', () => {
    const reg = getHostSlotRegistry();
    const { context } = createPluginContext(
      manifest('p.churn', ['ui.toolbar.register']),
      { events: fakeEvents },
    );

    const ITERS = 500;
    for (let i = 0; i < ITERS; i++) {
      const item: ToolbarItemDefinition = {
        id: `t.${i}`,
        commandId: 'cmd',
        label: 'X',
        position: 'left',
      };
      const h = context.toolbar.register(item);
      h.dispose();
    }
    expect(reg.getEntries('editor.toolbar.left')).toHaveLength(0);
  });

  it('subscribing to an unknown slot id throws', () => {
    const reg = getHostSlotRegistry();
    expect(() => reg.subscribe('not.a.real.slot' as SlotId, () => {})).toThrow();
  });
});
