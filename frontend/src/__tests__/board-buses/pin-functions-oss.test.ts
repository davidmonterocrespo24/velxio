// @vitest-environment jsdom
/**
 * Board buses F0: pin function tables for the OSS boards (DESIGN section 5.2).
 *
 * The board kinds come from BOARD_KIND_LABELS, which the compiler keeps
 * exhaustive over the BoardKind union, and the tables are looked up through
 * the registry the fabric will use, so a board added without a table fails
 * here rather than silently falling back to another board's pinout (what
 * boardProtocols.ts does today).
 *
 * The pads side mounts the real board elements (the same pinInfo the canvas
 * wires to) and resolves every pad through boardPinToNumber: a table pin no
 * pad reaches is either a typo or a pad the mapping loses, and both are
 * pinned down by name below. The known-answer rows are read off the
 * datasheets and core variant files each table cites.
 */
import { describe, it, expect } from 'vitest';
import '@wokwi/elements';
import '../../components/velxio-components/Esp32Element';
import '../../components/velxio-components/PiPicoWElement';
import '../../components/velxio-components/Attiny85Element';
import '../../components/velxio-components/Stm32BluePillElement';
import { buildPi40PinHeader } from '../../components/velxio-components/pi40PinHeader';
import { BOARD_KIND_LABELS, type BoardKind } from '../../types/board';
import { boardPinToNumber } from '../../utils/boardPinMapping';
import '../../simulation/buses/boardPinTables';
import {
  controllerOf,
  functionsOfPin,
  getBoardPinFunctions,
  type BusKind,
  type BusSignal,
  type PinFunction,
} from '../../simulation/buses/pinFunctions';
import { stm32PinNumber } from '../../simulation/buses/boardPinTables/stm32';

const OSS_KINDS = Object.keys(BOARD_KIND_LABELS) as BoardKind[];

function missingTables(kinds: readonly string[]): string[] {
  return kinds.filter((k) => getBoardPinFunctions(k) === undefined);
}

// ── Pads: what a wire on the canvas can reach ────────────────────────────────

/** The tag BoardOnCanvas renders for a kind (Pi Zero/1/2 are React wrappers over the same header). */
function padNames(kind: BoardKind): string[] {
  if (kind.startsWith('raspberry-pi-') && kind !== 'raspberry-pi-pico') {
    return buildPi40PinHeader().map((p) => p.name);
  }
  let tag: string;
  if (kind === 'arduino-uno' || kind === 'arduino-nano' || kind === 'arduino-mega')
    tag = `wokwi-${kind}`;
  else if (kind === 'raspberry-pi-pico' || kind === 'pi-pico-w') tag = 'velxio-pi-pico-w';
  else if (kind === 'attiny85') tag = 'velxio-attiny85';
  else if (kind.startsWith('stm32-')) tag = `velxio-${kind}`;
  else tag = 'velxio-esp32';
  const el = document.createElement(tag);
  if (tag === 'velxio-esp32') el.setAttribute('board-kind', kind);
  return (el as unknown as { pinInfo: Array<{ name: string }> }).pinInfo.map((p) => p.name);
}

function reachablePins(kind: BoardKind): Set<number> {
  const out = new Set<number>();
  for (const name of padNames(kind)) {
    const n = boardPinToNumber(kind, name);
    if (n !== null && n >= 0) out.add(n);
  }
  return out;
}

function defaultPinsOf(
  kind: BoardKind,
): Array<{ bus: BusKind; unit: number; signal: BusSignal; pin: number }> {
  const out: Array<{ bus: BusKind; unit: number; signal: BusSignal; pin: number }> = [];
  for (const c of getBoardPinFunctions(kind)!.controllers) {
    for (const [signal, value] of Object.entries(c.defaultPins) as Array<
      [BusSignal, number | number[]]
    >) {
      for (const pin of Array.isArray(value) ? value : [value])
        out.push({ bus: c.bus, unit: c.unit, signal, pin });
    }
  }
  return out;
}

const SIGNALS_OF: Record<BusKind, BusSignal[]> = {
  spi: ['sck', 'mosi', 'miso', 'cs'],
  i2c: ['sda', 'scl'],
  uart: ['tx', 'rx', 'rts', 'cts'],
};

const sorted = (xs: Iterable<number>) => Array.from(new Set(xs)).sort((a, b) => a - b);

/**
 * Core default pins the board does not break out. Real hardware facts: the
 * core picks the pin, the board has no pad for it, so begin() without pins
 * lands on a line no wire can touch.
 */
const DEFAULTS_OFF_HEADER: Partial<Record<BoardKind, number[]>> = {
  // Camera module: SPI (18/19/23/5), Wire (21/22), Serial1 (26/27), Serial2 TX (25) are internal.
  'esp32-cam': [5, 18, 19, 21, 22, 23, 25, 26, 27],
  // UART0 goes to the USB bridge only; GPIO1/3 are not on the header.
  'wemos-lolin32-lite': [1, 3],
  // Serial1 = 15/16 and Serial2 = 19/20 are not among the XIAO / Nano pads.
  'xiao-esp32-s3': [15, 16, 19, 20],
  'arduino-nano-esp32': [15, 16, 19, 20],
  // Serial1 = 18/19 (USB D-/D+) are not XIAO or SuperMini pads.
  'xiao-esp32-c3': [18, 19],
  'aitewinrobot-esp32c3-supermini': [18, 19],
  // SS = PB12: velxio draws only part of the Discovery headers.
  'stm32-f4-discovery': [stm32PinNumber('PB12')],
};

/**
 * Header pins the silicon routes buses to but no pad reaches in
 * boardPinMapping.ts today. If one of these starts resolving, drop it here.
 */
const PAD_MAP_GAPS: Partial<Record<BoardKind, number[]>> = {
  // ID_SD/ID_SC (header pins 27/28) are mapped to -1 on purpose: HAT EEPROM.
  'raspberry-pi-zero': [0, 1],
  'raspberry-pi-1': [0, 1],
  'raspberry-pi-2': [0, 1],
  'raspberry-pi-3': [0, 1],
  'raspberry-pi-4': [0, 1],
  'raspberry-pi-5': [0, 1],
};

/**
 * Boards velxio draws with part of the real header (Stm32BluePillElement
 * inlineConfig). Their tables keep the whole package, so the pad check only
 * runs one way for them.
 */
const PARTIAL_HEADER_KINDS = new Set<BoardKind>([
  'stm32-f4-discovery',
  'stm32-olimex-h405',
  'stm32-netduino-plus2',
  'stm32-netduino2',
]);

// ── Coverage ─────────────────────────────────────────────────────────────────

describe('pin function tables: coverage of the OSS board kinds', () => {
  it('enumerates the real board list, not an empty one', () => {
    expect(OSS_KINDS.length).toBeGreaterThanOrEqual(30);
    expect(OSS_KINDS).toContain('arduino-uno');
    expect(OSS_KINDS).toContain('raspberry-pi-5');
  });

  it('the coverage check reports a kind without a table (negative control)', () => {
    expect(missingTables(['arduino-uno', 'board-with-no-table'])).toEqual(['board-with-no-table']);
  });

  it('every OSS board kind has a pin function table', () => {
    expect(missingTables(OSS_KINDS)).toEqual([]);
  });
});

// ── Shape ────────────────────────────────────────────────────────────────────

describe.each(OSS_KINDS)('pin function table of %s', (kind) => {
  const table = () => getBoardPinFunctions(kind)!;

  it('names its source and its controllers once each', () => {
    const t = table();
    expect(['fixed', 'mux', 'matrix']).toContain(t.routing);
    expect(t.source.length).toBeGreaterThan(20);
    expect(t.controllers.length).toBeGreaterThan(0);
    const ids = t.controllers.map((c) => `${c.bus}/${c.unit}`);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of t.controllers) expect(c.name.length).toBeGreaterThan(0);
  });

  it('only lists functions of declared controllers, each once, with a CS index on CS only', () => {
    const t = table();
    for (const [key, fns] of Object.entries(t.pins)) {
      const pin = Number(key);
      expect(Number.isInteger(pin) && pin >= 0, `pin key ${key}`).toBe(true);
      expect(fns.length, `pin ${pin}`).toBeGreaterThan(0);
      const seen = new Set<string>();
      for (const f of fns) {
        expect(controllerOf(kind, f.bus, f.unit), `pin ${pin}: ${f.bus}/${f.unit}`).toBeDefined();
        expect(f.signal === 'cs', `pin ${pin}: csIndex on ${f.signal}`).toBe(
          f.csIndex !== undefined,
        );
        const id = `${f.bus}/${f.unit}/${f.signal}/${f.csIndex ?? ''}`;
        expect(seen.has(id), `pin ${pin}: duplicate ${id}`).toBe(false);
        seen.add(id);
        expect(SIGNALS_OF[f.bus], `pin ${pin}`).toContain(f.signal);
      }
    }
  });

  it('carries every default data pin of the core on that pin', () => {
    const t = table();
    for (const d of defaultPinsOf(kind)) {
      // On fixed and mux silicon a chip select is a plain GPIO the core names
      // (PB12 on the Discovery, PB3 on the ATtiny85), not an alternate.
      if (d.signal === 'cs' && t.routing !== 'matrix') continue;
      if (t.routing === 'matrix' && !(d.pin in t.pins)) continue; // off the header, checked below
      const has = functionsOfPin(kind, d.pin).some(
        (f: PinFunction) => f.bus === d.bus && f.unit === d.unit && f.signal === d.signal,
      );
      expect(has, `${d.bus}/${d.unit} ${d.signal} default on pin ${d.pin}`).toBe(true);
    }
  });
});

// ── Pads ─────────────────────────────────────────────────────────────────────

describe.each(OSS_KINDS)('pin function table of %s against the board pads', (kind) => {
  it('every core default pin is a pad on the board, or is known not to be', () => {
    const reach = reachablePins(kind);
    const unreachable = defaultPinsOf(kind)
      .map((d) => d.pin)
      .filter((p) => !reach.has(p));
    expect(sorted(unreachable)).toEqual(sorted(DEFAULTS_OFF_HEADER[kind] ?? []));
  });

  it('every pin the table lists is a pad on the board, or a known pad-map gap', () => {
    const reach = reachablePins(kind);
    const listed = Object.keys(getBoardPinFunctions(kind)!.pins).map(Number);
    const unreachable = listed.filter((p) => !reach.has(p));
    if (PARTIAL_HEADER_KINDS.has(kind)) {
      // The drawn pads must still be a subset of the package the table covers.
      expect(unreachable.length).toBeLessThan(listed.length);
      return;
    }
    expect(sorted(unreachable)).toEqual(sorted(PAD_MAP_GAPS[kind] ?? []));
  });
});

// ── Known answers ────────────────────────────────────────────────────────────

type Expect = [BoardKind, number, BusKind, number, BusSignal];
const S = stm32PinNumber;

/** One row per datasheet / variant line checked by hand. */
const KNOWN: Expect[] = [
  // ATmega328P / ATmega2560 port alternates.
  ['arduino-uno', 0, 'uart', 0, 'rx'],
  ['arduino-uno', 11, 'spi', 0, 'mosi'],
  ['arduino-nano', 19, 'i2c', 0, 'scl'],
  ['arduino-mega', 18, 'uart', 1, 'tx'],
  ['arduino-mega', 17, 'uart', 2, 'rx'],
  ['arduino-mega', 14, 'uart', 3, 'tx'],
  ['arduino-mega', 20, 'i2c', 0, 'sda'],
  ['arduino-mega', 50, 'spi', 0, 'miso'],
  // ATtiny85 USI, master-mode naming (DO = MOSI on PB1).
  ['attiny85', 1, 'spi', 0, 'mosi'],
  ['attiny85', 0, 'spi', 0, 'miso'],
  ['attiny85', 0, 'i2c', 0, 'sda'],
  ['attiny85', 2, 'i2c', 0, 'scl'],
  // RP2040 GPIO function table, F1/F2/F3.
  ['raspberry-pi-pico', 0, 'uart', 0, 'tx'],
  ['raspberry-pi-pico', 0, 'spi', 0, 'miso'],
  ['raspberry-pi-pico', 0, 'i2c', 0, 'sda'],
  ['raspberry-pi-pico', 4, 'uart', 1, 'tx'],
  ['raspberry-pi-pico', 13, 'spi', 1, 'cs'],
  ['raspberry-pi-pico', 19, 'spi', 0, 'mosi'],
  ['pi-pico-w', 26, 'i2c', 1, 'sda'],
  ['pi-pico-w', 26, 'spi', 1, 'sck'],
  ['pi-pico-w', 26, 'uart', 1, 'cts'],
  ['pi-pico-w', 28, 'uart', 0, 'tx'],
  // ESP32 IO_MUX and arduino-esp32 3.3.10 defaults.
  ['esp32', 23, 'spi', 3, 'mosi'],
  ['esp32', 14, 'spi', 2, 'sck'],
  ['esp32', 17, 'uart', 2, 'tx'],
  ['esp32', 25, 'uart', 2, 'tx'],
  ['esp32', 22, 'i2c', 0, 'scl'],
  ['wemos-lolin32-lite', 19, 'i2c', 0, 'sda'],
  ['esp32-s3', 11, 'spi', 2, 'mosi'],
  ['esp32-s3', 16, 'uart', 0, 'cts'],
  ['esp32-s3', 16, 'uart', 1, 'tx'],
  ['esp32-s3', 8, 'i2c', 0, 'sda'],
  ['xiao-esp32-s3', 43, 'uart', 0, 'tx'],
  ['arduino-nano-esp32', 48, 'spi', 2, 'sck'],
  ['esp32-c3', 7, 'spi', 2, 'mosi'],
  ['esp32-c3', 6, 'spi', 2, 'sck'],
  ['esp32-c3', 6, 'spi', 2, 'mosi'],
  ['xiao-esp32-c3', 21, 'uart', 0, 'tx'],
  ['xiao-esp32-c3', 9, 'spi', 2, 'miso'],
  // STM32duino PeripheralPins.c (units 0-based: USART1 = 0, UART4 = 3, USART6 = 5).
  ['stm32-bluepill', S('PA9'), 'uart', 0, 'tx'],
  ['stm32-bluepill', S('PB6'), 'i2c', 0, 'scl'],
  ['stm32-bluepill', S('PB6'), 'uart', 0, 'tx'],
  ['stm32-bluepill-f103cb', S('PB13'), 'spi', 1, 'sck'],
  ['stm32-bluepill-f103cb', S('PB13'), 'uart', 2, 'cts'],
  ['stm32-blackpill', S('PA11'), 'uart', 5, 'tx'],
  ['stm32-blackpill', S('PB12'), 'spi', 3, 'cs'],
  ['stm32-blackpill', S('PB0'), 'spi', 4, 'sck'],
  ['stm32-blackpill-f401', S('PB3'), 'i2c', 1, 'sda'],
  ['stm32-f4-discovery', S('PD8'), 'uart', 2, 'tx'],
  ['stm32-olimex-h405', S('PA0'), 'uart', 3, 'tx'],
  ['stm32-netduino-plus2', S('PC12'), 'uart', 4, 'tx'],
  ['stm32-netduino2', S('PC7'), 'uart', 5, 'rx'],
  // BCM2835 / BCM2711 / RP1 alternate function tables.
  ['raspberry-pi-3', 14, 'uart', 0, 'tx'],
  ['raspberry-pi-3', 14, 'uart', 1, 'tx'],
  ['raspberry-pi-zero', 18, 'spi', 1, 'cs'],
  ['raspberry-pi-2', 2, 'i2c', 1, 'sda'],
  ['raspberry-pi-4', 0, 'spi', 3, 'cs'],
  ['raspberry-pi-4', 0, 'uart', 2, 'tx'],
  ['raspberry-pi-4', 0, 'i2c', 6, 'sda'],
  ['raspberry-pi-4', 12, 'uart', 5, 'tx'],
  ['raspberry-pi-4', 13, 'i2c', 5, 'scl'],
  ['raspberry-pi-5', 10, 'spi', 0, 'mosi'],
  ['raspberry-pi-5', 10, 'uart', 3, 'cts'],
  ['raspberry-pi-5', 10, 'i2c', 1, 'sda'],
  ['raspberry-pi-5', 27, 'spi', 1, 'cs'],
];

describe('pin function tables: known answers from the datasheets', () => {
  it.each(KNOWN)('%s pin %i carries %s unit %i %s', (kind, pin, bus, unit, signal) => {
    expect(functionsOfPin(kind, pin)).toContainEqual(
      expect.objectContaining({ bus, unit, signal }),
    );
  });

  it('lists nothing for pins with no serial alternate', () => {
    expect(functionsOfPin('arduino-uno', 2)).toEqual([]);
    expect(functionsOfPin('esp32', 34)).toEqual([]); // input-only, no IO_MUX serial function
    expect(functionsOfPin('raspberry-pi-pico', 25)).toEqual([]); // on-board LED, not on the header
    expect(functionsOfPin('esp32-devkit-c-v4', 9)).toEqual([]); // SPI flash
  });

  it('keeps slave-only and header-less controllers out', () => {
    expect(controllerOf('raspberry-pi-5', 'spi', 4)).toBeUndefined(); // RP1 SPI4 is slave-only
    expect(controllerOf('raspberry-pi-4', 'spi', 2)).toBeUndefined(); // BCM2711 SPI2 is not on the header
    expect(controllerOf('esp32-c3', 'i2c', 1)).toBeUndefined(); // the C3 has one I2C
    expect(controllerOf('arduino-uno', 'uart', 1)).toBeUndefined();
  });

  it('binds the Arduino objects the way each core does', () => {
    expect(controllerOf('esp32', 'spi', 3)?.arduino).toEqual(['SPI']); // VSPI
    expect(controllerOf('esp32-s3', 'spi', 2)?.arduino).toEqual(['SPI']); // FSPI
    expect(controllerOf('esp32', 'uart', 2)?.defaultPins).toEqual({ tx: 25, rx: 4 }); // 3.x, not 16/17
    expect(controllerOf('xiao-esp32-s3', 'uart', 0)?.arduino).toEqual(['Serial0']); // CDC on boot
    expect(controllerOf('esp32-c3', 'uart', 0)?.arduino).toEqual(['Serial', 'Serial0']);
    expect(controllerOf('raspberry-pi-pico', 'spi', 1)?.arduino).toEqual(['SPI1']);
    expect(controllerOf('raspberry-pi-pico', 'i2c', 1)?.defaultPins).toEqual({ sda: 26, scl: 27 });
    expect(controllerOf('stm32-olimex-h405', 'uart', 3)).toMatchObject({
      name: 'UART4',
      arduino: ['Serial', 'Serial4'],
    });
    expect(controllerOf('stm32-f4-discovery', 'uart', 1)).toMatchObject({
      name: 'USART2',
      arduino: ['Serial', 'Serial2'],
    });
    expect(controllerOf('raspberry-pi-4', 'spi', 0)?.defaultPins).toEqual({
      sck: 11,
      miso: 9,
      mosi: 10,
      cs: [8, 7],
    });
  });
});
