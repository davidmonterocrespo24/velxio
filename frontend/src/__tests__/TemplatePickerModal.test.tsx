// @vitest-environment jsdom
/**
 * <TemplatePickerModal /> contract tests (SDK-004b).
 *
 * Verifies the template picker reads from the host TemplateRegistry,
 * surfaces the empty state when nothing is registered, and on
 * instantiation drives the editor + simulator stores. Wires fall back
 * to (0, 0) here because jsdom doesn't render wokwi-elements custom
 * elements — `calculatePinPosition()` returns null in that case, which
 * is the production fallback path and worth pinning.
 */
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

import type { TemplateDefinition } from '@velxio/sdk';

import { TemplatePickerModal } from '../components/layout/TemplatePickerModal';
import {
  getTemplateRegistry,
  resetTemplateRegistryForTests,
} from '../plugin-host/TemplateRegistry';
import { useEditorStore } from '../store/useEditorStore';
import { useSimulatorStore } from '../store/useSimulatorStore';

let container: HTMLElement;
let root: Root;
let closed: boolean;

beforeEach(() => {
  resetTemplateRegistryForTests();
  // Reset relevant store slices so each test starts with a clean canvas.
  useSimulatorStore.setState({ components: [], wires: [] });
  closed = false;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(): void {
  act(() => {
    root.render(<TemplatePickerModal onClose={() => { closed = true; }} />);
  });
}

function buildTemplate(overrides: Partial<TemplateDefinition> = {}): TemplateDefinition {
  return {
    id: 'demo.blink',
    name: 'Blink demo',
    description: 'Toggle the on-board LED.',
    category: 'beginner',
    difficulty: 1,
    snapshot: {
      schemaVersion: 1,
      board: 'arduino-uno',
      files: [{ name: 'sketch.ino', content: 'void setup(){}\nvoid loop(){}' }],
      components: [
        { id: 'comp1', metadataId: 'wokwi-led', x: 10, y: 20 },
      ],
      wires: [
        {
          id: 'wire1',
          start: { componentId: 'comp1', pinName: 'A' },
          end: { componentId: 'comp1', pinName: 'C' },
          color: '#ff0000',
        },
      ],
    },
    ...overrides,
  };
}

async function flushFrames(): Promise<void> {
  // The modal awaits two `requestAnimationFrame` ticks before reading
  // pin coordinates. jsdom polyfills rAF as a ~16 ms timeout, so wait
  // generously (50 ms covers two paints with margin) and yield the
  // microtask queue afterwards so the React commit lands before the
  // assertions run.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
}

describe('<TemplatePickerModal />', () => {
  it('shows the empty state when no templates are registered', () => {
    render();
    expect(container.querySelector('[data-testid="template-empty-state"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="template-list"]')).toBeNull();
  });

  it('renders one row per registered template, grouped by category', () => {
    getTemplateRegistry().registerFromPlugin(buildTemplate({ id: 'a', name: 'Alpha', category: 'beginner' }), 'p1');
    getTemplateRegistry().registerFromPlugin(buildTemplate({ id: 'b', name: 'Beta', category: 'advanced' }), 'p1');
    render();
    expect(container.querySelector('[data-testid="template-list-item-a"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="template-list-item-b"]')).not.toBeNull();
    // Categories sorted alphabetically by id (advanced before beginner).
    const headers = Array.from(container.querySelectorAll('h3')).map((h) => h.textContent);
    expect(headers).toEqual(['Advanced', 'Beginner']);
  });

  it('previews the first template by default', () => {
    getTemplateRegistry().registerFromPlugin(buildTemplate({ id: 'a', name: 'Alpha' }), 'p1');
    render();
    expect(container.querySelector('[data-testid="template-preview-a"]')).not.toBeNull();
  });

  it('switches preview when a different list item is clicked', () => {
    getTemplateRegistry().registerFromPlugin(buildTemplate({ id: 'a', name: 'Alpha' }), 'p1');
    getTemplateRegistry().registerFromPlugin(buildTemplate({ id: 'b', name: 'Beta' }), 'p1');
    render();
    const item = container.querySelector('[data-testid="template-list-item-b"]') as HTMLButtonElement;
    act(() => { item.click(); });
    expect(container.querySelector('[data-testid="template-preview-b"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="template-preview-a"]')).toBeNull();
  });

  it('drives loadFiles + setComponents + setWires when instantiated', async () => {
    getTemplateRegistry().registerFromPlugin(buildTemplate(), 'p1');
    render();
    const btn = container.querySelector('[data-testid="template-instantiate-btn"]') as HTMLButtonElement;
    act(() => { btn.click(); });
    await flushFrames();

    const editorFiles = useEditorStore.getState().files.map((f) => f.name);
    expect(editorFiles).toContain('sketch.ino');

    const components = useSimulatorStore.getState().components;
    expect(components).toHaveLength(1);
    expect(components[0]).toMatchObject({ id: 'comp1', metadataId: 'wokwi-led', x: 10, y: 20 });

    const wires = useSimulatorStore.getState().wires;
    expect(wires).toHaveLength(1);
    expect(wires[0]).toMatchObject({
      id: 'wire1',
      color: '#ff0000',
      start: { componentId: 'comp1', pinName: 'A', x: 0, y: 0 },
      end: { componentId: 'comp1', pinName: 'C', x: 0, y: 0 },
      waypoints: [],
    });

    // Modal closes on success.
    expect(closed).toBe(true);
  });

  it('copies properties as an independent object (no aliasing into snapshot)', async () => {
    const template = buildTemplate();
    template.snapshot.components[0] = {
      ...template.snapshot.components[0],
      properties: { color: 'red' },
    };
    getTemplateRegistry().registerFromPlugin(template, 'p1');
    render();
    const btn = container.querySelector('[data-testid="template-instantiate-btn"]') as HTMLButtonElement;
    act(() => { btn.click(); });
    await flushFrames();

    const live = useSimulatorStore.getState().components[0];
    // Mutating the live store must not bleed into the template definition.
    live.properties.color = 'blue';
    expect((template.snapshot.components[0].properties as Record<string, string>).color).toBe('red');
  });
});
