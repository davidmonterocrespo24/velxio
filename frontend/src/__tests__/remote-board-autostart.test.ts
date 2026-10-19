/**
 * The canvas starts each remote board once per simulation session.
 *
 * Production, 2026-09: a Raspberry Pi whose script finished in ~200 ms was
 * restarted by the canvas about five times a second for as long as another
 * board kept the simulation running (sessions of 5,964 and 8,664 runs). A
 * script that ends on a real Pi stays ended.
 */
import { describe, it, expect } from 'vitest';

import { remoteBoardActions } from '../simulation/remoteBoardAutostart';

describe('remoteBoardActions', () => {
  it('starts every stopped remote board when the simulation starts', () => {
    const started = new Set<string>();
    expect(remoteBoardActions(true, [{ id: 'pi', running: false }, { id: 'esp', running: false }], started))
      .toEqual({ start: ['pi', 'esp'], stop: [] });
  });

  it('does not restart a board whose own run ended while the simulation runs', () => {
    const started = new Set<string>();
    remoteBoardActions(true, [{ id: 'pi', running: false }], started);
    // the store flipped it to running, then the script finished
    remoteBoardActions(true, [{ id: 'pi', running: true }], started);
    for (let i = 0; i < 50; i++) {
      expect(remoteBoardActions(true, [{ id: 'pi', running: false }], started)).toEqual({ start: [], stop: [] });
    }
  });

  it('does not restart a board the toolbar started, once it finishes', () => {
    const started = new Set<string>();
    remoteBoardActions(true, [{ id: 'pi', running: true }], started);
    expect(remoteBoardActions(true, [{ id: 'pi', running: false }], started).start).toEqual([]);
  });

  it('starts a board added while the simulation runs, once', () => {
    const started = new Set<string>();
    remoteBoardActions(true, [{ id: 'pi', running: true }], started);
    expect(remoteBoardActions(true, [{ id: 'pi', running: true }, { id: 'pi2', running: false }], started).start)
      .toEqual(['pi2']);
    expect(remoteBoardActions(true, [{ id: 'pi', running: true }, { id: 'pi2', running: false }], started).start)
      .toEqual([]);
  });

  it('stops the running boards when the simulation stops, and the next Run starts them again', () => {
    const started = new Set<string>();
    remoteBoardActions(true, [{ id: 'pi', running: false }], started);
    expect(remoteBoardActions(false, [{ id: 'pi', running: true }], started)).toEqual({ start: [], stop: ['pi'] });
    expect(remoteBoardActions(true, [{ id: 'pi', running: false }], started).start).toEqual(['pi']);
  });
});
