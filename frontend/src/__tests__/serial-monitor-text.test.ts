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
import { SerialMonitor, type SerialMonitorSource } from '../components/simulator/SerialMonitor';
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

  it('keeps hardware and simulation output separate in the shared panel', async () => {
    let input!: ReadableStreamDefaultController<Uint8Array>;
    const requestPort = vi.fn(async () => ({
      open: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      readable: new ReadableStream<Uint8Array>({
        start(controller) { input = controller; },
      }),
      writable: new WritableStream<Uint8Array>(),
    }));
    const previousSerial = Object.getOwnPropertyDescriptor(navigator, 'serial');
    Object.defineProperty(navigator, 'serial', { configurable: true, value: { requestPort } });
    const selectSource = vi.fn();
    const render = (source: SerialMonitorSource) =>
      act(async () => root.render(createElement(SerialMonitor, { source, onSourceChange: selectSource })));
    const button = (label: string) =>
      Array.from(host.querySelectorAll('button')).find((b) => b.textContent === label)!;

    try {
      await render('hardware');
      expect(requestPort).not.toHaveBeenCalled();
      await act(async () => button('editor.serial.hardware.disconnected').click());
      expect(requestPort).toHaveBeenCalledOnce();
      await act(async () => {
        input.enqueue(new TextEncoder().encode('from USB\n'));
        await new Promise(requestAnimationFrame);
        await new Promise(requestAnimationFrame);
      });
      expect(shown()).toBe('from USB\n');

      await act(async () => button('editor.serial.simulation').click());
      expect(selectSource).toHaveBeenCalledWith('simulation');
      await render('simulation');
      expect(shown()).toBe('first line\nsecond line\n');
      await render('hardware');
      expect(shown()).toBe('from USB\n');

      await act(async () => host.querySelector<HTMLButtonElement>('.workspace-panel-clear')!.click());
      await render('simulation');
      expect(shown()).toBe('first line\nsecond line\n');
      await render('hardware');
      expect(shown()).toBe('editor.serial.waitingData');
      await act(async () => button('editor.serial.hardware.connected').click());
    } finally {
      if (previousSerial) Object.defineProperty(navigator, 'serial', previousSerial);
      else Reflect.deleteProperty(navigator, 'serial');
    }
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
