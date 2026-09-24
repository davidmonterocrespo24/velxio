/**
 * Stm32Bridge
 *
 * WebSocket client from the frontend to the backend stm32_lib_manager for one
 * STM32 board instance. Trimmed mirror of Esp32Bridge: GPIO + serial only (no
 * WiFi, MicroPython, sensors, SPI/I2C, camera yet).
 *
 * Protocol (JSON frames):
 *   Frontend -> Backend
 *     { type: 'start_stm32',         data: { board: BoardKind, firmware_b64?: string } }
 *     { type: 'stop_stm32' }
 *     { type: 'stm32_load_firmware', data: { firmware_b64: string } }
 *     { type: 'stm32_gpio_in',       data: { pin: number, state: 0|1 } }   // linear pin
 *
 *   Backend -> Frontend
 *     { type: 'serial_output', data: { data: string, uart?: number } }
 *     { type: 'gpio_change',   data: { pin: number, state: 0|1 } }   // linear pin (port*16+pin)
 *     { type: 'gpio_dir',      data: { pin: number, dir: 0|1 } }
 *     { type: 'gpio_pull',     data: { pin: number, pull: 0|1|2 } } // 0=none 1=up 2=down
 *     { type: 'system',        data: { event: string, ... } }
 *     { type: 'error',         data: { message: string } }
 *
 * Pin numbering matches the backend (hw/arm/stm32_picsimlab.c): a linear
 * 0-based index, global = port_index*16 + pin. Use stm32PinNameToLinear()
 * to convert a silkscreen name ('PC13') to that number and back.
 */

import type { BoardKind } from '../types/board';
import { generateUUID } from '../utils/uuid';
import type { LineSupport } from './line/LineHost';
import { recordPartGap } from './line/requestLine';
import { sensorRecordOwnsPin as recordOwnsPin } from './sensorModels';

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

export function getTabSessionId(): string {
  if (typeof sessionStorage === 'undefined') return generateUUID();
  const KEY = 'velxio-tab-id';
  let id = sessionStorage.getItem(KEY);
  if (!id) {
    id = generateUUID();
    sessionStorage.setItem(KEY, id);
  }
  return id;
}

const PORT_INDEX: Record<string, number> = { A: 0, B: 1, C: 2, D: 3, E: 4, F: 5, G: 6 };
const PORT_LETTER = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];

/** 'PC13' -> 2*16+13 = 45. Returns -1 for non-GPIO names (power/reset). */
export function stm32PinNameToLinear(name: string): number {
  const m = /^P([A-G])(\d{1,2})$/.exec(name.trim().toUpperCase());
  if (!m) return -1;
  const port = PORT_INDEX[m[1]];
  const pin = parseInt(m[2], 10);
  if (port === undefined || pin < 0 || pin > 15) return -1;
  return port * 16 + pin;
}

/** 45 -> 'PC13'. */
export function stm32LinearToPinName(linear: number): string {
  const port = Math.floor(linear / 16);
  const pin = linear % 16;
  return `P${PORT_LETTER[port] ?? '?'}${pin}`;
}

export class Stm32Bridge {
  readonly boardId: string;
  readonly boardKind: BoardKind;

  onSerialData: ((char: string, uart?: number) => void) | null = null;
  /** gpioPin is the linear pin (port*16+pin). */
  onPinChange: ((gpioPin: number, state: boolean) => void) | null = null;
  onPinChangeWithTime: ((gpioPin: number, state: boolean, timeMs: number) => void) | null = null;
  onPinDir: ((gpioPin: number, dir: 0 | 1) => void) | null = null;
  /** Internal pull the guest programmed for an INPUT pin (from PUPDR / CRL+ODR):
   *  0 = none, 1 = pull-up, 2 = pull-down. gpioPin is the linear pin. The store
   *  records it so the netlist stamps the weak resistor (mirrors ESP32). */
  onPinPull: ((gpioPin: number, pull: 0 | 1 | 2) => void) | null = null;
  onConnected: (() => void) | null = null;
  onDisconnected: (() => void) | null = null;
  /** Backend refused or lost the session. `code` is the server's
   *  machine-readable reason when it sent one (a gate, a full box). */
  onError: ((msg: string, code?: string) => void) | null = null;
  onSystemEvent: ((event: string, data: Record<string, unknown>) => void) | null = null;
  onCrash: ((data: Record<string, unknown>) => void) | null = null;

  /** I2C/SPI device write trace + display callbacks (wired by the store). */
  onI2cTrace: ((addr: number, op: string, result: number) => void) | null = null;
  /** Full I2C write transaction (addr + bytes) for write-only devices (SSD1306). */
  onI2cTransaction: ((addr: number, data: number[]) => void) | null = null;
  onSpiBatch: ((bytes: Uint8Array) => void) | null = null;
  onEpaperUpdate:
    | ((componentId: string, frame: { width: number; height: number; b64: string; refreshMs: number }) => void)
    | null = null;

  private socket: WebSocket | null = null;
  private _connected = false;
  private _pendingFirmware: string | null = null;
  private _pendingSensors: Array<Record<string, unknown>> = [];

  constructor(boardId: string, boardKind: BoardKind) {
    this.boardId = boardId;
    this.boardKind = boardKind;
  }

  get connected(): boolean {
    return this._connected;
  }

  get clientId(): string {
    return getTabSessionId() + '::' + this.boardId;
  }

  connect(): void {
    if (this.socket && this.socket.readyState !== WebSocket.CLOSED) return;

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
      this.onConnected?.();
      this._send({
        type: 'start_stm32',
        data: {
          board: this.boardKind,
          sensors: this._pendingSensors,
          // Who is on the SPI bus, with the firmware rather than after it:
          // the guest can clock its first byte before a later command would
          // arrive (project board-buses-2026-09, F4).
          bus_map: { spi: this._busMap },
          ...(this._pendingFirmware ? { firmware_b64: this._pendingFirmware } : {}),
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
          if (this.onSerialData) for (const ch of text) this.onSerialData(ch, uart);
          break;
        }
        case 'gpio_change': {
          const pin = msg.data.pin as number;
          const state = (msg.data.state as number) === 1;
          this.onPinChange?.(pin, state);
          this.onPinChangeWithTime?.(pin, state, performance.now());
          break;
        }
        case 'gpio_dir': {
          this.onPinDir?.(msg.data.pin as number, msg.data.dir as 0 | 1);
          break;
        }
        case 'gpio_pull': {
          this.onPinPull?.(msg.data.pin as number, msg.data.pull as 0 | 1 | 2);
          break;
        }
        case 'system': {
          const evt = msg.data.event as string;
          if (evt === 'crash') this.onCrash?.(msg.data);
          // The worker took a line sensor it has no model for. It is the only
          // side that knows, which is why the declaration below carries no
          // list; the gap reaches the user through the circuit check.
          //
          // Handled here rather than through onSystemEvent because nothing
          // assigns that callback on an STM32 board — the store wires
          // onSerialData / onError / onPinChange / onPinPull / onDisconnected
          // and no more — so a listener-based hook would drop every refusal.
          if (evt === 'sensor_refused') {
            recordPartGap({
              sensorType: String(msg.data.sensor_type ?? ''),
              pin: Number(msg.data.pin ?? -1),
              why: String(msg.data.why ?? 'this board does not model it'),
              componentId: msg.data.component_id ? String(msg.data.component_id) : undefined,
            });
          }
          this.onSystemEvent?.(evt, msg.data);
          break;
        }
        case 'i2c_transaction': {
          // Full STOP-bounded write phase from a write-only device (SSD1306,
          // PCF8574). The backend I2CWriteSink accumulates the bytes and emits
          // them here so the frontend virtual device can replay + render.
          const addr = msg.data.addr as number;
          const data = (msg.data.data as number[]) ?? [];
          this.onI2cTransaction?.(addr, data);
          break;
        }
        case 'i2c_trace': {
          // Diagnostic: one line per I2C op a real slave (BMP280, MPU6050…)
          // serviced. The read result already flowed into the guest via the
          // QEMU bus; this is for inspectors / debugging only.
          this.onI2cTrace?.(
            msg.data.addr as number,
            (msg.data.op as string) ?? '',
            (msg.data.result as number) ?? 0,
          );
          break;
        }
        case 'spi_batch': {
          // Worker batches consecutive MOSI bytes from one SPI transaction
          // into a base64 blob (see stm32_worker._flush_spi_batch_locked).
          const b64 = msg.data.b64 as string;
          if (b64 && this.onSpiBatch) {
            const bin = atob(b64);
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            this.onSpiBatch(bytes);
          }
          break;
        }
        case 'epaper_update': {
          // The STM32 worker nests the frame under data.data (it emits
          // {type:'epaper_update', data:{...}} and the manager re-wraps once).
          const f = (msg.data.data as Record<string, unknown>) ?? msg.data;
          this.onEpaperUpdate?.(f.component_id as string, {
            width: f.width as number,
            height: f.height as number,
            b64: f.frame_b64 as string,
            refreshMs: (f.refresh_ms as number) ?? 50,
          });
          break;
        }
        case 'error':
          this.onError?.(msg.data.message as string, msg.data.code as string | undefined);
          break;
      }
    };

    socket.onclose = () => {
      this._connected = false;
      this.socket = null;
      this.onDisconnected?.();
    };
    socket.onerror = () => this.onError?.('WebSocket error');
  }

  disconnect(): void {
    if (this.socket) {
      this._send({ type: 'stop_stm32' });
      this.socket.close();
      this.socket = null;
    }
    this._connected = false;
  }

  hasFirmware(): boolean {
    return this._pendingFirmware !== null && this._pendingFirmware !== '';
  }

  /** Load a compiled firmware (base64 .elf/.bin). Sent on connect, or now if live. */
  loadFirmware(firmwareBase64: string): void {
    this._pendingFirmware = firmwareBase64;
    if (this._connected) {
      this._send({ type: 'stm32_load_firmware', data: { firmware_b64: firmwareBase64 } });
    }
  }

  /**
   * What this board can host under the line contract (simulation/line).
   *
   * No list. The models run in the QEMU worker, on the guest's own clock, and
   * the worker is the only thing that knows which ones it has, so it takes
   * every line sensor and sends back a `sensor_refused` for the ones it
   * cannot model (handled in the 'system' case above). Today that is one
   * model, the membrane keypad; a second one is a worker-side change with
   * nothing to edit here.
   */
  lineSupport(): LineSupport {
    return { mode: 'hosted' };
  }

  /**
   * Pads the worker's own model drives, so the SPICE-threshold connector
   * leaves them alone.
   *
   * Narrower than the ESP32 bridge's, which asks about every registered
   * record: that worker drives an ePaper panel's BUSY line, and this one does
   * not — its ePaper branch reads DC, CS and RST only. Claiming BUSY here
   * would take it off the solved circuit and leave it driven by nobody.
   */
  ownsSensorPin(gpioPin: number): boolean {
    return this._pendingSensors.some(
      (s) => String(s['sensor_type'] ?? '') === 'matrix-keypad' && recordOwnsPin(s, gpioPin),
    );
  }

  /** Drive a GPIO input pin from an external source. `gpioPin` is linear. */
  sendPinEvent(gpioPin: number, state: boolean): void {
    if (this.ownsSensorPin(gpioPin)) return;
    this._send({ type: 'stm32_gpio_in', data: { pin: gpioPin, state: state ? 1 : 0 } });
  }

  /** Feed bytes into an STM32 USART RX (cross-board UART from a peer board).
   *  NOTE: the backend worker does not yet inject UART RX into the guest
   *  (qemu_picsimlab_uart_receive is unimplemented for arm), so this is a
   *  no-op end-to-end today; the message shape matches the other bridges so
   *  the Interconnect serial path binds cleanly. STM32-as-sender works fully. */
  sendSerialBytes(bytes: number[], uart = 0): void {
    if (bytes.length === 0) return;
    this._send({ type: 'stm32_serial_input', data: { bytes, uart } });
  }

  // ── Generic I2C/SPI device protocol offloading ─────────────────────────────
  // Mirrors Esp32Bridge: device models (BMP280, MPU6050, SSD1306, …) run inside
  // the backend QEMU worker. The frontend registers them by I2C address so the
  // worker builds the matching slave on the bus before firmware runs.

  /**
   * Pre-register devices so they are included in the start_stm32 payload.
   * Sent on connect (the common case: attachEvents fires before Run). Upsert
   * by `pin` so a later setSensors() from startBoard doesn't drop entries an
   * earlier sendSensorAttach() (e.g. an ePaper SPI slave) already buffered.
   */
  setSensors(sensors: Array<Record<string, unknown>>): void {
    const merged = this._pendingSensors.slice();
    for (const s of sensors) {
      const pin = s['pin'];
      const idx = merged.findIndex((e) => e['pin'] === pin);
      if (idx >= 0) merged[idx] = s;
      else merged.push(s);
    }
    this._pendingSensors = merged;
  }

  /** Register one I2C/SPI device. Buffered for start, or sent live if connected. */
  sendSensorAttach(sensorType: string, pin: number, properties: Record<string, unknown>): void {
    const entry = { sensor_type: sensorType, pin, ...properties };
    const existing = this._pendingSensors.findIndex((s) => s['pin'] === pin);
    if (existing >= 0) this._pendingSensors[existing] = entry;
    else this._pendingSensors.push(entry);
    if (this._connected) {
      this._send({ type: 'stm32_sensor_attach', data: entry });
    }
  }

  /** Update a live device's values (temperature, pressure, accel…). */
  sendSensorUpdate(pin: number, properties: Record<string, unknown>): void {
    const idx = this._pendingSensors.findIndex((s) => s['pin'] === pin);
    if (idx >= 0) this._pendingSensors[idx] = { ...this._pendingSensors[idx], ...properties };
    this._send({ type: 'stm32_sensor_update', data: { pin, ...properties } });
  }

  /** Detach a device. */
  sendSensorDetach(pin: number): void {
    this._pendingSensors = this._pendingSensors.filter((s) => s['pin'] !== pin);
    this._send({ type: 'stm32_sensor_detach', data: { pin } });
  }

  /**
   * Who is on this board's SPI bus and how each one is selected (project
   * board-buses-2026-09, F4). The whole map travels every time, so a device
   * the user deleted is gone by being absent; the last one is replayed at the
   * next start, because the worker begins with an empty bus.
   */
  sendBusMap(spi: unknown[]): void {
    this._busMap = spi;
    if (this._connected) this._send({ type: 'stm32_bus_map', data: { spi } });
  }

  private _busMap: unknown[] = [];

  /**
   * One hosted responder's live inputs (project board-buses-2026-09, F4): the
   * worker applies them to the model it built from the map, through the same
   * `update_attrs` a custom chip's sliders reach. The stored map takes them
   * too, so the next start replays what the user sees now and not what the
   * part showed when the map was built.
   */
  sendBusAttrs(owner: string, attrs: Record<string, number>): void {
    for (const e of this._busMap as Array<{ owner?: string; model?: { attrs?: object } }>) {
      if (e?.owner === owner && e.model) e.model.attrs = { ...(e.model.attrs ?? {}), ...attrs };
    }
    if (this._connected) this._send({ type: 'stm32_bus_attrs', data: { owner, attrs } });
  }

  private _send(payload: unknown): void {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(payload));
    }
  }
}
