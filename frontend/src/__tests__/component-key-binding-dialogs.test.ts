// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { ComponentPropertyDialog } from '../components/simulator/ComponentPropertyDialog';
import { PartInspectorDialog } from '../components/simulator/PartInspectorDialog';
import { useSimulatorStore } from '../store/useSimulatorStore';
import type { ComponentMetadata } from '../types/component-metadata';

const metadata: ComponentMetadata = {
  id: 'pushbutton',
  tagName: 'test-binding-button',
  name: 'Pushbutton',
  category: 'input',
  thumbnail: '',
  properties: [],
  defaultValues: {},
  pinCount: 0,
  tags: [],
};

describe.each([
  { name: 'component properties', Dialog: ComponentPropertyDialog, field: '.property-edit-section' },
  { name: 'part inspector', Dialog: PartInspectorDialog, field: '.pid-keybind' },
])('$name key binding', ({ Dialog, field }) => {
  it('assigns and clears keys, and cancels capture without closing the dialog', () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.body.appendChild(document.createElement('div'));
    const root = createRoot(host);
    const originalComponents = useSimulatorStore.getState().components;
    const onClose = vi.fn();
    const onPropertyChange = vi.fn();
    const render = (componentId: string, key: string) => {
      const props = {
        componentId,
        componentMetadata: metadata,
        componentProperties: { key },
        position: { x: 0, y: 0 },
        pinInfo: [],
        onClose,
        onDelete: vi.fn(),
        onRotate: vi.fn(),
        onPropertyChange,
      };
      const dialog =
        Dialog === ComponentPropertyDialog
          ? createElement(ComponentPropertyDialog, props)
          : createElement(PartInspectorDialog, props);
      act(() => root.render(dialog));
    };
    const button = (className: string) =>
      document.querySelector<HTMLButtonElement>(`${field} .${className}`)!;
    const press = (key: string) => {
      const event = new KeyboardEvent('keydown', { key, cancelable: true, bubbles: true });
      act(() => {
        document.body.dispatchEvent(event);
      });
      return event.defaultPrevented;
    };

    try {
      useSimulatorStore.setState({
        components: [
          { id: 'other', metadataId: 'pushbutton-6mm', x: 0, y: 0, properties: { key: 'A' } },
        ],
      });
      render('first', '');
      expect(button('keybind-chip').classList.contains('keybind-chip--empty')).toBe(true);
      act(() => button('keybind-chip').click());
      expect(press('Shift')).toBe(true);
      expect(button('keybind-chip').classList.contains('keybind-chip--capturing')).toBe(true);
      expect(press('Escape')).toBe(true);
      expect(onClose).not.toHaveBeenCalled();
      expect(onPropertyChange).not.toHaveBeenCalled();

      act(() => button('keybind-chip').click());
      expect(press('A')).toBe(true);
      expect(onPropertyChange).toHaveBeenLastCalledWith('first', 'key', 'a');
      render('first', 'a');
      expect(button('keybind-chip').textContent).toBe('A');
      expect(document.querySelector(`${field} .keybind-hint`)).not.toBeNull();
      act(() => button('keybind-clear').click());
      expect(onPropertyChange).toHaveBeenLastCalledWith('first', 'key', '');

      act(() => button('keybind-chip').click());
      render('other', 'A');
      expect(press('b')).toBe(false);
      expect(onPropertyChange).toHaveBeenCalledTimes(2);
      expect(document.querySelector(`${field} .keybind-hint`)).toBeNull();
    } finally {
      act(() => root.unmount());
      host.remove();
      useSimulatorStore.setState({ components: originalComponents });
      vi.unstubAllGlobals();
    }
  });
});
