// @vitest-environment jsdom
/**
 * A pad of an ordinary part as a first-class pin source (chipLikePads).
 *
 * A Grove relay switches its load from screw terminals that nothing inside the
 * brick joins to the signal pin, so a motor wired to a contact used to trace
 * to null and stay dead. registerChipLikePads lets the part claim those pads,
 * and the wire walk then treats them exactly like a custom-chip output pin:
 * one stable synthetic PinManager key shared by the brick's driver and every
 * component on that net.
 *
 * What must not break while it does that: an UNCLAIMED pad of the very same
 * part stays invisible (the seam is opt-in per pad, not per part), and a real
 * board GPIO on the net still wins — rule 1 beats rule 5, or a relay contact
 * that a user also wired to a pin would hide that pin.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Mocks (same shape as pin-trace-boards.test.ts) ──────────────────────────
// addBoard builds a real simulator / bridge per family; none of them is under
// test here, and the AVR and RP2040 ones pull in WASM.
vi.mock('../simulation/AVRSimulator', () => ({
  AVRSimulator: vi.fn(function (this: any) {
    this.onSerialData = null;
    this.onBaudRateChange = null;
    this.onPinChangeWithTime = null;
    this.start = vi.fn();
    this.stop = vi.fn();
    this.reset = vi.fn();
    this.loadHex = vi.fn();
    this.addI2CDevice = vi.fn();
    this.setPinState = vi.fn();
  }),
}));

vi.mock('../simulation/RP2040Simulator', () => ({
  RP2040Simulator: vi.fn(function (this: any) {
    this.onSerialData = null;
    this.onPinChangeWithTime = null;
    this.start = vi.fn();
    this.stop = vi.fn();
    this.reset = vi.fn();
    this.loadBinary = vi.fn();
    this.addI2CDevice = vi.fn();
    this.attachPioPeripheral = vi.fn();
    this.spi = { onByte: null, completeTransfer: vi.fn() };
  }),
}));

vi.mock('../simulation/PinManager', () => ({
  PinManager: vi.fn(function (this: any) {
    this.updatePort = vi.fn();
    this.onPinChange = vi.fn().mockReturnValue(() => {});
    this.getListenersCount = vi.fn().mockReturnValue(0);
    this.hardResetPinStates = vi.fn();
    this.resetPinStates = vi.fn();
    this.getOutputPins = vi.fn().mockReturnValue(new Set<number>());
  }),
}));

vi.mock('../store/useOscilloscopeStore', () => ({
  useOscilloscopeStore: {
    getState: vi.fn().mockReturnValue({ channels: [], pushSample: vi.fn() }),
  },
}));

class MockWebSocket {
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  readyState = MockWebSocket.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.();
  }
}

vi.stubGlobal('WebSocket', MockWebSocket);
vi.stubGlobal('requestAnimationFrame', (_cb: FrameRequestCallback) => 1);
vi.stubGlobal('cancelAnimationFrame', vi.fn());

import { useSimulatorStore } from '../store/useSimulatorStore';
import { traceDetailed } from '../simulation/PinTrace';
import {
  registerChipLikePads,
  resetChipLikePadsForTest,
} from '../simulation/customChips/chipLikePads';
import {
  syntheticChipPin,
  SYNTHETIC_CHIP_PIN_BASE,
} from '../simulation/customChips/syntheticPins';

const BOARD = 'arduino-uno';

function wire(
  id: string,
  a: [string, string],
  b: [string, string],
): Record<string, unknown> {
  return {
    id,
    waypoints: [],
    color: '#000',
    start: { componentId: a[0], pinName: a[1], x: 0, y: 0 },
    end: { componentId: b[0], pinName: b[1], x: 0, y: 0 },
  };
}

function trace(componentId: string, pinName: string) {
  return traceDetailed(useSimulatorStore.getState() as never, componentId, pinName, 0);
}

describe('chip-like pads', () => {
  beforeEach(() => {
    resetChipLikePadsForTest();
    // The store is a module singleton: a leftover board or wire from the
    // previous case would give the walk somewhere else to land.
    useSimulatorStore.setState({ boards: [], components: [], wires: [] } as never);
    useSimulatorStore.getState().addBoard(BOARD as never, 0, 0, BOARD);
    useSimulatorStore.getState().setComponents([
      { id: 'sw', metadataId: 'grove-x', x: 0, y: 0, properties: {} },
      { id: 'motor', metadataId: 'pro-dc-motor', x: 0, y: 0, properties: {} },
    ] as never);
  });

  it('mints a synthetic pin for a load wired to a registered pad', () => {
    registerChipLikePads('grove-x', ['NO']);
    useSimulatorStore.getState().setWires([
      wire('w1', ['motor', '+'], ['sw', 'NO']),
    ] as never);

    const hit = trace('motor', '+');
    expect(hit.arduinoPin).toBe(syntheticChipPin('sw', 'NO'));
    expect(hit.arduinoPin!).toBeGreaterThanOrEqual(SYNTHETIC_CHIP_PIN_BASE);
  });

  it('leaves an unregistered pad of the same part invisible', () => {
    // Only 'NO' is claimed: the common terminal is still just a wire end, and
    // a walk that answered for it would be minting keys nothing ever writes.
    registerChipLikePads('grove-x', ['NO']);
    useSimulatorStore.getState().setWires([
      wire('w1', ['motor', '+'], ['sw', 'COM']),
    ] as never);

    expect(trace('motor', '+').arduinoPin).toBeNull();
  });

  it('still prefers a real board pin on the same net', () => {
    // Rule 1 beats rule 5: the GPIO is what the sketch actually drives.
    registerChipLikePads('grove-x', ['NO']);
    useSimulatorStore.getState().setWires([
      wire('w1', ['motor', '+'], ['sw', 'NO']),
      wire('w2', ['motor', '+'], [BOARD, '7']),
    ] as never);

    expect(trace('motor', '+').arduinoPin).toBe(7);
  });
});
