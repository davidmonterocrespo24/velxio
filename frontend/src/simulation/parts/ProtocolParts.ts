/**
 * ProtocolParts.ts — Simulation for I2C, SPI, and custom-protocol components.
 *
 * Implements eight components that require specific communication stacks:
 *
 *  ssd1306      — I2C OLED display (0x3C). Full command/data decoder.
 *  ds1307       — I2C Real-Time Clock (0x68). The host's time until the sketch sets one.
 *  mpu6050      — I2C 6-axis IMU (0x68/0x69). Full register map simulation.
 *  dht22        — Single-wire temp/humidity. Drives DATA pin after start signal.
 *  hx711        — 2-wire load cell amplifier. Clocks out 24-bit ADC value.
 *  ir-receiver  — IR demodulator. Owns its pin through the line contract and
 *                 puts what crosses simulation/ir/irAir on it, at real timing.
 *  ir-remote    — IR handset. No pins: it transmits into the air.
 *  microsd-card — SPI SD card. Responds to CMD0/CMD8/ACMD41/CMD58 init.
 *
 * NOTE — the timing-sensitive parts (dht22, ir-receiver) do NOT live here any
 *   more. They are line-owning models under simulation/line/models, which place
 *   edges on the guest's own cycle counter, so a µs-accurate protocol is exact
 *   and an interrupt-driven library (IRremote, Adafruit DHT) decodes it. What
 *   is left in this file drives pins from host time and is fine with that.
 */

import { PartSimulationRegistry, type AnySimulator } from './PartSimulationRegistry';
import { attachSpiDevice, busRegistry, type SpiDevice } from '../buses';
import { setBoardPinDrive, type BoardPinHost } from '../customChips/busNets';
import { HIGHZ_DRIVE, Strength, type Drive } from '../customChips/busLogic';
import { isSyntheticChipPin } from '../customChips/syntheticPins';
import {
  loadSdBusChip,
  SdSpiCard,
  sdCardRemoteBlobWrite,
  sdCardHasRemoteModel,
  sdCardRemoteModel,
  sdSpiFabricDevice,
} from './sdSpiCard';
import { requestLine, releaseLineGap } from '../line/requestLine';
import { VirtualDS1307, VirtualBMP280, VirtualDS3231, VirtualPCF8574 } from '../I2CBusManager';
import type { I2CDevice, RtcDateTime } from '../I2CBusManager';
import type { GuestClock } from '../buses/types';
import { buildTimesOfPrograms } from '../firmwareBuildTime';
import { attachI2cPart, hostClockRecord, parseI2cAddress } from './i2cPart';
import {
  WasmBMP280,
  WasmDS1307,
  WasmDS3231,
  WasmMPU6050,
  wasmI2cModelB64,
  wasmI2cModelEnabled,
  wasmI2cModule,
} from './wasmI2cModels';
import { HD44780Decoder } from '../HD44780Decoder';
import { fontWithCgram } from './lcdCgram';
import { registerSensorUpdate, unregisterSensorUpdate } from '../SensorUpdateRegistry';
import { getSensorControl, sensorControlDefault } from '../sensorControlConfig';
import {
  emitIr,
  listenIr,
  necEncode,
  necEncodeRepeat,
  NEC_REPEAT_PERIOD_MS,
  type IrAirFrame,
  type IrPulse,
} from '../ir';
import { useSimulatorStore, registerSdImageReader } from '../../store/useSimulatorStore';

// ─── SSD1306 OLED ────────────────────────────────────────────────────────────

/**
 * SSD1306Core — shared GDDRAM buffer, command decoder, and rendering logic.
 *
 * The SSD1306 command set is identical for I2C and SPI; only the transport
 * differs.  This core is used by both VirtualSSD1306 (I2C) and
 * attachSSD1306SPI (SPI).
 *
 * Modelled from the datasheet (SSD1306 rev 1.1, section 10.1), everything that
 * decides what the glass shows:
 *  - 0x20 memory addressing mode, 0x21 column and 0x22 page window,
 *    0xB0-0xB7 page and 0x00-0x1F column pointer (page addressing)
 *  - 0x40-0x7F display start line, 0xD3 display offset
 *  - 0xA0/0xA1 segment re-map, 0xC0/0xC8 COM scan direction
 *  - 0x81 contrast, 0xA4/0xA5 entire display on, 0xA6/0xA7 normal/inverse,
 *    0xAE/0xAF display off/on
 * Every other command is parsed with its parameter bytes and ignored.
 *
 * The state starts at the chip's reset values (datasheet 8.5): display off,
 * contrast 0x7F, no re-map, normal scan, page addressing. It is the panel's,
 * not the sketch's, so it lives as long as the part on the canvas does (see
 * coreFor below).
 */
class SSD1306Core {
  /**
   * 1024-byte GDDRAM: 8 pages × 128 columns. Each byte = 8 vertical pixels.
   *
   * Byte `page * 128 + x` holds the column the glass shows at x. The RAM has
   * no read path here, so which way its columns are numbered is ours to pick;
   * this way round a driver that sends 0xA1 (Adafruit_SSD1306, U8g2 R0,
   * MicroPython ssd1306.py, SSD1306Ascii) addresses byte `page * 128 + col`,
   * as the buffer always was.
   */
  readonly buffer = new Uint8Array(128 * 8);

  // GDDRAM cursor
  private col = 0;
  private page = 0;
  private colStart = 0;
  private colEnd = 127;
  private pageStart = 0;
  private pageEnd = 7;
  // 0=horizontal, 1=vertical, 2=page. SSD1306 power-on default is PAGE
  // addressing (datasheet 10b). Adafruit_SSD1306 overrides it to horizontal
  // via 0x20,0x00; page-mode drivers (Tiny4kOLED, U8g2 page buffer) rely on
  // this default and never send 0x20 — so the default MUST be 2 or their
  // setCursor (0xB0-0xB7 + 0x00-0x1F) renders garbled.
  private memMode = 2;

  // What the glass shows (datasheet 10.1.6 to 10.1.15), at reset values.
  private displayOn = false;
  private contrast = 0x7f;
  private inverse = false;
  private entireOn = false;
  private segRemap = false;
  private comRemap = false;
  private displayOffset = 0;
  private startLine = 0;

  // Multi-byte command accumulation
  private cmdBuf: number[] = [];
  private cmdWant = 0;

  /** How many parameter bytes does this command require? */
  static cmdParams(cmd: number): number {
    if (
      cmd === 0x20 ||
      cmd === 0x81 ||
      cmd === 0x8d ||
      cmd === 0xa8 ||
      cmd === 0xd3 ||
      cmd === 0xd5 ||
      cmd === 0xd8 ||
      cmd === 0xd9 ||
      cmd === 0xda ||
      cmd === 0xdb
    )
      return 1;
    if (cmd === 0x21 || cmd === 0x22 || cmd === 0xa3) return 2;
    // Scroll setup (datasheet 10.2.1, 10.2.2). Their parameters carry values
    // such as 0x40 and 0x00-0x0F that would otherwise be taken for the start
    // line and column commands.
    if (cmd === 0x29 || cmd === 0x2a) return 5;
    if (cmd === 0x26 || cmd === 0x27) return 6;
    return 0;
  }

  /** Write a data byte to GDDRAM and advance cursor. */
  writeData(value: number): void {
    // Segment re-map acts on the write, not on the display: "Data already
    // stored in GDDRAM will have no changes" (datasheet 10.1.8). With 0xA1,
    // column address c drives SEG127-c; the glass is wired so that this is
    // the column at x = c (the orientation every driver's init selects).
    if (this.col <= 127) {
      const x = this.segRemap ? this.col : 127 - this.col;
      this.buffer[this.page * 128 + x] = value;
    }
    this.advanceCursor();
  }

  /**
   * Drop a half-received command. The MCU restarting leaves the panel
   * powered, so its GDDRAM and its configuration survive (the glass keeps
   * showing the last frame); only the bytes of a command that will never be
   * completed have to go, or the first byte of the new init would be eaten
   * as their parameter.
   */
  resetCommand(): void {
    this.cmdBuf = [];
    this.cmdWant = 0;
  }

  /** Feed a command or parameter byte. Multi-byte commands are accumulated. */
  writeCommand(value: number): void {
    if (this.cmdWant > 0) {
      this.cmdBuf.push(value);
      this.cmdWant--;
      if (this.cmdWant === 0) this.applyCmd();
      return;
    }
    this.cmdBuf = [value];
    this.cmdWant = SSD1306Core.cmdParams(value);
    if (this.cmdWant === 0) this.applyCmd();
  }

  private applyCmd(): void {
    const [cmd, p1, p2] = this.cmdBuf;
    switch (cmd) {
      case 0x20:
        this.memMode = p1 & 0x03;
        break;
      case 0x21:
        this.colStart = p1 & 0x7f;
        this.colEnd = p2 & 0x7f;
        this.col = this.colStart;
        break;
      case 0x22:
        this.pageStart = p1 & 0x07;
        this.pageEnd = p2 & 0x07;
        this.page = this.pageStart;
        break;
      case 0x81:
        this.contrast = p1;
        break;
      case 0xd3:
        this.displayOffset = p1 & 0x3f;
        break;
      case 0xa0:
      case 0xa1:
        this.segRemap = cmd === 0xa1;
        break;
      case 0xa4:
      case 0xa5:
        this.entireOn = cmd === 0xa5;
        break;
      case 0xa6:
      case 0xa7:
        this.inverse = cmd === 0xa7;
        break;
      case 0xae:
      case 0xaf:
        this.displayOn = cmd === 0xaf;
        break;
      case 0xc0:
      case 0xc8:
        this.comRemap = cmd === 0xc8;
        break;
      default:
        // Page-addressing-mode cursor commands (single-byte). Used by
        // Tiny4kOLED / U8g2 page buffer / classic SSD1306 drivers whose
        // setCursor() does NOT use the 0x21/0x22 column/page-range commands.
        if (cmd >= 0xb0 && cmd <= 0xb7) {
          // set page start address (B0..B7 → page 0..7)
          this.page = cmd & 0x07;
        } else if (cmd <= 0x0f) {
          // set lower column nibble (0x00..0x0F)
          this.col = (this.col & 0xf0) | (cmd & 0x0f);
        } else if (cmd >= 0x10 && cmd <= 0x1f) {
          // set higher column nibble (0x10..0x1F)
          this.col = (this.col & 0x0f) | ((cmd & 0x0f) << 4);
        } else if (cmd >= 0x40 && cmd <= 0x7f) {
          this.startLine = cmd & 0x3f;
        }
        break;
    }
  }

  private advanceCursor(): void {
    if (this.memMode === 0) {
      // horizontal addressing
      this.col++;
      if (this.col > this.colEnd) {
        this.col = this.colStart;
        this.page++;
        if (this.page > this.pageEnd) this.page = this.pageStart;
      }
    } else if (this.memMode === 1) {
      // vertical addressing
      this.page++;
      if (this.page > this.pageEnd) {
        this.page = this.pageStart;
        this.col++;
        if (this.col > this.colEnd) this.col = this.colStart;
      }
    } else {
      // page addressing
      this.col++;
      if (this.col > this.colEnd) this.col = this.colStart;
    }
  }

  /**
   * How bright a lit pixel is, 0..1, for the contrast register.
   *
   * The datasheet gives the contrast as 256 steps of segment current
   * (10.1.7), not as a luminance, and on a module the steps above the reset
   * value are hard to tell apart: Adafruit_SSD1306 dim() jumps straight to 0
   * because "the range of contrast is too small to be really useful". So the
   * reset value and every value above it paint at full brightness, the one the
   * panel always had, and that covers what every driver's init sends
   * (Adafruit 0x8F/0x9F/0xCF, U8g2 and ThingPulse 0xCF, SSD1306Ascii 0x7F,
   * MicroPython 0xFF). Below it the panel dims towards 0x00, which on the
   * bench is still readable.
   */
  private brightness(): number {
    const DIMMEST = 0.3;
    if (this.contrast >= 0x7f) return 1;
    return DIMMEST + ((1 - DIMMEST) * this.contrast) / 0x7f;
  }

  /**
   * Push what the glass shows to the wokwi-ssd1306 web component.
   *
   * wokwi-ssd1306 API:
   *   - `element.imageData` — a 128×64 ImageData (RGBA, 4 bytes/pixel)
   *   - `element.redraw()` — flushes imageData to the internal canvas
   *
   * Glass row y is driven by COM(63-y), so the scan direction every driver
   * selects (0xC8) shows RAM row y there. A COM pin shows display row
   * (i + offset) mod 64 when scanning up and (63 - i + offset) mod 64 when
   * scanning down, and display row r reads RAM row (r + start line) mod 64
   * (datasheet Tables 10-1 and 10-2). Display off leaves the segments at VSS:
   * a dark panel over an intact RAM (10.1.12). Entire display on lights every
   * pixel whatever the RAM holds (10.1.9); inverse lights the zeros (10.1.10).
   */
  syncElement(element: HTMLElement): void {
    const el = element as any;
    if (!el) return;

    let imgData: ImageData | undefined = el.imageData;
    if (!imgData || imgData.width !== 128 || imgData.height !== 64) {
      try {
        imgData = new ImageData(128, 64);
      } catch {
        return;
      }
    }

    const px = imgData.data;
    const level = this.brightness();
    const r = Math.round(200 * level);
    const g = Math.round(230 * level);
    const b = Math.round(255 * level);
    const flip = this.inverse ? 1 : 0;

    for (let y = 0; y < 64; y++) {
      const com = 63 - y;
      const displayRow = ((this.comRemap ? 63 - com : com) + this.displayOffset) & 63;
      const ramRow = (displayRow + this.startLine) & 63;
      const base = (ramRow >> 3) * 128;
      const bit = ramRow & 7;
      for (let x = 0; x < 128; x++) {
        const lit = this.displayOn && (this.entireOn || (((this.buffer[base + x] >> bit) & 1) ^ flip) === 1);
        const idx = (y * 128 + x) * 4;
        px[idx] = lit ? r : 0; // R
        px[idx + 1] = lit ? g : 0; // G
        px[idx + 2] = lit ? b : 0; // B
        px[idx + 3] = 255; // A
      }
    }

    el.imageData = imgData;
    if (typeof el.redraw === 'function') el.redraw();
  }
}

/**
 * One panel per part on the canvas. The part re-attaches when its wires
 * change or a new program is loaded, and neither powers the module down: the
 * configuration the sketch's init wrote in setup() (display on, re-map,
 * contrast) and the frame in its RAM stay, as on the bench. A fresh core per
 * attach would come up at the reset values, display off, and a sketch that
 * only initialises in setup() would stay dark after a wire edit.
 */
const panels = new WeakMap<object, SSD1306Core>();

function coreFor(element: HTMLElement): SSD1306Core {
  let core = panels.get(element);
  if (!core) {
    core = new SSD1306Core();
    panels.set(element, core);
  }
  core.resetCommand();
  return core;
}

/**
 * VirtualSSD1306 — I2C wrapper around SSD1306Core.
 *
 * Handles the I2C control byte (0x00 = command stream, 0x40 = data stream)
 * and delegates command/data writes to the shared core.
 *
 * The glass is repainted at most once per animation frame, as the SPI path
 * does. A driver sends one frame as many transactions: Adafruit_SSD1306
 * display() splits the 1 KiB buffer into WIRE_MAX chunks (32 bytes on AVR,
 * about 36 STOPs; Adafruit_SSD1306.cpp display()), U8g2 into 24-byte ones
 * (u8x8_cad_ssd13xx_fast_i2c). Painting on every STOP converted the whole
 * 128x64 panel that many times per frame, on the thread the in-tab engines
 * run on, and only the last of those pictures was ever on screen. Every STOP
 * still schedules a paint, so what the frame shows is the panel after the
 * last transaction before it, exactly what the per-STOP paint left there.
 */
class VirtualSSD1306 implements I2CDevice {
  address: number;
  private readonly core: SSD1306Core;

  private ctrlByte = true;
  private isData = false;
  private readonly element: HTMLElement;
  private dirty = false;
  private rafId: number | null = null;

  constructor(address: number, element: HTMLElement) {
    this.address = address;
    this.element = element;
    this.core = coreFor(element);
  }

  /** Expose core buffer for tests. */
  get buffer(): Uint8Array {
    return this.core.buffer;
  }

  writeByte(value: number): boolean {
    if (this.ctrlByte) {
      this.isData = (value & 0x40) !== 0;
      this.ctrlByte = false;
      return true;
    }
    if (this.isData) {
      this.core.writeData(value);
    } else {
      this.core.writeCommand(value);
    }
    return true;
  }

  readByte(): number {
    return 0xff;
  }

  stop(): void {
    this.ctrlByte = true;
    this.dirty = true;
    if (this.rafId !== null) return;
    if (typeof requestAnimationFrame !== 'function') {
      // No frame clock (a worker, a test without a DOM): paint now.
      this.flush();
      return;
    }
    this.rafId = requestAnimationFrame(() => {
      this.rafId = null;
      this.flush();
    });
  }

  /** Paint the panel if a transaction ended since the last paint. */
  flush(): void {
    if (!this.dirty) return;
    this.dirty = false;
    this.core.syncElement(this.element);
  }

  /**
   * The part leaves the canvas or attaches again. What the last transaction
   * wrote is painted now, not dropped with the pending frame: a sketch that
   * stops right after its display() keeps its picture.
   */
  dispose(): void {
    if (this.rafId !== null) {
      if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.flush();
  }
}

/**
 * Attach SSD1306 in SPI mode.
 *
 * The panel is a write-only sink on its bus: it has no MISO pin at all, so it
 * answers null and lets the fabric resolve the line, and it takes a whole
 * block in one call when the controller clocks one (DESIGN 11). Chip select
 * is not its business either: the fabric hands it the frames clocked while
 * this panel is selected and nothing else, so a CS strapped to a rail is a
 * selection like any other instead of an edge that never comes.
 *
 * D/C stays a plain pin (F3 rule 6), read from its CURRENT level when the
 * part attaches: a panel that (re)attaches in the middle of a frame, while
 * the sketch holds D/C high, must keep decoding pixels, not commands.
 */
function attachSSD1306SPI(
  element: HTMLElement,
  simulator: any,
  getPin: (name: string) => number | null,
  componentId?: string,
): () => void {
  const pinManager = simulator?.pinManager;
  const core = coreFor(element);
  let dcState = false;
  const unsubs: (() => void)[] = [];

  // D/C: LOW = command, HIGH = data.
  const pinDC = getPin('DC');
  if (pinDC !== null && pinDC >= 0 && pinManager) {
    dcState = pinManager.peekPinState?.(pinDC) ?? false;
    unsubs.push(
      pinManager.onPinChange(pinDC, (_: number, s: boolean) => {
        dcState = s;
      }),
    );
  }

  // Throttle rendering to ~60 fps
  let dirty = false;
  let rafId: number | null = null;
  const scheduleSync = () => {
    if (rafId !== null) return;
    rafId = requestAnimationFrame(() => {
      rafId = null;
      if (dirty) {
        core.syncElement(element);
        dirty = false;
      }
    });
  };

  // A command repaints too: invert, contrast, display on/off and the scan
  // direction change the glass without a single data byte.
  const take = (value: number): void => {
    if (dcState) core.writeData(value);
    else core.writeCommand(value);
    dirty = true;
    scheduleSync();
  };

  // No deselect(): a real SSD1306 keeps its command parser across chip
  // select. Adafruit_SSD1306 sends a two-byte command as two transactions
  // (ssd1306_command1 per byte, CS toggled in between), and the panel on the
  // bench still reads the second byte as the parameter of the first.
  const device: SpiDevice = {
    transfer: (value: number): number | null => {
      take(value);
      return null;
    },
    transferBlock: (bytes: Uint8Array): void => {
      for (let i = 0; i < bytes.length; i++) take(bytes[i]);
    },
    boardReset: () => core.resetCommand(),
  };

  const handle = attachSpiDevice(
    {
      owner: componentId ?? (element as { id?: string }).id ?? 'ssd1306',
      componentId,
      pins: { sck: 'CLK', mosi: 'DATA', cs: 'CS' },
      // 4-wire SPI: the byte is latched on the rising edge of the clock,
      // which idles either way (datasheet 8.1.3).
      modes: [0, 3],
      // A module wired for SPI whose CS pad is left open is the only chip on
      // the bus: that is how the bench wires it, and how every project
      // migrated from the old ssd1306-spi entry is wired.
      csWhenFloating: 'selected',
    },
    device,
  );

  return () => {
    handle.dispose();
    if (rafId !== null) cancelAnimationFrame(rafId);
    unsubs.forEach((u) => u());
  };
}

/**
 * Internal: SSD1306 attach logic, parameterised over the wire protocol.
 * Called by the single `ssd1306` entry once the protocol has been resolved
 * (auto-detected from the wiring, or read from an explicit `protocol` property).
 */
function attachSSD1306(
  element: HTMLElement,
  simulator: unknown,
  getPin: (n: string) => number | null,
  protocol: 'i2c' | 'spi',
  i2cAddr = 0x3c,
  componentId?: string,
  /** The 8-pin module's I2C mode uses D1 (DATA) as SDA and D0 (CLK) as SCL;
   *  the 4-pin module names them. */
  i2cPins: { scl: string; sda: string } = { scl: 'CLK', sda: 'DATA' },
): () => void {
  if (protocol === 'spi') {
    return attachSSD1306SPI(element, simulator, getPin, componentId);
  }
  const device = new VirtualSSD1306(i2cAddr, element);
  // A QEMU board's worker only ACKs and echoes the writes, and this copy
  // draws from them.
  const part = attachI2cPart({
    simulator,
    componentId,
    device,
    pins: i2cPins,
    worker: {
      type: 'ssd1306',
      echo: (data) => {
        data.forEach((b: number) => device.writeByte(b));
        device.stop();
      },
    },
  });
  return () => {
    part.dispose();
    device.dispose();
  };
}


/**
 * Which wire protocol did the user build?  A real SSD1306 breakout is ONE board
 * that talks either I2C or SPI depending on how it is wired.  The definitive
 * SPI-only signal is chip-select (CS): I2C never uses it.  (DC deliberately does
 * NOT count — on the 8-pin module DC doubles as the I2C address-select/SA0 line,
 * so many I2C circuits wire it too.)  So CS wired to a GPIO => SPI, otherwise
 * I2C.  This mirrors the physical part — one component, no protocol switch to
 * set, just wire it up.
 *
 * Pure wiring check: the wires decide, never the simulator. Which board is
 * under the part says nothing about which of its two buses the user built.
 */
function detectSSD1306Protocol(getPin: (n: string) => number | null): 'i2c' | 'spi' {
  return getPin('CS') !== null ? 'spi' : 'i2c';
}

/**
 * SSD1306 OLED — a single component that works on every board with an I2C or
 * SPI bus (AVR, RP2040, ESP32, STM32).  New projects just wire it up and the
 * protocol is auto-detected from the wiring like the physical module; a
 * `protocol` property, when present, pins it explicitly (projects migrated from
 * the old ssd1306-i2c / ssd1306-spi entries carry it so their behaviour is
 * preserved exactly).  Consolidates the old three picker entries into one
 * (issues #101 / #215).
 */
PartSimulationRegistry.register('ssd1306', {
  attachEvents: (element, simulator, getPin, componentId) => {
    const { components } = useSimulatorStore.getState();
    const comp = components.find((c) => c.id === componentId);
    const i2cAddr = parseI2cAddress(comp?.properties?.i2cAddress, 0x3c);
    const explicit = comp?.properties?.protocol;
    const protocol: 'i2c' | 'spi' =
      explicit === 'i2c' || explicit === 'spi' ? explicit : detectSSD1306Protocol(getPin);
    return attachSSD1306(element, simulator, getPin, protocol, i2cAddr, componentId);
  },
});

/**
 * SSD1306 OLED (I2C, 4-pin) — the cheap `velxio-ssd1306-i2c` module (GND/VCC/
 * SCL/SDA). Same display core as the 8-pin part but I2C-only by construction,
 * so there's no protocol to detect. Issue #215.
 */
PartSimulationRegistry.register('ssd1306-i2c-4pin', {
  attachEvents: (element, simulator, getPin, componentId) => {
    const { components } = useSimulatorStore.getState();
    const comp = components.find((c) => c.id === componentId);
    const i2cAddr = parseI2cAddress(comp?.properties?.i2cAddress, 0x3c);
    return attachSSD1306(element, simulator, getPin, 'i2c', i2cAddr, componentId, {
      scl: 'SCL',
      sda: 'SDA',
    });
  },
});

// ─── DS1307 RTC ──────────────────────────────────────────────────────────────

/**
 * When the firmware on the canvas was compiled, for a clock that is set to
 * `__DATE__` and `__TIME__` (RtcCounters in I2CBusManager.ts). Read from the
 * images the store holds, every board's: a clock answers whichever board its
 * wires reach, and a time that matches to the second says which.
 */
function firmwareBuildTimes(): RtcDateTime[] {
  try {
    const { boards, compiledHex } = useSimulatorStore.getState();
    return buildTimesOfPrograms([
      ...(boards ?? []).map((board) => board.compiledProgram),
      // The single-board load paths (loadHex, loadBinary) leave it here only.
      compiledHex,
    ]);
  } catch {
    return [];
  }
}

/**
 * The compiled model of an I2C chip (buses/models/ds1307.c, ds3231.c,
 * bmp280.c, mpu6050.c) and the bytes the worker's record carries so the
 * worker runs the same one (project i2c-model-fidelity-2026-09, P5). Null
 * when the i2cwasm flag turns it off or it cannot be built: then the part
 * keeps its hand-written model and the worker its Python twin.
 */
function compiledModel(
  name: 'ds1307' | 'ds3231' | 'bmp280' | 'mpu6050',
): { module: WebAssembly.Module; b64: string } | null {
  if (!wasmI2cModelEnabled(name)) return null;
  const module = wasmI2cModule(name);
  const b64 = wasmI2cModelB64(name);
  return module && b64 ? { module, b64 } : null;
}

/**
 * DS1307 Real-Time Clock: buses/models/ds1307.c (VirtualDS1307 from
 * I2CBusManager behind the i2cwasm flag). The browser's time, until the
 * sketch sets one of its own.
 */
PartSimulationRegistry.register('ds1307', {
  attachEvents: (_element, simulator, _getPin, componentId) => {
    const compiled = compiledModel('ds1307');
    const dev = compiled
      ? new WasmDS1307(compiled.module, { buildTimes: firmwareBuildTimes })
      : new VirtualDS1307({ buildTimes: firmwareBuildTimes });
    const part = attachI2cPart({
      simulator,
      componentId,
      device: dev,
      worker: {
        type: 'ds1307',
        props: { ...hostClockRecord(), ...(compiled ? { wasmB64: compiled.b64 } : {}) },
      },
    });
    return () => {
      part.dispose();
      if (dev instanceof WasmDS1307) dev.dispose();
    };
  },
});

// ─── MPU-6050 IMU ────────────────────────────────────────────────────────────

/**
 * What the MPU-6050 does with a byte written to it, and how it turns motion
 * into counts, as one table. The model below works from it, the tests hold it
 * against the copy in test/fixtures/i2c-vectors/mpu6050.json, and the backend
 * twin (esp32_i2c_slaves.MPU6050Slave) follows the same facts. Sections are
 * those of the register map, RM-MPU-6000A-00 rev 4.2.
 */
export const MPU6050_RULES = {
  /**
   * Every register powers on at 0x00 but these: the factory trims, asleep,
   * and its id (section 3; AN-OFFS 7.2).
   */
  power_on: {
    // The accelerometer's factory trims (OTP): not zero on any part, and the
    // low bit of each low byte is not a trim but the product revision, which
    // InvenSense's eMPL mpu_init() reads (bit 0 of 0x07, 0x09, 0x0B; 2 is a
    // part at full sensitivity, 0 fails with -6). AN-OFFS section 7.2.
    0x06: 0xfa,
    0x07: 0x38,
    0x08: 0x04,
    0x09: 0xb3,
    0x0a: 0x05,
    0x0b: 0xdc,
    0x6b: 0x40,
    0x75: 0x68,
  },
  /**
   * Inclusive ranges a write leaves as they are: I2C_MST_STATUS, INT_STATUS,
   * the sample block with the external sensor data behind it, FIFO_COUNT
   * and WHO_AM_I (sections 4.13, 4.16 to 4.20, 4.30 and 4.32).
   */
  read_only: [
    [0x36, 0x36],
    [0x3a, 0x3a],
    [0x3b, 0x60],
    [0x72, 0x73],
    [0x75, 0x75],
  ],
  /**
   * Bits that start something and are never stored, so the next read finds
   * them at 0. All of SIGNAL_PATH_RESET, which is write-only (4.26). The
   * resets of USER_CTRL (4.27) and its bit 3, where i2cdevlib and InvenSense's
   * own driver reset the DMP; i2cdevlib sets one bit at a time with a
   * read-modify-write, so a bit that stuck would fire again on every later
   * write. DEVICE_RESET in PWR_MGMT_1 (4.28).
   */
  self_clearing: { 0x68: 0xff, 0x6a: 0x0f, 0x6b: 0x80 },
  /**
   * Counts per g by AFS_SEL (4.17) and per degree per second by FS_SEL
   * (4.19). The table and not 131 / 2^n, which gives 32.75 and 16.375: the
   * drivers divide by 32.8 and 16.4.
   */
  accel_lsb_per_g: [16384, 8192, 4096, 2048],
  gyro_lsb_per_dps: [131, 65.5, 32.8, 16.4],
  /**
   * What one count of the offset registers weighs. The gyro offsets
   * XG/YG/ZG_OFFS_USR (0x13-0x18) are in the +-1000 deg/s format, 32.8 per
   * deg/s (AN-OFFS 6.2). The accelerometer trims (0x06-0x0B) at 2048 per g,
   * the +-16 g format, bit 0 left out: the application note says +-8 g, but
   * the calibrations that converge on real parts write in +-16 g units
   * (i2cdevlib PID(): reading at +-2 g / 8; Luis Rodenas' MPU6050_calibration
   * the same), and at +-8 g their loop gain would be 2 and never settle.
   * Decision O3, pending a bench measurement. An offset counts from the
   * factory trim, so the chip at power-on reads the panel's values.
   */
  gyro_offset_lsb_per_dps: 32.8,
  accel_offset_lsb_per_g: 2048,
  /**
   * The high byte of the X, Y and Z accelerometer offset words, each word
   * big-endian with its low byte behind it (XA_OFFS_H to ZA_OFFS_L, AN-OFFS
   * 7.1). The factory trims of `power_on` are the bytes of these words.
   */
  accel_offs_reg: [0x06, 0x08, 0x0a],
  /** TEMP_OUT = (T - 36.53) * 340 (4.18). */
  temp_lsb_per_c: 340,
  temp_offset_c: 36.53,
  /**
   * What another die of the family changes, selected by the part's
   * `variant` property. The MPU-9250 (the Grove IMU 9DOF v2.0 and 10DOF
   * bricks) answers WHO_AM_I 0x71 and reads TEMP_OUT = (T - 21) * 333.87
   * (RM-MPU-9250A-00 rev 1.6, sections 4.22 and 4.39; PS-MPU-9250A-01 3.4.2).
   * Its accelerometer offsets are XA/YA/ZA_OFFSET_H/L at 0x77-0x78,
   * 0x7A-0x7B and 0x7D-0x7E, in the same +-16 g format with bit 0 reserved,
   * and 0x06-0x0B are not in its map (RM-MPU-9250A-00 rev 1.4, sections 3
   * and 4.39); the factory trims are loaded there, as Kris Winer's
   * calibrateMPU9250() reads them back. Its FIFO holds 512 bytes (PS
   * section 3.1, RM 4.17). It powers on awake: PWR_MGMT_1 resets to 0x01,
   * CLKSEL on the auto-selected clock and SLEEP clear (RM rev 1.4 section 3),
   * where the MPU-6050 resets to 0x40; decision D1 follows each die's map.
   * Its AK8963 magnetometer is not modelled.
   */
  variants: {
    mpu9250: {
      power_on: { 0x6b: 0x01 },
      who_am_i: 0x71,
      temp_lsb_per_c: 333.87,
      temp_offset_c: 21,
      accel_offs_reg: [0x77, 0x7a, 0x7d],
      fifo_size: 512,
    },
  },
  /**
   * Bits a read of the register takes with it: "each bit will clear after
   * the register is read" (4.16). With INT_RD_CLEAR set in INT_PIN_CFG, a
   * read of any register clears them (4.14).
   */
  clear_on_read: { 0x3a: 0xff },
  /**
   * Inclusive ranges the register pointer does not move past: FIFO_R_W reads
   * and writes the FIFO one byte per access (4.31), and MEM_R_W moves the DMP
   * memory address instead, so a DMP upload bursts into the memory and not
   * over FIFO_COUNT and WHO_AM_I behind it. A host that keeps a pointer of its
   * own (the Raspberry Pi relay) keeps it there too (I2CDevice.pointerStays).
   */
  pointer_stays: [
    [0x6f, 0x6f],
    [0x74, 0x74],
  ],
  /**
   * Inclusive ranges a copy of the registers cannot answer for, so a host
   * that mirrors them (the Raspberry Pi relay) asks the model for every read
   * that touches one (I2CDevice.volatileReads): INT_STATUS, which a read
   * clears and every sample sets; MEM_R_W, which moves the memory address;
   * FIFO_COUNT, which grows with time; FIFO_R_W, which pops a byte per read.
   */
  volatile_reads: [
    [0x3a, 0x3a],
    [0x6f, 0x6f],
    [0x72, 0x74],
  ],
  /**
   * The gyroscope output rate the sample rate is divided from, in Hz: 8 kHz
   * with the low-pass filter off (DLPF_CFG 0 or 7), 1 kHz with it on.
   * Sample rate = rate / (1 + SMPLRT_DIV) (4.2, 4.3).
   */
  gyro_rate_hz: { dlpf_off: 8000, dlpf_on: 1000 },
  /**
   * With CYCLE set (and SLEEP clear) the chip wakes at LP_WAKE_CTRL
   * (PWR_MGMT_2 bits 7:6) to take one sample and sleeps between (4.28, 4.29).
   */
  cycle_rate_hz: [1.25, 5, 20, 40],
  /** How long INT stays active per interrupt with LATCH_INT_EN clear (4.14). */
  int_pulse_us: 50,
  /** Bytes the FIFO holds; past that the oldest go and FIFO_OFLOW_INT is set (4.31, PS 7.17). */
  fifo_size: 1024,
  /**
   * The DMP memory behind BANK_SEL (0x6D), MEM_START_ADDR (0x6E) and MEM_R_W
   * (0x6F): 32 banks of 256 bytes, the bank field of BANK_SEL being 5 bits
   * (i2cdevlib setMemoryBank, InvenSense eMPL mpu_write_mem). Undocumented
   * in the register map.
   */
  dmp_banks: 32,
  /**
   * DMP memory that is not zero at power-on, by bank * 256 + address: the
   * hardware revision i2cdevlib's dmpInitialize() reads at user bank 16,
   * byte 6. Parts report 0xA5 or 0x4D there (jrowberg/i2cdevlib issues 246
   * and 371); 0xA5 is the one in its MotionApps comments.
   */
  dmp_rom: { 0x1006: 0xa5 },
  /**
   * The rate the DMP runs at, in Hz, and where in its memory the divider of
   * its FIFO output sits (D_0_22, bank 2 byte 0x16, a big-endian word): it
   * writes a packet every 1 + divider of its own periods. "DMP output
   * frequency is calculated easily using this equation: (200Hz / (1 +
   * value))" (i2cdevlib MotionApps20 dmpConfig; eMPL
   * inv_mpu_dmp_motion_driver.c DMP_SAMPLE_RATE and dmp_set_fifo_rate).
   */
  dmp_rate_hz: 200,
  dmp_rate_div_at: 0x216,
  /**
   * The DMP images the model runs, told apart by the 16 bytes at the
   * program start address the sketch writes to DMP_CFG_1/2 (0x70-0x71), and
   * the packet each one writes to the FIFO while USER_CTRL has DMP_EN and
   * FIFO_EN set. `layout` is the packet as fields in order, each big-endian:
   * quat32 is w, x, y, z as 32-bit q30 (1.0 = 2^30), gyro32 and accel32 are
   * three 32-bit words with the counts in the high half, gyro16 and accel16
   * three 16-bit counts, mag16 three 16-bit zeros (no magnetometer is
   * modelled), footer two zero bytes. The gyroscope is in the counts
   * GYRO_CONFIG selects; the accelerometer at `accel_lsb_per_g`, or in the
   * counts ACCEL_CONFIG selects where that is null. Sizes and field places
   * are those of i2cdevlib's packet diagrams and dmpGet*() readers:
   * MPU6050_6Axis_MotionApps20 (42 bytes, "+1g = +8192 in standard DMP FIFO
   * packet"), MPU6050_9Axis_MotionApps41 of the MPU-9150 (48 bytes, 4096 per
   * g), MPU6050_6Axis_MotionApps612 (28 bytes, raw accelerometer, "+1g =
   * +16384" at the 2 g range it selects). The 2.0 and 4.1 images both start
   * at 0x0300 and 6.12 at 0x0400.
   */
  dmp_images: {
    motionapps20: {
      start: 0x300,
      signature: 'D8 DC BA A2 F1 DE B2 B8 B4 A8 81 91 F7 4A 90 7F',
      layout: 'quat32 gyro32 accel32 footer',
      accel_lsb_per_g: 8192,
    },
    motionapps41: {
      start: 0x300,
      signature: 'D8 DC F4 D8 B9 AB F3 F8 FA F1 BA A2 DE B2 B8 B4',
      layout: 'quat32 gyro32 mag16 accel32 footer',
      accel_lsb_per_g: 4096,
    },
    motionapps612: {
      start: 0x400,
      signature: 'D8 DC B4 B8 B0 D8 B9 AB F3 F8 FA B3 B7 BB 8E 9E',
      layout: 'quat32 accel16 gyro16',
      accel_lsb_per_g: null,
    },
  },
} as const;

/** The dies the model answers as: `mpu6050`, or one of MPU6050_RULES.variants. */
export type Mpu6050Variant = 'mpu6050' | keyof typeof MPU6050_RULES.variants;

/**
 * The part's `variant` property (the worker record's too, see
 * esp32_i2c_slaves.parse_variant): a die of MPU6050_RULES.variants, spelled
 * with or without the dash, or the MPU-6050.
 */
export function parseMpuVariant(value: unknown): Mpu6050Variant {
  if (typeof value !== 'string') return 'mpu6050';
  const v = value.trim().toLowerCase().replace(/-/g, '');
  return v in MPU6050_RULES.variants ? (v as Mpu6050Variant) : 'mpu6050';
}

/** Motion and temperature at the chip, under the names of the panel's sliders. */
export interface Mpu6050Inputs {
  /** g */
  accelX: number;
  accelY: number;
  accelZ: number;
  /** degrees per second */
  gyroX: number;
  gyroY: number;
  gyroZ: number;
  /** degrees Celsius */
  temp: number;
}

const MPU6050_INPUT_KEYS = [
  'accelX',
  'accelY',
  'accelZ',
  'gyroX',
  'gyroY',
  'gyroZ',
  'temp',
] as const;

/** XG_OFFS_USR_H: three signed words, X, Y, Z, of gyro offset. */
const MPU_XG_OFFS_USR = 0x13;
const MPU_SMPLRT_DIV = 0x19;
const MPU_CONFIG = 0x1a;
const MPU_GYRO_CONFIG = 0x1b;
const MPU_ACCEL_CONFIG = 0x1c;
const MPU_INT_PIN_CFG = 0x37;
/** Active low, against active high. */
const MPU_INT_LEVEL = 0x80;
/** Open drain, against push-pull. */
const MPU_INT_OPEN = 0x40;
/** Held until the interrupt is cleared, against a pulse. */
const MPU_LATCH_INT_EN = 0x20;
const MPU_INT_RD_CLEAR = 0x10;
const MPU_INT_ENABLE = 0x38;
const MPU_INT_STATUS = 0x3a;
const MPU_DATA_RDY_INT = 0x01;
/** A DMP packet reached the FIFO (i2cdevlib MPU6050_INTERRUPT_DMP_INT_BIT). */
const MPU_DMP_INT = 0x02;
const MPU_FIFO_OFLOW_INT = 0x10;
/** The interrupt sources the model raises, as bits of INT_ENABLE and INT_STATUS. */
const MPU_INT_SOURCES = MPU_DATA_RDY_INT | MPU_DMP_INT | MPU_FIFO_OFLOW_INT;
/** The sources a sample raises. */
const MPU_SAMPLE_INTS = MPU_DATA_RDY_INT | MPU_FIFO_OFLOW_INT;
/** The sources a DMP packet raises. */
const MPU_DMP_INTS = MPU_DMP_INT | MPU_FIFO_OFLOW_INT;
const MPU_FIFO_EN = 0x23;
/**
 * The FIFO_EN bits in the order their data enters the FIFO, which is the
 * order of the registers (4.6, 4.31): ACCEL (0x3B-0x40), TEMP, XG, YG, ZG, as
 * [bit, offset in the sample block, bytes]. SLV0-2 push the external sensor
 * data of the auxiliary master, which the model has none of.
 */
const MPU_FIFO_SOURCES: ReadonlyArray<readonly [number, number, number]> = [
  [0x08, 0, 6],
  [0x80, 6, 2],
  [0x40, 8, 2],
  [0x20, 10, 2],
  [0x10, 12, 2],
];
const MPU_FIFO_COUNT_H = 0x72;
const MPU_FIFO_COUNT_L = 0x73;
const MPU_FIFO_R_W = 0x74;
/** USER_CTRL: the FIFO takes samples, and the trigger that empties it (4.27). */
const MPU_USER_FIFO_EN = 0x40;
const MPU_FIFO_RESET = 0x04;
/** USER_CTRL: the DMP runs, and the trigger that restarts it (i2cdevlib setDMPEnabled, resetDMP). */
const MPU_USER_DMP_EN = 0x80;
const MPU_DMP_RESET = 0x08;
/** DMP_CFG_1 and DMP_CFG_2: the DMP program start address, high byte first. */
const MPU_DMP_CFG_1 = 0x70;
/** The DMP memory port: bank, address in the bank, and the byte there. */
const MPU_BANK_SEL = 0x6d;
const MPU_MEM_START_ADDR = 0x6e;
const MPU_MEM_R_W = 0x6f;
/** ACCEL_XOUT_H to GYRO_ZOUT_L: three axes, the die temperature, three axes. */
const MPU_SAMPLE_FIRST = 0x3b;
const MPU_SAMPLE_LAST = 0x48;
const MPU_USER_CTRL = 0x6a;
const MPU_SIG_COND_RESET = 0x01;
const MPU_PWR_MGMT_1 = 0x6b;
const MPU_DEVICE_RESET = 0x80;
const MPU_SLEEP = 0x40;
const MPU_WHO_AM_I = 0x75;
const MPU_CYCLE = 0x20;
const MPU_TEMP_DIS = 0x08;
/**
 * PWR_MGMT_2: LP_WAKE_CTRL in bits 7:6, then STBY_XA, YA, ZA, XG, YG, ZG
 * (4.29). The standby bits as the fields of the sample block they freeze
 * (ax, ay, az, temp, gx, gy, gz: bit n is field n).
 */
const MPU_PWR_MGMT_2 = 0x6c;
const MPU_STBY_FIELDS: ReadonlyArray<readonly [number, number]> = [
  [0x20, 0x01],
  [0x10, 0x02],
  [0x08, 0x04],
  [0x04, 0x10],
  [0x02, 0x20],
  [0x01, 0x40],
];
const MPU_TEMP_FIELD = 0x08;
const MPU_ALL_FIELDS = 0x7f;

/**
 * The accelerometer's factory trims, X, Y, Z, as the power-on bytes of the
 * MPU-6050's offset words: [high byte, low byte].
 */
const MPU_FACTORY_TRIM: ReadonlyArray<readonly [number, number]> =
  MPU6050_RULES.accel_offs_reg.map((at) => {
    const p = MPU6050_RULES.power_on as Record<number, number>;
    return [p[at] ?? 0, p[at + 1] ?? 0] as const;
  });
const MPU_READ_ONLY = new Uint8Array(256);
for (const [first, last] of MPU6050_RULES.read_only) MPU_READ_ONLY.fill(1, first, last + 1);
const MPU_SELF_CLEARING = new Uint8Array(256);
for (const [reg, mask] of Object.entries(MPU6050_RULES.self_clearing)) {
  MPU_SELF_CLEARING[Number(reg)] = mask;
}
/** The registers of inclusive ranges of the rules table, in order. */
const mpuRegistersOf = (ranges: readonly (readonly [number, number])[]): number[] =>
  ranges.flatMap(([first, last]) =>
    Array.from({ length: last - first + 1 }, (_, i) => first + i),
  );
/** Registers the pointer stays on after each byte (MPU6050_RULES.pointer_stays). */
const MPU_POINTER_STAYS = new Uint8Array(256);
for (const reg of mpuRegistersOf(MPU6050_RULES.pointer_stays)) MPU_POINTER_STAYS[reg] = 1;
const MPU_CLEAR_ON_READ = new Uint8Array(256);
for (const [reg, mask] of Object.entries(MPU6050_RULES.clear_on_read)) {
  MPU_CLEAR_ON_READ[Number(reg)] = mask;
}
const MPU_INT_PULSE_NS = MPU6050_RULES.int_pulse_us * 1000;

/** A DMP image the model runs (MPU6050_RULES.dmp_images). */
interface MpuDmpImage {
  start: number;
  signature: readonly number[];
  layout: readonly string[];
  size: number;
  accelLsbPerG: number | null;
}
/** Bytes of each field of a packet layout. */
const MPU_DMP_FIELD_BYTES: Readonly<Record<string, number>> = {
  quat32: 16,
  gyro32: 12,
  accel32: 12,
  gyro16: 6,
  accel16: 6,
  mag16: 6,
  footer: 2,
};
const MPU_DMP_IMAGES: readonly MpuDmpImage[] = Object.values(MPU6050_RULES.dmp_images).map(
  (image) => {
    const layout = image.layout.split(' ');
    return {
      start: image.start,
      signature: image.signature.split(' ').map((b) => parseInt(b, 16)),
      layout,
      size: layout.reduce((n, field) => n + MPU_DMP_FIELD_BYTES[field], 0),
      accelLsbPerG: image.accel_lsb_per_g,
    };
  },
);

/**
 * The orientation the DMP reports, as the unit quaternion w, x, y, z that
 * turns the chip's axes into the world's (i2cdevlib dmpGetGravity reads the
 * gravity the chip feels as its third row). The tilt is the shortest turn
 * that takes the accelerometer's direction to the vertical, so the gravity
 * i2cdevlib works out of it is the panel's accelerometer, and pitch and roll
 * follow the sliders; the heading is `yaw` about the vertical, integrated
 * from the gyroscope. Upside down exactly, the turn is about X. The Python
 * twin (esp32_i2c_slaves.mpu_dmp_quaternion) does the same operations in the
 * same order, so both write the same packets.
 */
function mpuDmpQuaternion(
  ax: number,
  ay: number,
  az: number,
  yaw: number,
): [number, number, number, number] {
  const n = Math.sqrt(ax * ax + ay * ay + az * az);
  let tw = 1;
  let tx = 0;
  let ty = 0;
  if (n > 0) {
    tw = 1 + az / n;
    tx = ay / n;
    ty = -ax / n;
    const m = Math.sqrt(tw * tw + tx * tx + ty * ty);
    if (m < 1e-9) {
      tw = 0;
      tx = 1;
      ty = 0;
    } else {
      tw /= m;
      tx /= m;
      ty /= m;
    }
  }
  const c = Math.cos(yaw / 2);
  const s = Math.sin(yaw / 2);
  // (c, 0, 0, s) times (tw, tx, ty, 0): the heading after the tilt.
  return [c * tw, c * tx - s * ty, c * ty + s * tx, s * tw];
}

/**
 * How far the heading turns in one DMP period, in radians: the rate about
 * the vertical, which is the gyroscope along the accelerometer's direction.
 * The counts of both are those of the sample block.
 */
function mpuDmpHeadingStep(block: Uint8Array, gyroLsb: number, periodNs: number): number {
  const w = (i: number) => (((block[2 * i] << 8) | block[2 * i + 1]) << 16) >> 16;
  const [ax, ay, az, gx, gy, gz] = [w(0), w(1), w(2), w(4), w(5), w(6)];
  const n = Math.sqrt(ax * ax + ay * ay + az * az);
  if (n === 0) return 0;
  const rate = (gx * ax + gy * ay + gz * az) / n / gyroLsb;
  return ((rate * periodNs) / 1e9) * (Math.PI / 180);
}

/** A q30 fraction (1.0 = 2^30) as a 32-bit word, half away from zero, held to the word. */
function mpuQ30(value: number): number {
  const q = Math.sign(value) * Math.round(Math.abs(value) * 1073741824);
  return Math.max(-2147483648, Math.min(2147483647, q));
}

/**
 * One packet of `image` as the DMP writes it to the FIFO, from the sample
 * block (the counts the output registers hold, offsets applied) and the
 * heading. `accelLsb` is the counts per g the block's accelerometer is in.
 */
function mpuDmpPacket(
  image: MpuDmpImage,
  block: Uint8Array,
  accelLsb: number,
  yaw: number,
): number[] {
  const w = (i: number) => (((block[2 * i] << 8) | block[2 * i + 1]) << 16) >> 16;
  const accel = [w(0), w(1), w(2)];
  const gyro = [w(4), w(5), w(6)];
  const dmpAccel =
    image.accelLsbPerG === null
      ? accel
      : accel.map((c) => mpuCounts((c * image.accelLsbPerG!) / accelLsb));
  const out: number[] = [];
  const word32 = (v: number) => out.push((v >> 24) & 0xff, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff);
  const word16 = (v: number) => out.push((v >> 8) & 0xff, v & 0xff);
  for (const field of image.layout) {
    if (field === 'quat32') {
      for (const v of mpuDmpQuaternion(accel[0], accel[1], accel[2], yaw)) word32(mpuQ30(v));
    } else if (field === 'gyro32') {
      for (const c of gyro) word32(c * 65536);
    } else if (field === 'accel32') {
      for (const c of dmpAccel) word32(c * 65536);
    } else if (field === 'gyro16') {
      for (const c of gyro) word16(c);
    } else if (field === 'accel16') {
      for (const c of dmpAccel) word16(c);
    } else {
      for (let i = 0; i < MPU_DMP_FIELD_BYTES[field]; i++) out.push(0);
    }
  }
  return out;
}

/** What the INT pad does to its line: it drives it, or lets go of it (open drain). */
export type Mpu6050IntPad = 'high' | 'low' | 'z';

/**
 * What the part needs of an MPU-6050 model: VirtualMPU6050 below, or the
 * compiled buses/models/mpu6050.c (WasmMPU6050, simulation/parts/
 * wasmI2cModels.ts) that the part runs by default.
 */
export interface Mpu6050Model extends I2CDevice {
  onAsleepRead: (() => void) | null;
  onDmpUnknown: (() => void) | null;
  onIntChange: (() => void) | null;
  setInputs(values: Record<string, unknown>): void;
  getInputs(): Mpu6050Inputs;
  intPad(): Mpu6050IntPad;
  intWakeNs(): number | null;
  readonly guestClock: GuestClock | null;
}

/**
 * A physical value as the counts of a 16-bit output register. Half a count
 * rounds away from zero, so a tilt one way and the same tilt the other way
 * read the same size (Math.round sends -65.5 to -65), and what does not fit
 * stays at the end of the scale, as the converter's output does.
 */
function mpuCounts(value: number): number {
  const counts = Math.sign(value) * Math.round(Math.abs(value));
  return Math.max(-32768, Math.min(32767, counts));
}

/**
 * Virtual MPU-6050: the 6-axis IMU, modelled where a driver can tell the
 * difference from the chip.
 *
 *  - It powers on asleep (PWR_MGMT_1 = 0x40), so a sketch that reads without
 *    waking it reads zeros, as it does on the bench.
 *  - DEVICE_RESET puts every register back to its power-on value and is gone
 *    before the next read. Adafruit_MPU6050::reset() polls that bit with no
 *    timeout: while it was stored like any other byte, begin() never returned.
 *  - What the panel sets is the world around the chip, not a register: it
 *    survives a reset, and the sample block 0x3B-0x48 is worked out from it
 *    and from the full-scale ranges the sketch selected, when a read begins.
 *    The whole burst is answered from that one sample (4.17), so a slider
 *    moving while it is read cannot mix two instants.
 *  - Asleep, the block holds what it held when the chip fell asleep. So does
 *    an axis in standby (PWR_MGMT_2) and the temperature with TEMP_DIS; in
 *    CYCLE mode the block moves only at each wake-up, at LP_WAKE_CTRL.
 *  - Awake, it takes a sample every sample period of the guest's time
 *    (setClock), whether the sketch talks to it or not. Each one sets
 *    DATA_RDY_INT, which a read of INT_STATUS clears, and with DATA_RDY_EN
 *    set moves the INT pad the way INT_PIN_CFG says. Nothing runs in the
 *    background for it: the samples due are counted when the chip is next
 *    looked at, from the time that has passed. On a board that keeps no time
 *    one period passes per register pointer the sketch writes, so a driver
 *    that waits for DATA_RDY still finds it.
 *  - With USER_CTRL.FIFO_EN set, each sample also pushes the sources FIFO_EN
 *    selects into the FIFO (1024 bytes, 512 on the MPU-9250), in register
 *    order. FIFO_COUNT is latched when its high byte is read, and FIFO_R_W
 *    pops a byte per read without moving the pointer (an empty FIFO repeats
 *    the last one), so the FIFO
 *    calibrations of FastIMU and Kris Winer average real packets instead of
 *    dividing by a count of zero.
 *  - BANK_SEL, MEM_START_ADDR and MEM_R_W reach 32 banks of DMP memory, the
 *    address advancing within its bank and the pointer staying on MEM_R_W,
 *    with the ROM byte i2cdevlib reads as the hardware revision.
 *  - With DMP_EN and FIFO_EN set in USER_CTRL, a DMP image it knows (the
 *    MotionApps 2.0, 4.1 and 6.12 images of i2cdevlib, told apart at the
 *    program start address of DMP_CFG_1/2) writes its packets into the FIFO
 *    at the rate the image's divider sets, on the guest's clock, and raises
 *    DMP_INT for each. The packet carries the orientation of the panel: the
 *    tilt of the accelerometer and a heading integrated from the gyroscope,
 *    which DMP_RESET and every start of the DMP put back to zero. An image
 *    it does not know writes nothing, and the monitor is told once per run
 *    (onDmpUnknown).
 */
export class VirtualMPU6050 implements Mpu6050Model {
  address: number;
  /** The sample block was read while the chip sleeps, for the first time in this run. */
  onAsleepRead: (() => void) | null = null;
  /** The sketch started the DMP on an image the model does not run, for the first time in this run. */
  onDmpUnknown: (() => void) | null = null;
  /**
   * What the INT pad does, or the time it moves next, may have changed: the
   * host that drives the pin reads intPad() and intWakeNs() again.
   */
  onIntChange: (() => void) | null = null;
  /** What a copy of dumpRegisters() cannot answer (MPU6050_RULES.volatile_reads). */
  readonly volatileReads: readonly number[] = mpuRegistersOf(MPU6050_RULES.volatile_reads);
  /** The ports the pointer stays on: MEM_R_W and FIFO_R_W (MPU6050_RULES.pointer_stays). */
  readonly pointerStays: readonly number[] = mpuRegistersOf(MPU6050_RULES.pointer_stays);

  private readonly regs = new Uint8Array(256);
  private readonly inputs: Mpu6050Inputs = {
    accelX: 0,
    accelY: 0,
    accelZ: 1,
    gyroX: 0,
    gyroY: 0,
    gyroZ: 0,
    temp: 24,
  };
  /** The sample the read in progress is answered from. */
  private readonly sample = new Uint8Array(MPU_SAMPLE_LAST - MPU_SAMPLE_FIRST + 1);
  /**
   * What the fields that do not sample hold: the block as it was when SLEEP,
   * a standby bit or TEMP_DIS stopped them, or at the last CYCLE wake-up.
   * Zeros after power-on and reset.
   */
  private readonly held = new Uint8Array(MPU_SAMPLE_LAST - MPU_SAMPLE_FIRST + 1);
  /** No START was heard for the read that comes next: latch on its first byte. */
  private latchDue = true;
  private asleepReadSaid = false;
  private regPtr = 0;
  private firstByte = true;
  private clock: GuestClock | null = null;
  /**
   * The guest time the sample periods are counted from, in ns: when the chip
   * woke up, or its rate changed. Null until the chip is next looked at.
   */
  private epochNs: number | null = null;
  /** Samples taken since the epoch. */
  private taken = 0;
  /** The period `taken` was counted with. */
  private periodNs = 0;
  /** Where the INT pulse of the last sample ends; null when there is none. */
  private pulseEndNs: number | null = null;
  /** The FIFO: a ring of the die's fifo_size bytes, `fifoCount` of them from `fifoHead`. */
  private readonly fifo: Uint8Array;
  private fifoHead = 0;
  private fifoCount = 0;
  /** What an empty FIFO answers: the byte read last (4.31). */
  private fifoLast = 0;
  private readonly dmpMem = new Uint8Array(MPU6050_RULES.dmp_banks * 256);
  private dmpUnknownSaid = false;
  /** The image the DMP runs, while it writes packets; null while it writes none. */
  private dmpImage: MpuDmpImage | null = null;
  /** The packet period of the running image, in ns. */
  private dmpPeriodNs = 0;
  /** As epochNs and taken, for the DMP's packets. */
  private dmpEpochNs: number | null = null;
  private dmpTaken = 0;
  /** The heading the DMP has integrated since it started, in radians. */
  private dmpYaw = 0;

  /** What the die changes of the MPU-6050's map (MPU6050_RULES.variants). */
  private readonly die: {
    /** Power-on values of the die that differ from the MPU-6050's. */
    power_on: Readonly<Record<number, number>>;
    who_am_i: number;
    temp_lsb_per_c: number;
    temp_offset_c: number;
    accel_offs_reg: readonly number[];
    fifo_size: number;
  };

  constructor(address: number, variant: Mpu6050Variant = 'mpu6050') {
    this.address = address;
    this.die =
      variant === 'mpu6050'
        ? {
            power_on: {},
            who_am_i: MPU6050_RULES.power_on[0x75],
            temp_lsb_per_c: MPU6050_RULES.temp_lsb_per_c,
            temp_offset_c: MPU6050_RULES.temp_offset_c,
            accel_offs_reg: MPU6050_RULES.accel_offs_reg,
            fifo_size: MPU6050_RULES.fifo_size,
          }
        : MPU6050_RULES.variants[variant];
    this.fifo = new Uint8Array(this.die.fifo_size);
    this.powerOn();
  }

  /** The clock of the board the chip is on, or null when it is on no bus. */
  setClock(clock: GuestClock | null): void {
    this.clock = clock;
    this.restartSampling();
    this.onIntChange?.();
  }

  /** For the host that times the INT pin: the clock the chip keeps. */
  get guestClock(): GuestClock | null {
    return this.clock;
  }

  /** The panel moved. Only the values it names change. */
  setInputs(values: Record<string, unknown>): void {
    // The samples due until now were taken of the world as it was.
    this.sync();
    for (const key of MPU6050_INPUT_KEYS) {
      const v = values[key];
      if (typeof v === 'number' && Number.isFinite(v)) this.inputs[key] = v;
    }
  }

  getInputs(): Mpu6050Inputs {
    return { ...this.inputs };
  }

  start(read: boolean): void {
    this.sync();
    if (read) this.latch();
    this.onIntChange?.();
  }

  writeByte(value: number): boolean {
    // For a host that does not say where a read begins: after a write, the
    // next byte read is the first of a new read.
    this.latchDue = true;
    if (this.firstByte) {
      this.regPtr = value & 0xff;
      this.firstByte = false;
      // Every register access starts with a pointer, on every host and in
      // both ways a repeated START is delivered: where there is no time to
      // read, this is the chip's tick.
      if (this.nowNs() === null) this.tick();
      else this.sync();
      return true;
    }
    this.sync();
    const reg = this.regPtr;
    this.regPtr = MPU_POINTER_STAYS[reg] ? reg : (reg + 1) & 0xff;
    this.writeRegister(reg, value & 0xff);
    this.onIntChange?.();
    return true;
  }

  readByte(): number {
    this.sync();
    if (this.latchDue) this.latch();
    const reg = this.regPtr;
    this.regPtr = MPU_POINTER_STAYS[reg] ? reg : (reg + 1) & 0xff;
    const value = this.readRegister(reg);
    // What the read takes with it goes at the read, not at the STOP: QEMU
    // ends a transfer before a repeated START, and a driver may never send
    // one (section "Principles" of the project's design).
    const cleared =
      (this.regs[MPU_INT_PIN_CFG] & MPU_INT_RD_CLEAR) !== 0 ? 0xff : MPU_CLEAR_ON_READ[reg];
    if (cleared !== 0 && (this.regs[MPU_INT_STATUS] & cleared) !== 0) {
      this.regs[MPU_INT_STATUS] &= ~cleared;
      this.onIntChange?.();
    }
    return value;
  }

  /**
   * The pointer survives the STOP: i2cdevlib writes it in one transaction and
   * reads in the next, and QEMU ends every write phase this way.
   */
  stop(): void {
    this.firstByte = true;
    this.latchDue = true;
  }

  /**
   * A new run reads a chip that is still asleep: its monitor is told as well.
   * The chip kept its supply and goes on sampling, but the guest's counter
   * started again, so the periods are counted from where it stands now.
   */
  boardReset(): void {
    this.asleepReadSaid = false;
    this.dmpUnknownSaid = false;
    this.restartSampling();
    this.onIntChange?.();
  }

  /**
   * The registers as a read would find them now: the sample block encoded
   * from the panel's values (or what a sleeping chip holds), and no trigger
   * bit. A host that answers its guest from a copy (the Raspberry Pi relay)
   * mirrors this. Nothing is cleared by it: it is not a read on the bus.
   */
  dumpRegisters(): Uint8Array {
    this.sync();
    const out = this.regs.slice();
    out.set(this.output(), MPU_SAMPLE_FIRST);
    // The count as it stands, not as a read of the high byte last latched it.
    out[MPU_FIFO_COUNT_H] = this.fifoCount >> 8;
    out[MPU_FIFO_COUNT_L] = this.fifoCount & 0xff;
    return out;
  }

  /**
   * What the INT pad does at this instant. Active is high or low by
   * INT_LEVEL; an open-drain pad (INT_OPEN) only ever pulls low, and lets go
   * where a push-pull one would drive high (4.14).
   */
  intPad(): Mpu6050IntPad {
    this.sync();
    const cfg = this.regs[MPU_INT_PIN_CFG];
    const high = this.intActive() !== ((cfg & MPU_INT_LEVEL) !== 0);
    if (!high) return 'low';
    return (cfg & MPU_INT_OPEN) !== 0 ? 'z' : 'high';
  }

  /**
   * The guest time, in ns, at which the pad moves next with nobody touching
   * the chip: the end of the pulse under way, or the next sample that will
   * raise an enabled interrupt. Null when nothing is due: a latched
   * interrupt waits for the sketch, and so does a board with no clock.
   */
  intWakeNs(): number | null {
    // Asleep, nothing moves: no sample, and going to sleep ended any pulse.
    if (!this.sampling) return null;
    this.sync();
    const now = this.nowNs();
    if (now === null) return null;
    if (this.latched) {
      if (this.intActive()) return null;
    } else if (this.pulseEndNs !== null && now < this.pulseEndNs) {
      return this.pulseEndNs;
    }
    const enabled = this.regs[MPU_INT_ENABLE];
    let next: number | null = null;
    if (this.epochNs !== null && (enabled & MPU_SAMPLE_INTS) !== 0) {
      next = this.epochNs + (this.taken + 1) * this.periodNs;
    }
    if (this.dmpImage && this.dmpEpochNs !== null && (enabled & MPU_DMP_INTS) !== 0) {
      const packet = this.dmpEpochNs + (this.dmpTaken + 1) * this.dmpPeriodNs;
      if (next === null || packet < next) next = packet;
    }
    return next;
  }

  private get asleep(): boolean {
    return (this.regs[MPU_PWR_MGMT_1] & MPU_SLEEP) !== 0;
  }

  /** Whether the chip takes samples: not while it sleeps. */
  private get sampling(): boolean {
    return !this.asleep;
  }

  /** LATCH_INT_EN: INT is held until the interrupt is cleared, not pulsed. */
  private get latched(): boolean {
    return (this.regs[MPU_INT_PIN_CFG] & MPU_LATCH_INT_EN) !== 0;
  }

  /** Whether the chip signals an interrupt on INT at this instant. */
  private intActive(): boolean {
    if (this.latched) {
      return (this.regs[MPU_INT_STATUS] & this.regs[MPU_INT_ENABLE] & MPU_INT_SOURCES) !== 0;
    }
    const now = this.nowNs();
    return this.pulseEndNs !== null && now !== null && now < this.pulseEndNs;
  }

  /** The guest's time in ns, or null on a board that keeps none. */
  private nowNs(): number | null {
    const clock = this.clock;
    if (!clock) return null;
    const hz = clock.clockHz();
    if (!(hz > 0)) return null;
    // Multiplied first: a whole number of ns comes out whole, so a period
    // ends on the cycle it ends on and not one float step either side.
    return (clock.now() * 1e9) / hz;
  }

  /** The sample period the registers select, in ns (4.2). */
  private samplePeriodNs(): number {
    if (this.cycling) {
      return 1e9 / MPU6050_RULES.cycle_rate_hz[this.regs[MPU_PWR_MGMT_2] >> 6];
    }
    const dlpf = this.regs[MPU_CONFIG] & 0x07;
    const rate =
      dlpf === 0 || dlpf === 7
        ? MPU6050_RULES.gyro_rate_hz.dlpf_off
        : MPU6050_RULES.gyro_rate_hz.dlpf_on;
    return ((1 + this.regs[MPU_SMPLRT_DIV]) * 1e9) / rate;
  }

  /**
   * The sample periods are counted from this instant: the chip woke up, its
   * rate changed, or the clock it measures on did. Where the time cannot be
   * read yet, from the next look at the chip.
   */
  private restartSampling(): void {
    this.epochNs = this.sampling ? this.nowNs() : null;
    this.taken = 0;
    this.periodNs = this.samplePeriodNs();
    this.pulseEndNs = null;
    this.dmpEpochNs = this.dmpImage ? this.nowNs() : null;
    this.dmpTaken = 0;
  }

  /**
   * Take the samples that came due since the chip was last looked at. It is
   * called before anything reads or changes what a sample depends on, so
   * every sample is taken of the registers and the world of its own instant.
   */
  private sync(): void {
    if (!this.sampling) return;
    const now = this.nowNs();
    if (now === null) {
      // No time to measure on: the periods are the ticks of writeByte.
      this.epochNs = null;
      this.dmpEpochNs = null;
      return;
    }
    this.syncSamples(now);
    this.syncDmp(now);
  }

  private syncSamples(now: number): void {
    const period = this.periodNs;
    if (this.epochNs === null || now < this.epochNs) {
      // A clock that was not there when the chip woke, or one that started
      // again: the first sample is one period from here.
      this.epochNs = now;
      this.taken = 0;
      return;
    }
    const due = Math.floor((now - this.epochNs) / period);
    if (due <= this.taken) return;
    const n = due - this.taken;
    this.taken = due;
    this.sampled(n, this.epochNs + due * period);
  }

  /** The DMP's packets that came due, counted as the samples are. */
  private syncDmp(now: number): void {
    if (!this.dmpImage) return;
    if (this.dmpEpochNs === null || now < this.dmpEpochNs) {
      this.dmpEpochNs = now;
      this.dmpTaken = 0;
      return;
    }
    const due = Math.floor((now - this.dmpEpochNs) / this.dmpPeriodNs);
    if (due <= this.dmpTaken) return;
    const n = due - this.dmpTaken;
    this.dmpTaken = due;
    this.dmpPackets(n, this.dmpEpochNs + due * this.dmpPeriodNs);
  }

  /**
   * One sample period passed, on a board where nothing measures it. A DMP
   * that runs writes one packet in it, so a driver that waits for one
   * still finds it.
   */
  private tick(): void {
    if (!this.sampling) return;
    this.sampled(1, null);
    if (this.dmpImage) this.dmpPackets(1, null);
  }

  /** `n` samples were taken, the last of them at `atNs` of the guest's time. */
  private sampled(n: number, atNs: number | null): void {
    // A CYCLE wake-up samples what is not in standby, and holds it until the next.
    if (this.cycling) {
      const live = this.encode();
      const stby = this.standbyFields();
      for (let f = 0; f < 7; f++) {
        if (!(stby & (1 << f))) this.held.set(live.subarray(2 * f, 2 * f + 2), 2 * f);
      }
    }
    let events = MPU_DATA_RDY_INT;
    if (this.fifoSamples(n)) events |= MPU_FIFO_OFLOW_INT;
    this.raise(events, atNs);
  }

  /**
   * Interrupts happened at `atNs` of the guest's time. Only an enabled
   * source raises its status bit. The register map does not say whether a
   * disabled one latches (4.15, 4.16), and every driver that polls DATA_RDY
   * enables it first: FastIMU and Kris Winer write INT_ENABLE = 0x01. A
   * driver that never enables it reads 0 there, as it did before the chip
   * kept time.
   */
  private raise(events: number, atNs: number | null): void {
    const raised = this.regs[MPU_INT_ENABLE] & MPU_INT_SOURCES & events;
    if (raised === 0) return;
    this.regs[MPU_INT_STATUS] |= raised;
    // A pulse has a length only where there is a clock to measure it on,
    // and the later of two events ends it.
    if (atNs !== null && !this.latched) {
      this.pulseEndNs = Math.max(this.pulseEndNs ?? 0, atNs + MPU_INT_PULSE_NS);
    }
  }

  /**
   * The DMP wrote `n` packets, the last of them at `atNs`. They are of one
   * instant, as fifoSamples' are, and the heading turns by one period's
   * worth of the gyroscope per packet, whether or not the FIFO keeps it.
   */
  private dmpPackets(n: number, atNs: number | null): void {
    const image = this.dmpImage!;
    const block = this.output();
    const accelLsb = MPU6050_RULES.accel_lsb_per_g[(this.regs[MPU_ACCEL_CONFIG] >> 3) & 3];
    const gyroLsb = MPU6050_RULES.gyro_lsb_per_dps[(this.regs[MPU_GYRO_CONFIG] >> 3) & 3];
    const step = mpuDmpHeadingStep(block, gyroLsb, this.dmpPeriodNs);
    const size = this.fifo.length;
    const lost = this.fifoCount + n * image.size > size;
    const pushes = Math.min(n, Math.ceil(size / image.size) + 1);
    for (let k = 0; k < n - pushes; k++) this.dmpYaw += step;
    for (let k = 0; k < pushes; k++) {
      this.dmpYaw += step;
      for (const b of mpuDmpPacket(image, block, accelLsb, this.dmpYaw)) this.fifoPush(b);
    }
    this.raise(MPU_DMP_INT | (lost ? MPU_FIFO_OFLOW_INT : 0), atNs);
  }

  /**
   * The image the DMP runs now, or null: it runs while the chip is awake
   * and USER_CTRL has DMP_EN and FIFO_EN, from the program start address of
   * DMP_CFG_1/2, and the model runs it where the bytes there are those of an
   * image it knows.
   */
  private dmpRunnable(): MpuDmpImage | null | 'unknown' {
    const both = MPU_USER_DMP_EN | MPU_USER_FIFO_EN;
    if (!this.sampling || (this.regs[MPU_USER_CTRL] & both) !== both) return null;
    const start = ((this.regs[MPU_DMP_CFG_1] << 8) | this.regs[MPU_DMP_CFG_1 + 1]) % this.dmpMem.length;
    const known = MPU_DMP_IMAGES.find(
      (image) =>
        image.start === start && image.signature.every((b, i) => this.dmpMem[start + i] === b),
    );
    return known ?? 'unknown';
  }

  /** The DMP period the image's divider sets, in ns. */
  private dmpPeriodOf(): number {
    const at = MPU6050_RULES.dmp_rate_div_at;
    const divider = (this.dmpMem[at] << 8) | this.dmpMem[at + 1];
    return ((1 + divider) * 1e9) / MPU6050_RULES.dmp_rate_hz;
  }

  /**
   * After a write: the DMP starts, stops, or runs at another rate. A start
   * (and DMP_RESET) puts the heading back to zero, and the first packet is
   * one period from here.
   */
  private dmpFollow(reset: boolean): void {
    const runnable = this.dmpRunnable();
    const image = runnable === 'unknown' ? null : runnable;
    if (runnable === 'unknown' && !this.dmpUnknownSaid) {
      this.dmpUnknownSaid = true;
      this.onDmpUnknown?.();
    }
    const period = image ? this.dmpPeriodOf() : 0;
    if (image === this.dmpImage && period === this.dmpPeriodNs && !reset) return;
    if (image !== this.dmpImage || reset) this.dmpYaw = 0;
    this.dmpImage = image;
    this.dmpPeriodNs = period;
    this.dmpEpochNs = image ? this.nowNs() : null;
    this.dmpTaken = 0;
  }

  /**
   * Push `n` samples of the sources FIFO_EN selects, while USER_CTRL lets
   * the FIFO take them. Returns whether bytes were lost to a full FIFO.
   * The samples of one call are of one instant, so only as many as can
   * still be in the FIFO afterwards are pushed.
   */
  private fifoSamples(n: number): boolean {
    if ((this.regs[MPU_USER_CTRL] & MPU_USER_FIFO_EN) === 0) return false;
    const sources = this.regs[MPU_FIFO_EN];
    if (sources === 0) return false;
    const block = this.output();
    const packet: number[] = [];
    for (const [bit, at, len] of MPU_FIFO_SOURCES) {
      if (sources & bit) for (let i = 0; i < len; i++) packet.push(block[at + i]);
    }
    if (packet.length === 0) return false;
    const size = this.fifo.length;
    const lost = this.fifoCount + n * packet.length > size;
    const pushes = Math.min(n, Math.ceil(size / packet.length) + 1);
    for (let k = 0; k < pushes; k++) for (const b of packet) this.fifoPush(b);
    return lost;
  }

  /** One byte into the FIFO; when it is full the oldest goes (4.31). */
  private fifoPush(value: number): void {
    const size = this.fifo.length;
    if (this.fifoCount === size) {
      this.fifoHead = (this.fifoHead + 1) % size;
      this.fifoCount--;
    }
    this.fifo[(this.fifoHead + this.fifoCount) % size] = value;
    this.fifoCount++;
  }

  private fifoPop(): number {
    if (this.fifoCount === 0) return this.fifoLast;
    this.fifoLast = this.fifo[this.fifoHead];
    this.fifoHead = (this.fifoHead + 1) % this.fifo.length;
    this.fifoCount--;
    return this.fifoLast;
  }

  private fifoEmpty(): void {
    this.fifoHead = 0;
    this.fifoCount = 0;
  }

  private powerOn(): void {
    this.regs.fill(0);
    for (const [reg, value] of Object.entries(MPU6050_RULES.power_on)) {
      this.regs[Number(reg)] = value;
    }
    // The factory trims go to the offset registers of the die, and a die
    // whose map has none at the MPU-6050's reads 0x00 there.
    for (const at of MPU6050_RULES.accel_offs_reg) this.regs.fill(0, at, at + 2);
    this.die.accel_offs_reg.forEach((at, axis) => this.regs.set(MPU_FACTORY_TRIM[axis], at));
    for (const [reg, value] of Object.entries(this.die.power_on)) this.regs[Number(reg)] = value;
    this.regs[MPU_WHO_AM_I] = this.die.who_am_i;
    this.held.fill(0);
    this.fifoEmpty();
    this.fifoLast = 0;
    this.dmpMem.fill(0);
    for (const [at, value] of Object.entries(MPU6050_RULES.dmp_rom)) this.dmpMem[Number(at)] = value;
    this.dmpImage = null;
    this.dmpPeriodNs = 0;
    this.dmpYaw = 0;
    this.restartSampling();
  }

  /**
   * Where MEM_R_W reads or writes, and the address moved on past it. The
   * address wraps within its bank: eMPL refuses to cross one and i2cdevlib
   * selects the next bank itself.
   */
  private dmpCell(): number {
    const at = ((this.regs[MPU_BANK_SEL] & 0x1f) << 8) | this.regs[MPU_MEM_START_ADDR];
    this.regs[MPU_MEM_START_ADDR] = (this.regs[MPU_MEM_START_ADDR] + 1) & 0xff;
    return at % this.dmpMem.length;
  }

  private readRegister(reg: number): number {
    if (reg === MPU_FIFO_COUNT_H) {
      // Both bytes are latched when the high one is read (4.30).
      this.regs[MPU_FIFO_COUNT_H] = this.fifoCount >> 8;
      this.regs[MPU_FIFO_COUNT_L] = this.fifoCount & 0xff;
    }
    if (reg === MPU_FIFO_R_W) return this.fifoPop();
    if (reg === MPU_MEM_R_W) return this.dmpMem[this.dmpCell()];
    if (reg < MPU_SAMPLE_FIRST || reg > MPU_SAMPLE_LAST) return this.regs[reg];
    if (this.asleep && !this.asleepReadSaid) {
      this.asleepReadSaid = true;
      this.onAsleepRead?.();
    }
    return this.sample[reg - MPU_SAMPLE_FIRST];
  }

  private writeRegister(reg: number, value: number): void {
    if (MPU_READ_ONLY[reg]) return;
    if (reg === MPU_PWR_MGMT_1 && (value & MPU_DEVICE_RESET) !== 0) {
      // Nothing of the byte is kept, SLEEP and CLKSEL included: Adafruit's
      // read-modify-write sends 0xC0 and then has to read 0x40.
      this.powerOn();
      return;
    }
    // SIG_COND_RESET clears the sensor registers too (4.27), which shows on a
    // sleeping chip; one that is awake has a new sample by the next read.
    if (reg === MPU_USER_CTRL && (value & MPU_SIG_COND_RESET) !== 0) this.held.fill(0);
    // FIFO_RESET empties it whether or not it is enabled: the register map
    // says "while FIFO_EN equals 0", and i2cdevlib resets it enabled and
    // counts on it (MotionApps resetFIFO).
    if (reg === MPU_USER_CTRL && (value & MPU_FIFO_RESET) !== 0) this.fifoEmpty();
    if (reg === MPU_FIFO_R_W) {
      this.fifoPush(value);
      return;
    }
    if (reg === MPU_MEM_R_W) {
      this.dmpMem[this.dmpCell()] = value;
      // A divider written while the DMP runs changes its rate.
      if (this.dmpImage) this.dmpFollow(false);
      return;
    }
    const stored = value & ~MPU_SELF_CLEARING[reg] & 0xff;
    // What sampled until now holds this instant from here on if the write
    // stops it; what did not keeps what it held.
    if (reg === MPU_PWR_MGMT_1 || reg === MPU_PWR_MGMT_2) this.held.set(this.output());
    const sampled = this.sampling;
    this.regs[reg] = stored;
    // Waking up, or another rate: the first sample is one period from here.
    if (this.sampling !== sampled || this.samplePeriodNs() !== this.periodNs) {
      this.restartSampling();
    }
    this.dmpFollow(reg === MPU_USER_CTRL && (value & MPU_DMP_RESET) !== 0);
  }

  private latch(): void {
    this.sample.set(this.output());
    this.latchDue = false;
  }

  /** CYCLE with SLEEP clear: one sample per wake-up (4.28). */
  private get cycling(): boolean {
    return (this.regs[MPU_PWR_MGMT_1] & (MPU_CYCLE | MPU_SLEEP)) === MPU_CYCLE;
  }

  /** The fields of the sample block that are not sampling, as bits (ax = bit 0). */
  private standbyFields(): number {
    let fields = 0;
    const stby = this.regs[MPU_PWR_MGMT_2];
    for (const [bit, field] of MPU_STBY_FIELDS) if (stby & bit) fields |= field;
    if (this.regs[MPU_PWR_MGMT_1] & MPU_TEMP_DIS) fields |= MPU_TEMP_FIELD;
    return fields;
  }

  /** The sample block as the chip's registers hold it now. */
  private output(): Uint8Array {
    const frozen = this.asleep || this.cycling ? MPU_ALL_FIELDS : this.standbyFields();
    if (frozen === MPU_ALL_FIELDS) return this.held.slice();
    const out = this.encode();
    for (let f = 0; f < 7; f++) {
      if (frozen & (1 << f)) out.set(this.held.subarray(2 * f, 2 * f + 2), 2 * f);
    }
    return out;
  }

  private encode(): Uint8Array {
    const { inputs, regs } = this;
    const accel = MPU6050_RULES.accel_lsb_per_g[(regs[MPU_ACCEL_CONFIG] >> 3) & 3];
    const gyro = MPU6050_RULES.gyro_lsb_per_dps[(regs[MPU_GYRO_CONFIG] >> 3) & 3];
    // Offsets act before the output registers, the FIFO and the DMP (AN-OFFS 4).
    const word = (reg: number) => ((regs[reg] << 8) | regs[reg + 1]) << 16 >> 16;
    const factory = (axis: number) =>
      ((MPU_FACTORY_TRIM[axis][0] << 8) | MPU_FACTORY_TRIM[axis][1]) << 16 >> 16;
    const trim = (axis: number) =>
      (((word(this.die.accel_offs_reg[axis]) & ~1) - (factory(axis) & ~1)) * accel) /
      MPU6050_RULES.accel_offset_lsb_per_g;
    const drift = (reg: number) => (word(reg) * gyro) / MPU6050_RULES.gyro_offset_lsb_per_dps;
    const block = [
      inputs.accelX * accel + trim(0),
      inputs.accelY * accel + trim(1),
      inputs.accelZ * accel + trim(2),
      (inputs.temp - this.die.temp_offset_c) * this.die.temp_lsb_per_c,
      inputs.gyroX * gyro + drift(MPU_XG_OFFS_USR),
      inputs.gyroY * gyro + drift(MPU_XG_OFFS_USR + 2),
      inputs.gyroZ * gyro + drift(MPU_XG_OFFS_USR + 4),
    ];
    const out = new Uint8Array(block.length * 2);
    block.forEach((value, i) => {
      const counts = mpuCounts(value);
      out[2 * i] = (counts >> 8) & 0xff;
      out[2 * i + 1] = counts & 0xff;
    });
    return out;
  }
}

/**
 * The `ad0` property as a level: true (high), false (low), or null when it
 * says nothing and the AD0 net decides. The worker's copy reads a record the
 * same way (esp32_i2c_slaves.parse_ad0), and both are held to the cases of
 * test/fixtures/i2c-vectors/mpu6050.json.
 */
export function parseAd0(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value === 1 ? true : value === 0 ? false : null;
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  if (['1', 'true', 'high', 'on', 'vcc'].includes(v)) return true;
  if (['0', 'false', 'low', 'off', 'gnd'].includes(v)) return false;
  return null;
}

/**
 * The address the chip answers at: b110100 and the level of AD0 (PS 9.2).
 * The `ad0` property overrides the wiring; otherwise AD0 tied to a supply is
 * high and anything else is low: tied to ground, or floating, which the
 * module's pull-down makes low (the GY-521 has a 4.7k to ground). A GPIO
 * that drives AD0 is read as low: the address is chosen when the part
 * attaches, not followed while the sketch runs.
 */
export function mpu6050Address(ad0Property: unknown, componentId: string | undefined): number {
  const forced = parseAd0(ad0Property);
  if (forced !== null) return forced ? 0x69 : 0x68;
  if (!componentId) return 0x68;
  const net = busRegistry.resolvePin(componentId, 'AD0');
  return net.kind === 'rail' && net.rail === 'vcc' ? 0x69 : 0x68;
}

/**
 * The MPU-6050's INT pad on the board pin it is wired to.
 *
 * The model says what the pad does and when it moves next; this puts it on
 * the wire. The pad is one driver of the pin's net (busNets), so an
 * open-drain INT that lets go leaves the line to the pull the sketch enabled,
 * and the level reaches the guest's input register and its pin interrupt.
 * The pin moves on the guest's clock: a timer at the next sample, and one at
 * the end of each 50 us pulse, which run between two instructions at their
 * cycle. While no interrupt is enabled nothing is armed at all.
 */
function hostMpu6050Int(
  device: Mpu6050Model,
  simulator: AnySimulator,
  pin: number,
  componentId: string,
): () => void {
  const host = simulator.pinManager as unknown as BoardPinHost | undefined;
  const sink = (level: boolean) => {
    try {
      simulator.setPinState(pin, level);
    } catch {
      /* the board is not up yet */
    }
  };
  const driverId = `${componentId}::INT`;
  const onNet = !!host && typeof host.triggerPinChange === 'function';
  const put = (pad: Mpu6050IntPad): void => {
    if (onNet) {
      const drive: Drive =
        pad === 'z' ? HIGHZ_DRIVE : { value: pad === 'high' ? 1 : 0, strength: Strength.STRONG };
      setBoardPinDrive(host!, pin, driverId, drive, sink);
    } else if (pad !== 'z') {
      // A board with no pin nets: the level goes straight to the guest.
      sink(pad === 'high');
    }
  };

  let last: Mpu6050IntPad | null = null;
  let cancel: (() => void) | null = null;
  let armedAt = -1;
  let disposed = false;
  const disarm = (): void => {
    cancel?.();
    cancel = null;
    armedAt = -1;
  };
  // Called on every byte the sketch moves: the timer already armed for the
  // same instant stays, so a burst read costs no timer churn.
  const refresh = (): void => {
    if (disposed) return;
    const pad = device.intPad();
    if (pad !== last) {
      last = pad;
      put(pad);
    }
    const wake = device.intWakeNs();
    const clock = device.guestClock;
    const hz = clock?.clockHz() ?? 0;
    if (wake === null || !clock || !(hz > 0)) {
      disarm();
      return;
    }
    // The first cycle at or past the instant, and never the cycle we are on:
    // the timer that fires has to find the instant behind it, or it would
    // arm itself for the same one again.
    const at = Math.max(Math.ceil((wake * hz) / 1e9), clock.now() + 1);
    if (cancel && at === armedAt) return;
    disarm();
    armedAt = at;
    cancel = clock.at(at, () => {
      cancel = null;
      armedAt = -1;
      refresh();
    });
  };
  device.onIntChange = refresh;
  refresh();

  return () => {
    disposed = true;
    disarm();
    device.onIntChange = null;
    if (onNet) setBoardPinDrive(host!, pin, driverId, HIGHZ_DRIVE, sink);
  };
}

PartSimulationRegistry.register('mpu6050', {
  attachEvents: (element, simulator, getPin, componentId) => {
    const el = element as any;
    const addr = mpu6050Address(el.ad0, componentId);
    const variant = parseMpuVariant(el.variant);
    // buses/models/mpu6050.c, the model the worker runs too (project
    // i2c-model-fidelity-2026-09, P5); VirtualMPU6050 behind the i2cwasm flag,
    // and for a model that cannot be built.
    let compiled = compiledModel('mpu6050');
    let device: Mpu6050Model;
    try {
      device = compiled
        ? new WasmMPU6050(compiled.module, {
            address: addr,
            variant,
            volatileReads: mpuRegistersOf(MPU6050_RULES.volatile_reads),
            pointerStays: mpuRegistersOf(MPU6050_RULES.pointer_stays),
          })
        : new VirtualMPU6050(addr, variant);
    } catch (e) {
      console.warn('[i2c-models] mpu6050: the compiled model could not start; the part keeps its own', e);
      compiled = null;
      device = new VirtualMPU6050(addr, variant);
    }
    // The world starts where the panel's sliders do.
    device.setInputs(getSensorControl('mpu6050')?.defaultValues ?? {});
    // A board pin, not a rail (-1) and not a net between chips.
    const wiredInt = getPin('INT');
    const intPin =
      wiredInt !== null && wiredInt >= 0 && !isSyntheticChipPin(wiredInt) ? wiredInt : null;
    const part = attachI2cPart({
      simulator,
      componentId,
      device,
      // The worker's copy starts from the same values, under the names its
      // sensor updates use, and not from defaults of its own. It drives the
      // pin INT is wired to itself, next to the guest.
      worker: {
        type: 'mpu6050',
        props: {
          ...device.getInputs(),
          ...(intPin !== null ? { int_pin: intPin } : {}),
          ...(variant !== 'mpu6050' ? { variant } : {}),
          ...(compiled ? { wasmB64: compiled.b64 } : {}),
        },
      },
    });
    device.onAsleepRead = () =>
      part.report(
        'i2c-target-asleep',
        `${variant.toUpperCase()} 0x${addr.toString(16)} is in sleep mode: write 0x00 to PWR_MGMT_1 (0x6B) to wake it`,
      );
    device.onDmpUnknown = () =>
      part.report(
        'i2c-target-unmodelled',
        `${variant.toUpperCase()} 0x${addr.toString(16)}: the sketch starts a DMP image the simulator does not know ` +
          '(it runs the MotionApps 2.0, 4.1 and 6.12 images of i2cdevlib), so no packets reach the FIFO. ' +
          'Read the accelerometer and gyroscope registers instead',
      );
    const releaseInt =
      intPin !== null && !part.remote
        ? hostMpu6050Int(device, simulator, intPin, componentId)
        : null;

    registerSensorUpdate(componentId, (values) => {
      // The worker's copy answers a QEMU board; this one answers every board
      // whose firmware runs in the tab, and the Pi relay reads its registers.
      part.updateWorker(values);
      device.setInputs(values);
    });

    return () => {
      releaseInt?.();
      part.dispose();
      unregisterSensorUpdate(componentId);
      if (device instanceof WasmMPU6050) device.dispose();
    };
  },
});

// ─── DHT22 Temperature / Humidity Sensor ─────────────────────────────────────

/**
 * DHT22 (AM2302) — a line-owning sensor. The protocol (start signal, 40-bit
 * self-timed reply on the same wire) is the MODEL in simulation/line/models/
 * dht22.ts, hosted by whichever board the part is wired to under the line
 * contract. This part only binds the canvas element to that contract: it says
 * what it is and where it sits, forwards slider changes, and shows the
 * board's answer when the board cannot host it.
 *
 * Default values: 50.0% humidity, 25.0 C. Change via `el.temperature` /
 * `el.humidity`.
 */
PartSimulationRegistry.register('dht22', {
  attachEvents: (element, simulator, getPin, componentId) => {
    // wokwi-dht22 element uses 'SDA' as the data pin name (not 'DATA')
    const pin = getPin('SDA') ?? getPin('DATA');
    if (pin === null) return () => {};

    const el = element as { temperature?: number; humidity?: number };
    const answer = requestLine(
      simulator,
      {
        sensor_type: 'dht22',
        pin,
        temperature: el.temperature ?? 25.0,
        humidity: el.humidity ?? 50.0,
      },
      { componentId },
    );

    // SensorControlPanel: update temperature / humidity on the element, and
    // tell the host when there is one.
    registerSensorUpdate(componentId, (values) => {
      if ('temperature' in values) el.temperature = values.temperature as number;
      if ('humidity' in values) el.humidity = values.humidity as number;
      if (answer.mode !== 'none') {
        answer.update({ temperature: el.temperature ?? 25.0, humidity: el.humidity ?? 50.0 });
      }
    });

    return () => {
      if (answer.mode !== 'none') answer.release();
      // A refusal left a gap recorded; drop it so a rewire cannot keep
      // reporting a sensor the user has already moved.
      else releaseLineGap(componentId);
      unregisterSensorUpdate(componentId);
    };
  },
});

// ─── HX711 Load Cell Amplifier ────────────────────────────────────────────────

/**
 * HX711 — 24-bit ADC for load cells.
 *
 * Protocol:
 *  - DOUT LOW  = conversion ready
 *  - MCU reads 24 rising CLK edges → DOUT sends 24 bits MSB-first
 *  - 1 extra CLK pulse → gain 128 (channel A, default)
 *  - After 25th pulse falling edge: new conversion starts (DOUT → LOW after ~delay)
 *
 * Default weight: 100 g. Change via element.weight (grams).
 * Raw ADC = weight × 1000 (signed 24-bit two's complement).
 *
 * Taring: Arduino sketches typically call tare() first, which reads the
 * zero offset. This simulation always returns weight × 1000 as the raw value;
 * after taring with 0 g the sketch will correctly read any non-zero value.
 */
PartSimulationRegistry.register('hx711', {
  attachEvents: (element, simulator, getPin) => {
    const pinSCK = getPin('SCK');
    const pinDOUT = getPin('DOUT');
    if (pinSCK === null || pinDOUT === null) return () => {};

    let rawValue = rawFromWeight(element);
    let bitCount = 0;
    let finishing = false;

    function rawFromWeight(el: HTMLElement): number {
      const w = (el as any).weight ?? 100; // grams
      const raw = Math.round(w * 1000); // 24-bit fixed-point
      return Math.max(-8_388_608, Math.min(8_388_607, raw)) & 0xff_ffff;
    }

    // DOUT LOW = next conversion ready
    simulator.setPinState(pinDOUT, false);

    const unsub = (simulator as any).pinManager.onPinChange(
      pinSCK,
      (_: number, rising: boolean) => {
        if (rising) {
          // Rising edge: output the current bit (MSB first), then advance
          if (bitCount < 24) {
            const bit = (rawValue >> (23 - bitCount)) & 1;
            simulator.setPinState(pinDOUT, bit === 1);
            bitCount++;
          } else {
            // 25th pulse → gain select. DOUT driven HIGH (end of word)
            simulator.setPinState(pinDOUT, true);
            finishing = true;
          }
        } else {
          // Falling edge after the 25th pulse → conversion complete
          if (finishing) {
            finishing = false;
            bitCount = 0;
            rawValue = rawFromWeight(element);
            // DOUT LOW = new conversion ready (simulate ~10 ms conversion time)
            setTimeout(() => simulator.setPinState(pinDOUT, false), 10);
          }
        }
      },
    );

    return () => {
      unsub();
      simulator.setPinState(pinDOUT, true); // DOUT HIGH = device idle / power down
    };
  },
});

// ─── Infrared ────────────────────────────────────────────────────────────────

/**
 * The two IR parts, and the air between them.
 *
 * WHAT WAS WRONG. Both were dead, each in its own way, and neither failure
 * looked like a failure on the canvas:
 *
 *  - the receiver asked for a pin named `OUT` or `DATA`. `wokwi-ir-receiver`
 *    calls it `DAT`, so the lookup returned null and `attachEvents` returned
 *    an empty cleanup on its second line. Wired or not, the part did nothing.
 *  - the remote asked for a pin too. It is a remote control: it has no pins
 *    and never had. All it did was dispatch an `ir-signal` DOM event that
 *    nothing in the codebase listened for, with a command from a hand-written
 *    key table whose names the element never emits — while the element itself
 *    was already carrying the correct NEC code in `detail.irCode`.
 *  - and the pulse train was built out of `setTimeout(next, 0.562)`. A NEC
 *    mark is 560 us; setTimeout's floor is a millisecond and its nested clamp
 *    is four. No IR library could ever have decoded it.
 *
 * WHAT THEY ARE NOW. The remote transmits into `simulation/ir/irAir` — the
 * medium, with no wire and no geometry — and the receiver is a line-owning
 * model (`simulation/line/models/ir-nec`) that puts the envelope of whatever
 * it hears on its pin, on the guest's own cycle counter, at real NEC timing.
 * Several remotes and several receivers work at once, on any mix of boards,
 * because the air carries microseconds and each receiver converts them to its
 * own board's clock.
 */

/** A component property that may arrive as a number or as a typed string. */
function numProp(el: Record<string, unknown>, keys: string[], dflt: number): number {
  for (const k of keys) {
    const v = el[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() !== '') {
      const n = v.trim().toLowerCase().startsWith('0x') ? parseInt(v, 16) : parseFloat(v);
      if (Number.isFinite(n)) return n;
    }
  }
  return dflt;
}

function textProp(el: Record<string, unknown>, key: string): string {
  const v = el[key];
  return typeof v === 'string' ? v : '';
}

/**
 * IR receiver — the demodulator can (a VS1838B, a TSOP38238) behind the lens.
 *
 * It owns its output pin through the line contract, so the board that hosts it
 * answers honestly: the model runs in the browser (AVR, RP2040, RP2350, the
 * esp32*js engines), it runs in the backend worker, or this board cannot host
 * it and the circuit check says why. A click on the part still transmits, as a
 * convenience for a canvas with no remote on it — the part IS the remote then,
 * sending its configured address and command.
 */
PartSimulationRegistry.register('ir-receiver', {
  attachEvents: (element, simulator, getPin, componentId) => {
    // `DAT` is what the element declares. The other two are accepted because
    // modules in the wild silk-screen them, and a saved project may carry
    // either spelling.
    const pin = getPin('DAT') ?? getPin('OUT') ?? getPin('DATA');
    if (pin === null) return () => {};

    const el = element as unknown as Record<string, unknown>;
    const channel = () => textProp(el, 'channel');
    /** Bumped on every transmission: the model fires on the CHANGE, so two
     *  identical presses in a row are still two frames. */
    let seq = 0;

    const answer = requestLine(
      simulator,
      {
        sensor_type: 'ir-nec',
        pin,
        address: numProp(el, ['irAddress', 'address'], 0x00),
        command: numProp(el, ['irCommand', 'command'], 0x45),
        channel: channel(),
      },
      { componentId },
    );

    /** Put a train on the pin. The air already decoded it; this only has to
     *  reproduce the envelope, so the raw pulses go over untouched — a remote
     *  speaking a protocol nothing here parses still reaches the sketch. */
    const deliver = (pulses: readonly IrPulse[]): boolean => {
      if (answer.mode === 'none') return false;
      answer.update({ pulses, seq: ++seq });
      return true;
    };

    const unlisten = listenIr(componentId, channel, (f: IrAirFrame) => deliver(f.pulses));

    // Clicking the receiver transmits its own configured code, so a canvas
    // with no remote on it is still testable. It goes through the air like
    // anything else, which is also what makes a second receiver hear it.
    const onClick = () => {
      emitIr({
        pulses: necEncode(
          numProp(el, ['irAddress', 'address'], 0x00),
          numProp(el, ['irCommand', 'command'], 0x45),
        ),
        sourceId: componentId,
        channel: channel(),
      });
    };
    element.addEventListener('click', onClick);

    // The sensor panel edits the SAME two values the element carries, so a
    // slider and the hex property in the inspector cannot drift apart and the
    // click path below reads whatever was set last.
    registerSensorUpdate(componentId, (values) => {
      if ('address' in values) el.irAddress = values.address;
      if ('command' in values) el.irCommand = values.command;
      // The panel's Send button transmits into the room rather than straight
      // onto the pin, so every OTHER receiver on this channel hears it too.
      if ('send' in values) onClick();
    });

    return () => {
      unlisten();
      element.removeEventListener('click', onClick);
      if (answer.mode !== 'none') answer.release();
      else releaseLineGap(componentId);
      unregisterSensorUpdate(componentId);
    };
  },
});

/**
 * IR remote control — a handset. It has no pins and connects to nothing; it
 * transmits into the room and whatever is listening hears it.
 *
 * The element already computes the NEC code for the button that was pressed
 * (`detail.irCode`) and it is the authority: the codes belong to the artwork
 * printed on its keys. The old hand-written table here disagreed with it on
 * every single key and was keyed on button names the element never emits.
 *
 * Holding a button repeats, exactly as a real remote does — a NEC repeat frame
 * every 108 ms, which is what makes a volume key ramp instead of stepping once.
 */
PartSimulationRegistry.register('ir-remote', {
  attachEvents: (element, _simulator, _getPin, componentId) => {
    const el = element as unknown as Record<string, unknown>;
    const channel = () => textProp(el, 'channel');
    /** The address the handset sends. NEC remotes each have their own; the
     *  element models one physical remote, so the property is on the part. */
    const address = () => numProp(el, ['irAddress', 'address'], 0x00);

    let repeatTimer: ReturnType<typeof setInterval> | null = null;
    const stopRepeat = () => {
      if (repeatTimer !== null) {
        clearInterval(repeatTimer);
        repeatTimer = null;
      }
    };

    const send = (pulses: readonly IrPulse[]) => {
      const taken = emitIr({ pulses, sourceId: componentId, channel: channel() });
      if (taken === 0) {
        // "The button does nothing" and "nothing was listening" look the same
        // on a canvas, and only one of them is the user's mistake.
        console.warn(
          `[ir] ${componentId} transmitted and no receiver took it` +
            (channel() ? ` on channel '${channel()}'` : ''),
        );
      }
    };

    const onButtonPress = (e: Event) => {
      const detail = (e as CustomEvent).detail ?? {};
      const irCode = Number(detail.irCode);
      if (!Number.isFinite(irCode)) return;
      stopRepeat();
      send(necEncode(address(), irCode & 0xff));
      // A held key sends repeat frames, carrying no data, every 108 ms.
      repeatTimer = setInterval(() => send(necEncodeRepeat()), NEC_REPEAT_PERIOD_MS);
    };
    const onButtonRelease = () => stopRepeat();

    element.addEventListener('button-press', onButtonPress);
    element.addEventListener('button-release', onButtonRelease);
    // A button-press with no release (the element focuses and blurs, a pointer
    // leaves the SVG) must not repeat forever.
    element.addEventListener('mouseleave', onButtonRelease);

    return () => {
      stopRepeat();
      element.removeEventListener('button-press', onButtonPress);
      element.removeEventListener('button-release', onButtonRelease);
      element.removeEventListener('mouseleave', onButtonRelease);
    };
  },
});

// ─── MicroSD Card ─────────────────────────────────────────────────────────────

/**
 * MicroSD card: the canvas part of the generic SD-over-SPI card.
 *
 * A responder on the bus fabric: it is on the bus its SCK/DI/DO/CS wires put
 * it on, whatever board and whatever engine, and it only ever sees the frames
 * clocked while its own chip select is active.
 *
 * The protocol is NOT here. One model serves this part, a board's built-in
 * slot and the portable artifact a remote worker runs
 * (`parts/sdSpiCard.ts` and `buses/models/microsd.c`), because three
 * hand-kept copies of it had already drifted apart and each drift was a card
 * that mounted on one engine and not another. What this part owns is the
 * interface: the image the project's files are baked into
 * (`element.sdImageData`), the reader the card panel lists them through, and
 * the pad names the fabric walks the wires from.
 */
// Fixed card capacity (mirrors Wokwi's "no size attribute" model). The backing
// store is SPARSE — only written/loaded blocks allocate — so the advertised
// capacity is free in RAM. Adjustable here; not exposed to the user.
const SD_CARD_BYTES = 64 * 1024 * 1024; // 64 MB

PartSimulationRegistry.register('microsd-card', {
  attachEvents: (element, _simulator, _getPin, componentId) => {
    const el = element as any;

    // The card model is shared with a board's built-in slot and with the
    // portable model a remote worker runs, so a fix lands in one place
    // (project board-buses-2026-09, F4). This part is the INTERFACE: the image
    // the user's files are baked into, the panel that lists them, and the pins
    // the silkscreen prints.
    const card = new SdSpiCard(null, SD_CARD_BYTES);

    // Optional pre-built FAT image (DynamicComponent sets element.sdImageData
    // from the project's files plus the panel's uploads). How big it was is
    // what the dump pads back to, so a FAT parser reading the card sees the
    // whole volume and not just the blocks somebody touched.
    let imageBytes = 0;
    {
      const raw = el.sdImageData;
      const bytes: Uint8Array | null =
        raw instanceof Uint8Array
          ? raw
          : raw instanceof ArrayBuffer
            ? new Uint8Array(raw)
            : Array.isArray(raw)
              ? Uint8Array.from(raw)
              : null;
      if (bytes) {
        imageBytes = bytes.length;
        card.loadImage(bytes);
      }
    }

    const owner = componentId ?? (el?.id as string) ?? 'microsd-card';
    // The panel asks by owner. `fromPart` says this card is a component on the
    // canvas, so a panel opened on the card itself finds it without being told
    // which component it is.
    const unpublish = registerSdImageReader(
      owner,
      () => {
        const image = card.dumpImage(imageBytes);
        // Nothing mounted yet reads as no card, which is what the panel shows
        // for a slot it has never seen a byte from.
        return image.length > 0 ? image : null;
      },
      { fromPart: true },
    );

    // The card is also a RESPONDER on a board whose CPU is in a QEMU worker,
    // and there it has to run beside the guest: the worker reads MISO for a
    // byte before this tab has seen the byte (D-004). Start the fetch of the
    // portable model now; the map is published again when the bytes land.
    loadSdBusChip();

    const handle = attachSpiDevice(
      {
        owner,
        componentId,
        pins: { sck: 'SCK', mosi: 'DI', miso: 'DO', cs: 'CS' },
        // SD cards clock on modes 0 and 3.
        modes: [0, 3],
        // CS (pin 1, DAT3) carries the card's own pull-up, so a card whose CS
        // nothing drives reads as deselected and stays quiet.
        csWhenFloating: 'deselected',
        remoteModel: () => sdCardRemoteModel(card, imageBytes),
        hasRemoteModel: () => sdCardHasRemoteModel(card, imageBytes),
        // What the guest writes on a remote board comes back as spans: the
        // worker no longer relays the bytes of a card transaction no sink can
        // see, and this copy is what the panel lists.
        remoteBlobWrite: sdCardRemoteBlobWrite(card),
      },
      sdSpiFabricDevice(card),
    );

    return () => {
      handle.dispose();
      unpublish();
      card.setCs(false);
    };
  },
});

// ─── BMP280 Barometric Pressure / Temperature Sensor ─────────────────────────

/**
 * BMP280 — I2C barometric pressure + temperature sensor.
 *
 * Addresses:
 *   0x76 (SDO pin pulled LOW, default)
 *   0x77 (SDO pin pulled HIGH — set element.address = '0x77', or
 *         element.i2cAddress, which is the name a Grove brick sets)
 *
 * The element may expose `temperature` (°C) and `pressure` (hPa) properties
 * that are read on attach and forwarded to the virtual device.
 *
 * The chip is buses/models/bmp280.c (VirtualBMP280 from I2CBusManager behind
 * the i2cwasm flag). It uses the BMP280 datasheet calibration example to
 * compute raw ADC values for any desired temperature/pressure combination, so
 * Arduino sketches using Adafruit_BMP280 or Bosch's reference driver receive
 * correct compensated readings.
 */
PartSimulationRegistry.register('bmp280', {
  attachEvents: (element, simulator, _getPin, componentId) => {
    const el = element as any;
    // SDO selects one of two addresses, and the chip has no other. The Grove
    // BMP280 sets `i2cAddress`: read as `address` only, the model sat at 0x76
    // while Seeed's library asks 0x77 and waits for an answer with no timeout.
    const addr = parseI2cAddress(el.i2cAddress ?? el.address, 0x76) === 0x77 ? 0x77 : 0x76;
    // An unset value starts where the panel and the property dialog say it
    // does (24 C, 1013.25 hPa), not at a literal of this part's own.
    const initTemp =
      el.temperature !== undefined
        ? parseFloat(el.temperature)
        : sensorControlDefault('bmp280', 'temperature', 24);
    const initPressure =
      el.pressure !== undefined
        ? parseFloat(el.pressure)
        : sensorControlDefault('bmp280', 'pressure', 1013.25);

    // The compiled model of the chip, and its bytes in the worker's record so
    // the worker runs it too; VirtualBMP280 behind the i2cwasm flag.
    const compiled = compiledModel('bmp280');
    const dev = compiled ? new WasmBMP280(compiled.module, addr) : new VirtualBMP280(addr);
    dev.temperatureC = initTemp;
    dev.pressureHPa = initPressure;
    const part = attachI2cPart({
      simulator,
      componentId,
      device: dev,
      worker: {
        type: 'bmp280',
        props: {
          temperature: initTemp,
          pressure: initPressure,
          ...(compiled ? { wasmB64: compiled.b64 } : {}),
        },
      },
    });
    dev.onAsleepRead = () =>
      part.report(
        'i2c-target-asleep',
        `BMP280 0x${addr.toString(16)} is in sleep mode and has not measured: write the mode to ctrl_meas (0xF4), 0x27 for normal mode`,
      );

    registerSensorUpdate(componentId, (values) => {
      part.updateWorker(values);
      if ('temperature' in values) dev.temperatureC = values.temperature as number;
      if ('pressure' in values) dev.pressureHPa = values.pressure as number;
    });

    return () => {
      part.dispose();
      if (dev instanceof WasmBMP280) dev.dispose();
      unregisterSensorUpdate(componentId);
    };
  },
});

// ─── DS3231 Real-Time Clock ───────────────────────────────────────────────────

/**
 * DS3231: I2C clock with two alarms and an on-chip temperature sensor
 * (address 0x68): buses/models/ds3231.c (VirtualDS3231 from I2CBusManager
 * behind the i2cwasm flag). The browser's time, until the sketch sets one of
 * its own.
 *
 * The temperature is the panel's; it starts at `element.temperature`, or at
 * the panel's default.
 */
PartSimulationRegistry.register('ds3231', {
  attachEvents: (element, simulator, _getPin, componentId) => {
    const el = element as any;
    const fromElement = el.temperature !== undefined ? parseFloat(el.temperature) : NaN;
    const initTemp = Number.isFinite(fromElement)
      ? fromElement
      : sensorControlDefault('ds3231', 'temperature', 25);

    // The compiled model of the chip, and its bytes in the worker's record so
    // the worker runs it too; VirtualDS3231 behind the i2cwasm flag.
    const compiled = compiledModel('ds3231');
    const dev = compiled
      ? new WasmDS3231(compiled.module, { buildTimes: firmwareBuildTimes })
      : new VirtualDS3231({ buildTimes: firmwareBuildTimes });
    const wasmB64 = compiled?.b64 ?? null;
    dev.temperatureC = initTemp;
    const part = attachI2cPart({
      simulator,
      componentId,
      device: dev,
      // The worker's copy starts from the same temperature and the same
      // clock, and not from defaults of its own.
      worker: {
        type: 'ds3231',
        props: { temperature: initTemp, ...hostClockRecord(), ...(wasmB64 ? { wasmB64 } : {}) },
      },
    });
    registerSensorUpdate(componentId, (values) => {
      part.updateWorker(values);
      const t = values.temperature;
      if (typeof t === 'number' && Number.isFinite(t)) dev.temperatureC = t;
    });
    return () => {
      part.dispose();
      if (dev instanceof WasmDS3231) dev.dispose();
      unregisterSensorUpdate(componentId);
    };
  },
});

// ─── PCF8574 I/O Expander ────────────────────────────────────────────────────

/**
 * PCF8574 — I2C 8-bit quasi-bidirectional I/O expander.
 *
 * Default address: 0x27 (all three address pins HIGH — typical LCD backpack).
 * Override with `element.i2cAddress` (e.g. '0x20', '0x3F').
 *
 * `element.portState` (0–255) sets the external input state visible to the
 * Arduino on a read. Defaults to 0xFF (all pins pulled high / floating input).
 *
 * Writes from the Arduino update `dev.outputLatch` and fire `dev.onWrite`
 * which sets `element.value` so wokwi-LCD-I2C or similar elements can render.
 */
PartSimulationRegistry.register('pcf8574', {
  attachEvents: (element, simulator, _getPin, componentId) => {
    const el = element as any;

    // Parse address from element property (accepts '0x27', '39', or numeric)
    let addr = 0x27;
    if (el.i2cAddress !== undefined) {
      const raw = String(el.i2cAddress).trim();
      const parsed =
        raw.startsWith('0x') || raw.startsWith('0X') ? parseInt(raw, 16) : parseInt(raw, 10);
      if (!isNaN(parsed)) addr = parsed;
    }

    const dev = new VirtualPCF8574(addr);
    if (el.portState !== undefined) dev.portState = Number(el.portState) & 0xff;
    dev.onWrite = (value: number) => {
      el.value = value;
    };

    const part = attachI2cPart({
      simulator,
      componentId,
      device: dev,
      worker: {
        type: 'pcf8574',
        // The worker's copy answers reads from its own latch and this port.
        props: { portState: dev.portState },
        // Every byte of a write phase reaches the port in turn, so the last
        // one is what the pins hold (PCF8574 datasheet, "Writing to the port":
        // the data is latched at the acknowledge of each byte).
        echo: (data: number[]) => {
          for (const b of data) dev.writeByte(b);
        },
      },
    });
    return () => part.dispose();
  },
});

// ─── LCD1602 / LCD2004 with I2C backpack (PCF8574 + HD44780) ────────────────

/**
/**
 * What the pins of the LCD backpack's PCF8574 read when the expander releases
 * them all. RS, RW, E and D4-D7 go to HD44780 inputs and float up on the
 * expander's weak pull-up. (The HD44780 drives D4-D7 while RW and E are both
 * high; that read of the controller is not modelled, and the pins read high.) P3 goes to the base of the
 * backlight's NPN transistor, whose emitter is on ground, so the base-emitter
 * junction holds a released P3 low. hd44780_I2Cexp reads exactly that to
 * decide the backlight polarity (hd44780_I2Cexp.h autocfg8574(): "for active
 * high backlights, the bl input pin will be low"); against a port that reads
 * 0xFF it picked active low and turned the panel dark. Drivers that never
 * read (LiquidCrystal_I2C, LiquidCrystal_PCF8574, LCD_I2C) see no change.
 */
const LCD_BACKPACK_PORT = 0xf7;

/**
 * Build a part attach function for an LCD with an I2C backpack.  The
 * same logic applies to LCD1602 (16×2) and LCD2004 (20×4); only the
 * geometry differs.
 *
 * On attach:
 *  1. Force the underlying `wokwi-lcd1602` / `wokwi-lcd2004` element
 *     into I2C-pinout mode (`pins='i2c'`) so the user sees the
 *     correct 4-pin backpack header.
 *  2. Pre-fill `characters` with spaces so the screen is clean before
 *     the sketch issues its first Clear command.
 *  3. Create a `VirtualPCF8574` at the configured address.
 *  4. Pipe `pcf.onWrite` → `HD44780Decoder.feedPCF8574Byte`.
 *  5. Reflect the decoder's `characters` + `backlight` snapshots back
 *     onto the element's reactive properties.
 *
 * Works on AVR, RP2040, and the ESP32 backend (same trifurcation
 * pattern as other I2C parts above).
 */
function makeI2cLcdAttach(cols: number, rows: number) {
  return (
    element: HTMLElement,
    simulator: unknown,
    _getPin: (name: string) => number | null,
    componentId: string,
  ): (() => void) => {
    const el = element as any;

    const addr = parseI2cAddress(el.i2cAddress ?? el.address, 0x27);

    // Switch the underlying LCD element to I2C pin mode + a clean
    // characters buffer.  The host wokwi element re-renders on
    // attribute change.
    try {
      el.pins = 'i2c';
    } catch {
      /* read-only on some implementations — ignore */
    }
    const blankGrid = new Uint8Array(cols * rows).fill(0x20);
    el.characters = blankGrid;
    if (el.backlight === undefined) el.backlight = true;

    const decoder = new HD44780Decoder({ cols, rows });
    decoder.onCharsChange = (chars) => {
      // wokwi-lcd1602 accepts both number[] and Uint8Array.  Use Uint8Array
      // so Lit's change detection sees a new reference.
      el.characters = Uint8Array.from(chars);
    };
    decoder.onBacklightChange = (on) => {
      el.backlight = on;
    };
    // createChar(): codes 0-15 draw the CGRAM patterns (velxio/velxio-prod#162).
    decoder.onCgramChange = (cgram) => {
      el.font = fontWithCgram(cgram, el.font);
    };
    decoder.onCursorChange = (snap) => {
      el.cursorX = snap.cursorCol;
      el.cursorY = snap.cursorRow;
      el.cursor = snap.cursorOn;
      el.blink = snap.cursorBlink;
    };

    const pcf = new VirtualPCF8574(addr);
    pcf.portState = LCD_BACKPACK_PORT;
    pcf.onWrite = (v: number) => decoder.feedPCF8574Byte(v);

    // On a QEMU board the worker's expander echoes each write phase, and the
    // decoder here takes the bytes as the backpack would.
    const part = attachI2cPart({
      simulator,
      componentId,
      device: pcf,
      worker: {
        type: 'pcf8574',
        props: { portState: LCD_BACKPACK_PORT },
        echo: (data: number[]) => {
          for (const b of data) decoder.feedPCF8574Byte(b);
        },
      },
    });
    return () => {
      part.dispose();
      decoder.reset();
    };
  };
}

/**
 * LCD 16×2 with PCF8574 I2C backpack — the classic "I2C LCD" you buy
 * in a single piece on AliExpress.  Default address 0x27.
 */
PartSimulationRegistry.register('lcd1602-i2c', {
  attachEvents: makeI2cLcdAttach(16, 2),
});

/**
 * LCD 20×4 with PCF8574 I2C backpack.  Same protocol; uses the 2004
 * DDRAM row offsets (0x00, 0x40, 0x14, 0x54).
 */
PartSimulationRegistry.register('lcd2004-i2c', {
  attachEvents: makeI2cLcdAttach(20, 4),
});
