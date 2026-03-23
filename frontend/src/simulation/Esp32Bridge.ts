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
 *     { type: 'ledc_update',   data: { channel: number, duty: number, duty_pct: number } }
 *     { type: 'ws2812_update', data: { channel: number, pixels: [number, number, number][] } }
 *     { type: 'i2c_event',     data: { addr: number, data: number } }
 *     { type: 'spi_event',     data: { data: number } }
 *     { type: 'system',        data: { event: string, ... } }
 *     { type: 'error',         data: { message: string } }
 */

import type { BoardKind } from '../types/board';

/**
 * Map any ESP32-family board kind to the 3 base QEMU machine types understood
 * by the backend esp_qemu_manager.
 */
function toQemuBoardType(kind: BoardKind): 'esp32' | 'esp32-s3' | 'esp32-c3' {
  if (kind === 'esp32-s3' || kind === 'xiao-esp32-s3' || kind === 'arduino-nano-esp32') return 'esp32-s3';
  if (kind === 'esp32-c3' || kind === 'xiao-esp32-c3' || kind === 'aitewinrobot-esp32c3-supermini') return 'esp32-c3';
  return 'esp32'; // esp32, esp32-devkit-c-v4, esp32-cam, wemos-lolin32-lite
}

const API_BASE = (): string =>
  (import.meta.env.VITE_API_BASE as string | undefined) ?? 'http://localhost:8001/api';

/** Returns a stable UUID for this browser tab (persists across reloads, resets on new tab). */
function getTabSessionId(): string {
  const KEY = 'velxio-tab-id';
  let id = sessionStorage.getItem(KEY);
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem(KEY, id);
  }
  return id;
}

export interface Ws2812Pixel { r: number; g: number; b: number }
export interface LedcUpdate  { channel: number; duty: number; duty_pct: number; gpio?: number }

export class Esp32Bridge {
  readonly boardId: string;
  readonly boardKind: BoardKind;

  // Callbacks wired up by useSimulatorStore
  onSerialData:    ((char: string, uart?: number) => void) | null = null;
  onPinChange:     ((gpioPin: number, state: boolean) => void) | null = null;
  onPinDir:        ((gpioPin: number, dir: 0 | 1) => void) | null = null;
  onLedcUpdate:    ((update: LedcUpdate) => void) | null = null;
  onWs2812Update:  ((channel: number, pixels: Ws2812Pixel[]) => void) | null = null;
  onI2cEvent:      ((addr: number, data: number) => void) | null = null;
  onSpiEvent:      ((data: number) => void) | null = null;
  onConnected:     (() => void) | null = null;
  onDisconnected:  (() => void) | null = null;
  onError:         ((msg: string) => void) | null = null;
  onSystemEvent:   ((event: string, data: Record<string, unknown>) => void) | null = null;
  onCrash:         ((data: Record<string, unknown>) => void) | null = null;

  private socket: WebSocket | null = null;
  private _connected = false;
  private _pendingFirmware: string | null = null;
  private _pendingSensors: Array<Record<string, unknown>> = [];

  constructor(boardId: string, boardKind: BoardKind) {
    this.boardId   = boardId;
    this.boardKind = boardKind;
  }

  get connected(): boolean {
    return this._connected;
  }

  connect(): void {
    if (this.socket && this.socket.readyState !== WebSocket.CLOSED) return;

    const base = API_BASE();
    const wsProtocol = base.startsWith('https') ? 'wss:' : 'ws:';
    const sessionId = getTabSessionId();
    const wsUrl = base.replace(/^https?:/, wsProtocol)
      + `/simulation/ws/${encodeURIComponent(sessionId + '::' + this.boardId)}`;

    const socket = new WebSocket(wsUrl);
    this.socket = socket;

    socket.onopen = () => {
      this._connected = true;
      console.log(`[Esp32Bridge:${this.boardId}] WebSocket connected → sending start_esp32 (firmware: ${this._pendingFirmware ? `${Math.round(this._pendingFirmware.length * 0.75 / 1024)}KB` : 'none'})`);
      this.onConnected?.();
      this._send({
        type: 'start_esp32',
        data: {
          board: toQemuBoardType(this.boardKind),
          ...(this._pendingFirmware ? { firmware_b64: this._pendingFirmware } : {}),
          sensors: this._pendingSensors,
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
          if (this.onSerialData) {
            for (const ch of text) this.onSerialData(ch, uart);
          }
          break;
        }
        case 'gpio_change': {
          const pin   = msg.data.pin as number;
          const state = (msg.data.state as number) === 1;
          console.log(`[Esp32Bridge:${this.boardId}] gpio_change pin=${pin} state=${state ? 'HIGH' : 'LOW'}`);
          this.onPinChange?.(pin, state);
          break;
        }
        case 'gpio_dir': {
          const pin = msg.data.pin as number;
          const dir = msg.data.dir as 0 | 1;
          this.onPinDir?.(pin, dir);
          break;
        }
        case 'ledc_update': {
          this.onLedcUpdate?.(msg.data as unknown as LedcUpdate);
          break;
        }
        case 'ws2812_update': {
          const channel = msg.data.channel as number;
          const raw = msg.data.pixels as [number, number, number][];
          const pixels: Ws2812Pixel[] = raw.map(([r, g, b]) => ({ r, g, b }));
          this.onWs2812Update?.(channel, pixels);
          break;
        }
        case 'i2c_event': {
          const addr = msg.data.addr as number;
          const data = msg.data.data as number;
          this.onI2cEvent?.(addr, data);
          break;
        }
        case 'spi_event': {
          const data = msg.data.data as number;
          this.onSpiEvent?.(data);
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
        case 'error':
          console.error(`[Esp32Bridge:${this.boardId}] error: ${msg.data.message as string}`);
          this.onError?.(msg.data.message as string);
          break;
      }
    };

    socket.onclose = (ev) => {
      console.log(`[Esp32Bridge:${this.boardId}] WebSocket closed (code=${ev.code})`);
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
   */
  setSensors(sensors: Array<Record<string, unknown>>): void {
    this._pendingSensors = sensors;
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

  /** Drive a GPIO pin from an external source (e.g. connected Arduino) */
  sendPinEvent(gpioPin: number, state: boolean): void {
    this._send({ type: 'esp32_gpio_in', data: { pin: gpioPin, state: state ? 1 : 0 } });
  }

  /** Set an ADC channel voltage (millivolts, 0–3300) */
  setAdc(channel: number, millivolts: number): void {
    this._send({ type: 'esp32_adc_set', data: { channel, millivolts } });
  }

  /** Configure the byte an I2C device at addr returns */
  setI2cResponse(addr: number, response: number): void {
    this._send({ type: 'esp32_i2c_response', data: { addr, response } });
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
    this._send({ type: 'esp32_sensor_attach', data: { sensor_type: sensorType, pin, ...properties } });
  }

  /** Update sensor properties (temperature, humidity, distance, etc.) */
  sendSensorUpdate(pin: number, properties: Record<string, unknown>): void {
    this._send({ type: 'esp32_sensor_update', data: { pin, ...properties } });
  }

  /** Detach a sensor from a GPIO pin */
  sendSensorDetach(pin: number): void {
    this._send({ type: 'esp32_sensor_detach', data: { pin } });
  }

  private _send(payload: unknown): void {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(payload));
    }
  }
}
