/**
 * Esp32Bridge
 *
 * Manages the WebSocket connection from the frontend to the backend
 * QEMU manager for one ESP32/ESP32-S3/ESP32-C3 board instance.
 *
 * Protocol (JSON frames):
 *   Frontend → Backend
 *     { type: 'start_esp32',        data: { board: BoardKind, firmware_b64?: string } }
 *     { type: 'stop_esp32' }
 *     { type: 'load_firmware',      data: { firmware_b64: string } }
 *     { type: 'esp32_serial_input', data: { bytes: number[], uart?: number } }
 *     { type: 'esp32_gpio_in',      data: { pin: number, state: 0 | 1 } }
 *     { type: 'esp32_adc_set',      data: { channel: number, millivolts: number } }
 *     { type: 'esp32_i2c_response', data: { addr: number, response: number } }
 *     { type: 'esp32_spi_response', data: { response: number } }
 *     { type: 'esp32_sensor_attach', data: { sensor_type: string, pin: number, ... } }
 *     { type: 'esp32_sensor_update', data: { pin: number, ... } }
 *     { type: 'esp32_sensor_detach', data: { pin: number } }
 *
 *   Backend → Frontend
 *     { type: 'serial_output', data: { data: string, uart?: number } }
 *     { type: 'gpio_change',   data: { pin: number, state: 0 | 1 } }
 *     { type: 'gpio_dir',      data: { pin: number, dir: 0 | 1 } }
 *     { type: 'gpio_pull',     data: { pin: number, pull: 0 | 1 | 2 } }  // 0=none 1=up 2=down
 *     { type: 'ledc_duty',     data: { channel: number, duty_pct: number } }
 *     { type: 'gpio_routing',  data: { gpio: number, signal_id: number } }
 *     { type: 'gpio_routing_clear', data: { gpio: number } }
 *     { type: 'ws2812_update', data: { channel: number, pin?: number,
 *                                        pixels: Array<{r,g,b}> | [r,g,b][] } }
 *     { type: 'i2c_event',        data: { addr: number, data: number } }
 *     { type: 'i2c_transaction',  data: { addr: number, data: number[] } }
 *     { type: 'spi_event',        data: { data: number } }
 *     { type: 'system',        data: { event: string, ... } }
 *     { type: 'error',         data: { message: string } }
 */

import type { BoardKind } from '../types/board';
import { MicroPythonSession, type MpyProgram } from './micropythonSession';
import { getProBoard } from '../lib/proBoardRegistry';
import { sensorRecordOwnsPin as recordOwnsPin } from './sensorModels';
import type { LineSupport } from './line/LineHost';
import { generateUUID } from '../utils/uuid';

/**
 * Map any ESP32-family board kind to the 3 base QEMU machine types understood
 * by the backend esp_qemu_manager.
 */
export function toQemuBoardType(kind: BoardKind): 'esp32' | 'esp32-s3' | 'esp32-c3' | 'esp32-c6' {
  // Overlay-registered boards carry their base chip in the registry.
  const proFam = getProBoard(kind)?.esp32Family;
  // Chips with NO QEMU machine anywhere (backend esp_qemu_manager knows
  // esp32/s3/c3 only; c6 is at least mapped): reaching this bridge means the
  // JS engine was skipped for a chip that has no other path — fail loudly
  // instead of booting the wrong machine and wedging on the first register.
  if (proFam === 'esp32-p4' || proFam === 'esp32-c5') {
    throw new Error(
      `${kind}: the ${proFam} has no QEMU machine - it runs only on its in-browser engine`,
    );
  }
  if (proFam) return proFam;
  if (kind === 'esp32-s3' || kind === 'xiao-esp32-s3' || kind === 'arduino-nano-esp32')
    return 'esp32-s3';
  if (kind === 'esp32-c3' || kind === 'xiao-esp32-c3' || kind === 'aitewinrobot-esp32c3-supermini')
    return 'esp32-c3';
  return 'esp32'; // esp32, esp32-devkit-c-v4, esp32-cam, wemos-lolin32-lite
}

/**
 * Upsert sensor records by `pin` — the one merge every bridge uses.
 *
 * Same kind on the same pin merges per FIELD. Two registration paths describe
 * one sensor knowing different halves: the part resolves its extra pins through
 * the wire walk, the store's pre-registration knows the component's properties.
 * Replacing the object let the coarser path silently drop `echo_pin`, and the
 * QEMU worker then fell back to TRIG+1 and pulsed a pin nobody was reading
 * (the 1k/2k2 divider report). Whoever writes last still wins per field.
 *
 * A DIFFERENT kind on the same pin replaces outright: a DHT22 swapped for an
 * HC-SR04 must not inherit a stale `echo_pin` that ownsSensorPin would then
 * keep guarding against the host.
 */
export function upsertSensorRecords(
  existing: ReadonlyArray<Record<string, unknown>>,
  incoming: ReadonlyArray<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const merged = existing.slice();
  for (const s of incoming) {
    const idx = merged.findIndex((e) => e['pin'] === s['pin']);
    if (idx < 0) merged.push(s);
    else merged[idx] = merged[idx]['sensor_type'] === s['sensor_type'] ? { ...merged[idx], ...s } : s;
  }
  return merged;
}

// The sensors whose model owns its line are declared once, in sensorModels.
// Re-exported here because this bridge is the import site the overlay engines
// and the tests already use; the list itself lives with the wiring spec so it
// cannot drift from what the store pre-registers.
export {
  SINGLE_WIRE_SENSOR_TYPES,
  isSingleWireSensorRecord,
  sensorRecordOwnsPin,
} from './sensorModels';

const API_BASE = (): string => {
  // The desktop shell injects the sidecar URL at runtime (random port) via
  // window.__VELXIO_API_BASE__; honor it first so the QEMU-board WebSocket
  // reaches the local Python sidecar instead of the build-time / dev
  // default. Without this, ESP32 / Pi / STM32 simulations never start in
  // the desktop app (the WS dialed localhost:8001, not the sidecar port).
  if (typeof window !== 'undefined') {
    const injected = (window as { __VELXIO_API_BASE__?: string }).__VELXIO_API_BASE__;
    if (typeof injected === 'string' && injected) {
      return injected.replace(/\/+$/, '');
    }
  }
  return (import.meta.env.VITE_API_BASE as string | undefined) ?? 'http://localhost:8001/api';
};

/** Returns a stable UUID for this browser tab (persists across reloads, resets on new tab). */
export function getTabSessionId(): string {
  // sessionStorage is not available in Node/test environments
  if (typeof sessionStorage === 'undefined') return generateUUID();
  const KEY = 'velxio-tab-id';
  let id = sessionStorage.getItem(KEY);
  if (!id) {
    id = generateUUID();
    sessionStorage.setItem(KEY, id);
  }
  return id;
}

export interface Ws2812Pixel {
  r: number;
  g: number;
  b: number;
}
/** LEDC duty event — channel + duty only. The frontend resolves
 *  channel→signal_id→pin via its SignalRouter mirror. */
export interface LedcDuty {
  channel: number;
  duty_pct: number;
  /** Carrier frequency in Hz, when the engine knows it. The JS engines derive
   *  it from the LEDC timer registers; without it a speaker on a PWM pin can
   *  only ever play one fixed note, which is how the M5Stack Core's piano
   *  spent months stuck on 660 Hz. */
  freq_hz?: number;
}
/** GPIO Matrix routing event — `gpio_out_sel[gpio]` was set to
 *  `signal_id`.  Maintained by the backend SignalRouter; emitted on
 *  every observed change so the frontend mirror stays in lock-step. */
export interface GpioRouting {
  gpio: number;
  signal_id: number;
}
export interface WifiStatus {
  status: string;
  ssid?: string;
  ip?: string;
  /** True when the board's network stack lives in THIS browser tab (in-browser
   *  JS engine). The IoT gateway must then open in the in-app iframe: a new
   *  tab backgrounds this one, the emulation gets timer-throttled, and the
   *  in-chip HTTP server can't answer. Unset = server runs backend-side. */
  inBrowser?: boolean;
}
export interface BleStatus {
  status: string;
}

export class Esp32Bridge {
  readonly boardId: string;
  readonly boardKind: BoardKind;

  /** Set to true before connect() to enable WiFi NIC in QEMU. */
  wifiEnabled = false;

  /**
   * Base64 FAT16 image for an on-canvas microSD card, set before connect().
   * Undefined when no card is present. Forwarded to the worker, which attaches
   * it as a synchronous SD-over-SPI slave (esp32_sd_slave.SdSpiSlave).
   */
  sdImageB64: string | undefined = undefined;

  /** SD chip-select GPIO for a board with a BUILT-IN SD sharing the SPI bus —
   * the worker CS-gates the slave so it doesn't consume the display stream.
   * Undefined for a standalone microsd-card component (owns the bus). */
  sdCsPin: number | undefined = undefined;

  // Callbacks wired up by useSimulatorStore
  onSerialData: ((char: string, uart?: number) => void) | null = null;
  onPinChange: ((gpioPin: number, state: boolean) => void) | null = null;
  /**
   * Timestamped version of onPinChange — wired to the oscilloscope so the
   * scope can render ESP32 GPIO activity at the same resolution as AVR /
   * RP2040 boards.  Also receives the synthesized UART TX frame bits from
   * `emitUartTxFrame` so a scope on GPIO1 / GPIO43 / etc. shows real bit-
   * level UART waveforms during `Serial.print`, matching real silicon.
   *
   * QEMU virtual time isn't exposed cleanly across the WebSocket, so the
   * timestamps come from `performance.now()` (wall-clock).  At 1× sim
   * speed this matches the AVR / RP2040 simulator-time within ~1 ms which
   * is invisible on any practical sweep.
   */
  onPinChangeWithTime: ((gpioPin: number, state: boolean, timeMs: number) => void) | null = null;
  onPinDir: ((gpioPin: number, dir: 0 | 1) => void) | null = null;
  /** Internal pull config the guest programmed into IO_MUX (INPUT_PULLUP /
   *  INPUT_PULLDOWN). 0 = none, 1 = pull-up, 2 = pull-down. The frontend
   *  netlist adds the matching weak resistor so idle inputs read the right
   *  level (real ESP32 internal pulls aren't otherwise visible to SPICE). */
  onPinPull: ((gpioPin: number, pull: 0 | 1 | 2) => void) | null = null;
  /**
   * Override baud rate used to space synthesized UART bits.  QEMU
   * transmits bytes "instantly" so the backend doesn't surface a real
   * baud rate, but for the scope to show a realistic frame we need a
   * bit period.  Defaults to 115200 (Arduino default).  The store
   * updates this when the firmware's `Serial.begin(N)` is observable.
   */
  uartBaudRate: number = 115200;
  /** Wired by the store to `makeLedcDutyHandler` which routes
   *  channel→pin via the per-board SignalRouter mirror. */
  onLedcDuty: ((duty: LedcDuty) => void) | null = null;
  /** Fires whenever the backend observes a write to `gpio_out_sel[N]`.
   *  The store's handler updates the per-board SignalRouter mirror so
   *  subsequent `onLedcDuty` events can resolve channel→pin correctly. */
  onGpioRouting: ((routing: GpioRouting) => void) | null = null;
  /** Pin is no longer routed to any peripheral (firmware reset the
   *  matrix entry). */
  onGpioRoutingClear: ((gpio: number) => void) | null = null;
  /**
   * A decoded WS2812 frame from the engine's RMT peripheral.
   *
   * `pin` is the GPIO the frame went out on, and it is what a NeoPixel PART on
   * the canvas is keyed by — the channel alone cannot reach one. The in-browser
   * engines know the pin (the GPIO matrix routing they emit alongside is
   * derived from it); the QEMU worker sends the channel only, so it stays
   * optional and the pin-keyed delivery is skipped when it is absent.
   */
  onWs2812Update:
    | ((channel: number, pixels: Ws2812Pixel[], pin?: number | null) => void)
    | null = null;
  /**
   * ePaper SSD168x backend rendering. Backend decodes SPI traffic in
   * `Ssd168xEpaperSlave` and emits this event on every 0x20
   * MASTER_ACTIVATION with a base64-encoded palette buffer (1 byte/pixel:
   * 0=black, 1=white, 2=red). One subscriber per `componentId`; multiple
   * panels on the same board are routed by ID.
   */
  onEpaperUpdate:
    | ((
        componentId: string,
        frame: { width: number; height: number; b64: string; refreshMs: number },
      ) => void)
    | null = null;
  onI2cEvent: ((addr: number, data: number) => void) | null = null;
  onI2cTransaction: ((addr: number, data: number[]) => void) | null = null;
  /**
   * Fires when the backend's `ProxySlave` emits a completed write
   * transaction (one full master write phase, terminated by STOP or
   * repeated-START).  Used by Interconnect / Esp32BridgeShim to
   * replay the bytes onto the actual frontend peer device so its
   * state stays consistent with what the ESP32 firmware "wrote".
   */
  onProxyI2cComplete: ((addr: number, data: number[]) => void) | null = null;
  onSpiEvent: ((data: number) => void) | null = null;
  /** Same as onSpiEvent but more explicit (a single MOSI byte). */
  onSpiByte: ((mosi: number) => void) | null = null;
  /** Fires on every CS line change emitted by the SoC's SPI peripheral.
   * `csIdx` is the index of the CS pin within the SPI bus (0-3 typical),
   * `low` is true when CS goes LOW (slave selected), false when HIGH. */
  onSpiCsChange: ((csIdx: number, low: boolean) => void) | null = null;
  onConnected: (() => void) | null = null;
  onDisconnected: (() => void) | null = null;
  onError: ((msg: string) => void) | null = null;
  onSystemEvent: ((event: string, data: Record<string, unknown>) => void) | null = null;
  onCrash: ((data: Record<string, unknown>) => void) | null = null;
  onWifiStatus: ((status: WifiStatus) => void) | null = null;
  onBleStatus: ((status: BleStatus) => void) | null = null;

  private socket: WebSocket | null = null;
  private _connected = false;
  private _pendingFirmware: string | null = null;
  private _pendingSensors: Array<Record<string, unknown>> = [];

  // MicroPython: the queued project, and the session that boots the board to
  // its raw REPL, writes the project's files onto the board filesystem and
  // starts the program. See simulation/micropythonSession.ts.
  private _pendingMicroPythonProgram: MpyProgram | null = null;
  private _mpySession: MicroPythonSession | null = null;
  micropythonMode = false;

  constructor(boardId: string, boardKind: BoardKind) {
    this.boardId = boardId;
    this.boardKind = boardKind;
  }

  get connected(): boolean {
    return this._connected;
  }

  /**
   * Default UART0 TX GPIO for each ESP32 family variant.  The actual pin
   * is selectable via the GPIO Matrix at runtime, but exposing the live
   * matrix state across the WebSocket isn't worth it — these defaults
   * match what the IO_MUX picks up for the standard `Serial` port and
   * are what every Arduino-ESP32 sketch ends up using unless the user
   * explicitly remaps via `Serial.setPins()`.
   */
  private uart0TxPin(): number {
    switch (this.boardKind) {
      case 'esp32-s3':
      case 'xiao-esp32-s3':
      case 'arduino-nano-esp32':
        return 43;
      case 'esp32-c6':
        return 16; // U0TXD default on the C6 (silkscreen TX on the DevKitC-1)
      case 'esp32-c3':
      case 'xiao-esp32-c3':
      case 'aitewinrobot-esp32c3-supermini':
        return 21;
      default:
        // esp32, esp32-devkit-c-v4, esp32-cam, wemos-lolin32-lite, …
        return 1;
    }
  }

  /**
   * Bit-level UART frame synthesis on the TX GPIO.  QEMU's UART
   * peripheral transmits bytes "instantly" at the virtual-time layer
   * and never toggles the SoC pad — same gap closed in AVRSimulator
   * and RP2040Simulator.  We rebuild the standard 8N1 frame (start
   * LOW + 8 data LSB-first + stop HIGH) at `this.uartBaudRate`, stamp
   * each transition with wall-clock-spaced timestamps starting now,
   * and push them through `onPinChangeWithTime` so the oscilloscope
   * draws the waveform a real ESP32 would put on the pin.
   *
   * Only UART0 is synthesized today — UART1 / UART2 would need their
   * own per-board GPIO mapping which Velxio doesn't currently track.
   */
  private emitUartTxFrame(byte: number, uart: number = 0): void {
    if (uart !== 0) return; // UART0 only for now
    if (!this.onPinChangeWithTime) return;
    const baud = this.uartBaudRate || 115200;
    if (baud <= 0) return;

    const txPin = this.uart0TxPin();
    const bitMs = 1000 / baud;
    const startMs = performance.now();

    // Seed idle HIGH right before the start bit so the scope renders the
    // start-bit transition against a HIGH baseline, matching how the line
    // sits between bytes on real hardware.
    this.onPinChangeWithTime(txPin, true, Math.max(0, startMs - bitMs));

    // 8N1: start LOW, then 8 data bits LSB-first, then stop HIGH.
    const bits: boolean[] = [false];
    for (let i = 0; i < 8; i++) bits.push(((byte >> i) & 1) !== 0);
    bits.push(true);

    let prev = true;
    for (let i = 0; i < bits.length; i++) {
      if (bits[i] !== prev) {
        this.onPinChangeWithTime(txPin, bits[i], startMs + i * bitMs);
        prev = bits[i];
      }
    }
  }

  get clientId(): string {
    return getTabSessionId() + '::' + this.boardId;
  }

  connect(): void {
    // Force a clean reconnect. The old guard here was
    //   if (this.socket && readyState !== CLOSED) return;
    // which made connect() a SILENT NO-OP whenever a socket lingered in any
    // non-CLOSED state (CONNECTING / OPEN / CLOSING). That's exactly the
    // "el agente terminó, di Run y no funcionó; recargué y sí" bug: the
    // agent's run_simulation left a live/half-dead socket, the backend QEMU
    // session had ended, and the user's Run → startBoard → connect() returned
    // without doing anything. A page reload worked only because it built a
    // fresh bridge. Tearing the zombie socket down and opening a new one to
    // the same session key is exactly what that reload does — the backend
    // already handles a new WS replacing an existing session (that's why
    // reload works), so it's safe to do it without the reload.
    if (this.socket) {
      try {
        this.socket.onopen = null;
        this.socket.onmessage = null;
        this.socket.onclose = null;
        this.socket.onerror = null;
        this.socket.close();
      } catch {
        /* already closing/closed */
      }
      this.socket = null;
      this._connected = false;
    }

    const base = API_BASE();
    const wsProtocol = base.startsWith('https') ? 'wss:' : 'ws:';
    const sessionId = getTabSessionId();
    const wsUrl =
      base.replace(/^https?:/, wsProtocol) +
      `/simulation/ws/${encodeURIComponent(sessionId + '::' + this.boardId)}`;

    const socket = new WebSocket(wsUrl);
    this.socket = socket;

    socket.onopen = () => {
      this._connected = true;
      console.log(
        `[Esp32Bridge:${this.boardId}] WebSocket connected → sending start_esp32 (firmware: ${this._pendingFirmware ? `${Math.round((this._pendingFirmware.length * 0.75) / 1024)}KB` : 'none'})`,
      );
      this.onConnected?.();
      this._send({
        type: 'start_esp32',
        data: {
          board: toQemuBoardType(this.boardKind),
          ...(this._pendingFirmware ? { firmware_b64: this._pendingFirmware } : {}),
          sensors: this._pendingSensors,
          wifi_enabled: this.wifiEnabled,
          ...(this.sdImageB64
            ? {
                sd_card: {
                  image_b64: this.sdImageB64,
                  ...(this.sdCsPin !== undefined ? { cs_pin: this.sdCsPin } : {}),
                },
              }
            : {}),
        },
      });
    };

    socket.onmessage = (event: MessageEvent) => {
      let msg: { type: string; data: Record<string, unknown> };
      try {
        msg = JSON.parse(event.data as string);
      } catch {
        return;
      }

      switch (msg.type) {
        case 'serial_output': {
          const text = (msg.data.data as string) ?? '';
          const uart = msg.data.uart as number | undefined;
          // What the console shows can be narrower than what the wire carried:
          // a MicroPython upload filters its own protocol out (see below). The
          // waveform below still gets every byte — they really were on the pin.
          let shown = text;
          // Synthesize the per-byte UART waveform on the TX GPIO so the
          // oscilloscope shows a real frame, matching how a real ESP32
          // drives the pin.  Falls back to UART0 when no uart index is
          // provided (which is the case for all current backend events).
          if (this.onPinChangeWithTime) {
            for (let i = 0; i < text.length; i++) {
              this.emitUartTxFrame(text.charCodeAt(i) & 0xff, uart ?? 0);
            }
          }
          // MicroPython project upload — see simulation/micropythonSession.ts.
          // The session owns the boot handshake, writes the project's files to
          // the board filesystem in bounded steps, and starts the program. It
          // also decides what the serial console gets to see: its own hundreds
          // of protocol exchanges stay out, the banner and the program's output
          // go through.
          if (this._mpySession) {
            shown = this._mpySession.feed(text);
          }
          if (this.onSerialData) {
            for (const ch of shown) this.onSerialData(ch, uart);
          }
          break;
        }
        case 'gpio_change': {
          const pin = msg.data.pin as number;
          const state = (msg.data.state as number) === 1;
          // No per-transition logging here: gpio_change fires on every edge
          // (e.g. each SPI clock pulse on a display-heavy sketch), so logging
          // it floods the console and measurably throttles the main thread and
          // simulation throughput. Keep only the functional callbacks below.
          this.onPinChange?.(pin, state);
          // Also feed the scope path so ESP32 digital pin activity shows
          // up on the oscilloscope at parity with AVR / RP2040 boards.
          // Wall-clock timestamp is good enough at 1× sim speed; QEMU
          // virtual time isn't surfaced across the WebSocket today.
          this.onPinChangeWithTime?.(pin, state, performance.now());
          break;
        }
        case 'gpio_dir': {
          const pin = msg.data.pin as number;
          const dir = msg.data.dir as 0 | 1;
          this.onPinDir?.(pin, dir);
          break;
        }
        case 'gpio_pull': {
          const pin = msg.data.pin as number;
          const pull = msg.data.pull as 0 | 1 | 2;
          this.onPinPull?.(pin, pull);
          break;
        }
        case 'ledc_duty': {
          this.onLedcDuty?.(msg.data as unknown as LedcDuty);
          break;
        }
        case 'gpio_routing': {
          this.onGpioRouting?.(msg.data as unknown as GpioRouting);
          break;
        }
        case 'gpio_routing_clear': {
          this.onGpioRoutingClear?.(msg.data.gpio as number);
          break;
        }
        case 'ws2812_update': {
          const channel = msg.data.channel as number;
          // The QEMU worker sends objects ({r,g,b}, esp32_worker._RmtDecoder);
          // the header above documents triplets, and destructuring an object as
          // an array yields three undefineds — a whole strip of NaN. Accept
          // both rather than pick a side and break the other producer.
          const raw = msg.data.pixels as Array<
            [number, number, number] | { r: number; g: number; b: number }
          >;
          const pixels: Ws2812Pixel[] = raw.map((px) =>
            Array.isArray(px) ? { r: px[0], g: px[1], b: px[2] } : px,
          );
          const pin = msg.data.pin as number | undefined;
          this.onWs2812Update?.(channel, pixels, pin ?? null);
          break;
        }
        case 'epaper_update': {
          const componentId = msg.data.component_id as string;
          this.onEpaperUpdate?.(componentId, {
            width: msg.data.width as number,
            height: msg.data.height as number,
            b64: msg.data.frame_b64 as string,
            refreshMs: (msg.data.refresh_ms as number) ?? 50,
          });
          break;
        }
        case 'i2c_event': {
          const addr = msg.data.addr as number;
          const data = msg.data.data as number;
          this.onI2cEvent?.(addr, data);
          break;
        }
        case 'i2c_transaction': {
          const addr = msg.data.addr as number;
          const data = msg.data.data as number[];
          this.onI2cTransaction?.(addr, data);
          break;
        }
        case 'proxy_i2c_complete': {
          // Backend `ProxySlave` saw a full I2C write transaction from
          // the ESP32 firmware and is forwarding the bytes back so the
          // frontend can replay them on the actual peer device.  The
          // peer's `I2CDevice.writeByte` handles its own state machine
          // (pointer-byte first, then data) — we just hand off the
          // sequence in order.
          const addr = msg.data.addr as number;
          const data = msg.data.data as number[];
          this.onProxyI2cComplete?.(addr, data);
          break;
        }
        case 'spi_batch': {
          // Worker batches consecutive MOSI bytes from a single SPI
          // transaction into one base64-encoded message. Replays each
          // byte through the same callbacks the per-byte spi_event path
          // uses — parts that subscribed to onSpiByte don't notice. See
          // backend/app/services/esp32_worker.py::_on_spi_event for the
          // batching policy (flush on CS HIGH or buffer cap).
          const b64 = msg.data.b64 as string;
          if (b64) {
            const bin = atob(b64);
            const handler = this.onSpiByte ?? this.onSpiEvent;
            if (handler) {
              for (let i = 0; i < bin.length; i++) {
                const m = bin.charCodeAt(i);
                handler(m);
              }
            }
          }
          break;
        }
        case 'spi_event': {
          // Worker emits {bus, event, response}. The 'event' field encodes:
          //   event = mosi << 8        (op = event & 0xFF == 0x00) → byte transfer
          //   event = ((cs<<1)|level) << 8 | 0x01 (op == 0x01)     → CS line change
          // See backend/app/services/esp32_worker.py::_on_spi_event.
          //
          // After the batching change, the byte transfer path goes
          // through 'spi_batch' instead. This branch now only fires for
          // CS-line changes (op == 0x01), but we keep the byte branch
          // for backwards compatibility with older worker builds.
          const event = msg.data.event as number;
          const op    = (event ?? 0) & 0xFF;
          if (op === 0x00) {
            const mosi = (event >> 8) & 0xFF;
            this.onSpiEvent?.(mosi);
            this.onSpiByte?.(mosi);
          } else if (op === 0x01) {
            const csIdx = (event >> 9) & 0x3;
            const level = (event >> 8) & 0x1;
            this.onSpiCsChange?.(csIdx, level === 1);
          }
          // Backwards-compat path for callers reading the old `data` field.
          if (msg.data.data !== undefined) {
            this.onSpiEvent?.(msg.data.data as number);
          }
          break;
        }
        case 'system': {
          const evt = msg.data.event as string;
          console.log(`[Esp32Bridge:${this.boardId}] system event: ${evt}`, msg.data);
          if (evt === 'crash') {
            this.onCrash?.(msg.data);
          }
          this.onSystemEvent?.(evt, msg.data);
          break;
        }
        case 'wifi_status': {
          const wifiStatus = msg.data as unknown as WifiStatus;
          console.log(
            `[Esp32Bridge:${this.boardId}] wifi_status: ${wifiStatus.status} ssid=${wifiStatus.ssid ?? ''} ip=${wifiStatus.ip ?? ''}`,
          );
          this.onWifiStatus?.(wifiStatus);
          break;
        }
        case 'ble_status': {
          const bleStatus = msg.data as unknown as BleStatus;
          console.log(`[Esp32Bridge:${this.boardId}] ble_status: ${bleStatus.status}`);
          this.onBleStatus?.(bleStatus);
          break;
        }
        case 'error':
          console.error(`[Esp32Bridge:${this.boardId}] error: ${msg.data.message as string}`);
          this.onError?.(msg.data.message as string);
          break;
      }
    };

    socket.onclose = (ev) => {
      console.log(`[Esp32Bridge:${this.boardId}] WebSocket closed (code=${ev?.code ?? '?'})`);
      this._connected = false;
      this.socket = null;
      this.onDisconnected?.();
    };

    socket.onerror = (ev) => {
      console.error(`[Esp32Bridge:${this.boardId}] WebSocket error`, ev);
      this.onError?.('WebSocket error');
    };
  }

  disconnect(): void {
    if (this.socket) {
      this._send({ type: 'stop_esp32' });
      this.socket.close();
      this.socket = null;
    }
    this._connected = false;
  }

  /**
   * Pre-register sensors so they are included in the start_esp32 payload.
   * This ensures sensors are ready in the QEMU worker BEFORE the firmware
   * begins executing, preventing race conditions where pulseIn() times out
   * because the sensor handler hasn't been registered yet.
   *
   * MERGE semantics (upsert by `pin`): pre-existing entries with a different
   * pin are kept, entries with the same pin are replaced.  An earlier
   * implementation did `this._pendingSensors = sensors` (full replace) which
   * blew away anything PartSimulationRegistry handlers had already
   * registered via `sendSensorAttach` (e.g. the ePaper SPI slaves on
   * virtual pins) the moment `startBoard` later called `setSensors` with
   * only the wire-resolved sensors it knew about (DHT22, HC-SR04, …).
   * That dropped the ePaper slave registration on every Run click, and the
   * 5.65" UC8159c panel sat unresponsive while its firmware busy-waited.
   */
  setSensors(sensors: Array<Record<string, unknown>>): void {
    this._pendingSensors = upsertSensorRecords(this._pendingSensors, sensors);
  }

  /** Returns true if a firmware has been loaded and is ready to send. */
  hasFirmware(): boolean {
    return this._pendingFirmware !== null && this._pendingFirmware !== '';
  }

  /**
   * Load a compiled firmware (base64-encoded .bin) into the running ESP32.
   * If not yet connected, the firmware will be sent on next connect().
   */
  loadFirmware(firmwareBase64: string): void {
    this._pendingFirmware = firmwareBase64;
    if (this._connected) {
      this._send({ type: 'load_firmware', data: { firmware_b64: firmwareBase64 } });
    }
  }

  /** Send a byte to the ESP32 UART0 (or UART1/2) */
  sendSerialByte(byte: number, uart = 0): void {
    this._send({ type: 'esp32_serial_input', data: { bytes: [byte], uart } });
  }

  /** Send multiple bytes at once */
  sendSerialBytes(bytes: number[], uart = 0): void {
    if (bytes.length === 0) return;
    this._send({ type: 'esp32_serial_input', data: { bytes, uart } });
  }

  /**
   * True when a backend-emulated single-wire sensor OWNS this pad — its data
   * line, or an HC-SR04's ECHO. The QEMU worker drives those itself, and a
   * host-injected level outranks it, so whoever pushes one silences the sensor.
   *
   * The caller that makes this matter is connectDigitalInputsToMcu,
   * thresholding the solved SPICE node. Its `sourcedNets` gate is meant to
   * leave part-managed pins alone, but a net stops being "unsourced" the
   * moment a real component sits on it: an HC-SR04 whose ECHO reaches the pad
   * through the 1k/2k2 divider a real 5 V sensor needs solves at ~0 V (nothing
   * models the sensor's output) and pinned the echo pad LOW between trigger
   * and reply — pulseIn() then timed out forever while the worker was pulsing
   * the pin correctly. Same shape as the in-browser engines' ownsPin guard.
   */
  /**
   * The line-owning sensors the backend QEMU worker models itself, timed on
   * the guest's clock inside QEMU (esp32_worker.py `_dht22_*` / hc-sr04 sync
   * handlers). Mirror of that file, the way esp32-signals.ts mirrors
   * esp32_signals.py: a new worker-side model is one entry here. An overlay
   * bridge that runs the models in the browser overrides this with the
   * registry's own list.
   */
  static readonly WORKER_LINE_MODELS: readonly string[] = ['dht22', 'hc-sr04', 'ir-nec'];

  /** What this board can host under the line contract (simulation/line). */
  lineSupport(): LineSupport {
    return { mode: 'hosted', models: Esp32Bridge.WORKER_LINE_MODELS };
  }

  ownsSensorPin(gpioPin: number): boolean {
    // ONLY the single-wire sensors own a pad. The same channel registers plenty
    // of other things — an ePaper panel's DC/BUSY pins, a membrane keypad's
    // rows, every I2C device on a virtual 200+addr pin — and those still need
    // the host to drive their real GPIOs. Blocking those was the difference
    // between this guard and the in-browser engines' narrow
    // SingleWireSensorHub.ownsPin, which is the behaviour to match.
    return this._pendingSensors.some((s) => recordOwnsPin(s, gpioPin));
  }

  /** Drive a GPIO pin from an external source (e.g. connected Arduino) */
  sendPinEvent(gpioPin: number, state: boolean): void {
    if (this.ownsSensorPin(gpioPin)) return;
    this._send({ type: 'esp32_gpio_in', data: { pin: gpioPin, state: state ? 1 : 0 } });
  }

  /** Set an ADC channel voltage (millivolts, 0–3300) */
  setAdc(channel: number, millivolts: number): void {
    this._send({ type: 'esp32_adc_set', data: { channel, millivolts } });
  }

  /**
   * Push a periodic waveform LUT for an ADC channel. The backend forwards
   * the samples to QEMU, which interpolates them against its virtual clock
   * on every MMIO ADC read — matching the per-read fidelity AVR and RP2040
   * get via `onADCRead` monkey-patching.
   *
   *   samples: 12-bit raw values (0-4095) aligned on a uniform time grid
   *   periodNs: full period of the LUT in nanoseconds
   *
   * Samples are sent as base64-encoded uint16 little-endian. Clearing the
   * waveform (returning to DC `setAdc` behavior) is done by passing an
   * empty `samples` array.
   */
  setAdcWaveform(channel: number, samples: Uint16Array, periodNs: number): void {
    // Encode little-endian uint16 → base64 (transport-safe for JSON stdin/WS).
    const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    const base64 =
      typeof btoa === 'function' ? btoa(binary) : Buffer.from(bytes).toString('base64');
    this._send({
      type: 'esp32_adc_waveform',
      data: { channel, samples_u12_b64: base64, period_ns: periodNs },
    });
  }

  /** Clear a previously-pushed ADC waveform, reverting to DC `setAdc`. */
  clearAdcWaveform(channel: number): void {
    this._send({
      type: 'esp32_adc_waveform',
      data: { channel, samples_u12_b64: '', period_ns: 0 },
    });
  }

  /** Configure the byte an I2C device at addr returns */
  setI2cResponse(addr: number, response: number): void {
    this._send({ type: 'esp32_i2c_response', data: { addr, response } });
  }

  // ── Cross-board I2C proxy ─────────────────────────────────────────────────
  // The backend hosts a `ProxySlave` at each registered address that responds
  // with the register dump pushed by the frontend.  Used when an ESP32 is
  // wired to another board's I2C bus and that peer board owns a virtual
  // device — the ESP32 firmware needs to read it synchronously inside QEMU,
  // which a WebSocket round-trip per byte can't deliver.  The proxy snapshot
  // is good enough for chip-id reads, calibration constants, and any device
  // whose state changes slowly relative to the ESP32 firmware's poll cadence.

  /**
   * Install a proxy I2C slave at `addr` initialised with the given register
   * dump (up to 256 bytes).  Pushed lazily — buffered until WS opens.
   */
  registerProxyI2c(addr: number, registers: Uint8Array): void {
    const regs_b64 = btoa(String.fromCharCode(...registers));
    this._send({
      type: 'esp32_proxy_i2c_register',
      data: { addr: addr & 0x7f, regs_b64 },
    });
  }

  /** Refresh the register state of an existing proxy slave at `addr`. */
  updateProxyI2c(addr: number, registers: Uint8Array): void {
    const regs_b64 = btoa(String.fromCharCode(...registers));
    this._send({
      type: 'esp32_proxy_i2c_update',
      data: { addr: addr & 0x7f, regs_b64 },
    });
  }

  /** Remove the proxy slave at `addr` (called on bridge teardown). */
  unregisterProxyI2c(addr: number): void {
    this._send({
      type: 'esp32_proxy_i2c_unregister',
      data: { addr: addr & 0x7f },
    });
  }

  /** Configure the MISO byte returned during an SPI transaction */
  setSpiResponse(response: number): void {
    this._send({ type: 'esp32_spi_response', data: { response } });
  }

  // ── Generic sensor protocol offloading ────────────────────────────────────
  // Sensors call these to delegate their protocol to the backend QEMU.
  // The sensor type (e.g. 'dht22', 'hc-sr04') tells the backend which
  // protocol handler to use.  Sensor-specific properties (temperature,
  // humidity, distance …) are passed as a generic Record.

  /** Register a sensor on a GPIO pin — backend handles its protocol */
  sendSensorAttach(sensorType: string, pin: number, properties: Record<string, unknown>): void {
    // Buffer into _pendingSensors so it is included in start_esp32 if sent
    // before the WebSocket opens (the common case when attachEvents fires
    // before the user clicks Run).
    const entry = { sensor_type: sensorType, pin, ...properties };
    this._pendingSensors = upsertSensorRecords(this._pendingSensors, [entry]);
    // Also send immediately if already connected (re-attach on hot reload)
    if (this._connected) {
      this._send({ type: 'esp32_sensor_attach', data: entry });
    }
  }

  /** Update sensor properties (temperature, humidity, distance, etc.) */
  sendSensorUpdate(pin: number, properties: Record<string, unknown>): void {
    // Keep _pendingSensors in sync so reconnects get current values
    const idx = this._pendingSensors.findIndex((s) => s['pin'] === pin);
    if (idx >= 0) {
      this._pendingSensors[idx] = { ...this._pendingSensors[idx], ...properties };
    }
    this._send({ type: 'esp32_sensor_update', data: { pin, ...properties } });
  }

  /** Detach a sensor from a GPIO pin */
  sendSensorDetach(pin: number): void {
    this._pendingSensors = this._pendingSensors.filter((s) => s['pin'] !== pin);
    this._send({ type: 'esp32_sensor_detach', data: { pin } });
  }

  // ── ESP32-CAM webcam injection ────────────────────────────────────────────
  /** Tell the backend a frame source is connected (call once when the user
   *  grants webcam permission). */
  sendCameraAttach(): void {
    this._send({ type: 'esp32_camera_attach', data: { board: 'esp32-cam' } });
  }

  /** Push one JPEG frame from the browser webcam to the emulator. The
   *  backend forwards it via ctypes to the QEMU OV2640+I²S device, which
   *  delivers the bytes to the firmware's DMA buffer.
   *
   *  Encoding: base64 in JSON. ~10–14 KB per QVGA frame at quality 0.6.
   *  At 10 fps that's ~120 KB/s — trivial over local WS. */
  sendCameraFrame(jpegBytes: ArrayBuffer | Uint8Array,
                  width = 320, height = 240): void {
    const u8 = jpegBytes instanceof Uint8Array
      ? jpegBytes
      : new Uint8Array(jpegBytes);
    // btoa needs a binary string; build one in 32 KB chunks to avoid
    // "argument size limit" issues with very large frames.
    let binary = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < u8.length; i += chunkSize) {
      binary += String.fromCharCode(...u8.subarray(i, i + chunkSize));
    }
    const b64 = btoa(binary);
    this._send({
      type: 'esp32_camera_frame',
      data: { fmt: 'jpeg', w: width, h: height, b64 },
    });
  }

  /** Drop the queued frame. Call when the user stops the webcam. */
  sendCameraDetach(): void {
    this._send({ type: 'esp32_camera_detach', data: {} });
  }

  /**
   * Queue the user's MicroPython project for the board.
   *
   * `files` are the project's other .py modules; they are written onto the
   * board filesystem before `main` runs, which is how a MicroPython library
   * works on real hardware — and, since #219, one bounded step at a time
   * rather than one 36 KB string literal. See simulation/micropythonSession.ts.
   */
  setPendingMicroPythonProgram(program: MpyProgram): void {
    this._pendingMicroPythonProgram = program;
    this.micropythonMode = true;
    this.armMicroPythonSession();
  }

  /** Back-compat entry point: a program with no extra files. */
  setPendingMicroPythonCode(code: string): void {
    this.setPendingMicroPythonProgram({ files: [], main: code });
  }

  /**
   * (Re)arm the upload for a fresh boot: the session tracks one boot handshake,
   * and queueing a program is what precedes every run.
   */
  private armMicroPythonSession(): void {
    this._mpySession?.dispose();
    this._mpySession = this._pendingMicroPythonProgram
      ? new MicroPythonSession(
          (bytes) => this.sendSerialBytes(bytes),
          this._pendingMicroPythonProgram,
          {
            tag: `Esp32Bridge:${this.boardId}`,
            // QEMU's own timings, not the in-browser engines'. Over here the
            // chardev holds the prompt until something else writes, so the
            // poke has to wait longer for the prompt to arrive on its own —
            // 800/200 is what this backend has been shipping.
            pokeDelayMs: 800,
            stageDelayMs: 200,
            onNotice: (line) => {
              for (const ch of line) this.onSerialData?.(ch, 0);
            },
          },
        )
      : null;
  }

  /** Check if this bridge is in MicroPython mode */
  isMicroPythonMode(): boolean {
    return this.micropythonMode;
  }

  /**
   * Push a key press/release for a board's built-in matrix keyboard. `row`/
   * `col` are the logical grid position dispatched by the board Web Component;
   * the worker's keyboard slave encodes it and pulses its interrupt line.
   * No-op for boards without a keyboard peripheral configured.
   */
  sendKey(row: number, col: number, pressed: boolean): void {
    this._send({ type: 'esp32_keyboard_key', data: { row, col, pressed } });
  }

  private _send(payload: unknown): void {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(payload));
    }
  }
}
