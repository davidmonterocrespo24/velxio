/**
 * A board whose engine sits behind a bridge (an ESP32: its shim's
 * getCurrentCycles() stays -1, parts tell an AVR from an ESP32 by it) offers
 * its cycle clock to the interconnect apart, through the shim's linkClock()
 * (velxio/velxio-prod#74). The interconnect's timed delivery (#397) then
 * works with it as with an AVR: its edges reach a timed board at their
 * spacing, a timed board's edges reach it at theirs, a clock that runs behind
 * its guest (`deferred`: an engine in a worker) has every edge scheduled, the
 * first one too, and a bridge that offers none (the QEMU bridge, the default)
 * keeps the immediate write in both directions. A burst starts
 * LINK_ANCHOR_AHEAD_S into the receiver's future (#74's bound on #397's
 * anchor, interconnect-link-anchor.test.ts), so no edge to a clock is written
 * at once any more.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { PinManager } from '../simulation/PinManager';
import {
  LINK_ANCHOR_AHEAD_S,
  bindBoard,
  resetInterconnect,
  setInterconnectRuntime,
  updateWires,
} from '../simulation/Interconnect';
import { Esp32BridgeShim } from '../store/useSimulatorStore';
import type { Wire } from '../types/wire';

/** A board in the tab with a cycle clock, as the AVR is one (16 MHz). */
class TimedBoard {
  cycles = 0;
  readonly pm = new PinManager();
  readonly scheduled: Array<[number, boolean, number]> = [];
  readonly written: Array<[number, boolean, number]> = [];
  getCurrentCycles(): number {
    return this.cycles;
  }
  getClockHz(): number {
    return 16_000_000;
  }
  schedulePinChange(pin: number, state: boolean, atCycle: number): void {
    this.scheduled.push([pin, state, atCycle]);
  }
  setPinState(pin: number, state: boolean): void {
    this.written.push([pin, state, this.cycles]);
  }
}

/** An ESP32's bridge as the interconnect and the shim reach it, with an engine clock (240 MHz) behind linkClock, or none. */
function espBoard(id: string, clock: { cycles: number; deferred: boolean } | null) {
  const sent: Array<[number, boolean]> = [];
  const scheduled: Array<[number, boolean, number]> = [];
  const bridge = {
    boardId: id,
    boardKind: 'esp32',
    onPinChange: null as ((pin: number, state: boolean) => void) | null,
    sendPinEvent: (pin: number, state: boolean) => sent.push([pin, state]),
    sendSerialBytes: () => {},
    ...(clock
      ? {
          linkClock: () => ({
            getCurrentCycles: () => clock.cycles,
            getClockHz: () => 240_000_000,
            schedulePinChange: (pin: number, state: boolean, at: number) => scheduled.push([pin, state, at]),
            deferred: clock.deferred,
          }),
        }
      : {}),
  };
  const pm = new PinManager();
  const shim = new Esp32BridgeShim(bridge as never, pm);
  return { id, bridge, shim, pm, sent, scheduled };
}

function wire(id: string, a: [string, string], b: [string, string]): Wire {
  return {
    id,
    start: { componentId: a[0], pinName: a[1], x: 0, y: 0 },
    end: { componentId: b[0], pinName: b[1], x: 0, y: 0 },
    color: '#000',
  } as unknown as Wire;
}

function link(esp: ReturnType<typeof espBoard>, uno: TimedBoard, espPin: string, unoPin: string): void {
  resetInterconnect();
  setInterconnectRuntime({
    getBoardSimulator: (id) => (id === esp.id ? esp.shim : uno),
    getBoardPinManager: (id) => (id === esp.id ? esp.pm : uno.pm),
    getBoardBridge: () => undefined,
    getEsp32Bridge: (id) => (id === esp.id ? esp.bridge : undefined),
    getStm32Bridge: () => undefined,
  });
  bindBoard(esp.id, 'esp32');
  bindBoard('uno', 'arduino-uno');
  updateWires([wire('w', [esp.id, espPin], ['uno', unoPin])]);
}

const US_ESP = 240; // cycles per microsecond
const US_UNO = 16;
/** Where a burst's first edge lands, ahead of the receiver's present, in its cycles. */
const AHEAD_ESP = LINK_ANCHOR_AHEAD_S * 240_000_000;
const AHEAD_UNO = LINK_ANCHOR_AHEAD_S * 16_000_000;

afterEach(() => resetInterconnect());

describe('an ESP32 end of a wire between boards, through its shim’s linkClock (#74)', () => {
  it('its edges reach a timed board at their spacing in the ESP32’s guest time', () => {
    const clock = { cycles: 1_000, deferred: false };
    const esp = espBoard('esp', clock);
    const uno = new TimedBoard();
    uno.cycles = 5_000;
    link(esp, uno, '4', '10');
    // A start bit, then two bits 104 us apart, inside one burst of the ESP32.
    for (const [us, level] of [[0, false], [104, true], [208, false]] as const) {
      clock.cycles = 1_000 + us * US_ESP;
      esp.bridge.onPinChange!(4, level);
    }
    // The first lands a burst's anchor ahead of the Uno's present, the others after it at the same spacing.
    expect(uno.written).toEqual([]);
    expect(uno.scheduled).toEqual([
      [10, false, 5_000 + AHEAD_UNO],
      [10, true, 5_000 + AHEAD_UNO + 104 * US_UNO],
      [10, false, 5_000 + AHEAD_UNO + 208 * US_UNO],
    ]);
  });

  it('a timed board’s edges reach it at their spacing, scheduled on its engine', () => {
    const clock = { cycles: 2_400, deferred: false };
    const esp = espBoard('esp', clock);
    const uno = new TimedBoard();
    link(esp, uno, '5', '11');
    for (const [us, level] of [[0, false], [104, true], [520, false]] as const) {
      uno.cycles = 8_000 + us * US_UNO;
      uno.pm.triggerPinChange(11, level, 'mcu');
    }
    expect(esp.sent).toEqual([]);
    expect(esp.scheduled).toEqual([
      [5, false, 2_400 + AHEAD_ESP],
      [5, true, 2_400 + AHEAD_ESP + 104 * US_ESP],
      [5, false, 2_400 + AHEAD_ESP + 520 * US_ESP],
    ]);
  });

  it('a clock that runs behind its guest (an engine in a worker) has every edge scheduled, the first too', () => {
    const clock = { cycles: 2_400, deferred: true };
    const esp = espBoard('esp', clock);
    const uno = new TimedBoard();
    link(esp, uno, '5', '11');
    for (const [us, level] of [[0, false], [104, true]] as const) {
      uno.cycles = 8_000 + us * US_UNO;
      uno.pm.triggerPinChange(11, level, 'mcu');
    }
    expect(esp.sent).toEqual([]);
    expect(esp.scheduled).toEqual([
      [5, false, 2_400 + AHEAD_ESP],
      [5, true, 2_400 + AHEAD_ESP + 104 * US_ESP],
    ]);
  });

  it('a bridge with no clock to offer (the QEMU bridge) keeps the immediate write, both ways', () => {
    const esp = espBoard('esp', null);
    const uno = new TimedBoard();
    link(esp, uno, '4', '10');
    esp.bridge.onPinChange!(4, false);
    esp.bridge.onPinChange!(4, true);
    expect(uno.written.map(([p, s]) => [p, s])).toEqual([
      [10, false],
      [10, true],
    ]);
    expect(uno.scheduled).toEqual([]);
    link(esp, uno, '5', '11');
    uno.pm.triggerPinChange(11, false, 'mcu');
    uno.cycles += 104 * US_UNO;
    uno.pm.triggerPinChange(11, true, 'mcu');
    expect(esp.sent).toEqual([
      [5, false],
      [5, true],
    ]);
  });

  it('the shim keeps answering getCurrentCycles() -1, whatever its bridge offers', () => {
    expect(espBoard('a', { cycles: 99, deferred: false }).shim.getCurrentCycles()).toBe(-1);
    expect(espBoard('b', null).shim.linkClock()).toBeNull();
  });
});
