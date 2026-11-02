// @vitest-environment jsdom
/**
 * The serial monitor renders a board's output through serialMonitorText
 * (store/serialMonitorText.ts): the whole output without a hook, and what an
 * installed hook returns, which is how the pro overlay bounds what a long
 * session re-renders on every flush (velxio/velxio-prod#19).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useSimulatorStore } from '../store/useSimulatorStore';
import { SerialMonitor } from '../components/simulator/SerialMonitor';
import { installSerialMonitorText, serialMonitorText } from '../store/serialMonitorText';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('the serial monitor renders serialMonitorText', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    const id = useSimulatorStore.getState().boards[0]!.id;
    useSimulatorStore.setState((s) => ({
      activeBoardId: id,
      boards: s.boards.map((b) => (b.id === id ? { ...b, serialOutput: 'first line\nsecond line\n' } : b)),
    }));
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    installSerialMonitorText(null);
  });

  const shown = () => host.querySelector('pre')?.textContent ?? null;

  it('shows the whole output without a hook', async () => {
    await act(async () => root.render(createElement(SerialMonitor)));
    expect(shown()).toBe('first line\nsecond line\n');
  });

  it('shows what an installed hook returns for the board', async () => {
    const asked: string[] = [];
    installSerialMonitorText((board) => {
      asked.push(board.id);
      return board.serialOutput.split('\n')[1] + '\n';
    });
    await act(async () => root.render(createElement(SerialMonitor)));
    expect(shown()).toBe('second line\n');
    expect(asked).toContain(useSimulatorStore.getState().boards[0]!.id);
  });

  it('shows the whole output when the hook throws', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    installSerialMonitorText(() => {
      throw new Error('broken hook');
    });
    expect(serialMonitorText({ id: 'b', serialOutput: 'all of it' })).toBe('all of it');
    warn.mockRestore();
  });
});
