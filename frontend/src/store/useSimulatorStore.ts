import { create } from 'zustand';
import { decideEngine, getInstantEngine } from '../lib/instantEngine';
import {
  getBoardSeedFiles,
  getProBoard,
  getGuestSetup,
  isProBoardSimulator,
  type ProBoardSimulator,
} from '../lib/proBoardRegistry';
import { AVRSimulator } from '../simulation/AVRSimulator';
import { attachSlavesFromCanvas } from '../simulation/piSlaveScanner';
import { RP2040Simulator } from '../simulation/RP2040Simulator';
import { RiscVSimulator } from '../simulation/RiscVSimulator';
import { Esp32C3Simulator } from '../simulation/Esp32C3Simulator';
import { PinManager } from '../simulation/PinManager';
import { SignalRouter } from '../simulation/SignalRouter';
import { requestElectricalResolve } from '../simulation/spice/electricalResolveHook';
import { ledcSignalForChannel } from '../simulation/esp32-signals';
import {
  VirtualDS1307,
  VirtualTempSensor,
  I2CMemoryDevice,
  I2CBusManager,
  nullI2CMaster,
} from '../simulation/I2CBusManager';
import type { I2CDevice } from '../simulation/I2CBusManager';
import type { RP2040I2CDevice } from '../simulation/RP2040Simulator';
import type { Wire, WireInProgress, WireEndpoint } from '../types/wire';
import type { BoardKind, BoardInstance, LanguageMode, WifiStatus } from '../types/board';
import { BOARD_KIND_FQBN, BOARD_SUPPORTS_ESPIDF, BOARD_SUPPORTS_MICROPYTHON, EMULATED_WIFI_SSIDS, isPiBoardKind, isStm32BoardKind } from '../types/board';
import { annotateSerialChunk } from '../utils/serialDiagnostics';
import { blockedByBoardGate, reportBoardRunRefused } from '../lib/proBoardGate';
import { getSerialTxInterceptor } from '../lib/proHardwareSerial';
import { calculatePinPosition } from '../utils/pinPositionCalculator';
import { useOscilloscopeStore } from './useOscilloscopeStore';
import { RaspberryPi3Bridge } from '../simulation/RaspberryPi3Bridge';
import { PiBridgeShim } from '../simulation/PiBridgeShim';
import { Esp32Bridge } from '../simulation/Esp32Bridge';
import type { Ws2812Pixel } from '../simulation/Esp32Bridge';
import { createEsp32Bridge } from '../simulation/Esp32BridgeFactory';
import { Stm32Bridge, stm32PinNameToLinear } from '../simulation/Stm32Bridge';
import { STM32_LED } from '../components/velxio-components/Stm32BluePillElement';
import { useEditorStore } from './useEditorStore';
import { fingerprintSources } from '../utils/sourceFingerprint';
import { useVfsStore } from './useVfsStore';
import { buildProjectSdImage, decodeSdFiles, bytesToB64 } from '../utils/sdCardFiles';
import {
  autoWireColor,
  DEFAULT_WIRE_COLOR,
  normalizeWireWaypoints,
  previewElbow,
} from '../utils/wireUtils';
import { computeWireSplit } from '../utils/wireSplit';
import { generateUUID } from '../utils/uuid';
import {
  routeAroundObstacles,
  collectComponentObstacles,
  collectComponentRects,
  collectWireSegments,
} from '../utils/wireAutoRoute';
import { isBreadboard } from '../utils/breadboardNets';
import { isBoardSeated } from '../utils/socketSnap';
import { computeSeating } from '../utils/breadboardSnap';
import { createSerialBatcher } from './serialBatcher';
import {
  reensureSerialHooks as icReensureSerialHooks,
  bindBoard as icBindBoard,
  unbindBoard as icUnbindBoard,
  updateWires as icUpdateWires,
  setInterconnectRuntime,
} from '../simulation/Interconnect';
import { SENSOR_CONTROLS, getSensorControl, getSensorControlForComponent } from '../simulation/sensorControlConfig';
import { SINGLE_WIRE_SENSOR_MODELS } from '../simulation/sensorModels';
import type { LineSupport } from '../simulation/line/LineHost';
import { traceBoardGpio } from '../simulation/PinTrace';
import { dispatchSensorUpdate } from '../simulation/SensorUpdateRegistry';

// ── Sensor pre-registration ──────────────────────────────────────────────────
// Sensors whose model drives its own line (DHT22, HC-SR04) — declared once in
// simulation/sensorModels, which the ESP32 bridge also reads to know which pads
// the host must not touch. Used here to pre-register them in the start_esp32
// payload so the worker has them before the firmware runs.
const SENSOR_COMPONENT_MAP = SINGLE_WIRE_SENSOR_MODELS;

// ── I2C sensor pre-registration ───────────────────────────────────────────────
// I2C sensors use virtual pins (200 + i2c_addr) instead of real GPIO pins.
// They are identified by I2C address and do not need wire-resolution.
// `addrProp` is the component property that overrides the default address.
const I2C_SENSOR_MAP: Record<
  string,
  {
    sensorType: string;
    defaultAddr: number;
    addrProp?: string; // property key that holds the I2C address (e.g. 'address')
    addrIsBool?: boolean; // true when addrProp is a boolean flag (e.g. AD0 → 0x68/0x69)
    addrBoolHigh?: number; // address when the boolean flag is truthy
    propertyKeys?: string[]; // additional sensor values to forward (e.g. temperature, pressure)
  }
> = {
  mpu6050: {
    sensorType: 'mpu6050',
    defaultAddr: 0x68,
    addrProp: 'ad0',
    addrIsBool: true,
    addrBoolHigh: 0x69,
  },
  bmp280: {
    sensorType: 'bmp280',
    defaultAddr: 0x76,
    addrProp: 'address',
    propertyKeys: ['temperature', 'pressure'],
  },
  ds1307: { sensorType: 'ds1307', defaultAddr: 0x68 },
  ds3231: { sensorType: 'ds3231', defaultAddr: 0x68, propertyKeys: ['temperature'] },
  ssd1306: { sensorType: 'ssd1306', defaultAddr: 0x3c },
  pcf8574: { sensorType: 'pcf8574', defaultAddr: 0x27, addrProp: 'i2cAddress' },
};

// ── Legacy type aliases (keep external consumers working) ──────────────────
/**
 * The active board's kind.
 *
 * This was a four-literal union left over from when those were the only boards
 * Velxio had, while setBoardType below already handled the whole space by
 * casting to BoardKind. The stale narrow type is one of the three copies that
 * made an ESP32 project unimportable (#268) — the zip importer and the import
 * dispatcher each carried their own. It is BoardKind, which is what it always
 * was at runtime; the overlay's kinds register into that union too.
 */
export type BoardType = BoardKind;

// BOARD_FQBN and BOARD_LABELS used to live here: two more four-board records
// from the same era, exported and imported by nothing. The names that are
// actually used are BOARD_KIND_LABELS (types/board.ts, exhaustive over
// BoardKind) and the fqbn each board declares. Removed rather than widened —
// a fifth stale copy of "Velxio has four boards" is not worth keeping.

export const DEFAULT_BOARD_POSITION = { x: 50, y: 50 };
export const ARDUINO_POSITION = DEFAULT_BOARD_POSITION;

// ── Lightweight shim wrapping Esp32Bridge so component simulations (DHT22, etc.)
// can call setPinState / pinManager just like they would on a local simulator. ──
// Exported for tests only: the ADC channel map below is chip-specific and was
// wrong for two whole chip families for months with nothing asserting it.
export class Esp32BridgeShim {
  pinManager: PinManager;
  // Digital input pins are driven from the SPICE solve
  // (connectDigitalInputsToMcu), not the part-level seed — so a button reads
  // the real circuit (pull-up, GND, shorts) like hardware. Parts check this
  // flag and skip their direct setPinState seed for this board.
  readonly spiceDrivenInputs = true;
  onSerialData: ((ch: string) => void) | null = null;
  onPinChangeWithTime: ((pin: number, state: boolean, timeMs: number) => void) | null = null;
  onBaudRateChange: ((baud: number) => void) | null = null;
  private bridge: Esp32Bridge;

  /**
   * Cross-board I2C surface — see AVRSimulator / RP2040Simulator for
   * the canonical pattern.  ESP32 sketches run in backend QEMU, so the
   * "primary" I2C path goes through the backend's libqemu-xtensa I2C
   * slaves and reaches the frontend as `i2c_event` / `i2c_transaction`
   * WebSocket messages.  But virtual devices attached to the ESP32
   * board on the canvas also live frontend-side as I2CDevice instances
   * — and Interconnect's bridge mechanism needs to reach them when a
   * peer board's master tries to read across an SDA+SCL wire.  So we
   * expose an I2CBusManager whose local devices mirror what
   * ProtocolParts registers via `registerSensor`.  The peer-master
   * direction works through this bus; the ESP32-master direction
   * still flows through the backend (where the firmware runs).
   */
  private i2cBusInstance: I2CBusManager;

  /**
   * Canvas parts waiting for a decoded WS2812 frame, keyed by their DIN pin.
   *
   * A NeoPixel part normally recovers its colours by timing the edges on DIN
   * (createNeopixelDecoder), which is what a bit-banging core like the AVR
   * produces. The ESP32 does not bit-bang: Adafruit_NeoPixel drives the pixel
   * through the RMT peripheral, the engine consumes that stream itself, and
   * the pin never toggles — so the edge decoder sees nothing and the part
   * stays black forever, with no error anywhere (the "NeoPixel never lights on
   * ESP32" reports). The engine hands us the decoded frame instead; this is
   * where a part collects it.
   *
   * Keyed by pin, and the shim is already per-board, so two boards each with a
   * pixel on GPIO 6 stay separate.
   */
  private ws2812Sinks = new Map<number, (pixels: Ws2812Pixel[]) => void>();

  constructor(bridge: Esp32Bridge, pm: PinManager) {
    this.bridge = bridge;
    this.pinManager = pm;
    this.i2cBusInstance = new I2CBusManager(nullI2CMaster());

    // Wire the write-forwarding path: when the backend ProxySlave emits
    // a completed write transaction (one full STOP-bounded master phase
    // from the ESP32 firmware), look up the peer device on the local
    // device lookup map and replay the bytes through its writeByte()
    // contract.  Peer `I2CDevice` implementations (I2CMemoryDevice,
    // VirtualPCF8574, VirtualSSD1306, …) already encode the
    // pointer-byte + data semantics; we just hand off the sequence.
    bridge.onProxyI2cComplete = (addr: number, data: number[]) => {
      const dev = this._peerDeviceLookup.get(addr);
      if (!dev) return;
      try {
        for (const b of data) dev.writeByte(b);
        dev.stop?.();
      } catch (e) {
        console.warn(
          `[Esp32BridgeShim] proxy write replay failed for 0x${addr.toString(16)}`,
          e,
        );
      }
    };
  }

  setPinState(pin: number, state: boolean): void {
    this.bridge.sendPinEvent(pin, state);
  }

  /**
   * Claim the decoded WS2812 frames going out on `pin` while the part is
   * attached. Returns the unsubscribe, like every other part subscription.
   */
  subscribeWs2812(pin: number, sink: (pixels: Ws2812Pixel[]) => void): () => void {
    this.ws2812Sinks.set(pin, sink);
    return () => {
      if (this.ws2812Sinks.get(pin) === sink) this.ws2812Sinks.delete(pin);
    };
  }

  /** The store hands a frame the engine decoded to whoever claimed that pin. */
  publishWs2812(pin: number, pixels: Ws2812Pixel[]): void {
    const sink = this.ws2812Sinks.get(pin);
    if (!sink) return;
    try {
      sink(pixels);
    } catch (e) {
      console.warn(`[Esp32BridgeShim] ws2812 sink for pin ${pin} threw`, e);
    }
  }

  getCurrentCycles(): number {
    // Deliberately -1, even when the in-browser engine below DOES have a cycle
    // counter: several parts read `getCurrentCycles() >= 0` to tell an AVR from
    // an ESP32 bridge (ComplexParts' servo picks its whole strategy on it).
    // Guest TIME is exposed separately, through getGuestMicros().
    return -1;
  }
  getClockHz(): number {
    return 240_000_000;
  }
  /**
   * Elapsed guest time in microseconds, or -1 when this board's clock is not
   * readable from the browser (backend QEMU runs in another process).
   *
   * An in-browser engine carries its own virtual clock, and a part generating a
   * time-varying signal has to step it on THAT clock — see `guestMillis` in
   * simulation/parts/partUtils. Optional on the bridge: the stock QEMU
   * `Esp32Bridge` does not implement it and answers -1 here.
   */
  getGuestMicros(): number {
    const b = this.bridge as unknown as { getGuestMicros?: () => number };
    return typeof b.getGuestMicros === 'function' ? b.getGuestMicros() : -1;
  }
  isRunning(): boolean {
    return this.bridge.connected;
  }
  serialWrite(text: string): void {
    this.bridge.sendSerialBytes(Array.from(new TextEncoder().encode(text)));
  }
  /**
   * Feed RAW BYTES into a hardware UART's RX. Use this, not `feedUart`, for
   * anything that is not text.
   *
   * `feedUart`/`serialWrite` take a string and run it through TextEncoder,
   * which is UTF-8: every byte >= 0x80 comes out as TWO bytes. That is
   * invisible for NMEA or AT chatter and silently fatal for a binary frame —
   * a reply of `AA 55 04 00 FF FD 01 FD 55 AA` reaches the guest as
   * `C2 AA 55 04 00 C3 BF C3 BD 01 C3 BD 55 C2 AA` and no parser recovers.
   * Byte-oriented device models (framed UART protocols with checksums and
   * 0xAA/0x55 sync words) need the bytes to arrive as written.
   */
  sendSerialBytes(bytes: number[], uart = 0): void {
    this.bridge.sendSerialBytes(bytes, uart);
  }
  /**
   * Feed TEXT into a hardware UART's RX from an external part (GPS module,
   * a wired peer board via Interconnect, …). Uniform seam across simulators
   * (`sim.feedUart(uart, data)`). The backend QEMU worker routes the bytes
   * into the requested UART (0 = Serial / GPIO3, 2 = Serial2 / GPIO16 on
   * the classic ESP32 pinout). Text only — see `sendSerialBytes` above.
   */
  feedUart(uart: number, data: string): boolean {
    this.bridge.sendSerialBytes(Array.from(new TextEncoder().encode(data)), uart);
    return true;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getADC(): any {
    return null;
  }

  /**
   * GPIO -> ADC channel, for `setAdcVoltage` and `setAdcWaveform`.
   *
   * The mapping is CHIP-specific, and there are two sources for it:
   *
   *   1. The bridge, when it implements `adcChannelForGpio`. A bridge that
   *      knows which engine will run the board is the better authority,
   *      because the answer can differ per BACKEND and not just per chip
   *      (see the QEMU-only indices below). Private overlays install such a
   *      bridge; it answers before connect(), which matters because part
   *      attaches seed their ADC values before the run starts.
   *   2. This map, otherwise. The plain `Esp32Bridge` does not implement
   *      the method, so every QEMU-backed run lands here.
   *
   * Chip coverage of the fallback, all QEMU-backed:
   *   - Classic ESP32: ADC1 on GPIO 36-39 (CH0-3) and 32-35 (CH4-7).
   *   - ESP32-S3 family, including xiao-esp32-s3 and the S3-based
   *     arduino-nano-esp32: ADC1 = GPIO 1-10 (CH0-9), ADC2 = GPIO 11-20 at
   *     channel index 10-19, which is what the machine's SENS stub uses.
   *     Without this branch analogRead always saw 0 there (2026-07
   *     emulation-gaps audit, F1).
   *   - ESP32-C3 family: ADC1 = GPIO0-4 -> CH0-4, and GPIO5 (ADC2_CH0) at
   *     index 5. Verified against the qemu SARADC: esp32_adc_set{channel:3}
   *     is what analogRead(3) returns (emulation-gaps harness, 2026-07-31).
   *
   * This used to be TWO methods with the same name in this class body, one
   * holding the per-chip map and one holding the bridge delegation. Only
   * the later definition existed at runtime, so the per-chip map was dead
   * code and every QEMU run fell through to the classic ESP32 map: an S3 or
   * C3 board resolved -1 for its real ADC pins and setAdcVoltage dropped the
   * value, silently, which is the regression the per-chip map had been
   * written to fix. esbuild warned on every build ("Duplicate member
   * adcChannelForPin in class body") and the warning scrolled past.
   */
  private adcChannelForPin(pin: number): number {
    const b = this.bridge as unknown as { adcChannelForGpio?: (gpio: number) => number };
    if (typeof b.adcChannelForGpio === 'function') return b.adcChannelForGpio(pin);
    const kind = this.bridge.boardKind as string;
    if (kind === 'esp32-s3' || kind === 'xiao-esp32-s3' || kind === 'arduino-nano-esp32') {
      if (pin >= 1 && pin <= 10) return pin - 1;
      if (pin >= 11 && pin <= 20) return 10 + (pin - 11);
      return -1;
    }
    if (kind === 'esp32-c3' || kind === 'xiao-esp32-c3' || kind === 'aitewinrobot-esp32c3-supermini') {
      return pin >= 0 && pin <= 5 ? pin : -1;
    }
    if (pin >= 36 && pin <= 39) return pin - 36; // GPIO 36→CH0 … 39→CH3
    if (pin >= 32 && pin <= 35) return pin - 28; // GPIO 32→CH4 … 35→CH7
    return -1;
  }

  setAdcVoltage(pin: number, voltage: number): boolean {
    const channel = this.adcChannelForPin(pin);
    if (channel < 0) return false;
    const millivolts = Math.round(voltage * 1000);
    this.bridge.setAdc(channel, millivolts);
    return true;
  }

  /**
   * Push a 12-bit waveform LUT to QEMU for per-read ADC interpolation.
   * Call once per SPICE `.tran` solve; QEMU interpolates at every MMIO
   * read against its virtual clock. See `Esp32Bridge.setAdcWaveform`.
   *
   * `pin` follows the same GPIO→channel mapping as `setAdcVoltage`.
   * `samples` are 12-bit raw values (0-4095) aligned on a uniform grid.
   */
  setAdcWaveform(pin: number, samples: Uint16Array, periodNs: number): boolean {
    const channel = this.adcChannelForPin(pin);
    if (channel < 0) return false;
    this.bridge.setAdcWaveform(channel, samples, periodNs);
    return true;
  }
  getMCU(): null {
    return null;
  }
  start(): void {
    /* managed by bridge */
  }
  stop(): void {
    /* managed by bridge */
  }
  reset(): void {
    /* managed by bridge */
  }
  setSpeed(_s: number): void {
    /* no-op */
  }
  getSpeed(): number {
    return 1;
  }
  loadHex(_hex: string): void {
    /* no-op */
  }
  loadBinary(_b64: string): void {
    /* no-op */
  }

  // ── Generic sensor registration (board-agnostic API) ──────────────────────
  // ESP32 delegates sensor protocols to the backend QEMU.

  /** The line contract's declaration: whatever the bridge behind this shim
   *  can host (the QEMU worker's models, or an in-browser engine's). */
  lineSupport(): LineSupport {
    return this.bridge.lineSupport();
  }

  registerSensor(type: string, pin: number, properties: Record<string, unknown>): boolean {
    this.bridge.sendSensorAttach(type, pin, properties);
    return true; // backend handles the protocol
  }

  /** Pins a backend-emulated single-wire sensor drives itself. The generic
   *  seam connectDigitalInputsToMcu asks before thresholding a pin into the
   *  guest — see simulation/partPinOwnership for the same rule on the part
   *  side. Both exist because they know different halves: the part layer knows
   *  what the canvas attached, the bridge knows what the worker was told. */
  ownsPin(pin: number): boolean {
    // Optional call on purpose: this shim wraps whichever bridge the build
    // installed (the OSS QEMU one, or an overlay's in-browser engine), and a
    // missing answer must degrade to "not owned", never to a TypeError thrown
    // inside the SPICE subscription.
    return this.bridge.ownsSensorPin?.(pin) ?? false;
  }

  /**
   * Expose the underlying Esp32Bridge so simulation parts can subscribe to
   * board-specific WS events (e.g. `onEpaperUpdate` for the ePaper backend
   * rendering path). Hooks should restore any handler they overwrite.
   */
  getBridge(): Esp32Bridge {
    return this.bridge;
  }

  /**
   * Generic SPI bus adapter — same shape as AVRSimulator.spi so SPI-driven
   * parts (ILI9341, SD cards, custom chips…) can hook the bus without
   * caring whether they're on AVR, RP2040, or any of the ESP32 variants.
   * The MOSI byte arrives via the QEMU worker's spi_event WS message
   * (decoded in Esp32Bridge); MISO is driven by the worker's
   * `_spi_response` global, so `completeTransfer` is a no-op on ESP32.
   *
   * Lazy-initialised so the bridge subscription only happens once a part
   * actually accesses `.spi`.
   */
  private _spiAdapter: { onByte: ((mosi: number) => void) | null;
                         completeTransfer: (miso: number) => void } | null = null;
  get spi(): { onByte: ((mosi: number) => void) | null;
               completeTransfer: (miso: number) => void } {
    if (!this._spiAdapter) {
      const adapter = {
        onByte: null as ((mosi: number) => void) | null,
        // MISO goes back through the bridge's setSpiResponse — every bridge
        // has it (QEMU forwards to the worker's _spi_response; the JS engines
        // set the byte their SpiForwarder returns for THIS transfer, since the
        // whole onByte chain runs synchronously inside the engine's transfer).
        // This used to be a no-op "because the worker drives MISO", which was
        // only true for QEMU-era parts: any SPI part that ANSWERS (an SD card
        // reponding to CMD0) was talking to nobody in js mode — measured as
        // SD.begin()=0 with sd_diskio retrying CMD0 forever.
        completeTransfer: (miso: number) => {
          (this.bridge as unknown as { setSpiResponse?: (b: number) => void })
            .setSpiResponse?.(miso);
        },
      };
      // Forward every per-byte WS event into whichever handler the part
      // installed. Single-listener channel — last writer wins.
      this.bridge.onSpiByte = (mosi: number) => {
        adapter.onByte?.(mosi);
      };
      this._spiAdapter = adapter;
    }
    return this._spiAdapter;
  }
  updateSensor(pin: number, properties: Record<string, unknown>): void {
    this.bridge.sendSensorUpdate(pin, properties);
  }
  unregisterSensor(pin: number): void {
    this.bridge.sendSensorDetach(pin);
  }

  // ── I2C write-only device relay (SSD1306, PCF8574) ───────────────────────
  private _i2cTransactionListeners = new Map<number, (data: number[]) => void>();

  addI2CTransactionListener(addr: number, fn: (data: number[]) => void): void {
    this._i2cTransactionListeners.set(addr, fn);
    this.bridge.onI2cTransaction = (a: number, data: number[]) => {
      this._i2cTransactionListeners.get(a)?.(data);
    };
  }

  removeI2CTransactionListener(addr: number): void {
    this._i2cTransactionListeners.delete(addr);
    if (this._i2cTransactionListeners.size === 0) {
      this.bridge.onI2cTransaction = null;
    }
  }

  // ── Cross-board I2C bus surface ─────────────────────────────────────────

  /**
   * Expose the I2CBusManager so Interconnect can install cross-board
   * bridges and ProtocolParts can register frontend-side virtual
   * devices.  ESP32 has 2 hardware I2C buses but we collapse them
   * onto a single front-end bus for now — the bus index is ignored.
   * Splitting per-bus would require teaching the backend to tag
   * `i2c_event` payloads with the originating bus number, which
   * the lib worker already does (`bus` field) but the frontend
   * shim doesn't yet route on.
   */
  getI2CBus(_bus: 0 | 1 = 0): I2CBusManager {
    return this.i2cBusInstance;
  }

  /**
   * Register a frontend-side virtual I2C device.  This mirrors the
   * backend's QEMU-side slave (kept in sync via `registerSensor` /
   * `updateSensor`) so peer boards reading across the I2C bridge
   * find the device.  ProtocolParts calls this on the ESP32 path
   * alongside the existing `registerSensor` + `addI2CTransactionListener`.
   */
  /** Sync-attached part devices, kept so a bridge REBUILD can adopt them.
   *  The overlay loads async: a deep-linked example attaches its parts to the
   *  shim wired around the stock QEMU bridge (whose attachSyncI2cDevice is
   *  missing — a silent no-op), and only then does the overlay's factory
   *  rebuild the board. Without this record the part's device existed
   *  nowhere: the C6 gesture example booted with an EMPTY engine I2C bus and
   *  arduino's i2c-ng driver failed every transaction (ESP_ERR_INVALID_STATE)
   *  — whether it broke depended on a chunk-load race the pro bundle's growth
   *  turned into a sure loss. */
  private syncI2cParts = new Map<number, I2CDevice>();

  addI2CDevice(device: I2CDevice, _bus: 0 | 1 = 0): void {
    this.i2cBusInstance.addDevice(device);
    this.syncI2cParts.set(device.address, device);
    // An in-browser JS-emulator substitute bridge (velxio-prod overlay) plugs
    // the part's real device model straight onto the engine's synchronous I2C
    // bus, so the firmware's own reads hit it (sensors answer, displays
    // render). The QEMU WebSocket bridge has no such method — reads there are
    // served by the backend slave from registerSensor — so this is a no-op.
    (this.bridge as { attachSyncI2cDevice?: (d: I2CDevice) => void }).attachSyncI2cDevice?.(device);
  }

  /** A rebuilt board gets a fresh shim; the parts on the canvas do NOT
   *  re-attach (their closures hold the old shim), so the new shim re-plays
   *  everything the old one had. Runs through addI2CDevice so the new bridge
   *  (a pre-connect-buffering Delegating bridge) hears about each device. */
  adoptPartsFrom(prev: Esp32BridgeShim): void {
    for (const dev of prev.syncI2cParts.values()) this.addI2CDevice(dev);
    // Same reason as the I2C devices: a NeoPixel part subscribed to the OLD
    // shim and will not re-attach for a bridge rebuild, so without this the
    // pixel goes black on the first recompile and never comes back.
    for (const [pin, sink] of prev.ws2812Sinks) this.ws2812Sinks.set(pin, sink);
  }

  /**
   * Attach (or clear, with null) the microphone sample source feeding the
   * board's I2S RX path: one signed 16-bit sample per call. Same forwarding
   * pattern as addI2CDevice — the in-browser JS-engine bridges implement
   * setMicrophoneSource (velxio-prod overlay); everywhere else it's a no-op,
   * which reads as a silent mic.
   */
  setMicrophoneSource(source: (() => number) | null): boolean {
    const b = this.bridge as { setMicrophoneSource?: (s: (() => number) | null) => void };
    if (typeof b?.setMicrophoneSource === 'function') {
      b.setMicrophoneSource(source);
      return true;
    }
    // No bridge, or one without an audio path: the caller learns the truth
    // instead of talking into a void — a part can then SAY the host has no
    // I2S rather than pretending to stream.
    return false;
  }

  /**
   * Watch the board's audio OUTPUT: the callback gets the peak level of each
   * block the guest played (0..32767). The audio itself goes to the host's
   * sound card — a board with an on-board speaker/jack plays through YOUR
   * speakers, so nothing is wired for it on the canvas; this is only the
   * "is it making sound" signal a part needs to animate. Pass null to stop.
   * No-op on bridges without an audio path (a silent speaker).
   */
  setSpeakerMonitor(cb: ((peak: number) => void) | null): void {
    (this.bridge as { setSpeakerMonitor?: (c: ((p: number) => void) | null) => void })
      .setSpeakerMonitor?.(cb);
  }

  /**
   * Gate the board's audio OUTPUT at the sink end: muted, the guest keeps
   * clocking I2S TX samples out exactly like real hardware with nothing
   * plugged in, but the host speakers stay silent. The part that IS the
   * speaker (seated or wired) opens the gate while it is connected and
   * closes it when it is lifted off. No-op on bridges without an audio path.
   */
  setSpeakerMuted(muted: boolean): void {
    (this.bridge as { setSpeakerMuted?: (m: boolean) => void }).setSpeakerMuted?.(muted);
  }

  /** Remove a previously-registered virtual device. */
  removeI2CDevice(addr: number, _bus: 0 | 1 = 0): void {
    this.i2cBusInstance.removeDevice(addr);
    this.syncI2cParts.delete(addr);
    (this.bridge as { detachSyncI2cDevice?: (a: number) => void }).detachSyncI2cDevice?.(addr);
  }

  /**
   * Push register snapshots of a peer board's I2C devices into a
   * backend `ProxySlave` per address.  Called by Interconnect after a
   * cross-board I2C bridge is installed so the ESP32 firmware's Wire
   * master reads can find the peer's devices inside QEMU.
   *
   * Walks the peer bus AND its transitive bridges (BFS).  Each device
   * found at any reachable hop gets a ProxySlave on the backend.  All
   * addresses discovered through `peerBus` are tracked under that key,
   * so `clearProxiesForPeer(peerBus)` cleans up exactly what this call
   * installed without disturbing proxies from concurrent bridges
   * (e.g. when another wire pair also connects to this same ESP32).
   *
   * Devices that don't expose `dumpRegisters` (PCF8574, SSD1306,
   * LCD-I2C) are skipped — they receive state through the
   * write-forwarding path (proxy_i2c_complete event from the backend
   * ProxySlave) instead.
   */
  syncProxyFromPeer(peerBus: I2CBusManager): void {
    const ownedAddrs = this._proxiedByPeer.get(peerBus) ?? new Set<number>();

    // BFS over the peer's bridge graph.  Skip our own bus so we don't
    // mirror ourselves back via the return edge.
    const visited = new Set<I2CBusManager>([this.i2cBusInstance, peerBus]);
    const queue: I2CBusManager[] = [peerBus];

    while (queue.length > 0) {
      const bus = queue.shift()!;
      if (typeof bus.listDevices === 'function') {
        for (const device of bus.listDevices()) {
          // Track the live device reference for write-forwarding and
          // periodic resync.  Last writer wins on address collisions
          // (rare; the user wired two devices to the same address).
          this._peerDeviceLookup.set(device.address, device);
          if (typeof device.dumpRegisters !== 'function') continue;
          try {
            const regs = device.dumpRegisters();
            this.bridge.registerProxyI2c(device.address, regs);
            ownedAddrs.add(device.address);
            // Prime the resync hash so the first tick doesn't push a
            // redundant identical dump.
            this._lastDumpHash.set(
              device.address,
              Esp32BridgeShim._hashRegs(regs),
            );
          } catch (e) {
            console.warn(
              `[Esp32BridgeShim] syncProxyFromPeer dump failed for 0x${device.address.toString(16)}`,
              e,
            );
          }
        }
      }
      if (typeof bus.getBridges === 'function') {
        for (const next of bus.getBridges()) {
          if (visited.has(next)) continue;
          visited.add(next);
          queue.push(next);
        }
      }
    }

    if (ownedAddrs.size > 0) {
      this._proxiedByPeer.set(peerBus, ownedAddrs);
      this._ensureResyncTimer();
    }
  }

  /**
   * Tear down only the proxies that `syncProxyFromPeer(peerBus)`
   * installed.  Safe to call multiple times; idempotent.  Other
   * concurrent bridges (different peer buses) retain their proxies.
   */
  clearProxiesForPeer(peerBus: I2CBusManager): void {
    const owned = this._proxiedByPeer.get(peerBus);
    if (!owned) return;
    for (const addr of owned) {
      // Only unregister if no other peer also claims this address.
      let claimedElsewhere = false;
      for (const [other, set] of this._proxiedByPeer) {
        if (other !== peerBus && set.has(addr)) {
          claimedElsewhere = true;
          break;
        }
      }
      if (!claimedElsewhere) {
        this.bridge.unregisterProxyI2c(addr);
        this._peerDeviceLookup.delete(addr);
        this._lastDumpHash.delete(addr);
      }
    }
    this._proxiedByPeer.delete(peerBus);
    this._stopResyncTimerIfIdle();
  }

  /**
   * Tear down EVERY proxy slave we've installed.  Used on full board
   * stop / disconnect — `clearProxiesForPeer` is preferred for
   * single-wire-pair teardowns.
   */
  clearAllProxies(): void {
    for (const set of this._proxiedByPeer.values()) {
      for (const addr of set) this.bridge.unregisterProxyI2c(addr);
    }
    this._proxiedByPeer.clear();
    this._peerDeviceLookup.clear();
    this._lastDumpHash.clear();
    this._stopResyncTimerIfIdle();
  }

  /** Per-peer set of addresses we've mirrored.  Cleanup keyed by peer bus. */
  private _proxiedByPeer = new Map<I2CBusManager, Set<number>>();
  /** Address → live frontend device, for write-forwarding & periodic resync. */
  private _peerDeviceLookup = new Map<number, I2CDevice>();
  /** Periodic resync timer — runs while any proxy is live. */
  private _resyncTimer: ReturnType<typeof setInterval> | null = null;
  /** Cheap hash of the last dumped register set per address, to skip WS pushes when unchanged. */
  private _lastDumpHash = new Map<number, number>();

  /**
   * Periodic resync interval in ms.  250 ms strikes the balance
   * between WS bandwidth and human-perceivable RTC freshness; see
   * the architecture rationale in the plan file.  Exposed for tests
   * that want a faster cadence via fake timers.
   */
  static RESYNC_INTERVAL_MS = 250;

  private _ensureResyncTimer(): void {
    if (this._resyncTimer !== null) return;
    if (this._proxiedByPeer.size === 0) return;
    this._resyncTimer = setInterval(
      () => this._resyncTick(),
      Esp32BridgeShim.RESYNC_INTERVAL_MS,
    );
  }

  private _stopResyncTimerIfIdle(): void {
    if (this._proxiedByPeer.size === 0 && this._resyncTimer !== null) {
      clearInterval(this._resyncTimer);
      this._resyncTimer = null;
      this._lastDumpHash.clear();
    }
  }

  /**
   * Cheap XOR-stride hash over a 256-byte buffer.  Detects any byte
   * difference; collisions are theoretically possible but we don't
   * care — a missed update on a flaky hash just delays freshness by
   * one cycle.
   */
  private static _hashRegs(regs: Uint8Array): number {
    let h = regs.length & 0xff;
    for (let i = 0; i < regs.length; i += 16) {
      h = ((h << 5) - h + regs[i]) | 0;
    }
    for (let i = 0; i < Math.min(regs.length, 8); i++) {
      h = ((h << 5) - h + regs[i]) | 0;
    }
    return h;
  }

  private _resyncTick(): void {
    // Union of all proxied addresses across peers.
    const seen = new Set<number>();
    for (const set of this._proxiedByPeer.values()) {
      for (const addr of set) seen.add(addr);
    }
    for (const addr of seen) {
      const device = this._peerDeviceLookup.get(addr);
      if (!device || typeof device.dumpRegisters !== 'function') continue;
      let regs: Uint8Array;
      try {
        regs = device.dumpRegisters();
      } catch {
        continue;
      }
      const h = Esp32BridgeShim._hashRegs(regs);
      if (this._lastDumpHash.get(addr) === h) continue;
      this._lastDumpHash.set(addr, h);
      this.bridge.updateProxyI2c(addr, regs);
    }
  }
}

// ── LEDC duty handler ───────────────────────────────────────────────────
//
// Resolves a (channel, duty_pct) event from the worker into one or more
// (gpio_pin, duty_cycle) updates by consulting the per-board
// SignalRouter mirror. Replaces the legacy `ledc_update` path that
// embedded the gpio in the event and needed a per-channel memo + a
// PinManager.broadcastPwm fallback to survive the worker's gpio=-1
// race window.

function makeLedcDutyHandler(boardId: string) {
  return (duty: { channel: number; duty_pct: number; freq_hz?: number }) => {
    const boardPm = pinManagerMap.get(boardId);
    const router = signalRouterMap.get(boardId);
    if (!boardPm || !router) return;
    const dutyCycle = duty.duty_pct / 100;
    const signalId = ledcSignalForChannel(duty.channel);
    const pins = router.pinsForSignal(signalId);
    // Multi-pin routing: one LEDC channel CAN legally drive multiple
    // pins via the GPIO Matrix (rare but documented in TRM). Iterate
    // all of them — each gets its own updatePwm call.
    for (const pin of pins) {
      // The carrier frequency rides alongside, when the engine knows it: a
      // speaker listener reads it back with getPwmFreq to play the sketch's
      // actual note rather than a canned one.
      if (duty.freq_hz && duty.freq_hz > 0) boardPm.setPwmFreq(pin, duty.freq_hz);
      boardPm.updatePwm(pin, dutyCycle);
    }
  };
}

/**
 * A decoded WS2812 frame from the engine's RMT peripheral.
 *
 * Two destinations, because there are two kinds of NeoPixel on the canvas:
 *  - a part the user placed and wired — reached by its DIN pin through the
 *    board's shim (Esp32BridgeShim.subscribeWs2812). This is the path that
 *    makes `neopixel` / `led-ring` / `neopixel-matrix` work on ESP32 at all:
 *    those parts otherwise time the edges on DIN, and the RMT peripheral
 *    produces none;
 *  - the legacy `ws2812-{boardId}-{channel}` DOM contract, kept because a
 *    board element that draws its own strip may still claim that id.
 */
function makeWs2812Handler(boardId: string) {
  return (channel: number, pixels: Ws2812Pixel[], pin?: number | null) => {
    if (pin != null) {
      const shim = simulatorMap.get(boardId);
      if (shim instanceof Esp32BridgeShim) shim.publishWs2812(pin, pixels);
    }
    const eventTarget = document.getElementById(`ws2812-${boardId}-${channel}`);
    if (eventTarget) {
      eventTarget.dispatchEvent(new CustomEvent('ws2812-pixels', { detail: { pixels } }));
    }
  };
}

function makeGpioRoutingHandler(boardId: string) {
  return (routing: { gpio: number; signal_id: number }) => {
    signalRouterMap.get(boardId)?.updateRouting(routing.gpio, routing.signal_id);
  };
}

function makeGpioRoutingClearHandler(boardId: string) {
  return (gpio: number) => {
    signalRouterMap.get(boardId)?.clearRouting(gpio);
  };
}

function makePinPullHandler(boardId: string) {
  return (gpio: number, pull: 0 | 1 | 2) => {
    // Record the internal pull so the netlist stamps a weak resistor
    // (vcc_rail for pull-up, GND for pull-down) and request a re-solve.
    const pm = pinManagerMap.get(boardId);
    pm?.setPinPull(gpio, pull);
    // Seed the guest input to the pull's RESTING level immediately (real
    // silicon raises the pad in nanoseconds). Two failure modes this
    // closes (2026-07 audit): (a) the boot window before the first SPICE
    // solve where INPUT_PULLUP read LOW and phantom-triggered buttons,
    // and (b) an INPUT_PULLUP pin with NOTHING wired — no net in
    // pinNetMap, so connectDigitalInputsToMcu never drives it and the
    // guest read 0 forever. On wired+sourced nets the connector overrides
    // with the solved level right after, so the "mis-wired button still
    // works" bug does NOT come back: the solve remains authoritative.
    if (pull !== 0 && !(pm?.getOutputPins().has(gpio))) {
      const sim = simulatorMap.get(boardId) as
        | { setPinState?: (pin: number, state: boolean) => void }
        | undefined;
      sim?.setPinState?.(gpio, pull === 1);
    }
    requestElectricalResolve();
  };
}

// ── Lightweight shim wrapping Stm32Bridge so PartSimulationRegistry parts
// (I2C displays, sensors, SPI panels) attach to an STM32 board the same way
// they attach to ESP32.  Like the STM32 firmware itself, every device model
// runs in the backend QEMU worker: `registerSensor` builds the QEMU-side I2C
// slave, write-only devices (SSD1306, PCF8574) stream their bytes back via
// `i2c_transaction`, and SPI panels read MOSI bytes off the `spi_batch`
// channel through the `.spi` adapter — identical surface to Esp32BridgeShim,
// minus the ESP32-only WiFi / proxy-resync machinery. ──────────────────────
class Stm32BridgeShim {
  // Drive digital INPUT pins from the solved circuit (connectDigitalInputsToMcu)
  // instead of the legacy part-seed, so digitalRead() reflects the REAL wiring.
  // The internal pull is reported by the backend QEMU worker via the bridge's
  // `gpio_pull` message (wired to makePinPullHandler in the store). Mirrors AVR
  // / RP2040 / ESP32; event-driven parts with no SPICE model are protected by
  // the `sourcedNets` gate in the connector.
  readonly spiceDrivenInputs = true;
  pinManager: PinManager;
  onSerialData: ((ch: string) => void) | null = null;
  onPinChangeWithTime: ((pin: number, state: boolean, timeMs: number) => void) | null = null;
  onBaudRateChange: ((baud: number) => void) | null = null;
  private bridge: Stm32Bridge;
  private i2cBusInstance: I2CBusManager;
  private _i2cTransactionListeners = new Map<number, (data: number[]) => void>();

  constructor(bridge: Stm32Bridge, pm: PinManager) {
    this.bridge = bridge;
    this.pinManager = pm;
    this.i2cBusInstance = new I2CBusManager(nullI2CMaster());
  }

  // ── Lifecycle stubs (the store drives the real bridge via getStm32Bridge) ──
  start(): void {}
  stop(): void {}
  reset(): void {}
  setSpeed(_s: number): void {}
  getSpeed(): number { return 1; }
  loadHex(_hex: string): void {}
  loadBinary(_b64: string): void {}
  isRunning(): boolean { return this.bridge.connected; }

  /** Drive a GPIO input from a part. `pin` is the linear pin (port*16+pin). */
  setPinState(pin: number, state: boolean): void {
    this.bridge.sendPinEvent(pin, state);
  }

  /** Raw-byte counterpart of `feedUart` — see the note on the ESP32 shim:
   *  feedUart is UTF-8 and mangles any byte >= 0x80, so binary protocols
   *  must use this. */
  sendSerialBytes(bytes: number[], uart = 0): void {
    this.bridge.sendSerialBytes(bytes, uart);
  }
  /**
   * Feed TEXT into a hardware USART's RX from an external part (GPS module,
   * a wired peer board via Interconnect, …). Uniform seam across simulators
   * (`sim.feedUart(uart, data)`). uart 0 = USART1 (PA10 RX), 1 = USART2 (PA3).
   * Text only — see `sendSerialBytes` above.
   */
  feedUart(uart: number, data: string): boolean {
    this.bridge.sendSerialBytes(Array.from(new TextEncoder().encode(data)), uart);
    return true;
  }

  /** The STM32 worker reuses the ESP32 worker's device models but leaves out
   *  the DHT22 / HC-SR04 sync handlers (stm32_worker.py header), so a
   *  line-owning sensor on an STM32 has nothing to answer it. Said here, so
   *  the part hears it instead of waiting on a silent pad. */
  lineSupport(): LineSupport {
    return {
      mode: 'none',
      why: "the STM32 emulator's worker does not model single-wire sensors (no DHT22 / HC-SR04 handlers)",
    };
  }

  // ── Generic sensor registration (delegated to the backend QEMU worker) ──
  registerSensor(type: string, pin: number, properties: Record<string, unknown>): boolean {
    this.bridge.sendSensorAttach(type, pin, properties);
    return true;
  }
  updateSensor(pin: number, properties: Record<string, unknown>): void {
    this.bridge.sendSensorUpdate(pin, properties);
  }
  unregisterSensor(pin: number): void {
    this.bridge.sendSensorDetach(pin);
  }

  /** Expose the bridge so SPI/ePaper parts can subscribe to backend frames. */
  getBridge(): Stm32Bridge {
    return this.bridge;
  }

  // ── I2C write-only device relay (SSD1306, PCF8574) ────────────────────────
  addI2CTransactionListener(addr: number, fn: (data: number[]) => void): void {
    this._i2cTransactionListeners.set(addr, fn);
    this.bridge.onI2cTransaction = (a: number, data: number[]) => {
      this._i2cTransactionListeners.get(a)?.(data);
    };
  }
  removeI2CTransactionListener(addr: number): void {
    this._i2cTransactionListeners.delete(addr);
    if (this._i2cTransactionListeners.size === 0) {
      this.bridge.onI2cTransaction = null;
    }
  }

  // ── Cross-board I2C bus surface (for Interconnect bridges) ────────────────
  getI2CBus(_bus: 0 | 1 = 0): I2CBusManager {
    return this.i2cBusInstance;
  }
  addI2CDevice(device: I2CDevice, _bus: 0 | 1 = 0): void {
    this.i2cBusInstance.addDevice(device);
  }
  removeI2CDevice(addr: number, _bus: 0 | 1 = 0): void {
    this.i2cBusInstance.removeDevice(addr);
  }

  // ── Generic SPI bus adapter (same shape as AVRSimulator.spi) ──────────────
  // SPI panels (ILI9341, SSD1306-SPI) hook `.spi.onByte`; STM32 runs SPI in
  // the backend, so the MOSI bytes arrive batched over `spi_batch` and we
  // replay them one at a time. MISO is driven by the worker, so
  // `completeTransfer` is a no-op (mirrors the ESP32 adapter).
  private _spiAdapter: {
    onByte: ((mosi: number) => void) | null;
    completeTransfer: (miso: number) => void;
  } | null = null;
  get spi(): {
    onByte: ((mosi: number) => void) | null;
    completeTransfer: (miso: number) => void;
  } {
    if (!this._spiAdapter) {
      const adapter = {
        onByte: null as ((mosi: number) => void) | null,
        completeTransfer: (_miso: number) => {},
      };
      this.bridge.onSpiBatch = (bytes: Uint8Array) => {
        for (const b of bytes) adapter.onByte?.(b);
      };
      this._spiAdapter = adapter;
    }
    return this._spiAdapter;
  }
}

// ── Runtime Maps (outside Zustand — not serialisable) ─────────────────────
const simulatorMap = new Map<
  string,
  | AVRSimulator
  | RP2040Simulator
  | RiscVSimulator
  | Esp32C3Simulator
  | Esp32BridgeShim
  | Stm32BridgeShim
  | PiBridgeShim
>();
const pinManagerMap = new Map<string, PinManager>();
// Per-board ESP32 GPIO Matrix mirror.  Populated for boards whose kind
// is an ESP32 variant (others don't have a GPIO Matrix in the same
// sense; AVR/RP2040 wire signals to pins directly without the IO_MUX).
// Lifecycle parallels pinManagerMap — created in addBoard / setBoardType
// / initSimulator, deleted in removeBoard / cleanup.
const signalRouterMap = new Map<string, SignalRouter>();
const bridgeMap = new Map<string, RaspberryPi3Bridge>();
const esp32BridgeMap = new Map<string, Esp32Bridge>();
// STM32 bridge — created lazily, only when isStm32BoardKind(boardKind).
const stm32BridgeMap = new Map<string, Stm32Bridge>();

export const getBoardSimulator = (id: string) => simulatorMap.get(id);
export const getBoardPinManager = (id: string) => pinManagerMap.get(id);
export const getBoardBridge = (id: string) => bridgeMap.get(id);

/** Upload a QEMU-Linux board's editor file group into the guest home and run
 * its script (guestHome/autoRun overridable per overlay board). Used by the
 * boot auto-run and by Run on an already-booted board. */
export async function piSyncAndRunScript(boardId: string, boardKind: string): Promise<void> {
  const bridge = bridgeMap.get(boardId);
  if (!bridge || !bridge.connected) return;
  const proDef = getProBoard(boardKind);
  const home = (proDef?.guestHome ?? '/home/pi').replace(/\/+$/, '');
  const board = useSimulatorStore.getState().boards.find((b) => b.id === boardId);
  const groupId = board?.activeFileGroupId ?? `group-${boardId}`;
  const groupFiles = useEditorStore.getState().getGroupFiles(groupId);
  const files = groupFiles.map((f) => ({ path: `${home}/${f.name}`, content: f.content }));
  try {
    const { uploadFilesToPi } = await import('../utils/piUpload');
    await uploadFilesToPi(bridge, files);
  } finally {
    // Reveal the shell (ends quietBoot) right before the script starts, so
    // the user's first visible output is their own program.
    bridge.setQuiet(false);
  }
  const cmd = proDef?.autoRun ?? `python3 ${home}/${piMainScript(groupFiles)}`;
  bridge.sendSerialText(cmd.endsWith('\n') ? cmd : cmd + '\n');
}

/** The file the guest runs: `script.py` when the group has one, else the
 * first `.py` — the same rule the in-browser engine applies, so a project
 * whose only script is `main.py` starts in either mode instead of the guest
 * printing "No such file" for a name the user never typed. */
export function piMainScript(files: readonly { name: string }[]): string {
  return (
    files.find((f) => f.name === 'script.py')?.name ??
    files.find((f) => f.name.endsWith('.py'))?.name ??
    'script.py'
  );
}

/** Re-run on a BOOTED QEMU-Linux board without rebooting: interrupt the
 * running script (Ctrl-C), re-upload the file group, run again. */
export async function piRerunScript(boardId: string, boardKind: string): Promise<void> {
  const bridge = bridgeMap.get(boardId);
  if (!bridge || !bridge.connected) return;
  bridge.sendSerialBytes([0x03]);
  await new Promise((r) => setTimeout(r, 400));
  await piSyncAndRunScript(boardId, boardKind);
}
export const getEsp32Bridge = (id: string) => esp32BridgeMap.get(id);
export const getStm32Bridge = (id: string) => stm32BridgeMap.get(id);

/** Set a board's WiFi status (used by the pro PIO peripheral to surface the
 *  Pico W's WiFi state into the canvas badge). */
export const setBoardWifiStatus = (id: string, ws: WifiStatus) =>
  useSimulatorStore.setState((s) => ({
    boards: s.boards.map((b) => (b.id === id ? { ...b, wifiStatus: ws } : b)),
  }));

// Xtensa-based ESP32 boards — use QEMU bridge (backend)
const ESP32_KINDS = new Set<BoardKind>([
  'esp32',
  'esp32-devkit-c-v4',
  'esp32-cam',
  'wemos-lolin32-lite',
  'esp32-s3',
  'xiao-esp32-s3',
  'arduino-nano-esp32',
]);

// RISC-V ESP32 boards — also use QEMU bridge (qemu-system-riscv32 -M esp32c3)
// The browser-side Esp32C3Simulator cannot handle the 150+ ROM functions ESP-IDF needs.
const ESP32_RISCV_KINDS = new Set<BoardKind>([
  'esp32-c3',
  'xiao-esp32-c3',
  'aitewinrobot-esp32c3-supermini',
]);

function isEsp32Kind(kind: BoardKind): boolean {
  if (ESP32_KINDS.has(kind) || ESP32_RISCV_KINDS.has(kind)) return true;
  // Overlay-registered ESP32-class boards route through the same bridge path.
  return getProBoard(kind)?.esp32Family !== undefined;
}

/**
 * Does this sketch need the emulated WiFi NIC?
 *
 * Single source of truth for two callers that must agree: startBoard(),
 * which decides whether QEMU gets `-nic` at all, and
 * loadMicroPythonProgram(), which decides whether to shadow `network`
 * with the offline stub. Disagreement between them is precisely the
 * failure reported in #262 — a real driver with no device behind it, or
 * a stub in front of a device that works.
 *
 * Arduino is detected from its includes; MicroPython from its import
 * forms. `from network import WLAN` is listed because omitting it left
 * hasWifi false for a sketch that genuinely uses WiFi, and the board
 * then hung for ~26s on a peripheral that was never attached.
 */
export function sketchUsesWifi(files: Array<{ content: string }>): boolean {
  return files.some(
    (f) =>
      f.content.includes('#include <WiFi.h>') ||
      f.content.includes('#include <esp_wifi.h>') ||
      f.content.includes('#include "WiFi.h"') ||
      f.content.includes('WiFi.begin(') ||
      /import\s+network\b/.test(f.content) ||
      /from\s+network\s+import\b/.test(f.content) ||
      /network\.WLAN/.test(f.content),
  );
}

function isRiscVEsp32Kind(kind: BoardKind): boolean {
  const fam = getProBoard(kind)?.esp32Family;
  return ESP32_RISCV_KINDS.has(kind) || fam === 'esp32-c3' || fam === 'esp32-c6';
}

// ── Component type ────────────────────────────────────────────────────────
interface Component {
  id: string;
  metadataId: string;
  x: number;
  y: number;
  properties: Record<string, unknown>;
}

// ── Undo/redo history ────────────────────────────────────────────────────
/**
 * One entry on the canvas undo/redo stack.
 *
 *   description  — human-readable label shown as the undo/redo button
 *                  tooltip ("Undo: Move LED").
 *   execute()    — applied on redo. Should be idempotent against the
 *                  current state at redo time (the user may have undone
 *                  several steps then started a new branch).
 *   undo()       — reverts the change. Same idempotency contract.
 *
 * Commands that capture the inverse on construction (e.g. `recordMove`
 * captures fromX/fromY) are pushed with `applyNow:false` because the
 * mutation already happened — the command only needs to remember how to
 * undo/redo it later. Commands that ARE the canonical mutation (e.g.
 * `recordAddComponent`) are pushed with `applyNow:true` so a single call
 * both performs the action and stores the undo path.
 */
export interface CanvasCommand {
  description: string;
  execute(): void;
  undo(): void;
}

const HISTORY_MAX = 50;

// ── Store interface ───────────────────────────────────────────────────────
interface SimulatorState {
  // ── Multi-board state ───────────────────────────────────────────────────
  boards: BoardInstance[];
  activeBoardId: string | null;

  addBoard: (boardKind: BoardKind, x: number, y: number, explicitId?: string) => string;
  /** Recreate an ESP32-family board's simulation bridge + shim through the
   *  Esp32BridgeFactory seam. Called by the pro overlay after it installs a
   *  factory (the overlay loads via async import, so a deep-linked example
   *  can create boards before the factory exists). No-op (false) for
   *  non-ESP32 kinds or while the board is running. */
  rebuildEsp32Bridge: (boardId: string) => boolean;
  removeBoard: (boardId: string) => void;
  /** Reload the entire workspace from a saved project payload. Tears down
   *  all current boards, recreates them with their saved IDs (so wire
   *  endpoints remain valid), restores file groups, components, wires. */
  loadProjectState: (payload: {
    boards: BoardInstance[];
    fileGroups: Record<string, { name: string; content: string }[]>;
    folderGroups?: Record<string, string[]>;
    components: Component[];
    wires: Wire[];
    activeBoardId: string | null;
  }) => void;
  updateBoard: (boardId: string, updates: Partial<BoardInstance>) => void;
  setBoardPosition: (pos: { x: number; y: number }, boardId?: string) => void;
  setActiveBoardId: (boardId: string) => void;
  /**
   * Record a board's build. `extras.uf2` is the RP2 hardware-flash artifact
   * (see BoardInstance.compiledUf2); omitted/null for every other family.
   */
  compileBoardProgram: (
    boardId: string,
    program: string,
    extras?: { uf2?: string | null },
  ) => void;
  loadMicroPythonProgram: (
    boardId: string,
    files: Array<{ name: string; content: string }>,
  ) => Promise<void>;
  setBoardLanguageMode: (boardId: string, mode: LanguageMode) => void;
  startBoard: (boardId: string) => void;
  stopBoard: (boardId: string) => void;
  resetBoard: (boardId: string) => void;

  // ── Legacy single-board API (reads/writes activeBoardId board) ───────────
  /** @deprecated use boards[]/activeBoardId directly */
  boardType: BoardType;
  /** @deprecated use boards[x].x/y */
  boardPosition: { x: number; y: number };
  /** @deprecated use getBoardSimulator(activeBoardId) */
  simulator:
    | AVRSimulator
    | RP2040Simulator
    | RiscVSimulator
    | Esp32C3Simulator
    | Esp32BridgeShim
    | Stm32BridgeShim
    | PiBridgeShim
    | null;
  /** @deprecated use getBoardPinManager(activeBoardId) */
  pinManager: PinManager;
  running: boolean;
  compiledHex: string | null;
  hexEpoch: number;
  /** Bumped on every Reset so the open SensorControlPanel remounts and
   *  re-reads each interactive sensor's freshly-defaulted value. */
  sensorResetNonce: number;
  /** Ids of components destroyed at runtime (P4 burnout) — the canvas renders
   *  them charred. Cleared on Reset / restart. */
  burntComponents: Set<string>;
  /** Mark a component destroyed (called by the runtime burnout monitor). */
  markComponentBurnt: (componentId: string) => void;
  /** Clear all runtime-destroyed components (on Reset / restart). */
  clearBurntComponents: () => void;
  serialOutput: string;
  serialBaudRate: number;
  serialMonitorOpen: boolean;
  /** @deprecated use getBoardBridge(activeBoardId) */
  remoteConnected: boolean;
  remoteSocket: WebSocket | null;

  setBoardType: (type: BoardType) => void;
  initSimulator: () => void;
  loadHex: (hex: string) => void;
  loadBinary: (base64: string) => void;
  startSimulation: () => void;
  stopSimulation: () => void;
  resetSimulation: () => void;
  /** Bump hexEpoch to force every component part to re-attach (e.g. so a
   *  board-less custom chip picks up freshly compiled WASM). */
  restartParts: () => void;
  setCompiledHex: (hex: string) => void;
  setCompiledBinary: (base64: string) => void;
  setRunning: (running: boolean) => void;
  connectRemoteSimulator: (clientId: string) => void;
  disconnectRemoteSimulator: () => void;
  sendRemotePinEvent: (pin: string, state: number) => void;

  // ── ESP32 crash notification ─────────────────────────────────────────────
  esp32CrashBoardId: string | null;
  dismissEsp32Crash: () => void;

  // ── Components ──────────────────────────────────────────────────────────
  components: Component[];
  addComponent: (component: Component) => void;
  removeComponent: (id: string) => void;
  updateComponent: (id: string, updates: Partial<Component>) => void;
  /** Recompute the breadboard seating wires (bb: true) of one component. */
  reseatComponentOnBreadboard: (id: string) => void;
  updateComponentState: (id: string, state: boolean) => void;
  handleComponentEvent: (componentId: string, eventName: string, data?: unknown) => void;
  setComponents: (components: Component[]) => void;
  /**
   * Bumped on every BULK canvas replacement (setComponents / setWires —
   * project load, example load, .vlx/wokwi import, clear). Lets observers
   * that diff `components`/`wires` between updates (overlay telemetry)
   * tell hydration apart from a user deliberately adding one part: bulk
   * loads are not usage signal.
   */
  hydrationSeq: number;

  // ── Wires ───────────────────────────────────────────────────────────────
  wires: Wire[];
  selectedWireId: string | null;
  wireInProgress: WireInProgress | null;
  addWire: (wire: Wire) => void;
  removeWire: (wireId: string) => void;
  /**
   * Drop a junction node onto `wireId` at (x, y), splitting it in two, and
   * optionally land the wire currently being drawn on the new node.
   *
   * The whole gesture is ONE undo command: Ctrl+Z restores the original wire
   * and removes the node, rather than leaving the user to unpick a half-split
   * circuit. Returns the junction's component id, or null when the point is
   * not actually on the wire (the caller then treats the click normally).
   */
  splitWireWithJunction: (
    wireId: string,
    x: number,
    y: number,
    threshold: number,
    opts?: { finishWireInProgress?: boolean },
  ) => string | null;
  updateWire: (wireId: string, updates: Partial<Wire>) => void;
  setSelectedWire: (wireId: string | null) => void;
  setWires: (wires: Wire[]) => void;
  startWireCreation: (endpoint: WireEndpoint, color: string) => void;
  updateWireInProgress: (x: number, y: number) => void;
  addWireWaypoint: (x: number, y: number) => void;
  setWireInProgressColor: (color: string) => void;
  finishWireCreation: (endpoint: WireEndpoint) => void;
  cancelWireCreation: () => void;
  updateWirePositions: (componentId: string) => void;
  recalculateAllWirePositions: () => void;

  // ── Drag-to-front stacking ───────────────────────────────────────────────
  /**
   * Items the user has DRAGGED, in drag order: id -> monotonic rank. The
   * canvas raises an item on the first movement of its drag, so whatever you
   * dragged last paints above everything it overlaps — boards over parts,
   * parts over boards, symmetrically. Click-select alone never raises
   * (deliberate: selection should not reshuffle a scene you arranged), and
   * untouched items keep the static layering (components above unseated
   * boards, seated boards above their socket). Ephemeral: not saved with the
   * project.
   */
  zOrders: Record<string, number>;
  /** Highest rank handed out so far. */
  zTop: number;
  /** Move an item (board or component id) to the top of the dragged stack. */
  raiseItem: (id: string) => void;

  // ── Undo/redo ────────────────────────────────────────────────────────────
  /** Bounded ring buffer of canvas mutations (HISTORY_MAX = 50). */
  history: CanvasCommand[];
  /** Index of the last APPLIED command. -1 = empty / fully undone. */
  historyIndex: number;
  /** Push a command and (by default) execute it. Truncates the redo stack. */
  pushCommand: (cmd: CanvasCommand, opts?: { applyNow?: boolean }) => void;
  undo: () => void;
  redo: () => void;
  canUndo: () => boolean;
  canRedo: () => boolean;
  /** Wipe the stack (called on project load / clear). */
  clearHistory: () => void;
  /**
   * Recorded canvas actions — these are the public API the UI and agent
   * tools should use to mutate the canvas. Each one wraps a raw mutator
   * with a CanvasCommand so the change is undoable. Drag-preview frames
   * still use the raw mutators (addComponent / updateComponent / addWire
   * / removeWire / updateWire) which DO NOT touch history.
   */
  recordAddComponent: (component: Component) => void;
  recordRemoveComponent: (id: string) => void;
  recordMove: (
    id: string,
    from: { x: number; y: number },
    to: { x: number; y: number },
  ) => void;
  recordRotate: (id: string, prevRotation: number, nextRotation: number) => void;
  recordSetProperty: (id: string, key: string, prevValue: unknown, nextValue: unknown) => void;
  recordAddWire: (wire: Wire) => void;
  recordRemoveWire: (wireId: string) => void;
  recordUpdateWire: (
    wireId: string,
    prev: Partial<Wire>,
    next: Partial<Wire>,
    description?: string,
  ) => void;

  // ── Serial monitor ──────────────────────────────────────────────────────
  toggleSerialMonitor: () => void;
  serialWrite: (text: string) => void;
  serialWriteToBoard: (boardId: string, text: string) => void;
  clearSerialOutput: () => void;
  clearBoardSerialOutput: (boardId: string) => void;
}

// ── Helper: create a simulator for a given board kind ─────────────────────
function createSimulator(
  boardKind: BoardKind,
  pm: PinManager,
  onSerial: (ch: string) => void,
  onBaud: (baud: number) => void,
  onPinTime: (pin: number, state: boolean, t: number) => void,
): AVRSimulator | RP2040Simulator | RiscVSimulator | Esp32C3Simulator | ProBoardSimulator {
  let sim: AVRSimulator | RP2040Simulator | RiscVSimulator | Esp32C3Simulator | ProBoardSimulator;
  const proDef = getProBoard(boardKind);
  if (proDef?.createSimulator) {
    // Overlay-provided in-browser simulator (e.g. the RP2350/Hazard3 engine).
    sim = proDef.createSimulator(pm);
  } else if (boardKind === 'arduino-mega') {
    sim = new AVRSimulator(pm, 'mega');
  } else if (boardKind === 'attiny85') {
    sim = new AVRSimulator(pm, 'tiny85');
  } else if (boardKind === 'raspberry-pi-pico' || boardKind === 'pi-pico-w') {
    sim = new RP2040Simulator(pm);
  } else if (isRiscVEsp32Kind(boardKind)) {
    // ESP32-C3 / XIAO-C3 / C3 SuperMini — browser-side RV32IMC emulator
    sim = new Esp32C3Simulator(pm);
  } else {
    // arduino-uno, arduino-nano
    sim = new AVRSimulator(pm, 'uno');
  }
  sim.onSerialData = onSerial;
  if (sim instanceof AVRSimulator) sim.onBaudRateChange = onBaud;
  sim.onPinChangeWithTime = onPinTime;
  return sim;
}

// ── Default initial board (Arduino Uno — same as old behaviour) ───────────
const INITIAL_BOARD_ID = 'arduino-uno';
const INITIAL_BOARD: BoardInstance = {
  id: INITIAL_BOARD_ID,
  boardKind: 'arduino-uno',
  x: DEFAULT_BOARD_POSITION.x,
  y: DEFAULT_BOARD_POSITION.y,
  running: false,
  compiledProgram: null,
  serialOutput: '',
  serialBaudRate: 0,
  serialMonitorOpen: false,
  activeFileGroupId: `group-${INITIAL_BOARD_ID}`,
  languageMode: 'arduino' as LanguageMode,
};

// ── Serial batching ───────────────────────────────────────────────────────
// USART callbacks fire once per byte. Sketches doing `Serial.println(x)` at
// ~200 Hz emit ~600 bytes/s, and a raw `set()` per byte overwhelms React's
// useSyncExternalStore reconciliation (→ "Maximum update depth exceeded").
// The batcher coalesces chunks per animation frame (≤60 Hz), grouped by board.
const { append: appendSerial } = createSerialBatcher((perBoard) => {
  useSimulatorStore.setState((s) => {
    let globalOut = s.serialOutput;
    const boards = s.boards.map((b) => {
      const raw = perBoard.get(b.id);
      if (!raw) return b;
      // Attach the one-line explanation when a known cryptic firmware error
      // scrolls past (issue #270); a no-op for ordinary output.
      const chunk = annotateSerialChunk(b.serialOutput, raw);
      if (s.activeBoardId === b.id) globalOut += chunk;
      return { ...b, serialOutput: b.serialOutput + chunk };
    });
    return { boards, serialOutput: globalOut };
  });
});

/**
 * Pro overlay seam: append bytes coming from a REAL board's UART (Web
 * Serial hardware monitor) into a board's serial output. Goes through the
 * same per-frame batcher as simulator bytes, so the SerialMonitor needs no
 * changes and hardware chatter cannot trigger the per-byte set() storm.
 */
export function appendHardwareSerial(boardId: string, chunk: string): void {
  appendSerial(boardId, chunk);
}

// ── Store ─────────────────────────────────────────────────────────────────
export const useSimulatorStore = create<SimulatorState>((set, get) => {
  // Initialise runtime objects for the default board
  const initialPm = new PinManager();
  pinManagerMap.set(INITIAL_BOARD_ID, initialPm);

  function getOscilloscopeCallback(boardId: string) {
    return (pin: number, state: boolean, timeMs: number) => {
      const { channels, pushSample } = useOscilloscopeStore.getState();
      for (const ch of channels) {
        // Analog channels are fed by the SPICE bridge, not by GPIO edges —
        // they carry a net name, not a (board, pin).
        if (ch.kind !== 'digital') continue;
        if (ch.boardId === boardId && ch.pin === pin) pushSample(ch.id, timeMs, state);
      }
    };
  }

  // Create + fully wire the simulation bridge and shim for an ESP32-family
  // board. Shared by addBoard and rebuildEsp32Bridge: the pro overlay rebuilds
  // a board's bridge when it installs an Esp32BridgeFactory AFTER the board
  // was already created — main.tsx loads the overlay via an async import, so a
  // deep-linked example can call addBoard before the factory exists and would
  // otherwise silently keep the stock QEMU bridge.
  /**
   * Handler for a backend `error` on a QEMU-Linux (Pi family) or STM32
   * socket. The message is the server's answer to a start that will not
   * happen — the board is Pro-gated for this session, a quota ran out,
   * the box is full — and until 2026-09 it went nowhere: the bridges have
   * an onError slot, nothing filled it, so the UI showed a board that was
   * "running" and a terminal that never booted. Same treatment as the ESP32
   * branch: write it to the serial monitor, stop the board, open the
   * monitor. Then tell the gate's owner (an overlay keys its verdict on
   * state the server just contradicted).
   *
   * `disconnect` closes the bridge's socket. The server refuses without
   * closing, and both bridges send their start message from `onopen` and
   * make connect() a no-op on a live socket — so without this the next
   * Run set `running`, called connect(), and nothing left the tab: a
   * board "running" over nothing, for a user who was just told to try
   * again. A fresh socket on the next Run re-sends the start.
   */
  function makeRunRefusedHandler(
    id: string,
    boardKind: BoardKind,
    serialCallback: (ch: string) => void,
    disconnect: () => void,
  ): (message: string, code?: string) => void {
    return (message: string, code?: string) => {
      console.error(`[${boardKind}:${id}] ${message}`);
      serialCallback(`\r\n[Velxio] ${message}\r\n`);
      set((s) => {
        const boards = s.boards.map((b) => (b.id === id ? { ...b, running: false } : b));
        const isActive = s.activeBoardId === id;
        return {
          boards,
          serialMonitorOpen: true,
          ...(isActive ? { running: false } : {}),
        };
      });
      try {
        disconnect();
      } catch (e) {
        console.warn(`[${boardKind}:${id}] disconnect after refusal failed:`, e);
      }
      reportBoardRunRefused({ boardId: id, kind: boardKind, message, code });
    };
  }

  function wireEsp32Board(id: string, boardKind: BoardKind, pm: PinManager): void {
    const serialCallback = (ch: string) => appendSerial(id, ch);
    const bridge = createEsp32Bridge(id, boardKind);
    bridge.onSerialData = serialCallback;
    bridge.onError = (message: string) => {
      // Surface backend/worker errors in the Serial Monitor so the user sees
      // a clear reason instead of a board that silently never boots. The
      // canonical case is an ESP32-S3 board: it compiles, but the bundled
      // QEMU has no esp32s3 machine, so the worker reports a clear message
      // here rather than crashing cryptically. Stop "running" and pop the
      // monitor open so the note is visible immediately.
      console.error(`[esp32:${id}] ${message}`);
      serialCallback(`\r\n[Velxio] ${message}\r\n`);
      set((s) => {
        const boards = s.boards.map((b) => (b.id === id ? { ...b, running: false } : b));
        const isActive = s.activeBoardId === id;
        return {
          boards,
          serialMonitorOpen: true,
          ...(isActive ? { running: false } : {}),
        };
      });
    };
    bridge.onPinChange = (gpioPin, state) => {
      const boardPm = pinManagerMap.get(id);
      if (boardPm) boardPm.triggerPinChange(gpioPin, state, 'mcu');
    };
    // Wire scope sampling for ESP32 (GPIO transitions + synthesized
    // UART TX bits).  Mirrors what AVR/RP2040 simulators get for free
    // by passing the oscilloscope callback into createSimulator().
    bridge.onPinChangeWithTime = getOscilloscopeCallback(id);
    bridge.onCrash = () => {
      set({ esp32CrashBoardId: id });
    };
    bridge.onDisconnected = () => {
      set((s) => {
        const boards = s.boards.map((b) => (b.id === id ? { ...b, running: false } : b));
        const isActive = s.activeBoardId === id;
        return { boards, ...(isActive ? { running: false } : {}) };
      });
    };
    signalRouterMap.set(id, new SignalRouter());
    bridge.onLedcDuty = makeLedcDutyHandler(id);
    bridge.onGpioRouting = makeGpioRoutingHandler(id);
    bridge.onGpioRoutingClear = makeGpioRoutingClearHandler(id);
    bridge.onPinPull = makePinPullHandler(id);
    bridge.onWs2812Update = makeWs2812Handler(id);
    bridge.onWifiStatus = (ws) => {
      set((s) => ({
        boards: s.boards.map((b) => (b.id === id ? { ...b, wifiStatus: ws } : b)),
      }));
    };
    bridge.onBleStatus = (bs) => {
      set((s) => ({
        boards: s.boards.map((b) => (b.id === id ? { ...b, bleStatus: bs } : b)),
      }));
    };
    esp32BridgeMap.set(id, bridge);
    // Provide a shim so PartSimulationRegistry components (DHT22, etc.)
    // can call setPinState / access pinManager on ESP32 boards.
    const shim = new Esp32BridgeShim(bridge, pm);
    shim.onSerialData = serialCallback;
    // If a shim already exists for this id (e.g. tests recreate the
    // same kind after reset, or the pro overlay rebuilds the bridge),
    // dispose any active proxies / timers so the orphaned instance
    // doesn't keep firing.
    const existingShim = simulatorMap.get(id) as any;
    if (existingShim?.clearAllProxies) {
      try { existingShim.clearAllProxies(); } catch { /* ignore */ }
    }
    // The parts on the canvas attached their I2C device models to the OLD
    // shim (their attach closures hold it) and will not re-attach for a
    // bridge rebuild — carry them over, or the rebuilt engine boots with an
    // empty I2C bus and every Wire transaction fails.
    if (existingShim instanceof Esp32BridgeShim) {
      try { shim.adoptPartsFrom(existingShim); } catch { /* ignore */ }
    }
    simulatorMap.set(id, shim);
    // The Interconnect's serial fan-out wraps the INSTANCE's
    // onSerialData; a fresh simulator (compile, reset, engine
    // swap) drops that wrapper, so a wired peer stopped
    // hearing this board mid-session. Re-ensure it here.
    icReensureSerialHooks(id);
  }

  const initialSim = createSimulator(
    'arduino-uno',
    initialPm,
    (ch) => appendSerial(INITIAL_BOARD_ID, ch),
    (baud) => {
      set((s) => {
        const boards = s.boards.map((b) =>
          b.id === INITIAL_BOARD_ID ? { ...b, serialBaudRate: baud } : b,
        );
        const isActive = s.activeBoardId === INITIAL_BOARD_ID;
        return { boards, ...(isActive ? { serialBaudRate: baud } : {}) };
      });
    },
    getOscilloscopeCallback(INITIAL_BOARD_ID),
  );
  // Cross-board routing for the initial board is handled by the Interconnect
  // (registered after the store is created — see bottom of this file).
  simulatorMap.set(INITIAL_BOARD_ID, initialSim);

  // ── Legacy single-board PinManager (references initial board's pm) ───────
  const legacyPinManager = initialPm;

  return {
    // ── Multi-board state ─────────────────────────────────────────────────
    boards: [INITIAL_BOARD],
    activeBoardId: INITIAL_BOARD_ID,

    rebuildEsp32Bridge: (boardId: string): boolean => {
      const board = get().boards.find((b) => b.id === boardId);
      const pm = pinManagerMap.get(boardId);
      if (!board || !pm || !isEsp32Kind(board.boardKind)) return false;
      if (board.running) return false; // never yank a live simulation
      const old = esp32BridgeMap.get(boardId);
      if (old) {
        try { old.disconnect(); } catch { /* ignore */ }
      }
      wireEsp32Board(boardId, board.boardKind, pm);
      // A deep-linked overlay board is created BEFORE the overlay registers
      // its kinds, so isEsp32Kind() was false at addBoard time and the board
      // was wired as a generic AVR. Parts attach their device models against
      // the flat `simulator` field — if it still holds that placeholder, the
      // whole part layer (I2C devices included) is talking to a simulator
      // nobody will ever run: the C6 gesture example booted with an empty
      // engine I2C bus and every Wire transaction died. Re-sync the flat
      // field so DynamicComponent's [simulator] effect re-attaches every
      // part against the rebuilt shim.
      if (get().activeBoardId === boardId) {
        set({
          simulator: (simulatorMap.get(boardId) ?? null) as never,
          pinManager: pinManagerMap.get(boardId) ?? legacyPinManager,
        });
      }
      return true;
    },

    addBoard: (boardKind: BoardKind, x: number, y: number, explicitId?: string) => {
      let id: string;
      if (explicitId) {
        id = explicitId;
      } else {
        const existing = get().boards.filter((b) => b.boardKind === boardKind);
        id = existing.length === 0 ? boardKind : `${boardKind}-${existing.length + 1}`;
      }

      const pm = new PinManager();
      pinManagerMap.set(id, pm);

      const serialCallback = (ch: string) => appendSerial(id, ch);

      if (isPiBoardKind(boardKind)) {
        const bridge = new RaspberryPi3Bridge(id, boardKind);
        const piDef = getProBoard(boardKind);
        if (piDef?.quietBoot) {
          bridge.quietBootDefault = true;
          bridge.quietBootLabel = piDef.label;
        }
        bridge.onSerialData = (ch: string) => {
          serialCallback(ch);
          // Cross-board routing now handled by Interconnect (see bind below).
        };
        bridge.onError = makeRunRefusedHandler(id, boardKind, serialCallback, () =>
          bridge.disconnect(),
        );
        bridge.onPinChange = (gpioPin, state) => {
          // Feed the guest's GPIO writes into this board's PinManager so they
          // reach wired components and the SPICE solver (the LED brightness
          // path) — same as the ESP32 branch. Without this the Pi could print
          // "LED on" but the canvas LEDs stayed dark. Interconnect preserves
          // and calls this before its own cross-board routing.
          const boardPm = pinManagerMap.get(id);
          if (boardPm) boardPm.triggerPinChange(gpioPin, state, 'mcu');
        };
        // Guest Linux finished booting (shell prompt reached). Flip piBooted so
        // the workspace swaps the "Booting…" overlay for the live terminal and
        // uploads know the shell is ready. Overlay boards may declare a
        // guestSetup line (hostname/PS1/clear) to de-brand the generic image;
        // it runs before piBooted flips so the VFS upload (gated on piBooted)
        // cannot interleave with it.
        bridge.onBooted = () => {
          const setup = getGuestSetup(boardKind);
          // Attach the slave models for I2C/SPI/UART components wired to
          // this Pi. This used to live in RaspberryPiWorkspace, which the
          // unified terminal replaced — leaving the scan with no caller,
          // so a BMP280 on the Pi's I2C pins never got its backend model.
          try {
            const st = get();
            attachSlavesFromCanvas(
              id,
              bridge,
              st.components as never,
              st.wires as never,
            );
          } catch (e) {
            console.warn('[pi] slave scan failed:', e);
          }
          const flip = () =>
            set((s) => ({
              boards: s.boards.map((b) => (b.id === id ? { ...b, piBooted: true } : b)),
            }));
          // After boot (+setup) the board's editor file group is uploaded
          // into the guest home and the run command executed, so one click
          // on Run boots, uploads and starts the user's script — same UX as
          // every other board's compile-and-run. Overlay boards can override
          // home/command via guestHome/autoRun.
          void (async () => {
            if (setup) {
              await bridge.sendAndWaitForPrompt(setup.endsWith('\n') ? setup : setup + '\n');
            }
            flip();
            try {
              await piSyncAndRunScript(id, boardKind);
            } catch (e) {
              console.warn(`[${boardKind}] auto-run failed:`, e);
            }
          })();
        };
        bridge.onDisconnected = () => {
          set((s) => {
            const boards = s.boards.map((b) =>
              b.id === id ? { ...b, running: false, piBooted: false } : b,
            );
            const isActive = s.activeBoardId === id;
            return { boards, ...(isActive ? { running: false } : {}) };
          });
        };
        bridgeMap.set(id, bridge);
        // The simulator-shaped object the parts attach to (I2C devices, SPI
        // panels, PWM consumers, the ADC refusal). Both engines route their
        // bus requests through it, so a sensor answers the same in either.
        const shim = new PiBridgeShim({
          boardId: id,
          boardKind,
          bridge,
          pinManager: pm,
          boardState: () => get().boards.find((b) => b.id === id),
        });
        simulatorMap.set(id, shim);
        // The guest's pulls reach the netlist and rest the pin, like every
        // MCU board; its PWM reaches the servo / dimmed LED listeners; its
        // bus operations reach the device models on the canvas.
        bridge.onPinPull = makePinPullHandler(id);
        bridge.onGpioPwm = (pin, frequency, dutyCycle, event) =>
          shim.applyPwm(pin, frequency, event === 'stop' ? 0 : dutyCycle);
        bridge.onBusRequest = (_rid, line) => shim.answerBusLine(line);
        // A backend that answers the guest's bus from the canvas announces
        // it once per guest; the shim then publishes the bus map and keeps
        // it true, and the board says so (a part that used to be handed to
        // the guest can stay in the tab).
        bridge.onBusRelay = () => {
          shim.startBusSync();
          set((s) => ({
            boards: s.boards.map((b) => (b.id === id ? { ...b, busRelay: true } : b)),
          }));
        };
        const disconnected = bridge.onDisconnected;
        bridge.onDisconnected = () => {
          shim.stopBusSync();
          disconnected?.();
        };
        // The UART routes were built at page load, when this bridge did
        // not exist — re-attempt the TX hook now that it does, or the
        // guest's header-UART bytes never reach the canvas wire.
        icReensureSerialHooks(id);
      } else if (isEsp32Kind(boardKind)) {
        wireEsp32Board(id, boardKind, pm);
      } else if (isStm32BoardKind(boardKind)) {
        const bridge = new Stm32Bridge(id, boardKind);
        // Onboard-LED pin + polarity per board kind. Blue/Black Pill drive PC13
        // active-LOW; the F4 Discovery / Olimex / Netduino boards drive their LED
        // active-HIGH on a different port pin (see STM32_LED).
        const ledCfg = STM32_LED[boardKind] ?? { pin: 'PC13', activeLow: true };
        const ledLinear = stm32PinNameToLinear(ledCfg.pin);
        bridge.onSerialData = serialCallback;
        bridge.onError = makeRunRefusedHandler(id, boardKind, serialCallback, () =>
          bridge.disconnect(),
        );
        bridge.onPinChange = (gpioPin, state) => {
          const boardPm = pinManagerMap.get(id);
          if (boardPm) boardPm.triggerPinChange(gpioPin, state, 'mcu');
          if (gpioPin === ledLinear) {
            const dom = document.getElementById(id) as (HTMLElement & { led?: boolean }) | null;
            if (dom && 'led' in dom) dom.led = ledCfg.activeLow ? !state : !!state;
          }
        };
        bridge.onPinChangeWithTime = getOscilloscopeCallback(id);
        // Record the guest's internal pull so NetlistBuilder stamps the weak
        // resistor; the connector then drives the pin from the solved circuit.
        bridge.onPinPull = makePinPullHandler(id);
        bridge.onDisconnected = () => {
          set((s) => {
            const boards = s.boards.map((b) => (b.id === id ? { ...b, running: false } : b));
            const isActive = s.activeBoardId === id;
            return { boards, ...(isActive ? { running: false } : {}) };
          });
        };
        stm32BridgeMap.set(id, bridge);
        // Shim so PartSimulationRegistry parts (I2C displays, sensors, SPI
        // panels) attach to this STM32 the same way they do on ESP32.
        simulatorMap.set(id, new Stm32BridgeShim(bridge, pm));
        // The Interconnect's serial fan-out wraps the INSTANCE's
        // onSerialData; a fresh simulator (compile, reset, engine
        // swap) drops that wrapper, so a wired peer stopped
        // hearing this board mid-session. Re-ensure it here.
        icReensureSerialHooks(id);
      } else {
        const sim = createSimulator(
          boardKind,
          pm,
          serialCallback,
          (baud) => {
            set((s) => {
              const boards = s.boards.map((b) =>
                b.id === id ? { ...b, serialBaudRate: baud } : b,
              );
              const isActive = s.activeBoardId === id;
              return { boards, ...(isActive ? { serialBaudRate: baud } : {}) };
            });
          },
          getOscilloscopeCallback(id),
        );
        // Cross-board routing now handled by Interconnect (see bind below).
        simulatorMap.set(id, sim);
        // The Interconnect's serial fan-out wraps the INSTANCE's
        // onSerialData; a fresh simulator (compile, reset, engine
        // swap) drops that wrapper, so a wired peer stopped
        // hearing this board mid-session. Re-ensure it here.
        icReensureSerialHooks(id);

        // ── Attach a PIO bus peripheral if a factory supports this board.
        // The pro overlay registers a CYW43 WiFi peripheral for 'pi-pico-w'
        // (paid feature); OSS has no factory, so this is a no-op and a Pico W
        // simulates as a plain Pico. The peripheral owns its own WS bridge and
        // surfaces WiFi status via setBoardWifiStatus().
        if (sim instanceof RP2040Simulator) {
          sim.attachPioPeripheral(boardKind, id);
        } else if (isProBoardSimulator(sim)) {
          (sim as { attachPioPeripheral?: (k: string, i: string) => void }).attachPioPeripheral?.(
            boardKind,
            id,
          );
        }
      }

      // Arduino is the default language everywhere EXCEPT on a board that has
      // no FQBN at all: the ESP32-C5 kits have no arduino-esp32 core, so a
      // board seeded into 'arduino' can never compile and the toolbar's
      // language select (which hides the Arduino option for them) would show
      // a value it does not carry. Seed those into a mode they can run.
      const seededLanguage: LanguageMode = BOARD_KIND_FQBN[boardKind]
        ? 'arduino'
        : BOARD_SUPPORTS_MICROPYTHON.has(boardKind)
          ? 'micropython'
          : BOARD_SUPPORTS_ESPIDF.has(boardKind)
            ? 'espidf'
            : 'arduino';

      const newBoard: BoardInstance = {
        id,
        boardKind,
        x,
        y,
        running: false,
        compiledProgram: null,
        serialOutput: '',
        serialBaudRate: 0,
        serialMonitorOpen: false,
        activeFileGroupId: `group-${id}`,
        languageMode: seededLanguage,
      };

      set((s) => {
        // If there's no current active board (or the stored id doesn't point
        // to one that exists), promote the new board to active. Without this,
        // an agent that does add_board → compile_sketch fails on step 2 with
        // "no active board on the canvas" and has to spend a turn on
        // set_active_board. Manual placements via the UI already auto-active
        // through the picker; this just closes the API gap.
        const stillExists = s.boards.some((b) => b.id === s.activeBoardId);
        const nextActive = stillExists ? s.activeBoardId : id;
        // Keep `simulator` in sync with `activeBoardId`. setActiveBoardId is the
        // only other place that promotes a board, and it sets BOTH — if addBoard
        // promotes a board (first board, or the active one was removed) without
        // syncing the simulator, s.simulator stays pointed at the previous board.
        // Parts that read s.simulator (SPI displays like ILI9341, which attach
        // `spi.onByte` to the active simulator) then wire onto the wrong board's
        // bus and never receive data — the "boards[] ESP32 TFT renders black"
        // bug. When nextActive is unchanged this is a no-op (same reference).
        return {
          boards: [...s.boards, newBoard],
          activeBoardId: nextActive,
          simulator: simulatorMap.get(nextActive) ?? s.simulator,
        };
      });
      // Create the editor file group for this board. A board that ships its
      // own seed code (vendor library boards: M5Stack, UNIHIKER, ...) gets it
      // here — the editor's family default is an LED_BUILTIN blink / an
      // RPi.GPIO script, neither of which runs on such a board, so the very
      // first Run on a freshly placed board would fail. QEMU-Linux boards seed
      // their guest script ('python'); everything else starts in Arduino mode.
      const seedMode = isPiBoardKind(boardKind) ? 'python' : 'arduino';
      useEditorStore
        .getState()
        .createFileGroup(`group-${id}`, getBoardSeedFiles(boardKind, seedMode));
      // The seed sketch includes the board's vendor library, so declare it in
      // the board's manifest (= the compile resolution scope) right away.
      const seedLibs = getProBoard(boardKind)?.defaultLibraries;
      if (seedLibs?.length) {
        set((s) => ({
          boards: s.boards.map((b) => (b.id === id ? { ...b, libraries: [...seedLibs] } : b)),
        }));
      }
      // If this board is now the active one (it's the first board, or the
      // previously-active board was removed), point the editor at its file
      // group too. The canvas board picker calls addBoard directly WITHOUT
      // setActiveBoardId (which is the only other place that syncs the editor
      // group), so without this the editor keeps editing the previous/deleted
      // board's group while compile reads THIS board's group — the code you
      // type is silently dropped and the board runs its default sketch.
      if (get().activeBoardId === id) {
        useEditorStore.getState().setActiveGroup(`group-${id}`);
      }
      // Init VFS for QEMU-Linux boards. Overlay boards may declare their
      // guest home (e.g. '/root' when the guest logs in as root); those
      // also drop the historic hello.sh sample.
      if (isPiBoardKind(boardKind)) {
        const home = getProBoard(boardKind)?.guestHome;
        useVfsStore
          .getState()
          .initBoardVfs(id, home ? { home, withShellSample: false } : undefined);
      }
      // ── Interconnect: register the board and rebuild routes ──────────
      icBindBoard(id, boardKind);
      icUpdateWires(get().wires);
      return id;
    },

    removeBoard: (boardId: string) => {
      const board = get().boards.find((b) => b.id === boardId);
      getBoardSimulator(boardId)?.stop();
      simulatorMap.delete(boardId);
      pinManagerMap.delete(boardId);
      signalRouterMap.delete(boardId);
      const bridge = getBoardBridge(boardId);
      if (bridge) {
        bridge.disconnect();
        bridgeMap.delete(boardId);
      }
      const esp32Bridge = getEsp32Bridge(boardId);
      if (esp32Bridge) {
        esp32Bridge.disconnect();
        esp32BridgeMap.delete(boardId);
      }
      const stm32Bridge = getStm32Bridge(boardId);
      if (stm32Bridge) {
        stm32Bridge.disconnect();
        stm32BridgeMap.delete(boardId);
      }
      // Detach the PIO peripheral (it disconnects its own bridge).
      const rpSim = getBoardSimulator(boardId);
      if (rpSim instanceof RP2040Simulator) rpSim.detachPioPeripheral();
      else if (isProBoardSimulator(rpSim)) rpSim.detachPioPeripheral?.();
      set((s) => {
        const boards = s.boards.filter((b) => b.id !== boardId);
        const activeBoardId =
          s.activeBoardId === boardId ? (boards[0]?.id ?? null) : s.activeBoardId;
        // Remove wires connected to this board
        const wires = s.wires.filter(
          (w) => w.start.componentId !== boardId && w.end.componentId !== boardId,
        );
        // Reconcile the flat `running` mirror. This flag tracks the ACTIVE
        // board's run state (see startBoard/stopBoard/setActiveBoardId's
        // `isActive` sync). Removing the active board reassigns
        // `activeBoardId` above, but used to leave `running` stale — so
        // deleting the running/active board left the UI stuck in a fake
        // "running" state, and SimulatorCanvas's auto-start effect (which
        // treats `running` as a master switch for remote boards) then spun
        // a sibling board up. Re-derive it from whatever board is active
        // now (false if none remain).
        const nextActive = activeBoardId
          ? boards.find((b) => b.id === activeBoardId) ?? null
          : null;
        const running = nextActive ? nextActive.running : false;
        return { boards, activeBoardId, wires, running };
      });
      // Clean up file group in editor store
      if (board) {
        useEditorStore.getState().deleteFileGroup(board.activeFileGroupId);
      }
      // The removed board may have been the active one; activeBoardId was just
      // reassigned (above) to a remaining board, or null. Re-point the editor's
      // active file group at whatever board is active now, so the editor never
      // keeps showing/editing the deleted board's group.
      const newActiveId = get().activeBoardId;
      if (newActiveId) {
        const nb = get().boards.find((b) => b.id === newActiveId);
        if (nb) useEditorStore.getState().setActiveGroup(nb.activeFileGroupId);
      }
      // ── Interconnect: drop board and rebuild routes ──────────────────
      icUnbindBoard(boardId);
      icUpdateWires(get().wires);
    },

    updateBoard: (boardId: string, updates: Partial<BoardInstance>) => {
      set((s) => ({
        boards: s.boards.map((b) => (b.id === boardId ? { ...b, ...updates } : b)),
      }));
    },

    loadProjectState: (payload) => {
      const { stopSimulation, removeBoard, addBoard, setComponents, setWires,
        setActiveBoardId, recalculateAllWirePositions } = get();
      // Tear down current state
      if (get().running) stopSimulation();
      const oldIds = get().boards.map((b) => b.id);
      oldIds.forEach((id) => removeBoard(id));

      // Recreate boards with their saved ids so wire endpoints (which embed
      // the literal board id) keep matching.
      payload.boards.forEach((b) => {
        addBoard(b.boardKind, b.x, b.y, b.id);
        // Apply the rest of the saved fields that addBoard doesn't set.
        const patch: Partial<BoardInstance> = {};
        if (b.languageMode && b.languageMode !== 'arduino') patch.languageMode = b.languageMode;
        if (b.name && b.name.trim()) patch.name = b.name;
        // P2.4 — restore per-board persisted fields that ride in boards_json.
        if (b.boardOptions) patch.boardOptions = b.boardOptions;
        if (b.spiffsFiles) patch.spiffsFiles = b.spiffsFiles;
        if (b.libraries && b.libraries.length) patch.libraries = b.libraries;
        if (Object.keys(patch).length > 0) {
          set((s) => ({
            boards: s.boards.map((bb) => (bb.id === b.id ? { ...bb, ...patch } : bb)),
          }));
        }
      });

      // Replace editor file groups atomically. Skip groups that already exist
      // (createFileGroup is a no-op for existing ids) — overwrite their files.
      useEditorStore.getState().replaceFileGroups(payload.fileGroups, payload.folderGroups);

      // Components and wires. Normalize the retired ssd1306-i2c / ssd1306-spi
      // ids (merged into the single auto-detecting `ssd1306`, issues #101/#215)
      // so old .vlx files and pre-migration snapshots still render and simulate;
      // the old id's protocol is pinned so behaviour is preserved exactly.
      const normalizedComponents = payload.components.map((c) =>
        c.metadataId === 'ssd1306-i2c' || c.metadataId === 'ssd1306-spi'
          ? {
              ...c,
              metadataId: 'ssd1306',
              properties: {
                protocol: c.metadataId === 'ssd1306-spi' ? 'spi' : 'i2c',
                ...(c.properties ?? {}),
              },
            }
          : c,
      );
      setComponents(normalizedComponents);
      setWires(payload.wires);

      // Active board: prefer the saved one, fall back to the first.
      const targetActive = payload.activeBoardId &&
        get().boards.find((b) => b.id === payload.activeBoardId)
        ? payload.activeBoardId
        : (get().boards[0]?.id ?? null);
      if (targetActive) setActiveBoardId(targetActive);

      // Wires need a frame for the wokwi-elements to mount in the DOM before
      // pinPositionCalculator can resolve their pinInfo.
      requestAnimationFrame(() => {
        recalculateAllWirePositions();
        icUpdateWires(get().wires);
      });
    },

    setBoardPosition: (pos: { x: number; y: number }, boardId?: string) => {
      const id = boardId ?? get().activeBoardId ?? INITIAL_BOARD_ID;
      set((s) => ({
        boardPosition: s.activeBoardId === id ? pos : s.boardPosition,
        boards: s.boards.map((b) => (b.id === id ? { ...b, x: pos.x, y: pos.y } : b)),
      }));
    },

    setActiveBoardId: (boardId: string) => {
      const board = get().boards.find((b) => b.id === boardId);
      if (!board) return;
      set({
        activeBoardId: boardId,
        // Sync legacy flat fields to this board's values
        boardType: (isPiBoardKind(board.boardKind)
          ? 'arduino-uno'
          : board.boardKind) as BoardType,
        boardPosition: { x: board.x, y: board.y },
        simulator: simulatorMap.get(boardId) ?? null,
        pinManager: pinManagerMap.get(boardId) ?? legacyPinManager,
        running: board.running,
        compiledHex: board.compiledProgram,
        serialOutput: board.serialOutput,
        serialBaudRate: board.serialBaudRate,
        serialMonitorOpen: board.serialMonitorOpen,
        remoteConnected:
          bridgeMap.get(boardId)?.connected ?? esp32BridgeMap.get(boardId)?.connected ?? false,
        remoteSocket: null,
      });
      // Switch the editor to this board's file group
      useEditorStore.getState().setActiveGroup(board.activeFileGroupId);
    },

    compileBoardProgram: (boardId: string, program: string, extras?: { uf2?: string | null }) => {
      const board = get().boards.find((b) => b.id === boardId);
      if (!board) {
        console.warn(`[compileBoardProgram] board not found: ${boardId}`);
        return;
      }
      console.log(`[compileBoardProgram] ${boardId} kind=${board.boardKind} programLen=${program?.length ?? 0}`);

      if (isEsp32Kind(board.boardKind)) {
        // All ESP32 boards (Xtensa + RISC-V C3): send firmware to QEMU via bridge.
        // Note: isEsp32Kind() includes C3 boards, so they route through Esp32Bridge
        // for full WiFi/BLE emulation via qemu-system-riscv32.
        const esp32Bridge = getEsp32Bridge(boardId);
        if (esp32Bridge) esp32Bridge.loadFirmware(program);
      } else if (isStm32BoardKind(board.boardKind)) {
        // STM32: send the compiled .elf (base64) to QEMU via the bridge.
        getStm32Bridge(boardId)?.loadFirmware(program);
      } else if (isRiscVEsp32Kind(board.boardKind)) {
        // Fallback: browser-only RV32IMC emulation (no WiFi/BLE support).
        // Currently unreachable because isEsp32Kind() above includes C3 boards.
        const sim = getBoardSimulator(boardId);
        if (sim instanceof Esp32C3Simulator) {
          try {
            sim.loadFlashImage(program);
          } catch (err) {
            console.error(`[Esp32C3Simulator] loadFlashImage failed for ${boardId}:`, err);
            return;
          }
        }
      } else {
        const sim = getBoardSimulator(boardId);
        if (sim && !isPiBoardKind(board.boardKind)) {
          try {
            if (sim instanceof AVRSimulator) {
              sim.loadHex(program);
              sim.addI2CDevice(new VirtualDS1307());
              sim.addI2CDevice(new VirtualTempSensor());
              sim.addI2CDevice(new I2CMemoryDevice(0x50));
            } else if (sim instanceof RP2040Simulator) {
              sim.loadBinary(program);
              sim.addI2CDevice(new VirtualDS1307() as RP2040I2CDevice);
              sim.addI2CDevice(new VirtualTempSensor() as RP2040I2CDevice);
              sim.addI2CDevice(new I2CMemoryDevice(0x50) as RP2040I2CDevice);
            } else if (isProBoardSimulator(sim)) {
              // Overlay-registered board: the overlay owns the whole load
              // sequence (PIO/peripheral attach, binary format, demo devices).
              getProBoard(board.boardKind)?.loadFirmware?.(sim, program, {
                boardKind: board.boardKind,
                boardId,
              });
            }
          } catch (err) {
            console.error(`compileBoardProgram(${boardId}):`, err);
            return;
          }
        }
      }

      // Remember what this program was built from, so the Flash dialog can
      // tell a fresh build from one the user has edited past.
      const compiledSourceHash = fingerprintSources(
        board,
        useEditorStore.getState().getGroupFiles(board.activeFileGroupId),
      );
      // The .uf2 rides along for RP2 boards (hardware flash); everything
      // else leaves it null so a stale one never outlives its build.
      const compiledUf2 = extras?.uf2 ?? null;
      set((s) => {
        const boards = s.boards.map((b) =>
          b.id === boardId
            ? { ...b, compiledProgram: program, compiledSourceHash, compiledUf2 }
            : b,
        );
        const isActive = s.activeBoardId === boardId;
        return {
          boards,
          ...(isActive ? { compiledHex: program, hexEpoch: s.hexEpoch + 1 } : {}),
        };
      });
    },

    loadMicroPythonProgram: async (
      boardId: string,
      files: Array<{ name: string; content: string }>,
    ) => {
      const board = get().boards.find((b) => b.id === boardId);
      if (!board) return;
      if (!BOARD_SUPPORTS_MICROPYTHON.has(board.boardKind)) return;

      if (isEsp32Kind(board.boardKind)) {
        // ESP32 path: load MicroPython firmware via QEMU bridge, inject code via raw-paste REPL
        const { getEsp32Firmware, padToFlashSize, uint8ArrayToBase64 } =
          await import('../simulation/Esp32MicroPythonLoader');
        const esp32Bridge = getEsp32Bridge(boardId);
        if (!esp32Bridge) return;

        const firmware = await getEsp32Firmware(board.boardKind);
        const b64 = uint8ArrayToBase64(padToFlashSize(firmware, board.boardKind));
        esp32Bridge.loadFirmware(b64);

        // Queue the project for after the REPL boots. Multi-file projects:
        // every .py file other than the entry point is materialized onto the
        // MicroPython filesystem before main runs, so `import mylib` resolves.
        //
        // They travel as FILES, not as source inlined into the program. Inlining
        // is what issue #219 was: a 36 KB library became one Python string
        // literal, so compiling it asked a PSRAM-less ESP32 for one contiguous
        // 36 KB allocation and the board answered MemoryError. The bridge now
        // writes each one in bounded steps — see simulation/micropythonSession.ts.
        const mainFile = files.find((f) => f.name === 'main.py') ?? files[0];
        if (mainFile) {
          const auxFiles = files.filter(
            (f) => f !== mainFile && f.name.endsWith('.py'),
          );

          // Does this run get a real, WORKING network driver? Two gates:
          //  - the sketch must want WiFi (must match what startBoard()
          //    decides, because that is what attaches the NIC device —
          //    see sketchUsesWifi()), and
          //  - the backend must be able to serve MicroPython's esp_wifi
          //    blob. The QEMU worker can (issue #262 was reproduced and
          //    fixed there). An overlay bridge that routes MicroPython to
          //    an in-browser engine declares `micropythonWifiSupported =
          //    false` until the engine models what that blob touches —
          //    handing it the real driver today stalls esp_wifi_init with
          //    no output at all, which is strictly worse than the stub.
          //    Absent property (plain OSS bridge) means supported.
          const bridgeMpyWifi = (
            esp32Bridge as { micropythonWifiSupported?: boolean }
          ).micropythonWifiSupported;
          // Does this run get the REAL network driver? Only one thing decides
          // it now: whether the backend behind this board models the radio.
          //
          // It used to also require the sketch to look like a WiFi sketch,
          // because without a NIC `network.WLAN(STA_IF)` hangs forever on
          // status bits nothing sets, and the stub was the lesser evil. The
          // QEMU worker attaches the radio unconditionally since #260 — the
          // chip has one whether or not the sketch uses it — so that condition
          // no longer describes anything real, and keeping it would put the
          // stub in front of a working device whenever the scan misread the
          // sketch. That is the #262 failure, from the other direction.
          //
          // Known gap, not introduced here: QEMU's S3 machine models no radio
          // at all, so a MicroPython sketch that calls WLAN() on an S3 through
          // the backend waits on a device that is not there. That was already
          // true when this was gated on the sketch — such a sketch set hasWifi
          // and took the real driver either way. A sketch that never imports
          // network is unaffected, which is why this widening is safe.
          const wifiOn = bridgeMpyWifi !== false;

          // WiFi compat shim: replace `network`, `ntptime`, `urequests`
          // with smart stubs BEFORE user main.py imports them.
          //
          // `network` is stubbed ONLY when no NIC is attached. With one
          // attached the real driver works (DHCP on 192.168.4.x, DNS,
          // outbound TCP), and shadowing it made MicroPython WiFi look
          // permanently broken while Arduino worked on the same board:
          // scan() returned [], ifconfig() reported QEMU's SLIRP
          // defaults, and sockets raised EHOSTUNREACH — issue #262.
          //
          // Without a NIC the stub still earns its place. The picsimlab
          // QEMU fork's esp32_wifi emulation is enough for Arduino's
          // lightweight WiFi.h but not for MicroPython's full
          // esp_wifi_init path: `network.WLAN(STA_IF)` then hangs
          // forever waiting for peripheral status bits QEMU never sets,
          // tripping the FreeRTOS task watchdog after ~26s. Deleting the
          // stub outright would trade a working-but-fake network for a
          // hung board, so it stays as the offline fallback.
          //
          // ntptime and urequests are stubbed unconditionally: they back
          // the gallery examples' clocks and weather panels, which have
          // no emulated internet to reach either way.
          //
          // Smart stub behaviour (so examples like smart-ui-eyes WORK
          // end-to-end, not just degrade gracefully):
          //   wlan.isconnected() → True after first 2 calls (simulates
          //                        ~1 second connection)
          //   wlan.ifconfig() → plausible LAN IPs
          //   ntptime.settime() → sets machine.RTC to host's current
          //                       UTC so localtime() returns real time
          //   urequests.get(url) → returns a Response stub whose .json()
          //                        decodes a stubbed payload (weather
          //                        for openweathermap URLs, generic {}
          //                        otherwise). Backed by client-side
          //                        fixtures so the example screens show
          //                        useful data instead of "API Error".
          const now = new Date();
          const fakeWeatherCity = 'Simulator City';
          // With a NIC attached: the REAL driver, behind a thin proxy that
          // rewrites unknown SSIDs to the emulated AP. The emulated radio
          // (QEMU esp32_wifi_ap.c and the esp32*js engines both) announces
          // exactly four networks; a sketch that connects to its author's
          // home SSID would scan, find nothing, and busy-wait on
          // isconnected() forever — which is what every gallery example
          // that ships a made-up SSID would do. Redirecting to
          // Velxio-GUEST keeps those sketches on the REAL stack (DHCP on
          // 192.168.4.x, DNS, outbound TCP through SLIRP) instead of
          // reviving the fake stub for them. Known SSIDs pass through
          // untouched, and the rewrite is announced on serial so nobody
          // debugs a connection they didn't make.
          // Custom AP parts (overlay-provided window seam) replace the
          // network list the shim knows about — and the redirect target
          // becomes the FIRST project network instead of Velxio-GUEST.
          // Without the provider (OSS build) the classic four stand.
          const customSsids =
            (window as { __velxio_custom_wifi_ssids__?: () => string[] | null })
              .__velxio_custom_wifi_ssids__?.() ?? null;
          const shimSsids: readonly string[] = customSsids ?? EMULATED_WIFI_SSIDS;
          const networkStub = wifiOn ? [
            'import network as _vlx_net',
            'import time as _vlx_time',
            `_VLX_SSIDS = (${shimSsids.map((s) => JSON.stringify(s)).join(', ')},)`,
            'class _VlxWLAN:',
            '    def __init__(self, *a, **k):',
            '        self._w = _vlx_net.WLAN(*a, **k)',
            '    def connect(self, ssid=None, key=None, **kw):',
            '        if ssid is not None and ssid not in _VLX_SSIDS:',
            `            print("[velxio] SSID %r is not part of the emulated network; connecting to ${JSON.stringify(shimSsids[0]).replace(/"/g, "'")} instead" % ssid)`,
            `            ssid, key = ${JSON.stringify(shimSsids[0])}, ""`,
            '        if ssid is None:',
            '            return self._w.connect()',
            '        return self._w.connect(ssid, key, **kw)',
            // The sleepy poll pair. The canonical connect idiom is
            // `while not wlan.isconnected(): pass` — a pure Python busy-wait.
            // The emulated CPU only fast-forwards through WAITI idles, so a
            // busy-wait pins the sim at real execution speed (~2% of the
            // chip) and the handshake that costs ~1.5M instructions under a
            // sleepy loop costs ~194M under a busy one — measured; it reads
            // as "WiFi hangs". Sleeping 20ms per unanswered poll turns the
            // user's busy loop into an idle loop without touching their code.
            '    def isconnected(self):',
            '        ok = self._w.isconnected()',
            '        if not ok:',
            '            _vlx_time.sleep_ms(20)',
            '        return ok',
            '    def status(self, *a):',
            '        st = self._w.status(*a)',
            '        _vlx_time.sleep_ms(20)',
            '        return st',
            '    def __getattr__(self, n):',
            '        return getattr(self._w, n)',
            'class _VlxNetwork:',
            '    STA_IF = _vlx_net.STA_IF',
            '    AP_IF = _vlx_net.AP_IF',
            '    WLAN = _VlxWLAN',
            '    def __getattr__(self, n):',
            '        return getattr(_vlx_net, n)',
            'sys.modules["network"] = _VlxNetwork()',
          ] : [
            'class _StubWLAN:',
            '    def __init__(self, *a, **k):',
            '        self._calls = 0',
            '    def active(self, on=None): return True',
            '    def connect(self, ssid=None, pwd=None): pass',
            '    def disconnect(self): pass',
            '    def isconnected(self):',
            '        self._calls += 1',
            '        return self._calls > 2',
            '    def ifconfig(self, c=None): return ("10.0.2.15", "255.255.255.0", "10.0.2.2", "10.0.2.3")',
            '    def config(self, *a, **k): return b"velxio"',
            '    def status(self, *a): return 1010',
            '    def scan(self): return []',
            'class _StubNetwork:',
            '    STA_IF = 0',
            '    AP_IF = 1',
            '    WLAN = _StubWLAN',
            'sys.modules["network"] = _StubNetwork()',
          ];

          const wifiStub = [
            'import sys',
            'import json as _json',
            'try:',
            '    import machine as _machine',
            'except ImportError:',
            '    _machine = None',
            '',
            ...networkStub,
            '',
            '# ntptime: pre-load RTC with host UTC so localtime() works.',
            `_VLX_BOOT_UTC = (${now.getUTCFullYear()}, ${now.getUTCMonth() + 1}, ${now.getUTCDate()}, ${now.getUTCDay() || 7}, ${now.getUTCHours()}, ${now.getUTCMinutes()}, ${now.getUTCSeconds()}, 0)`,
            'class _StubNTP:',
            '    host = "pool.ntp.org"',
            '    timeout = 1',
            '    @staticmethod',
            '    def settime():',
            '        if _machine is not None:',
            '            try: _machine.RTC().datetime(_VLX_BOOT_UTC)',
            '            except Exception: pass',
            '    @staticmethod',
            '    def time(): return 0',
            'sys.modules["ntptime"] = _StubNTP()',
            '',
            '# urequests: fake responses so examples that call HTTP APIs',
            '# show real-looking data on the OLED instead of "API Error".',
            `_VLX_WEATHER = {"main": {"temp": 22.5, "humidity": 58, "pressure": 1013}, "weather": [{"main": "Clouds", "description": "partly cloudy"}], "name": "${fakeWeatherCity}", "wind": {"speed": 3.4}}`,
            'class _StubResponse:',
            '    def __init__(self, payload):',
            '        self._payload = payload',
            '        self.status_code = 200',
            '        self.text = _json.dumps(payload)',
            '        self.content = self.text.encode()',
            '    def json(self): return self._payload',
            '    def close(self): pass',
            '    def __enter__(self): return self',
            '    def __exit__(self, *a): pass',
            'class _StubURequests:',
            '    @staticmethod',
            '    def _route(url):',
            '        u = url.lower()',
            '        if "openweathermap" in u or "weather" in u: return _VLX_WEATHER',
            '        if "ipify" in u or "myip" in u: return {"ip": "10.0.2.15"}',
            '        if "worldtimeapi" in u: return {"datetime": "2026-05-25T00:00:00+00:00"}',
            '        return {}',
            '    @staticmethod',
            '    def get(url, *a, **k): return _StubResponse(_StubURequests._route(url))',
            '    @staticmethod',
            '    def post(url, *a, **k): return _StubResponse({"ok": True})',
            '    @staticmethod',
            '    def head(url, *a, **k): return _StubResponse({})',
            'sys.modules["urequests"] = _StubURequests()',
            'sys.modules["requests"] = _StubURequests()',
          ].join('\n');

          esp32Bridge.setPendingMicroPythonProgram({
            files: auxFiles.map((f) => ({ name: f.name, content: f.content })),
            main: wifiStub + '\n' + mainFile.content,
          });
        }
      } else {
        // Browser-side firmware+filesystem path. Any simulator exposing
        // `loadMicroPython(files)` plugs in here — the OSS RP2040Simulator, or
        // an overlay-registered pro simulator (e.g. the RP2350's ARM
        // MicroPython). Duck-typed rather than `instanceof RP2040Simulator` so
        // pro boards need no change here; a sim without the method is a no-op.
        const sim = getBoardSimulator(boardId) as {
          attachPioPeripheral?: (kind: string, id: string) => void;
          loadMicroPython?: (files: Array<{ name: string; content: string }>) => Promise<void>;
        } | null;
        if (typeof sim?.loadMicroPython !== 'function') return;
        // (Re)attach the PIO peripheral before loading firmware. An example
        // deep-link adds the board during render, which can race the pro
        // overlay's async mountPro that installs the CYW43 factory — so the
        // board-add attach returned null and a paid user's Pico W would boot
        // the plain firmware (no `network` -> ImportError). attachPioPeripheral
        // is idempotent; by run time the factory is installed, so a paid user
        // gets the W peripheral -> the RPI_PICO_W firmware variant. No-op in
        // OSS (no factory) and for free users (factory returns null).
        sim.attachPioPeripheral?.(board.boardKind, boardId);
        await sim.loadMicroPython(files);
      }

      set((s) => {
        const boards = s.boards.map((b) =>
          b.id === boardId ? { ...b, compiledProgram: 'micropython-loaded', compiledUf2: null } : b,
        );
        const isActive = s.activeBoardId === boardId;
        return {
          boards,
          ...(isActive ? { compiledHex: 'micropython-loaded', hexEpoch: s.hexEpoch + 1 } : {}),
        };
      });
    },

    setBoardLanguageMode: (boardId: string, mode: LanguageMode) => {
      const board = get().boards.find((b) => b.id === boardId);
      if (!board) return;

      // Only allow MicroPython / ESP-IDF for supported boards
      if (mode === 'micropython' && !BOARD_SUPPORTS_MICROPYTHON.has(board.boardKind)) return;
      if (mode === 'espidf' && !BOARD_SUPPORTS_ESPIDF.has(board.boardKind)) return;

      // Stop any running simulation
      if (board.running) get().stopBoard(boardId);

      // Clear compiled program since language changed. hasWifi goes with
      // it: it is a property of the compiled sketch, not of the board, and
      // only arduino-cli sets it. Keeping the old value meant a board that
      // had been compiled as Arduino carried that verdict into a later
      // MicroPython run, where the source-scanning fallback never fires
      // (it only runs when hasWifi is undefined) — so a MicroPython WiFi
      // sketch on a reused board silently got no NIC at all (#262).
      set((s) => ({
        boards: s.boards.map((b) =>
          b.id === boardId
            ? { ...b, languageMode: mode, compiledProgram: null, compiledUf2: null, hasWifi: undefined }
            : b,
        ),
      }));

      // Replace file group with appropriate default files and activate it.
      // A board's own seed for the target mode wins over the family default:
      // the MicroPython fallback is a Pico `Pin(25)` blink, which is a dead
      // pin on an M5Stack.
      const editorStore = useEditorStore.getState();
      editorStore.deleteFileGroup(board.activeFileGroupId);
      const modeSeed = getBoardSeedFiles(
        board.boardKind,
        mode === 'micropython' || mode === 'espidf' ? mode : 'arduino',
      );
      editorStore.createFileGroup(board.activeFileGroupId, modeSeed ?? mode);
      editorStore.setActiveGroup(board.activeFileGroupId);
    },

    startBoard: (boardId: string) => {
      const boardKindOfBoard = (b: { boardKind: string }): string => b.boardKind;
      const board = get().boards.find((b) => b.id === boardId);
      if (!board) return;

      // A fresh run starts with a clean radio state. The WiFi/BLE badges are
      // only visible while the board runs, and nothing else clears them, so
      // without this a re-run opens showing the PREVIOUS run's association
      // (a green got_ip badge for a connection nothing has made yet).
      if (board.wifiStatus || board.bleStatus) {
        set((s) => ({
          boards: s.boards.map((b) =>
            b.id === boardId ? { ...b, wifiStatus: undefined, bleStatus: undefined } : b,
          ),
        }));
      }

      // Pro gate, 'run' action. This is THE gate for a Pro board: placing one
      // is free (the 'add' action normally allows, and examples / loaded
      // projects never asked), so every path that starts a board comes
      // through here. Non-paid web users get the prompt instead of a run.
      if (blockedByBoardGate(board.boardKind, 'run')) return;

      if (isPiBoardKind(board.boardKind)) {
        // Engine routing: most projects are a Python script driving GPIO and
        // a screen, and those run in the browser in seconds instead of
        // booting a Linux guest (a backend process + ~90 s). The detector
        // lives in the overlay; `enginePinned` lets the user override it.
        const decision = decideEngine(boardId, board.enginePinned);
        // One line per start: which engine took the run and why. The
        // toolbar already logs its own [handleRun] trace; without this
        // one, a board that starts nothing at all (wrong engine, missing
        // bridge) is indistinguishable from one that started fine.
        console.info(
          `[pi] start ${boardId}: engine=${decision.engine} pinned=${board.enginePinned ?? 'auto'} — ${decision.reason}`,
        );
        // `running` is set here (not only by the toolbar): the Linux-mode
        // button restarts the board directly, and without this the flag
        // kept whatever the previous run left, so the UI showed Stop for
        // a board that was not running.
        set((s) => ({
          boards: s.boards.map((b) =>
            b.id === boardId
              ? { ...b, engineMode: decision.engine, running: true }
              : b,
          ),
          serialMonitorOpen: true,
          ...(s.activeBoardId === boardId ? { running: true } : {}),
        }));
        if (decision.engine === 'instant') {
          const instant = getInstantEngine();
          void instant?.run(boardId).finally(() => {
            set((s) => {
              const boards = s.boards.map((b) =>
                b.id === boardId ? { ...b, running: false } : b,
              );
              const isActive = s.activeBoardId === boardId;
              return { boards, ...(isActive ? { running: false } : {}) };
            });
          });
        } else {
          const bridge = getBoardBridge(boardId);
          if (bridge) {
            bridge.connect();
          } else {
            // A Pi with no bridge cannot boot, and the optional-chain
            // version of this call failed in silence: no guest, no error,
            // and a toolbar still showing Stop. Say so.
            console.warn(
              `[${boardKindOfBoard(board)}] no bridge for ${boardId}: the guest cannot start`,
            );
            set((s) => ({
              boards: s.boards.map((b) =>
                b.id === boardId ? { ...b, running: false } : b,
              ),
            }));
          }
        }
      } else if (isEsp32Kind(board.boardKind)) {
        // Pre-register sensors connected to this board so the QEMU worker
        // has them ready before the firmware starts executing.
        const esp32Bridge = getEsp32Bridge(boardId);
        if (esp32Bridge) {
          const traceState = get();
          const { components } = traceState;
          const sensors: Array<Record<string, unknown>> = [];
          for (const comp of components) {
            const sensorDef = SENSOR_COMPONENT_MAP[comp.metadataId];
            if (!sensorDef) continue;
            // Resolved with the SAME wire walk the parts use, not by reading
            // one wire's far end. A sensor pin reaches the board through a
            // breadboard strip or a level-shifting divider just as truly as
            // through a jumper landing on the pad, and this entry REPLACES the
            // one the part registered (setSensors is keyed by pin) — so every
            // pin this fails to resolve is silently lost. That is what left an
            // HC-SR04 behind a 1k/2k2 divider with no echo pin at all: the
            // backend fell back to TRIG+1 and pulsed a GPIO nobody was reading.
            const gpioPin = traceBoardGpio(traceState, comp.id, sensorDef.dataPinName, boardId);
            if (gpioPin === null) continue;
            // Collect sensor properties from the component
            const props: Record<string, unknown> = {
              sensor_type: sensorDef.sensorType,
              pin: gpioPin,
            };
            const textKeys = new Set(sensorDef.textPropertyKeys ?? []);
            for (const key of sensorDef.propertyKeys) {
              const val = comp.properties[key];
              if (val === undefined) continue;
              // A text property goes over as it was typed. Everything else is
              // a number the dialog stored as a string.
              props[key] =
                textKeys.has(key) || typeof val !== 'string' ? val : parseFloat(val);
            }
            // Extra pins (e.g. echo_pin for HC-SR04) resolve the same way
            if (sensorDef.extraPins) {
              for (const [propName, compPinName] of Object.entries(sensorDef.extraPins)) {
                const extraGpio = traceBoardGpio(traceState, comp.id, compPinName, boardId);
                if (extraGpio !== null) props[propName] = extraGpio;
              }
            }
            sensors.push(props);
          }

          // Pre-register I2C sensors (virtual pin = 200 + i2c_addr, no wire resolution needed)
          for (const comp of components) {
            const i2cDef = I2C_SENSOR_MAP[comp.metadataId];
            if (!i2cDef) continue;
            // Resolve I2C address from component property or use default
            let addr = i2cDef.defaultAddr;
            if (i2cDef.addrProp) {
              const rawAddr = comp.properties[i2cDef.addrProp];
              if (rawAddr !== undefined) {
                if (i2cDef.addrIsBool) {
                  // Boolean flag (e.g. AD0 on MPU-6050): truthy → high address
                  if (rawAddr === true || rawAddr === 'true' || rawAddr === '1') {
                    addr = i2cDef.addrBoolHigh ?? i2cDef.defaultAddr;
                  }
                } else {
                  const parsed =
                    typeof rawAddr === 'string'
                      ? rawAddr.startsWith('0x')
                        ? parseInt(rawAddr, 16)
                        : parseInt(rawAddr, 10)
                      : Number(rawAddr);
                  if (!isNaN(parsed)) addr = parsed;
                }
              }
            }
            const virtualPin = 200 + addr;
            const props: Record<string, unknown> = {
              sensor_type: i2cDef.sensorType,
              pin: virtualPin,
              addr,
            };
            for (const key of i2cDef.propertyKeys ?? []) {
              const val = comp.properties[key];
              if (val !== undefined) props[key] = typeof val === 'string' ? parseFloat(val) : val;
            }
            sensors.push(props);
          }

          // Built-in bridge peripherals an overlay-registered board declares
          // (e.g. an on-board I2C keyboard) — no canvas wiring involved.
          for (const builtIn of getProBoard(board.boardKind)?.builtInSensors ?? []) {
            sensors.push({ ...builtIn });
          }
          esp32Bridge.setSensors(sensors);

          // Either signal saying "WiFi" is enough. The compiler's flag comes
          // from the build that actually ran, which is why it is consulted at
          // all; the source scan reads every file in the group, which the
          // compiler's Arduino path did not until #260. Neither is authoritative
          // alone, and an OR cannot be talked out of a true by a stale or
          // narrower false — which is the direction that used to hurt.
          const editorState = useEditorStore.getState();
          const rawFiles = editorState.fileGroups[board.activeFileGroupId];
          const boardFiles = rawFiles && rawFiles.length > 0 ? rawFiles : editorState.files;
          // Shared with loadMicroPythonProgram's stub decision so the two
          // cannot disagree about whether this sketch wants WiFi.
          const hasWifi = (board.hasWifi ?? false) || sketchUsesWifi(boardFiles);
          esp32Bridge.wifiEnabled = hasWifi;

          // microSD — if a card is on the canvas, build a FAT16 image (project
          // files, plus any paid binary uploads stored on the part) and hand
          // it to the bridge so the QEMU worker can attach it as an SD-over-SPI
          // slave. No card -> clear any stale image from a previous run.
          const sdCard = components.find((c) => c.metadataId === 'microsd-card');
          // Overlay-registered boards can declare a BUILT-IN microSD on a
          // shared SPI bus: attach it even without a card component, and tell
          // the bridge to CS-gate it so it doesn't eat the display's pixel
          // stream. A standalone card owns the bus -> no gating.
          const builtInSdCs = getProBoard(board.boardKind)?.builtInSdCsPin;
          if (sdCard || builtInSdCs !== undefined) {
            try {
              // Uploads come from the card component when one is on the
              // canvas, else from the BOARD's own slot (board.sdFiles - the
              // XIAO Sense pattern, same panel, persisted on the board).
              const uploaded = sdCard
                ? decodeSdFiles(sdCard.properties.sdFiles)
                : decodeSdFiles(board.sdFiles);
              const image = buildProjectSdImage(useEditorStore.getState().files, uploaded);
              esp32Bridge.sdImageB64 = bytesToB64(image);
              esp32Bridge.sdCsPin = sdCard ? undefined : builtInSdCs;
            } catch (e) {
              console.warn('[microsd] SD image build failed:', e);
              esp32Bridge.sdImageB64 = undefined;
              esp32Bridge.sdCsPin = undefined;
            }
          } else {
            esp32Bridge.sdImageB64 = undefined;
            esp32Bridge.sdCsPin = undefined;
          }

          // Ensure firmware is loaded into the bridge (handles page-refresh case
          // where _pendingFirmware is lost but compiledProgram is still in store).
          if (!esp32Bridge.hasFirmware() && board.compiledProgram) {
            esp32Bridge.loadFirmware(board.compiledProgram);
          }

          esp32Bridge.connect();
        }
      } else if (isStm32BoardKind(board.boardKind)) {
        const stm32Bridge = getStm32Bridge(boardId);
        if (stm32Bridge) {
          // Pre-register I2C devices (BMP280, MPU6050, SSD1306, …) so the QEMU
          // worker builds each slave on the bus BEFORE the firmware's Wire
          // master starts probing. Address-based — no wire resolution needed
          // (virtual pin = 200 + i2c_addr). Mirrors the ESP32 path.
          const { components } = get();
          const sensors: Array<Record<string, unknown>> = [];
          for (const comp of components) {
            const i2cDef = I2C_SENSOR_MAP[comp.metadataId];
            if (!i2cDef) continue;
            let addr = i2cDef.defaultAddr;
            if (i2cDef.addrProp) {
              const rawAddr = comp.properties[i2cDef.addrProp];
              if (rawAddr !== undefined) {
                if (i2cDef.addrIsBool) {
                  if (rawAddr === true || rawAddr === 'true' || rawAddr === '1') {
                    addr = i2cDef.addrBoolHigh ?? i2cDef.defaultAddr;
                  }
                } else {
                  const parsed =
                    typeof rawAddr === 'string'
                      ? rawAddr.startsWith('0x')
                        ? parseInt(rawAddr, 16)
                        : parseInt(rawAddr, 10)
                      : Number(rawAddr);
                  if (!isNaN(parsed)) addr = parsed;
                }
              }
            }
            const props: Record<string, unknown> = {
              sensor_type: i2cDef.sensorType,
              pin: 200 + addr,
              addr,
            };
            for (const key of i2cDef.propertyKeys ?? []) {
              const val = comp.properties[key];
              if (val !== undefined) props[key] = typeof val === 'string' ? parseFloat(val) : val;
            }
            sensors.push(props);
          }
          stm32Bridge.setSensors(sensors);

          if (!stm32Bridge.hasFirmware() && board.compiledProgram) {
            stm32Bridge.loadFirmware(board.compiledProgram);
          }
          stm32Bridge.connect();
        }
      } else {
        const rpSim = getBoardSimulator(boardId);
        rpSim?.start();
        // Notify an attached PIO peripheral (the pro CYW43 WiFi co-processor)
        // that the simulation started, with the board's source files so it can
        // detect WiFi usage and open its network bridge. No-op in OSS.
        //
        // Overlay boards carry the same peripheral: the Pimoroni Pico Plus 2 W
        // and Badger 2350 have the RM2 (the same CYW43439 die) on an RP2350
        // simulator, which is NOT an RP2040Simulator. Without this branch they
        // associated to the local virtual AP but never got the network bridge
        // opened, so real internet and the Pro custom-AP config never applied
        // — WiFi that reached an IP and could reach nothing.
        const pioSim = rpSim as
          | (typeof rpSim & { getPioPeripheral?: () => { onSimulationStart?: (f: unknown[]) => void } | null })
          | null;
        if (typeof pioSim?.getPioPeripheral === 'function') {
          const editorState = useEditorStore.getState();
          const rawFiles = editorState.fileGroups[board.activeFileGroupId];
          const boardFiles =
            rawFiles && rawFiles.length > 0 ? rawFiles : editorState.files;
          pioSim.getPioPeripheral()?.onSimulationStart?.(boardFiles);
        }
      }

      set((s) => {
        const boards = s.boards.map((b) =>
          b.id === boardId ? { ...b, running: true, serialMonitorOpen: true } : b,
        );
        const isActive = s.activeBoardId === boardId;
        return { boards, ...(isActive ? { running: true, serialMonitorOpen: true } : {}) };
      });
    },

    stopBoard: (boardId: string) => {
      const board = get().boards.find((b) => b.id === boardId);
      if (!board) return;

      if (isPiBoardKind(board.boardKind)) {
        if (board.engineMode === 'instant') getInstantEngine()?.stop(boardId);
        else getBoardBridge(boardId)?.disconnect();
        // The shim holds no process, but it may hold a chip-select from an
        // unfinished transfer.
        getBoardSimulator(boardId)?.stop();
      } else if (isEsp32Kind(board.boardKind)) {
        getEsp32Bridge(boardId)?.disconnect();
      } else if (isStm32BoardKind(board.boardKind)) {
        getStm32Bridge(boardId)?.disconnect();
      } else {
        // Stop is "cut power": pressing Run again must boot from setup()
        // not resume mid-loop, so reset the CPU to PC=0 here. Without
        // this the AVR keeps its program counter and the next Run picks
        // up wherever it left off — which is fine for Pause but wrong
        // for the physical Stop button users expect.
        getBoardSimulator(boardId)?.reset();
      }

      // Hard reset: clear cached pin states AND notify listeners so
      // multiplexed displays (7-segment, LED matrix, NeoPixel) clear
      // the frozen frame they were holding when power was cut, instead
      // of carrying it into the next run.
      getBoardPinManager(boardId)?.hardResetPinStates();

      set((s) => {
        const boards = s.boards.map((b) => (b.id === boardId ? { ...b, running: false } : b));
        const isActive = s.activeBoardId === boardId;
        return { boards, ...(isActive ? { running: false } : {}) };
      });
    },

    resetBoard: (boardId: string) => {
      const board = get().boards.find((b) => b.id === boardId);
      if (!board) return;

      if (isEsp32Kind(board.boardKind)) {
        // Reset ESP32: disconnect then reconnect the QEMU bridge
        const esp32Bridge = getEsp32Bridge(boardId);
        if (esp32Bridge?.connected) {
          esp32Bridge.disconnect();
          setTimeout(() => esp32Bridge.connect(), 500);
        }
      } else if (!isPiBoardKind(board.boardKind)) {
        const sim = getBoardSimulator(boardId);
        if (sim) {
          sim.reset();
          // Hard reboot: CPU back to PC=0, every pin floats, every
          // output classification dropped, and listeners notified so
          // visual components (7-segment, NeoPixel, LCD) clear their
          // stale frame instead of freezing on whatever was lit.
          // Same semantics as Stop — both behave like cutting power.
          getBoardPinManager(boardId)?.hardResetPinStates();
          // NOTE: do NOT reassign sim.onSerialData here. sim.reset()
          // recreates the USART but the new usart.onByteTransmit
          // already chains through `this.onSerialData`, which is the
          // wrapper Interconnect installed for cross-board UART. The
          // previous "re-wire" line was destroying that wrapper and
          // silently breaking sibling-board serial forwarding after
          // every Reset press.
          if (sim instanceof AVRSimulator) {
            sim.onBaudRateChange = (baud) => {
              set((s) => {
                const boards = s.boards.map((b) =>
                  b.id === boardId ? { ...b, serialBaudRate: baud } : b,
                );
                const isActive = s.activeBoardId === boardId;
                return { boards, ...(isActive ? { serialBaudRate: baud } : {}) };
              });
            };
          }
        }
      }

      set((s) => {
        const boards = s.boards.map((b) =>
          b.id === boardId ? { ...b, running: false, serialOutput: '', serialBaudRate: 0 } : b,
        );
        const isActive = s.activeBoardId === boardId;
        // Bump hexEpoch so every component part re-attaches with a fresh
        // closure. Without this, latched per-part state (e.g. an LED's
        // `burnt` flag after overcurrent) would survive a Reset and the
        // part would stay dead even after the user fixes the circuit —
        // only a recompile would clear it. Mirrors restartParts().
        return {
          boards,
          hexEpoch: s.hexEpoch + 1,
          // A Reset un-chars any runtime-destroyed parts so a fixed circuit
          // comes back to life (mirrors the LED's burnt-latch clearing).
          ...(s.burntComponents.size > 0 ? { burntComponents: new Set<string>() } : {}),
          ...(isActive ? { running: false, serialOutput: '', serialBaudRate: 0 } : {}),
        };
      });

      // Reset interactive sensors (temperature / lux / gas sliders, etc.) back
      // to their configured defaults so a restart starts from a clean state
      // instead of freezing on the last slider position the user dragged to.
      // dispatchSensorUpdate re-injects the default into the running sim (so the
      // NTC's injected ADC voltage and the SPICE solve both return to 25°C /
      // 2.5V) and refreshes the panel's cached value; bumping sensorResetNonce
      // remounts the open SensorControlPanel so its slider snaps back too.
      const sensorComps = get().components.filter(
        (c) => c.metadataId && getSensorControlForComponent(c),
      );
      if (sensorComps.length > 0) {
        set((s) => ({
          components: s.components.map((c) => {
            const def = getSensorControlForComponent(c);
            if (!def) return c;
            // Custom chips keep control values under properties.attrs (the
            // chip reads them via vx_attr_read) — never as top-level props.
            if (c.metadataId === 'custom-chip') {
              const prev = (c.properties.attrs ?? {}) as Record<string, number>;
              return { ...c, properties: { ...c.properties, attrs: { ...prev, ...def.defaultValues } } };
            }
            return { ...c, properties: { ...c.properties, ...def.defaultValues } };
          }),
          sensorResetNonce: s.sensorResetNonce + 1,
        }));
        for (const c of sensorComps) {
          dispatchSensorUpdate(c.id, getSensorControlForComponent(c)!.defaultValues);
        }
      }
    },

    // ── Legacy single-board API ───────────────────────────────────────────
    boardType: 'arduino-uno',
    boardPosition: { ...DEFAULT_BOARD_POSITION },
    simulator: initialSim,
    pinManager: legacyPinManager,
    running: false,
    compiledHex: null,
    hexEpoch: 0,
    sensorResetNonce: 0,
    burntComponents: new Set<string>(),
    serialOutput: '',
    serialBaudRate: 0,
    serialMonitorOpen: false,
    remoteConnected: false,
    remoteSocket: null,

    esp32CrashBoardId: null,
    dismissEsp32Crash: () => set({ esp32CrashBoardId: null }),

    setBoardType: (type: BoardType) => {
      const { activeBoardId, running, stopSimulation } = get();
      if (running) stopSimulation();

      const boardId = activeBoardId ?? INITIAL_BOARD_ID;
      const pm = getBoardPinManager(boardId) ?? legacyPinManager;

      // Stop and remove old simulator / bridge
      getBoardSimulator(boardId)?.stop();
      simulatorMap.delete(boardId);
      getEsp32Bridge(boardId)?.disconnect();
      esp32BridgeMap.delete(boardId);

      const serialCallback = (ch: string) => appendSerial(boardId, ch);

      if (isEsp32Kind(type as BoardKind)) {
        // ESP32: use bridge, not AVR simulator
        const bridge = createEsp32Bridge(boardId, type as BoardKind);
        bridge.onSerialData = serialCallback;
        bridge.onPinChange = (gpioPin, state) => {
          const boardPm = pinManagerMap.get(boardId);
          if (boardPm) boardPm.triggerPinChange(gpioPin, state, 'mcu');
        };
        bridge.onPinChangeWithTime = getOscilloscopeCallback(boardId);
        bridge.onCrash = () => {
          set({ esp32CrashBoardId: boardId });
        };
        bridge.onDisconnected = () => {
          set((s) => {
            const boards = s.boards.map((b) => (b.id === boardId ? { ...b, running: false } : b));
            const isActive = s.activeBoardId === boardId;
            return { boards, ...(isActive ? { running: false } : {}) };
          });
        };
        signalRouterMap.set(boardId, new SignalRouter());
        bridge.onLedcDuty = makeLedcDutyHandler(boardId);
        bridge.onGpioRouting = makeGpioRoutingHandler(boardId);
        bridge.onGpioRoutingClear = makeGpioRoutingClearHandler(boardId);
        bridge.onPinPull = makePinPullHandler(boardId);
        bridge.onWs2812Update = makeWs2812Handler(boardId);
        esp32BridgeMap.set(boardId, bridge);
        const shim = new Esp32BridgeShim(bridge, pm);
        shim.onSerialData = serialCallback;
        simulatorMap.set(boardId, shim);
        // The Interconnect's serial fan-out wraps the INSTANCE's
        // onSerialData; a fresh simulator (compile, reset, engine
        // swap) drops that wrapper, so a wired peer stopped
        // hearing this board mid-session. Re-ensure it here.
        icReensureSerialHooks(boardId);

        set((s) => ({
          boardType: type,
          simulator: shim as any,
          compiledHex: null,
          serialOutput: '',
          serialBaudRate: 0,
          boards: s.boards.map((b) =>
            b.id === boardId
              ? {
                  ...b,
                  boardKind: type as BoardKind,
                  compiledProgram: null,
                  compiledUf2: null,
                  serialOutput: '',
                  serialBaudRate: 0,
                }
              : b,
          ),
        }));
      } else {
        const sim = createSimulator(
          type as BoardKind,
          pm,
          serialCallback,
          (baud) =>
            set((s) => {
              const boards = s.boards.map((b) =>
                b.id === boardId ? { ...b, serialBaudRate: baud } : b,
              );
              return { boards, serialBaudRate: baud };
            }),
          getOscilloscopeCallback(boardId),
        );
        simulatorMap.set(boardId, sim);
        // The Interconnect's serial fan-out wraps the INSTANCE's
        // onSerialData; a fresh simulator (compile, reset, engine
        // swap) drops that wrapper, so a wired peer stopped
        // hearing this board mid-session. Re-ensure it here.
        icReensureSerialHooks(boardId);

        set((s) => ({
          boardType: type,
          simulator: sim,
          compiledHex: null,
          serialOutput: '',
          serialBaudRate: 0,
          boards: s.boards.map((b) =>
            b.id === boardId
              ? {
                  ...b,
                  boardKind: type as BoardKind,
                  compiledProgram: null,
                  compiledUf2: null,
                  serialOutput: '',
                  serialBaudRate: 0,
                }
              : b,
          ),
        }));
      }
      console.log(`Board switched to: ${type}`);
    },

    initSimulator: () => {
      const { boardType, activeBoardId } = get();
      const boardId = activeBoardId ?? INITIAL_BOARD_ID;
      const pm = getBoardPinManager(boardId) ?? legacyPinManager;

      // Multi-board flows (addBoard, loadProjectState) already create
      // sims + register them in simulatorMap, AND Interconnect wraps
      // sim.onSerialData for cross-board UART forwarding. SimulatorCanvas
      // runs initSimulator() once on mount as a legacy single-board
      // "make sure a sim exists for the active board" helper. If we let
      // it through here when a sim ALREADY exists we wipe simulatorMap,
      // recreate the sim, and silently drop the Interconnect wrapper —
      // every cross-board wire stops forwarding bytes (Nano never sees
      // anything the Uno sends). Skip out early in that case.
      const existingSim = getBoardSimulator(boardId);
      if (existingSim) return;

      getEsp32Bridge(boardId)?.disconnect();
      esp32BridgeMap.delete(boardId);

      const serialCallback = (ch: string) => appendSerial(boardId, ch);

      if (isEsp32Kind(boardType as BoardKind)) {
        // ESP32: create bridge + shim (same as setBoardType)
        const bridge = createEsp32Bridge(boardId, boardType as BoardKind);
        bridge.onSerialData = serialCallback;
        bridge.onPinChange = (gpioPin, state) => {
          const boardPm = pinManagerMap.get(boardId);
          if (boardPm) boardPm.triggerPinChange(gpioPin, state, 'mcu');
        };
        bridge.onPinChangeWithTime = getOscilloscopeCallback(boardId);
        bridge.onCrash = () => {
          set({ esp32CrashBoardId: boardId });
        };
        bridge.onDisconnected = () => {
          set((s) => {
            const boards = s.boards.map((b) => (b.id === boardId ? { ...b, running: false } : b));
            const isActive = s.activeBoardId === boardId;
            return { boards, ...(isActive ? { running: false } : {}) };
          });
        };
        signalRouterMap.set(boardId, new SignalRouter());
        bridge.onLedcDuty = makeLedcDutyHandler(boardId);
        bridge.onGpioRouting = makeGpioRoutingHandler(boardId);
        bridge.onGpioRoutingClear = makeGpioRoutingClearHandler(boardId);
        bridge.onPinPull = makePinPullHandler(boardId);
        bridge.onWs2812Update = makeWs2812Handler(boardId);
        esp32BridgeMap.set(boardId, bridge);
        const shim = new Esp32BridgeShim(bridge, pm);
        shim.onSerialData = serialCallback;
        simulatorMap.set(boardId, shim);
        // The Interconnect's serial fan-out wraps the INSTANCE's
        // onSerialData; a fresh simulator (compile, reset, engine
        // swap) drops that wrapper, so a wired peer stopped
        // hearing this board mid-session. Re-ensure it here.
        icReensureSerialHooks(boardId);
        set({ simulator: shim as any, serialOutput: '', serialBaudRate: 0 });
      } else {
        const sim = createSimulator(
          boardType as BoardKind,
          pm,
          serialCallback,
          (baud) =>
            set((s) => {
              const boards = s.boards.map((b) =>
                b.id === boardId ? { ...b, serialBaudRate: baud } : b,
              );
              return { boards, serialBaudRate: baud };
            }),
          getOscilloscopeCallback(boardId),
        );
        simulatorMap.set(boardId, sim);
        // The Interconnect's serial fan-out wraps the INSTANCE's
        // onSerialData; a fresh simulator (compile, reset, engine
        // swap) drops that wrapper, so a wired peer stopped
        // hearing this board mid-session. Re-ensure it here.
        icReensureSerialHooks(boardId);
        set({ simulator: sim, serialOutput: '', serialBaudRate: 0 });
      }
      console.log(`Simulator initialized: ${boardType}`);
    },

    loadHex: (hex: string) => {
      const { activeBoardId } = get();
      const boardId = activeBoardId ?? INITIAL_BOARD_ID;
      const sim = getBoardSimulator(boardId);
      if (sim && sim instanceof AVRSimulator) {
        try {
          sim.loadHex(hex);
          sim.addI2CDevice(new VirtualDS1307());
          sim.addI2CDevice(new VirtualTempSensor());
          sim.addI2CDevice(new I2CMemoryDevice(0x50));
          set((s) => ({ compiledHex: hex, hexEpoch: s.hexEpoch + 1 }));
          console.log('HEX file loaded successfully');
        } catch (error) {
          console.error('Failed to load HEX:', error);
        }
      } else {
        console.warn('loadHex: simulator not initialized or wrong board type');
      }
    },

    loadBinary: (base64: string) => {
      const { activeBoardId } = get();
      const boardId = activeBoardId ?? INITIAL_BOARD_ID;
      const sim = getBoardSimulator(boardId);
      if (sim && sim instanceof RP2040Simulator) {
        try {
          sim.loadBinary(base64);
          sim.addI2CDevice(new VirtualDS1307() as RP2040I2CDevice);
          sim.addI2CDevice(new VirtualTempSensor() as RP2040I2CDevice);
          sim.addI2CDevice(new I2CMemoryDevice(0x50) as RP2040I2CDevice);
          set((s) => ({ compiledHex: base64, hexEpoch: s.hexEpoch + 1 }));
          console.log('Binary loaded into RP2040 successfully');
        } catch (error) {
          console.error('Failed to load binary:', error);
        }
      } else {
        console.warn('loadBinary: simulator not initialized or wrong board type');
      }
    },

    startSimulation: () => {
      const { activeBoardId } = get();
      const boardId = activeBoardId ?? INITIAL_BOARD_ID;
      get().startBoard(boardId);
    },

    restartParts: () => set((s) => ({ hexEpoch: s.hexEpoch + 1, burntComponents: new Set() })),
    markComponentBurnt: (componentId: string) =>
      set((s) =>
        s.burntComponents.has(componentId)
          ? {}
          : { burntComponents: new Set(s.burntComponents).add(componentId) },
      ),
    clearBurntComponents: () => set((s) => (s.burntComponents.size === 0 ? {} : { burntComponents: new Set() })),

    stopSimulation: () => {
      const { activeBoardId } = get();
      const boardId = activeBoardId ?? INITIAL_BOARD_ID;
      get().stopBoard(boardId);
    },

    resetSimulation: () => {
      const { activeBoardId } = get();
      const boardId = activeBoardId ?? INITIAL_BOARD_ID;
      get().resetBoard(boardId);
    },

    setCompiledHex: (hex: string) => {
      set({ compiledHex: hex });
      get().loadHex(hex);
    },

    setCompiledBinary: (base64: string) => {
      set({ compiledHex: base64 });
      get().loadBinary(base64);
    },

    setRunning: (running: boolean) => set({ running }),

    connectRemoteSimulator: (clientId: string) => {
      // Legacy: connect a Pi bridge for the given clientId
      const boardId = clientId;
      let bridge = getBoardBridge(boardId);
      if (!bridge) {
        bridge = new RaspberryPi3Bridge(boardId);
        bridge.onSerialData = (ch) => appendSerial(boardId, ch);
        bridge.onPinChange = (gpioPin, state) => {
          const { wires } = get();
          const sim = getBoardSimulator(get().activeBoardId ?? INITIAL_BOARD_ID);
          if (!sim) return;
          const wire = wires.find(
            (w) =>
              (w.start.componentId.includes('raspberry-pi') &&
                w.start.pinName === String(gpioPin)) ||
              (w.end.componentId.includes('raspberry-pi') && w.end.pinName === String(gpioPin)),
          );
          if (wire) {
            const isArduinoStart = !wire.start.componentId.includes('raspberry-pi');
            const targetEndpoint = isArduinoStart ? wire.start : wire.end;
            const pinNum = parseInt(targetEndpoint.pinName, 10);
            if (!isNaN(pinNum)) sim.setPinState(pinNum, state);
          }
        };
        bridgeMap.set(boardId, bridge);
      }
      bridge.connect();
      set({ remoteConnected: true });
    },

    disconnectRemoteSimulator: () => {
      const { activeBoardId } = get();
      const boardId = activeBoardId ?? INITIAL_BOARD_ID;
      getBoardBridge(boardId)?.disconnect();
      set({ remoteConnected: false, remoteSocket: null });
    },

    sendRemotePinEvent: (pin: string, state: number) => {
      const { activeBoardId } = get();
      const boardId = activeBoardId ?? INITIAL_BOARD_ID;
      getBoardBridge(boardId)?.sendPinEvent(parseInt(pin, 10), state === 1);
    },

    // ── Components ────────────────────────────────────────────────────────
    // Default canvas shown on a bare /editor visit: an external LED on
    // pin 13 PROTECTED BY A 220Ω SERIES RESISTOR (the canonical Blink
    // wiring textbooks teach). Without the resistor the LED is a direct
    // short forward-biased between 5V and GND — real hardware blows the
    // diode, and the ngspice solver returns an indeterminate / NaN branch
    // current so the visual LED never lights up on the canvas either.
    // NOTE: component ids must NOT contain hyphens. ngspice (WASM build)
    // truncates branch-current vector names at '-', so a sense source
    // named V_led-builtin_sense yields the wrong key in branchCurrents
    // and the LED's update() loop never sees the diode current — the
    // node voltage is correct (the user sees ~1.84V on the wire) but the
    // visual brightness stays at zero. Underscore is safe.
    components: [
      {
        id: 'led_builtin',
        metadataId: 'led',
        x: 380,
        y: 100,
        properties: { color: 'red' },
      },
      {
        id: 'r_builtin',
        metadataId: 'resistor',
        x: 240,
        y: 130,
        properties: { value: '220' },
      },
    ],

    hydrationSeq: 0,

    wires: [
      // Pin 13 → resistor pin 1 (current-limiting side).
      {
        id: 'wire_builtin_pin13',
        start: { componentId: 'arduino-uno', pinName: '13', x: 0, y: 0 },
        end: { componentId: 'r_builtin', pinName: '1', x: 0, y: 0 },
        waypoints: [],
        color: '#22c55e',
      },
      // Resistor pin 2 → LED anode.
      {
        id: 'wire_builtin_anode',
        start: { componentId: 'r_builtin', pinName: '2', x: 0, y: 0 },
        end: { componentId: 'led_builtin', pinName: 'A', x: 0, y: 0 },
        waypoints: [],
        color: '#22c55e',
      },
      // LED cathode → GND.
      {
        id: 'wire_builtin_cathode',
        start: { componentId: 'led_builtin', pinName: 'C', x: 0, y: 0 },
        end: { componentId: 'arduino-uno', pinName: 'GND.1', x: 0, y: 0 },
        waypoints: [],
        color: '#000000',
      },
    ],
    selectedWireId: null,
    wireInProgress: null,

    addComponent: (component) => set((state) => ({ components: [...state.components, component] })),

    removeComponent: (id) =>
      set((state) => ({
        components: state.components.filter((c) => c.id !== id),
        wires: state.wires.filter((w) => w.start.componentId !== id && w.end.componentId !== id),
      })),

    updateComponent: (id, updates) => {
      const before = get().components.find((c) => c.id === id);
      const isBbMove =
        !!before && isBreadboard(before.metadataId) &&
        (updates.x !== undefined || updates.y !== undefined);
      const dx = isBbMove ? (updates.x ?? before.x) - before.x : 0;
      const dy = isBbMove ? (updates.y ?? before.y) - before.y : 0;

      set((state) => ({
        components: state.components.map((c) => (c.id === id ? { ...c, ...updates } : c)),
      }));
      // Re-stamp wire endpoints when the geometry of the component changes:
      // position (x/y) OR rotation. Without this, rotating a component
      // leaves every wire anchored to the pre-rotation pin positions, so
      // the part visually disconnects from its cables.
      const rotationChanged =
        updates.properties && 'rotation' in updates.properties;
      if (updates.x !== undefined || updates.y !== undefined || rotationChanged) {
        get().updateWirePositions(id);
        // Reseat ONLY on geometry changes (move/rotate) — the DOM pinInfo is
        // still valid for those. Property changes that swap the pin SET
        // (7segment digits, LED flip) re-render asynchronously; reseating
        // now would read the STALE pinout and seat ghost pins (seen live:
        // a digits=4 display seated with the 1-digit COM pinout). Those go
        // through the element's 'pininfo-change' event instead
        // (DynamicComponent listener).
        get().reseatComponentOnBreadboard(id);
      }

      // A moving breadboard carries its seated parts: shift every part
      // plugged into it (bb wires) by the same delta AFTER the board has
      // moved, so each rider's own reseat re-lands on the same holes at
      // their new location regardless of how fast the drag is.
      if (isBbMove && (dx !== 0 || dy !== 0)) {
        const riders = new Set<string>();
        for (const w of get().wires) {
          if (!w.bb) continue;
          if (w.start.componentId === id) riders.add(w.end.componentId);
          if (w.end.componentId === id) riders.add(w.start.componentId);
        }
        riders.delete(id);
        for (const rid of riders) {
          const rc = get().components.find((c) => c.id === rid);
          if (rc) get().updateComponent(rid, { x: rc.x + dx, y: rc.y + dy });
        }
      }
    },

    reseatComponentOnBreadboard: (id) => {
      const comp = get().components.find((c) => c.id === id);
      if (!comp || isBreadboard(comp.metadataId)) return;
      const seating = computeSeating(comp, get().components);
      // null = geometry unmeasurable (unmounted DOM) — keep whatever
      // seating exists rather than tearing out live connections.
      if (seating === null) return;
      // Nothing seated and nothing to clear: skip the store write. The
      // mount-time reseat (DynamicComponent) calls this for EVERY part as
      // its element becomes measurable — on a project load that would churn
      // the wires array identity once per off-board component for no change.
      if (
        seating.length === 0 &&
        !get().wires.some((w) => w.bb && (w.start.componentId === id || w.end.componentId === id))
      ) {
        return;
      }
      set((state) => {
        const kept = state.wires.filter(
          (w) => !(w.bb && (w.start.componentId === id || w.end.componentId === id)),
        );
        const seated: Wire[] = seating.map((s, i) => ({
          id: `bbwire-${id}-${i}-${s.holeName}`,
          start: { componentId: id, pinName: s.pinName, x: s.pinX, y: s.pinY },
          end: { componentId: s.bbId, pinName: s.holeName, x: s.holeX, y: s.holeY },
          waypoints: [],
          color: '#000000',
          bb: true,
        }));
        return { wires: [...kept, ...seated] };
      });
    },

    updateComponentState: (id, state) => {
      set((prevState) => {
        // No-op guard: this runs per GPIO edge for wire-connected components.
        // Unconditionally minting a new components array re-rendered every
        // subscriber (canvas, editor page, console) thousands of times per
        // second on a fast-toggling sketch — the main cause of the frozen
        // browser on the ESP32 multiplexed-clock projects.
        const comp = prevState.components.find((c) => c.id === id);
        if (!comp || (comp.properties.state === state && comp.properties.value === state)) {
          return prevState;
        }
        return {
          components: prevState.components.map((c) =>
            c.id === id ? { ...c, properties: { ...c.properties, state, value: state } } : c,
          ),
        };
      });
    },

    handleComponentEvent: (_componentId, _eventName, _data) => {},

    setComponents: (components) => {
      // Bulk replacement (project load / clear) — any pending undo/redo
      // would point at component IDs that no longer exist after this.
      set((state) => ({
        components,
        history: [],
        historyIndex: -1,
        hydrationSeq: state.hydrationSeq + 1,
      }));
    },

    addWire: (wire) => set((state) => ({ wires: [...state.wires, wire] })),

    splitWireWithJunction: (wireId, x, y, threshold, opts) => {
      const state = get();
      const original = state.wires.find((w) => w.id === wireId);
      if (!original) return null;

      const split = computeWireSplit(original, x, y, threshold);
      if (!split) return null;

      // The wire being drawn, if the caller wants it landed on the new node.
      // Captured BEFORE the command runs so undo can put it back.
      const wip = opts?.finishWireInProgress ? state.wireInProgress : null;
      let closing: Wire | null = null;
      if (wip) {
        const last = wip.waypoints.length
          ? wip.waypoints[wip.waypoints.length - 1]
          : { x: wip.startEndpoint.x, y: wip.startEndpoint.y };
        const elbow = previewElbow(last, split.endpoint.x, split.endpoint.y);
        closing = {
          id: `wire-${generateUUID()}`,
          start: wip.startEndpoint,
          end: split.endpoint,
          waypoints: normalizeWireWaypoints(
            { x: wip.startEndpoint.x, y: wip.startEndpoint.y },
            elbow ? [...wip.waypoints, elbow] : wip.waypoints,
            { x: split.endpoint.x, y: split.endpoint.y },
          ),
          color: wip.color,
          autoRouted: false,
        };
      }

      const junction = split.junction as Component;
      get().pushCommand({
        description: 'Add wire junction',
        execute: () =>
          set((s2) => ({
            components: [...s2.components, junction],
            wires: [
              ...s2.wires.filter((w) => w.id !== original.id),
              split.wireA,
              split.wireB,
              ...(closing ? [closing] : []),
            ],
            wireInProgress: closing ? null : s2.wireInProgress,
          })),
        undo: () =>
          set((s2) => ({
            components: s2.components.filter((c) => c.id !== junction.id),
            wires: [
              ...s2.wires.filter(
                (w) =>
                  w.id !== split.wireA.id &&
                  w.id !== split.wireB.id &&
                  (!closing || w.id !== closing.id),
              ),
              original,
            ],
          })),
      });

      // The stored endpoint coords are exact by construction, but the node's
      // pinInfo only becomes readable once its element mounts — re-stamp then
      // so a later component move keeps every attached wire on the dot.
      const recalc = () => get().updateWirePositions(junction.id);
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(recalc);
      else recalc();

      return junction.id;
    },

    removeWire: (wireId) =>
      set((state) => ({
        wires: state.wires.filter((w) => w.id !== wireId),
        selectedWireId: state.selectedWireId === wireId ? null : state.selectedWireId,
      })),

    updateWire: (wireId, updates) =>
      set((state) => ({
        wires: state.wires.map((w) => (w.id === wireId ? { ...w, ...updates } : w)),
      })),

    setSelectedWire: (wireId) => set({ selectedWireId: wireId }),

    setWires: (wires) =>
      set((state) => ({
        // Ensure every wire has waypoints (backwards-compatible with saved projects)
        wires: wires.map((w) => ({ waypoints: [], ...w })),
        // Bulk replacement clears history for the same reason as setComponents.
        history: [],
        historyIndex: -1,
        hydrationSeq: state.hydrationSeq + 1,
      })),

    startWireCreation: (endpoint, color) =>
      set({
        wireInProgress: {
          startEndpoint: endpoint,
          waypoints: [],
          color,
          currentX: endpoint.x,
          currentY: endpoint.y,
        },
      }),

    updateWireInProgress: (x, y) =>
      set((state) => {
        const wip = state.wireInProgress;
        if (!wip) return state;

        // Live routed preview: while the wire has no user-placed waypoints,
        // route start -> cursor so the preview dodges components and other
        // wires AS THE MOUSE MOVES — the committed shape then matches what
        // the user was seeing instead of snapping on the final click.
        // Throttled: between routings the last route keeps rendering, so
        // the preview trails by at most one throttle window.
        let routedPreview = wip.routedPreview ?? null;
        let lastRouteAt = wip.lastRouteAt ?? 0;
        if (wip.waypoints.length === 0) {
          const now = Date.now();
          if (now - lastRouteAt >= 40) {
            lastRouteAt = now;
            routedPreview = routeAroundObstacles(
              { x: wip.startEndpoint.x, y: wip.startEndpoint.y },
              { x, y },
              collectComponentObstacles(state.components, [wip.startEndpoint.componentId]),
              collectWireSegments(state.wires),
            );
          }
        } else {
          routedPreview = null; // user is hand-guiding — show their path
        }

        return {
          wireInProgress: { ...wip, currentX: x, currentY: y, routedPreview, lastRouteAt },
        };
      }),

    addWireWaypoint: (x, y) =>
      set((state) => {
        if (!state.wireInProgress) return state;
        return {
          wireInProgress: {
            ...state.wireInProgress,
            waypoints: [...state.wireInProgress.waypoints, { x, y }],
          },
        };
      }),

    setWireInProgressColor: (color) =>
      set((state) => {
        if (!state.wireInProgress) return state;
        return { wireInProgress: { ...state.wireInProgress, color } };
      }),

    finishWireCreation: (endpoint) => {
      const state = get();
      if (!state.wireInProgress) return;
      const { startEndpoint, waypoints, color } = state.wireInProgress;

      // Finish wire: auto-detect color from pin name
      const finalColor = color === DEFAULT_WIRE_COLOR ? autoWireColor(endpoint.pinName) : color;

      // First-time auto-routing: a direct pin-to-pin wire (no user-placed
      // waypoints) gets routed around other components AND clear of the
      // wires already on the canvas. The wire is marked `autoRouted`, so
      // the post-move pass keeps it clean when parts move; the moment the
      // user drags a segment the flag is cleared and the shape is theirs.
      let routed: { x: number; y: number }[] | null = null;
      if (waypoints.length === 0) {
        routed = routeAroundObstacles(
          { x: startEndpoint.x, y: startEndpoint.y },
          { x: endpoint.x, y: endpoint.y },
          collectComponentObstacles(state.components, [
            startEndpoint.componentId,
            endpoint.componentId,
          ]),
          collectWireSegments(state.wires),
        );
      }

      // Materialise the elbow of the final leg exactly as the live preview
      // drew it (longer axis first). Without this the committed wire falls
      // back to the implicit horizontal-first corner and visibly changes
      // shape the instant the user clicks the destination pin.
      const last = waypoints.length
        ? waypoints[waypoints.length - 1]
        : { x: startEndpoint.x, y: startEndpoint.y };
      const elbow = previewElbow(last, endpoint.x, endpoint.y);

      const newWire: Wire = {
        id: `wire-${Date.now()}`,
        start: startEndpoint,
        end: endpoint,
        waypoints: normalizeWireWaypoints(
          { x: startEndpoint.x, y: startEndpoint.y },
          routed ?? (elbow ? [...waypoints, elbow] : waypoints),
          { x: endpoint.x, y: endpoint.y },
        ),
        color: finalColor,
        // System-owned shape only when the user placed no waypoints —
        // guided wires are hand-authored from birth.
        autoRouted: waypoints.length === 0,
      };
      set((state) => ({ wires: [...state.wires, newWire], wireInProgress: null }));
    },

    cancelWireCreation: () => set({ wireInProgress: null }),

    updateWirePositions: (componentId) => {
      set((state) => {
        const component = state.components.find((c) => c.id === componentId);
        // Check if this componentId matches a board id
        const board = state.boards.find((b) => b.id === componentId);
        // Components have a DynamicComponent wrapper with border:2px +
        // padding:4px on EVERY side → inner element sits at (+6, +6)
        // from the wrapper top-left. Earlier code used (+4, +6) — the
        // 2 px X bias rotated visibly with the component and looked
        // like wires came off the pins when rotated. Boards are
        // rendered directly without that wrapper, so no offset.
        const compX = component ? component.x + 6 : board ? board.x : state.boardPosition.x;
        const compY = component ? component.y + 6 : board ? board.y : state.boardPosition.y;
        // Boards never rotate; components carry their angle in properties.rotation.
        const rotation = component ? Number(component.properties?.rotation) || 0 : 0;

        const updatedWires = state.wires.map((wire) => {
          const updated = { ...wire };
          if (wire.start.componentId === componentId) {
            const pos = calculatePinPosition(
              componentId, wire.start.pinName, compX, compY, rotation,
            );
            if (pos) updated.start = { ...wire.start, x: pos.x, y: pos.y };
          }
          if (wire.end.componentId === componentId) {
            const pos = calculatePinPosition(
              componentId, wire.end.pinName, compX, compY, rotation,
            );
            if (pos) updated.end = { ...wire.end, x: pos.x, y: pos.y };
          }
          return updated;
        });
        return { wires: updatedWires };
      });
    },

    zOrders: {},
    zTop: 0,
    raiseItem: (id: string) => {
      const s = get();
      // Already on top: re-raising would only churn renders.
      if (s.zOrders[id] === s.zTop && s.zTop > 0) return;
      // A board plugged into a socket sits ON it, so it must keep painting
      // above — raising the socket alone buried its own seated board, and a
      // buried board cannot be grabbed to unplug it.
      const seatedOnIt = s.components.some((c) => c.id === id)
        ? s.boards.filter((b) =>
            isBoardSeated(b.id, b.boardKind, b.x, b.y, s.components.filter((c) => c.id === id)),
          )
        : [];
      let top = s.zTop;
      const zOrders = { ...s.zOrders, [id]: ++top };
      for (const b of seatedOnIt) zOrders[b.id] = ++top;
      set({ zTop: top, zOrders });
    },

    recalculateAllWirePositions: () => {
      const state = get();
      const updatedWires = state.wires.map((wire) => {
        const updated = { ...wire };

        // Resolve start — components have wrapper offset (6,6) on
        // both axes (padding:4 + border:2). Boards have no wrapper.
        const startComp = state.components.find((c) => c.id === wire.start.componentId);
        const startBoard = state.boards.find((b) => b.id === wire.start.componentId);
        const startX = startComp
          ? startComp.x + 6
          : startBoard
            ? startBoard.x
            : state.boardPosition.x;
        const startY = startComp
          ? startComp.y + 6
          : startBoard
            ? startBoard.y
            : state.boardPosition.y;
        const startRotation = startComp ? Number(startComp.properties?.rotation) || 0 : 0;
        const startPos = calculatePinPosition(
          wire.start.componentId,
          wire.start.pinName,
          startX,
          startY,
          startRotation,
        );
        updated.start = startPos
          ? { ...wire.start, x: startPos.x, y: startPos.y }
          : { ...wire.start, x: startX, y: startY };

        // Resolve end — same (6,6) wrapper offset as start above.
        const endComp = state.components.find((c) => c.id === wire.end.componentId);
        const endBoard = state.boards.find((b) => b.id === wire.end.componentId);
        const endX = endComp ? endComp.x + 6 : endBoard ? endBoard.x : state.boardPosition.x;
        const endY = endComp ? endComp.y + 6 : endBoard ? endBoard.y : state.boardPosition.y;
        const endRotation = endComp ? Number(endComp.properties?.rotation) || 0 : 0;
        const endPos = calculatePinPosition(
          wire.end.componentId, wire.end.pinName, endX, endY, endRotation,
        );
        updated.end = endPos
          ? { ...wire.end, x: endPos.x, y: endPos.y }
          : { ...wire.end, x: endX, y: endY };

        return updated;
      });

      // ── Re-route system-owned wires ──────────────────────────────────
      // Endpoints just moved (component drag, agent batch, mount settle):
      // waypoints stored earlier may now cross parts or ride other wires.
      // Re-route every `autoRouted` wire; hand-authored wires keep their
      // shape untouched, exactly where the user left them.
      //
      // This runs at drag END and on settle timers — never per drag frame
      // (updateWirePositions handles those and does not route).
      //
      // Sequential on purpose: each wire sees the already-re-routed shapes
      // of the ones before it, which is what lays parallel runs out as a
      // tidy side-by-side bus instead of a shuffle of overlaps.
      if (updatedWires.some((w) => w.autoRouted && !w.bb)) {
        const rectsById = collectComponentRects(state.components);
        for (let i = 0; i < updatedWires.length; i++) {
          const wire = updatedWires[i];
          if (!wire.autoRouted || wire.bb) continue;
          const rects = rectsById
            .filter((r) => r.id !== wire.start.componentId && r.id !== wire.end.componentId)
            .map((r) => r.rect);
          const routed = routeAroundObstacles(
            { x: wire.start.x, y: wire.start.y },
            { x: wire.end.x, y: wire.end.y },
            rects,
            collectWireSegments(updatedWires, wire.id),
          );
          // routed === null means the PREVIEW elbow (longer-axis-first) is
          // clear — so that exact elbow must be materialised. Storing []
          // instead renders the implicit horizontal-first corner, a
          // DIFFERENT elbow the router never checked: three agent wires
          // shipped crossing a display that way while their checked route
          // was clean.
          const elbow =
            routed === null
              ? previewElbow(
                  { x: wire.start.x, y: wire.start.y },
                  wire.end.x,
                  wire.end.y,
                )
              : null;
          updatedWires[i] = {
            ...wire,
            waypoints: normalizeWireWaypoints(
              { x: wire.start.x, y: wire.start.y },
              routed ?? (elbow ? [elbow] : []),
              { x: wire.end.x, y: wire.end.y },
            ),
          };
        }
      }

      set({ wires: updatedWires });
    },

    // ── Undo/redo ──────────────────────────────────────────────────────────
    history: [],
    historyIndex: -1,

    pushCommand: (cmd, opts) => {
      const applyNow = opts?.applyNow ?? true;
      if (applyNow) cmd.execute();
      set((state) => {
        // Truncate the redo branch — once you push a new command, the
        // entries you'd previously redone are abandoned.
        const truncated = state.history.slice(0, state.historyIndex + 1);
        let next = [...truncated, cmd];
        let nextIdx = next.length - 1;
        // Cap at HISTORY_MAX. When over, drop the oldest entry and shift
        // the index down so it still points at the just-pushed command.
        if (next.length > HISTORY_MAX) {
          const overflow = next.length - HISTORY_MAX;
          next = next.slice(overflow);
          nextIdx = next.length - 1;
        }
        return { history: next, historyIndex: nextIdx };
      });
    },

    undo: () => {
      const state = get();
      if (state.historyIndex < 0) return;
      const cmd = state.history[state.historyIndex];
      try {
        cmd.undo();
      } catch (err) {
        // A failing undo would otherwise leave the index pointing at a
        // half-applied command. Bail out cleanly.
        // eslint-disable-next-line no-console
        console.error('[history] undo failed:', cmd.description, err);
        return;
      }
      set({ historyIndex: state.historyIndex - 1 });
    },

    redo: () => {
      const state = get();
      if (state.historyIndex >= state.history.length - 1) return;
      const cmd = state.history[state.historyIndex + 1];
      try {
        cmd.execute();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[history] redo failed:', cmd.description, err);
        return;
      }
      set({ historyIndex: state.historyIndex + 1 });
    },

    canUndo: () => get().historyIndex >= 0,
    canRedo: () => {
      const s = get();
      return s.historyIndex < s.history.length - 1;
    },

    clearHistory: () => set({ history: [], historyIndex: -1 }),

    // ── Recorded canvas actions ────────────────────────────────────────────
    // Each `record*` builds a CanvasCommand that captures both directions
    // and pushes it. Naming intent: the user has *committed* a change
    // (drag-end, click finalised, agent tool execute) — distinct from the
    // raw mutators above which can be called per-frame during a drag.

    recordAddComponent: (component) => {
      get().pushCommand({
        description: `Add ${component.metadataId}`,
        execute: () =>
          set((s) => ({ components: [...s.components, component] })),
        undo: () =>
          set((s) => ({
            components: s.components.filter((c) => c.id !== component.id),
            // Mirror the cascade in removeComponent so a redo→undo round
            // trip of an add-then-wired pair stays consistent.
            wires: s.wires.filter(
              (w) =>
                w.start.componentId !== component.id && w.end.componentId !== component.id,
            ),
          })),
      });
    },

    recordRemoveComponent: (id) => {
      const state = get();
      const removed = state.components.find((c) => c.id === id);
      if (!removed) return;
      // Capture wires that will be cascaded too — undo must restore both
      // the component AND its wires together.
      const removedWires = state.wires.filter(
        (w) => w.start.componentId === id || w.end.componentId === id,
      );
      get().pushCommand({
        description: `Remove ${removed.metadataId}`,
        execute: () =>
          set((s) => ({
            components: s.components.filter((c) => c.id !== id),
            wires: s.wires.filter(
              (w) => w.start.componentId !== id && w.end.componentId !== id,
            ),
          })),
        undo: () => {
          set((s) => ({
            components: [...s.components, removed],
            wires: [...s.wires, ...removedWires],
          }));
          // Recalc this part's wire endpoints once it re-mounts. Without this
          // a rotated component restored via Ctrl+Z keeps the unrotated wire
          // coords captured at delete time, so its wires sit off the pins
          // until the user rotates again (issue #232). rAF waits for the DOM
          // node so calculatePinPosition can read the wrapper geometry.
          const recalc = () => get().updateWirePositions(id);
          if (typeof requestAnimationFrame === 'function') requestAnimationFrame(recalc);
          else recalc();
        },
      });
    },

    recordMove: (id, from, to) => {
      // The state is already at `to` (caller mutated during drag). We push
      // applyNow:false so we don't redundantly re-apply on first push;
      // execute()/undo() are only invoked on future redo/undo.
      get().pushCommand(
        {
          description: 'Move component',
          execute: () => {
            set((s) => ({
              components: s.components.map((c) =>
                c.id === id ? { ...c, x: to.x, y: to.y } : c,
              ),
            }));
            get().updateWirePositions(id);
          },
          undo: () => {
            set((s) => ({
              components: s.components.map((c) =>
                c.id === id ? { ...c, x: from.x, y: from.y } : c,
              ),
            }));
            get().updateWirePositions(id);
          },
        },
        { applyNow: false },
      );
    },

    recordRotate: (id, prevRotation, nextRotation) => {
      get().pushCommand(
        {
          description: 'Rotate component',
          execute: () => {
            set((s) => ({
              components: s.components.map((c) =>
                c.id === id
                  ? { ...c, properties: { ...c.properties, rotation: nextRotation } }
                  : c,
              ),
            }));
            // Wires must follow the part on undo / redo too, otherwise a
            // Ctrl+Z after a rotate would re-show the post-rotation pin
            // positions against the now-restored unrotated component.
            get().updateWirePositions(id);
          },
          undo: () => {
            set((s) => ({
              components: s.components.map((c) =>
                c.id === id
                  ? { ...c, properties: { ...c.properties, rotation: prevRotation } }
                  : c,
              ),
            }));
            get().updateWirePositions(id);
          },
        },
        { applyNow: false },
      );
    },

    recordSetProperty: (id, key, prevValue, nextValue) => {
      get().pushCommand(
        {
          description: `Change ${key}`,
          execute: () =>
            set((s) => ({
              components: s.components.map((c) =>
                c.id === id
                  ? { ...c, properties: { ...c.properties, [key]: nextValue } }
                  : c,
              ),
            })),
          undo: () =>
            set((s) => ({
              components: s.components.map((c) =>
                c.id === id
                  ? { ...c, properties: { ...c.properties, [key]: prevValue } }
                  : c,
              ),
            })),
        },
        { applyNow: false },
      );
    },

    recordAddWire: (wire) => {
      get().pushCommand({
        description: 'Add wire',
        execute: () => set((s) => ({ wires: [...s.wires, wire] })),
        undo: () =>
          set((s) => ({
            wires: s.wires.filter((w) => w.id !== wire.id),
            selectedWireId: s.selectedWireId === wire.id ? null : s.selectedWireId,
          })),
      });
    },

    recordRemoveWire: (wireId) => {
      const removed = get().wires.find((w) => w.id === wireId);
      if (!removed) return;
      get().pushCommand({
        description: 'Remove wire',
        execute: () =>
          set((s) => ({
            wires: s.wires.filter((w) => w.id !== wireId),
            selectedWireId: s.selectedWireId === wireId ? null : s.selectedWireId,
          })),
        undo: () => set((s) => ({ wires: [...s.wires, removed] })),
      });
    },

    recordUpdateWire: (wireId, prev, next, description = 'Update wire') => {
      // applyNow defaults to true: both callers (the wire color palette and the
      // wire right-click menu) pass the new value and expect it applied — they
      // do NOT pre-apply via the raw updateWire mutator. The old `applyNow:false`
      // recorded the change for undo but never executed it, so changing a wire
      // colour from the UI was a silent no-op (only the keyboard shortcut, which
      // calls updateWire directly, actually worked).
      get().pushCommand({
        description,
        execute: () =>
          set((s) => ({
            wires: s.wires.map((w) => (w.id === wireId ? { ...w, ...next } : w)),
          })),
        undo: () =>
          set((s) => ({
            wires: s.wires.map((w) => (w.id === wireId ? { ...w, ...prev } : w)),
          })),
      });
    },

    toggleSerialMonitor: () => set((s) => ({ serialMonitorOpen: !s.serialMonitorOpen })),

    serialWrite: (text: string) => {
      const { activeBoardId } = get();
      const boardId = activeBoardId ?? INITIAL_BOARD_ID;
      const board = get().boards.find((b) => b.id === boardId);
      if (!board) return;

      if (isPiBoardKind(board.boardKind)) {
        const bridge = getBoardBridge(boardId);
        if (bridge) {
          for (let i = 0; i < text.length; i++) {
            bridge.sendSerialByte(text.charCodeAt(i));
          }
        }
      } else if (isEsp32Kind(board.boardKind)) {
        const esp32Bridge = getEsp32Bridge(boardId);
        if (esp32Bridge) {
          esp32Bridge.sendSerialBytes(Array.from(new TextEncoder().encode(text)));
        }
      } else {
        getBoardSimulator(boardId)?.serialWrite(text);
      }
    },

    clearSerialOutput: () => {
      const { activeBoardId } = get();
      const boardId = activeBoardId ?? INITIAL_BOARD_ID;
      set((s) => ({
        serialOutput: '',
        boards: s.boards.map((b) => (b.id === boardId ? { ...b, serialOutput: '' } : b)),
      }));
    },

    serialWriteToBoard: (boardId: string, text: string) => {
      const board = get().boards.find((b) => b.id === boardId);
      if (!board) return;
      // A connected hardware serial monitor (pro overlay) takes the input
      // instead of the board's simulator.
      const hardwareTx = getSerialTxInterceptor(boardId);
      if (hardwareTx) {
        hardwareTx(text);
        return;
      }
      if (isPiBoardKind(board.boardKind)) {
        const bridge = getBoardBridge(boardId);
        if (bridge) {
          for (let i = 0; i < text.length; i++) {
            bridge.sendSerialByte(text.charCodeAt(i));
          }
        }
      } else if (isEsp32Kind(board.boardKind)) {
        const esp32Bridge = getEsp32Bridge(boardId);
        if (esp32Bridge) {
          esp32Bridge.sendSerialBytes(Array.from(new TextEncoder().encode(text)));
        }
      } else {
        getBoardSimulator(boardId)?.serialWrite(text);
      }
    },

    clearBoardSerialOutput: (boardId: string) => {
      const isActive = get().activeBoardId === boardId;
      set((s) => ({
        ...(isActive ? { serialOutput: '' } : {}),
        boards: s.boards.map((b) => (b.id === boardId ? { ...b, serialOutput: '' } : b)),
      }));
    },
  };
});

// ── Helper: get the active board instance (convenience for consumers) ─────
export function getActiveBoard(): BoardInstance | null {
  const { boards, activeBoardId } = useSimulatorStore.getState();
  return boards.find((b) => b.id === activeBoardId) ?? null;
}

// ── Cross-board interconnect wiring ────────────────────────────────────────
//
// The Interconnect router subscribes to wire and board changes to propagate
// digital pin transitions and UART bytes between boards. We register the
// runtime accessors once, bind the initial board, and watch for store
// mutations.

setInterconnectRuntime({
  getBoardSimulator: (id: string) => simulatorMap.get(id),
  getBoardPinManager: (id: string) => pinManagerMap.get(id),
  getBoardBridge: (id: string) => bridgeMap.get(id),
  getEsp32Bridge: (id: string) => esp32BridgeMap.get(id),
  getStm32Bridge: (id: string) => stm32BridgeMap.get(id),
});

// Bind the initial Arduino Uno that ships with the store.
icBindBoard(INITIAL_BOARD_ID, 'arduino-uno');
icUpdateWires(useSimulatorStore.getState().wires);

// React to wire mutations from any source (drag, import, setState, ...).
let lastWiresRef: readonly Wire[] = useSimulatorStore.getState().wires;
let lastBoardsRef: readonly BoardInstance[] = useSimulatorStore.getState().boards;
useSimulatorStore.subscribe((state) => {
  const wiresChanged = state.wires !== lastWiresRef;
  const boardsChanged = state.boards !== lastBoardsRef;
  if (boardsChanged) {
    lastBoardsRef = state.boards;
    // Bind any boards that appeared in state but not yet in interconnect
    // (covers paths that bypass addBoard, e.g. import-from-zip, hot reload).
    for (const b of state.boards) icBindBoard(b.id, b.boardKind);
  }
  if (wiresChanged || boardsChanged) {
    lastWiresRef = state.wires;
    icUpdateWires(state.wires);
  }
});
