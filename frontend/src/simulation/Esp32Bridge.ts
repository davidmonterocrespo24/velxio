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
 *     { type: 'i2c_event',        data: { addr: number, data: number } }
 *     { type: 'i2c_transaction',  data: { addr: number, data: number[] } }
 *     { type: 'spi_event',        data: { data: number } }
 *     { type: 'system',        data: { event: string, ... } }
 *     { type: 'error',         data: { message: string } }
 */

import type { BoardKind } from '../types/board';

/**
 * Map any ESP32-family board kind to the 3 base QEMU machine types understood
 * by the backend esp_qemu_manager.
 */
export function toQemuBoardType(kind: BoardKind): 'esp32' | 'esp32-s3' | 'esp32-c3' {
  if (kind === 'esp32-s3' || kind === 'xiao-esp32-s3' || kind === 'arduino-nano-esp32')
    return 'esp32-s3';
  if (kind === 'esp32-c3' || kind === 'xiao-esp32-c3' || kind === 'aitewinrobot-esp32c3-supermini')
    return 'esp32-c3';
  return 'esp32'; // esp32, esp32-devkit-c-v4, esp32-cam, wemos-lolin32-lite
}

const API_BASE = (): string =>
  (import.meta.env.VITE_API_BASE as string | undefined) ?? 'http://localhost:8001/api';

/** Returns a stable UUID for this browser tab (persists across reloads, resets on new tab). */
export function getTabSessionId(): string {
  // sessionStorage is not available in Node/test environments
  if (typeof sessionStorage === 'undefined') return crypto.randomUUID();
  const KEY = 'velxio-tab-id';
  let id = sessionStorage.getItem(KEY);
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem(KEY, id);
  }
  return id;
}

export interface Ws2812Pixel {
  r: number;
  g: number;
  b: number;
}
export interface LedcUpdate {
  channel: number;
  duty: number;
  duty_pct: number;
  gpio?: number;
}
export interface WifiStatus {
  status: string;
  ssid?: string;
  ip?: string;
}
export interface BleStatus {
  status: string;
}

export class Esp32Bridge {
  readonly boardId: string;
  readonly boardKind: BoardKind;

  /** Set to true before connect() to enable WiFi NIC in QEMU. */
  wifiEnabled = false;

  // Callbacks wired up by useSimulatorStore
  onSerialData: ((char: string, uart?: number) => void) | null = null;
  onPinChange: ((gpioPin: number, state: boolean) => void) | null = null;
  onPinDir: ((gpioPin: number, dir: 0 | 1) => void) | null = null;
  onLedcUpdate: ((update: LedcUpdate) => void) | null = null;
  onWs2812Update: ((channel: number, pixels: Ws2812Pixel[]) => void) | null = null;
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

  // MicroPython REPL injection — 4-stage state machine
  //   idle → banner_seen → prompt_seen → raw_repl_entered → done
  // Each stage waits for a specific string in the serial buffer before
  // proceeding.  This avoids the race where code is sent before raw REPL
  // mode is confirmed and ends up echoed by the normal REPL.
  private _pendingMicroPythonCode: string | null = null;
  private _serialBuffer = '';
  private _replState: 'idle' | 'banner_seen' | 'prompt_seen' | 'raw_repl_entered' = 'idle';
  micropythonMode = false;

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
          // MicroPython REPL injection — 4-stage state machine.
          // Each stage waits for a confirmed string in the serial buffer before
          // advancing, so we never send code before raw REPL mode is verified.
          if (this._pendingMicroPythonCode || this._replState !== 'idle') {
            this._serialBuffer += text;

            // Stage 1: banner "Type help()" → poke UART with \r to flush ">>> "
            // The >>> prompt has no \n so the backend UART buffer holds it until
            // we send a byte that causes another write.
            if (this._replState === 'idle' && this._serialBuffer.includes('Type "help()"')) {
              this._replState = 'banner_seen';
              console.log('[Esp32Bridge] Stage 1: banner seen → poking UART with \\r');
              setTimeout(() => {
                this._send({ type: 'esp32_serial_input', data: { bytes: [0x0d] } });
              }, 800);
            }

            // Stage 2: ">>>" → send Ctrl+A to enter raw REPL
            if (this._replState === 'banner_seen' && this._serialBuffer.includes('>>>')) {
              this._replState = 'prompt_seen';
              this._serialBuffer = '';
              console.log('[Esp32Bridge] Stage 2: >>> seen → sending Ctrl+A');
              setTimeout(() => {
                this._send({ type: 'esp32_serial_input', data: { bytes: [0x01] } });
              }, 200);
            }

            // Stage 3: "raw REPL" confirmation → now safe to send code
            if (this._replState === 'prompt_seen' && this._serialBuffer.includes('raw REPL')) {
              this._replState = 'raw_repl_entered';
              const code = this._pendingMicroPythonCode!;
              this._pendingMicroPythonCode = null;
              this._serialBuffer = '';
              console.log('[Esp32Bridge] Stage 3: raw REPL confirmed → sending code');
              setTimeout(() => this._sendCodeInRawRepl(code), 200);
            }

            // Keep buffer from growing unboundedly
            if (this._serialBuffer.length > 8192) {
              this._serialBuffer = this._serialBuffer.slice(-1024);
            }
          }
          break;
        }
        case 'gpio_change': {
          const pin = msg.data.pin as number;
          const state = (msg.data.state as number) === 1;
          console.log(
            `[Esp32Bridge:${this.boardId}] gpio_change pin=${pin} state=${state ? 'HIGH' : 'LOW'}`,
          );
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
          console.log(
            `[Esp32Bridge:${this.boardId}] ledc_update ch=${msg.data.channel} duty=${msg.data.duty_pct}% gpio=${msg.data.gpio}`,
          );
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
        case 'spi_event': {
          // Worker emits {bus, event, response}. The 'event' field encodes:
          //   event = mosi << 8        (op = event & 0xFF == 0x00) → byte transfer
          //   event = ((cs<<1)|level) << 8 | 0x01 (op == 0x01)     → CS line change
          // See backend/app/services/esp32_worker.py::_on_spi_event.
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
   */
  setSensors(sensors: Array<Record<string, unknown>>): void {
    this._pendingSensors = sensors;
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

  /** Drive a GPIO pin from an external source (e.g. connected Arduino) */
  sendPinEvent(gpioPin: number, state: boolean): void {
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
    const existing = this._pendingSensors.findIndex((s) => s['pin'] === pin);
    if (existing >= 0) {
      this._pendingSensors[existing] = entry;
    } else {
      this._pendingSensors.push(entry);
    }
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
   * Queue user MicroPython code for injection after the REPL boots.
   * The code will be sent via raw-paste protocol once `>>>` is detected.
   */
  setPendingMicroPythonCode(code: string): void {
    this._pendingMicroPythonCode = code;
    this._serialBuffer = '';
    this._replState = 'idle';
    this.micropythonMode = true;
  }

  /** Check if this bridge is in MicroPython mode */
  isMicroPythonMode(): boolean {
    return this.micropythonMode;
  }

  /**
   * Send code bytes to QEMU UART, then Ctrl+D to execute.
   * Called ONLY after "raw REPL; CTRL-B to exit" has been confirmed in the
   * serial buffer (stage 3), so we are guaranteed to be in raw REPL mode.
   */
  /**
   * Sanitize MicroPython source code before sending to the raw REPL.
   *
   * MicroPython v1.20 on ESP32 uses a byte-oriented tokenizer that doesn't
   * handle non-ASCII bytes in source code.  Multi-byte UTF-8 sequences
   * (e.g. Spanish accents: á=\xC3\xA1, ú=\xC3\xBA) in comments confuse the
   * tokenizer and produce SyntaxError at the wrong line.
   *
   * Safe to strip non-ASCII only from comments because:
   *  - String literals with non-ASCII would already fail on MicroPython's
   *    default build (no wide-unicode support on ESP32).
   *  - Identifiers must be ASCII.
   */
  private static _sanitizeForRepl(code: string): string {
    // 1. Strip UTF-8 BOM if present
    let s = code.startsWith('\uFEFF') ? code.slice(1) : code;
    // 2. Normalize line endings to LF
    s = s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    // 3. Replace non-ASCII in line-comments with '?' so the line is preserved
    s = s.replace(/^([ \t]*#.*)$/gm, (line) => line.replace(/[^\x00-\x7F]/g, '?'));
    // 4. Replace non-ASCII in inline comments (after code on the same line)
    s = s.replace(/([ \t]+#.*)$/gm, (comment) => comment.replace(/[^\x00-\x7F]/g, '?'));
    return s;
  }

  private _sendCodeInRawRepl(code: string): void {
    const sanitized = Esp32Bridge._sanitizeForRepl(code);
    console.log(
      `[Esp32Bridge:${this.boardId}] Sending ${sanitized.length} bytes to raw REPL + Ctrl+D`,
    );
    if (sanitized !== code) {
      console.log(
        `[Esp32Bridge:${this.boardId}] Code was sanitized (non-ASCII in comments stripped)`,
      );
    }
    const codeBytes = Array.from(new TextEncoder().encode(sanitized));
    console.log(
      `[Esp32Bridge:${this.boardId}] Sending ${codeBytes.length} bytes in chunks to raw REPL`,
    );

    // The ESP32 UART RX FIFO is 128 bytes in hardware (and in QEMU's emulation).
    // Sending >128 bytes in one qemu_picsimlab_uart_receive() call overflows the
    // FIFO — the extra bytes are silently dropped, corrupting the injected code
    // (e.g. "time.sleep" becomes "ti" causing NameError).
    // Use ≤64-byte chunks with a 150 ms gap so QEMU drains the FIFO between sends.
    const CHUNK_SIZE = 64;
    const CHUNK_DELAY_MS = 150;
    let offset = 0;

    const sendChunk = () => {
      if (offset >= codeBytes.length) {
        // All bytes delivered — wait for QEMU to finish processing the last chunk
        setTimeout(() => {
          this.sendSerialBytes([0x04]); // Ctrl+D → compile & execute
          this._replState = 'idle';
          console.log(`[Esp32Bridge:${this.boardId}] Ctrl+D sent — code executing`);
        }, 300);
        return;
      }
      const chunk = codeBytes.slice(offset, offset + CHUNK_SIZE);
      this.sendSerialBytes(chunk);
      offset += CHUNK_SIZE;
      setTimeout(sendChunk, CHUNK_DELAY_MS);
    };
    sendChunk();
  }

  private _send(payload: unknown): void {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(payload));
    }
  }
}
