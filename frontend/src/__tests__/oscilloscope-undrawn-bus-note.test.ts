// @vitest-environment jsdom
/**
 * A channel on a hardware I2C or SPI line that its board's engine does not
 * draw says so (velxio/velxio-prod#160).
 *
 * The AVR and RP2040 engines now draw their Wire and SPI transfers on the
 * scope (simulation/busScope.ts). The ESP32, STM32 and Pi engines still move
 * no pin for a transfer, so their SDA or SCK trace stays flat however busy the
 * bus is, and a flat SDA reads like an idle bus. Their channel gets a note
 * naming the line, from the bus fabric's routing: the line the controller is
 * routed to now, or the board's default pad when the engine cannot say.
 *
 * The test binds a fake engine to the store's first board, in place of its
 * AVR, with one I2C and one SPI controller, and renders the real panel.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import '../i18n'; // the app's English strings, interpolated as on the page
import { Oscilloscope } from '../components/simulator/Oscilloscope';
import { useOscilloscopeStore } from '../store/useOscilloscopeStore';
import { getBoardSimulator } from '../store/useSimulatorStore';
import { busRegistry } from '../simulation/buses/registry';
import type {
  BoardPins,
  EngineBinding,
  I2cControllerPort,
  I2cRouting,
  SpiControllerConfig,
  SpiControllerPort,
  SpiRouting,
} from '../simulation/buses/types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const BOARD = 'arduino-uno'; // the store's first board

const pins: BoardPins = {
  onPinChange: () => () => {},
  peekPinState: () => undefined,
};

function i2cPort(route: I2cRouting | 'static'): I2cControllerPort {
  return {
    bus: 'i2c',
    unit: 0,
    name: 'I2C0',
    setTransactionHandler: () => {},
    routing: () => route,
  };
}

function spiPort(route: SpiRouting, enabled: boolean): SpiControllerPort {
  const cfg: SpiControllerConfig = enabled
    ? { enabled: true, mode: 0, bitOrder: 'msb', bits: 8, hz: 1_000_000 }
    : { enabled: false };
  return {
    bus: 'spi',
    unit: 2,
    name: 'GPSPI2',
    setFrameHandler: () => {},
    config: () => cfg,
    routing: () => route,
  } as SpiControllerPort;
}

let host: HTMLDivElement;
let root: Root;
/** The AVR's own `scopeDrawsHardwareBuses`, put back after each test. */
let drawsDescriptor: PropertyDescriptor | undefined;

/** Bind an engine that does not draw its buses in place of the board's AVR. */
function engineThatDoesNotDraw(binding: EngineBinding): void {
  const sim = getBoardSimulator(BOARD) as object;
  drawsDescriptor = Object.getOwnPropertyDescriptor(sim, 'scopeDrawsHardwareBuses');
  Object.defineProperty(sim, 'scopeDrawsHardwareBuses', { value: false, configurable: true });
  busRegistry.bindEngine(BOARD, binding);
}

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', () => {});
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => null);
  useOscilloscopeStore.setState({
    open: true,
    running: true,
    timeDivMs: 1,
    channels: [],
    samples: {},
    triggerMode: 'auto',
    triggerChannelId: null,
    triggeredAtMs: null,
    triggerStatus: 'idle',
  });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  const sim = getBoardSimulator(BOARD) as object;
  if (drawsDescriptor) Object.defineProperty(sim, 'scopeDrawsHardwareBuses', drawsDescriptor);
  drawsDescriptor = undefined;
  busRegistry.bindBoard(BOARD, sim);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function render(): void {
  act(() => root.render(createElement(Oscilloscope)));
}

/** The note on each channel row, by its label. */
function notes(): Record<string, { text: string; title: string } | null> {
  const out: Record<string, { text: string; title: string } | null> = {};
  for (const row of Array.from(host.querySelectorAll('.osc-channel-row'))) {
    const label = row.querySelector('.osc-channel-name')!.textContent!;
    const note = row.querySelector('.osc-channel-hwbus');
    out[label] = note ? { text: note.textContent!, title: note.getAttribute('title')! } : null;
  }
  return out;
}

function addChannels(list: Array<[number, string]>): void {
  const s = useOscilloscopeStore.getState();
  for (const [pin, label] of list) s.addChannel(BOARD, pin, label, 3.3);
}

describe('a hardware bus line the engine does not draw', () => {
  it('names the I2C or SPI line on its channel, and nothing on a plain pin', () => {
    engineThatDoesNotDraw({
      pins,
      spi: [spiPort({ sck: 18, mosi: 23, miso: 19 }, true)],
      i2c: [i2cPort({ sda: 21, scl: 22 })],
    });
    addChannels([
      [21, 'GPIO21'],
      [22, 'GPIO22'],
      [18, 'GPIO18'],
      [5, 'GPIO5'],
    ]);
    render();
    const n = notes();
    expect(n.GPIO21).toMatchObject({ text: 'I2C SDA', title: expect.stringMatching(/I2C0 SDA/) });
    expect(n.GPIO21!.title).toMatch(/flat/);
    expect(n.GPIO22).toMatchObject({ text: 'I2C SCL' });
    expect(n.GPIO18).toMatchObject({ text: 'SPI SCK' });
    expect(n.GPIO5).toBeNull();
  });

  it('an SPI controller that is not enabled marks nothing', () => {
    engineThatDoesNotDraw({ pins, spi: [spiPort({ sck: 18, mosi: 23, miso: 19 }, false)] });
    addChannels([[18, 'GPIO18']]);
    render();
    expect(notes().GPIO18).toBeNull();
  });

  it('a controller the engine cannot place: the note says it is the board\'s default pad', () => {
    // 'static' routing: the board table's Wire pins, A4 = 18 on this board.
    engineThatDoesNotDraw({ pins, spi: [], i2c: [i2cPort('static')] });
    addChannels([[18, 'A4']]);
    render();
    expect(notes().A4).toMatchObject({ text: 'I2C SDA', title: expect.stringMatching(/default/) });
  });
});

describe('an engine that draws its buses', () => {
  it('the Uno\'s A4, its TWI SDA, gets no note: Wire is drawn there', () => {
    addChannels([[18, 'A4']]);
    render();
    expect(notes().A4).toBeNull();
  });
});
