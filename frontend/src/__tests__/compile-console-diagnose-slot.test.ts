// @vitest-environment jsdom
/**
 * The output console offers the overlay's "Diagnose with AI" slot for a
 * compile that failed, and only for one (velxio/velxio-prod#222).
 *
 * The console's log also holds the Circuit check's lines (EditorToolbar's
 * CIRCUIT_CHECK_TARGET: the pre-run findings and the runtime faults), typed
 * 'error' like the compiler's. The slot was mounted for any error line, so a
 * power short or a burnt LED on a build that compiled fine offered to
 * diagnose a compile that did not fail. The agent panel's banner stopped
 * counting those lines in velxio/velxio-prod#21 (c); the console's slot is
 * the same rule. The ✕ badge still counts every error line the console
 * shows, the Circuit check's included.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CompilationConsole } from '../components/editor/CompilationConsole';
import {
  CIRCUIT_CHECK_TARGET_ID,
  compileErrorCount,
  type CompilationLog,
  type CompileTarget,
} from '../utils/compilationLogger';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CIRCUIT: CompileTarget = { id: CIRCUIT_CHECK_TARGET_ID, label: 'Circuit check', kind: 'board' };
const BOARD: CompileTarget = { id: 'esp32', label: 'ESP32 DevKit', kind: 'board' };

const line = (type: CompilationLog['type'], message: string, target?: CompileTarget): CompilationLog => ({
  timestamp: new Date(0),
  type,
  message,
  ...(target ? { target } : {}),
});

const SHORT = line(
  'error',
  "Power is shorted to ground — the 3V3 supply pin of esp32 reaches ground (lcd1's GND pin) through strip 12t of breadboard bb1.",
  CIRCUIT,
);
const BURNT = line('error', 'LED burnt out — nothing limits its current (no series resistor).', CIRCUIT);

describe('the console counts compiler errors for the Diagnose slot', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  const render = async (logs: CompilationLog[]) => {
    await act(async () =>
      root.render(createElement(CompilationConsole, { isOpen: true, onClose: () => {}, logs, onClear: () => {} })),
    );
  };
  const slot = () => host.querySelector('[data-velxio-slot="compile-console-actions"]');
  const badge = () => Array.from(host.querySelectorAll('span')).find((s) => s.textContent?.startsWith('✕ '));

  it('offers no diagnosis for Circuit-check errors on a build that compiled', async () => {
    await render([
      SHORT,
      BURNT,
      line('info', 'Compiling for ESP32 DevKit...', BOARD),
      line('success', '✓ Compilation successful', BOARD),
    ]);
    expect(slot(), 'the Diagnose slot').toBeNull();
    // The console still shows those errors, and its badge still counts them.
    expect(badge()?.textContent).toBe('✕ 2');
  });

  it('offers no diagnosis when the log holds Circuit-check errors alone', async () => {
    await render([SHORT]);
    expect(slot()).toBeNull();
    expect(badge()?.textContent).toBe('✕ 1');
  });

  it('offers it for a compile that failed, Circuit-check lines or not', async () => {
    await render([
      SHORT,
      line('info', 'Compiling for ESP32 DevKit...', BOARD),
      line('error', "sketch.ino:3:1: error: 'foo' was not declared in this scope", BOARD),
      line('error', '✕ Compilation failed', BOARD),
    ]);
    expect(slot()).not.toBeNull();
    expect(badge()?.textContent).toBe('✕ 3');
  });

  it('counts the error lines that are not the Circuit check\'s', () => {
    expect(compileErrorCount([])).toBe(0);
    expect(compileErrorCount([SHORT, BURNT])).toBe(0);
    expect(compileErrorCount([SHORT, line('error', 'x.ino:1:1: error: y', BOARD)])).toBe(1);
    // Narration without a target (a multi-target "Done — 1 failed") is the compile's.
    expect(compileErrorCount([line('error', 'Done — 0 boards ok, 1 failed')])).toBe(1);
    expect(compileErrorCount([line('warning', 'x.ino:1:1: warning: y', BOARD)])).toBe(0);
  });
});
