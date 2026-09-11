/**
 * RaspberryPi3Bridge
 *
 * Manages the WebSocket connection from the frontend to the backend
 * QEMU manager for one Raspberry Pi 3B board instance.
 *
 * Protocol (JSON frames):
 *   Frontend → Backend
 *     { type: 'start_pi', data: { board: 'raspberry-pi-3'|'raspberry-pi-4'|'raspberry-pi-5' } }
 *     { type: 'stop_pi' }
 *     { type: 'serial_input', data: { bytes: number[] } }
 *     { type: 'gpio_in', data: { pin: number, state: 0 | 1 } }
 *     { type: 'pi_attach_slave', data: {
 *         bus_kind: 'i2c'|'spi'|'uart',
 *         bus_num:  number,
 *         address?: number,   // i2c
 *         cs?:      number,   // spi
 *         model_id: string,   // e.g. 'bme280'
 *         config?:  Record<string, unknown>,
 *     }}
 *     { type: 'pi_detach_slave', data: { bus_kind, bus_num, address?|cs? } }
 *     { type: 'pi_bus_reply',  data: { rid: number, line: string | null } }
 *
 *   Backend → Frontend
 *     { type: 'serial_output', data: { data: string } }
 *     { type: 'gpio_change',   data: { pin: number, state: 0 | 1 } }
 *     { type: 'gpio_setup',    data: { pin: number, direction: 'in'|'out', pull: 'pud_up'|'pud_down'|'pud_off' } }
 *     { type: 'pi_bus_request', data: { rid: number, line: string } }
 *     { type: 'system',        data: { event: string, ... } }
 *     { type: 'error',         data: { message: string } }
 *
 * `pi_bus_request` / `pi_bus_reply` carry one bus operation each (an I2C
 * transaction, an SPI transfer, a 1-Wire op) as a request line the guest's
 * shim libraries wrote; the board's simulator shim answers it against the
 * device models on the canvas (see simulation/PiBridgeShim). A request the
 * frontend cannot answer is replied with `line: null` so the backend never
 * waits on it.
 */

import { getTabSessionId } from './Esp32Bridge';

/**
 * What the board publishes to the backend about its bus (`pi_bus_topology`).
 * `regs` is the device's 256 registers as hex when it can export them (the
 * backend then answers reads from that copy with no round trip), null when
 * the device has to be asked each time.
 */
export interface PiBusTopology {
  version: 1;
  i2c: Array<{ bus: number; addr: number; regs: string | null }>;
  spi: { attached: boolean };
}

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

export class RaspberryPi3Bridge {
  readonly boardId: string;
  /** Pi family member: 'raspberry-pi-3' | 'raspberry-pi-4' | 'raspberry-pi-5'.
   * The backend uses this to pick the QEMU -cpu / -m. Defaults to Pi 3 for
   * back-compat with code paths that don't know the kind yet. */
  readonly boardKind: string;

  // Callbacks wired up by useSimulatorStore
  onSerialData: ((char: string) => void) | null = null;
  onPinChange: ((gpioPin: number, state: boolean) => void) | null = null;
  /** The guest programmed a pin's internal pull (from its GPIO_SETUP):
   * 0 = none, 1 = pull-up, 2 = pull-down. Wired to the store's pull handler
   * so the netlist stamps the resistor and the pin rests at its level. */
  onPinPull: ((gpioPin: number, pull: 0 | 1 | 2) => void) | null = null;
  /** One bus operation the guest is waiting on (`pi_bus_request`). Return
   * the reply line, or null when there is nothing to say; either way a
   * `pi_bus_reply` with the same `rid` goes back. */
  onBusRequest: ((rid: number, line: string) => string | null) | null = null;
  /** The backend announced (`system` event `bus_relay`) that it answers the
   * guest's bus from the canvas: publish the bus map now. Its own slot so it
   * never competes with whoever owns onSystemEvent. */
  onBusRelay: ((version: number) => void) | null = null;
  onConnected: (() => void) | null = null;
  onDisconnected: (() => void) | null = null;
  /** Backend refused or lost the session. `code` is the server's
   *  machine-readable reason when it sent one (a gate, a full box). */
  onError: ((msg: string, code?: string) => void) | null = null;
  onSystemEvent: ((event: string, data: Record<string, unknown>) => void) | null = null;
  /** Guest display command (opaque base64 payload from the DISP protocol
   * op). Overlay boards with built-in screens render it on their element. */
  onDisplay: ((data: string) => void) | null = null;
  /** Bytes the guest wrote to its HEADER UART (not the console): another
   * board wired to those pads is the destination. Decoded text. */
  onUartTx: ((text: string) => void) | null = null;
  /** Guest PWM activity (PWM_START / PWM_CHANGE / PWM_STOP). Overlay boards
   * use it for built-in buzzers/speakers. */
  onGpioPwm:
    | ((pin: number, frequency: number, dutyCycle: number, event: string) => void)
    | null = null;
  /** Fires once when the guest Linux has finished booting and reached an
   * interactive shell prompt. `connected` only means the WebSocket is open
   * (~1s); the guest still takes 30-60s to boot. Drives the "booting" UI and
   * gates file uploads. */
  onBooted: (() => void) | null = null;

  private socket: WebSocket | null = null;
  private _connected = false;
  private _booted = false;
  /** Extra fields merged into the `start_pi` payload (an overlay uses it
   * to declare what this session needs materialised, e.g. packages). */
  startPayload: Record<string, unknown> = {};
  /** quietBoot (ProBoardDef): while true, guest serial output is withheld
   * from onSerialData (boot detection still runs) and a neutral Velxio
   * progress line + dots show instead. The run path calls setQuiet(false)
   * to reveal the shell right before the script starts. */
  quietBootDefault = false;
  /** Board label for the quiet-boot progress line. */
  quietBootLabel = '';
  private _quiet = false;
  private _quietTimer: ReturnType<typeof setInterval> | null = null;
  /** Rolling, escape-stripped tail of recent guest output, used to detect the
   * boot-complete marker and shell prompts for flow-controlled sends. */
  private _serialTail = '';
  private _promptWaiters: Array<() => void> = [];

  constructor(boardId: string, boardKind: string = 'raspberry-pi-3') {
    this.boardId = boardId;
    this.boardKind = boardKind;
  }

  get connected(): boolean {
    return this._connected;
  }

  connect(): void {
    // Numeric readyState, and only when a socket actually exists: reading
    // WebSocket.OPEN off the global made `undefined === undefined` true
    // whenever the constants were missing (any stand-in socket), so connect()
    // returned without opening anything and the bridge sat there dead.
    if (this.socket) {
      const state = this.socket.readyState;
      if (state === 0 /* CONNECTING */ || state === 1 /* OPEN */) return;
    }
    // A socket in CLOSING is on its way out, not usable: the old guard
    // treated it as live and returned, so "restart in Linux mode" right
    // after a run silently did nothing — no boot, and the toolbar still
    // showing Stop. Drop it and open a fresh one.
    this.socket = null;

    const base = API_BASE();
    const wsProtocol = base.startsWith('https') ? 'wss:' : 'ws:';
    // Scope the backend client_id to THIS tab. With the bare boardId, two
    // tabs (or two users) opening the same example shared one QEMU
    // instance: serial output went to whichever WebSocket connected last,
    // keystrokes interleaved, and one tab's stop killed the other's guest.
    const clientId = `${this.boardId}--${getTabSessionId()}`;
    const wsUrl =
      base.replace(/^https?:/, wsProtocol) + `/simulation/ws/${encodeURIComponent(clientId)}`;

    const socket = new WebSocket(wsUrl);
    this.socket = socket;

    socket.onopen = () => {
      this._connected = true;
      this.onConnected?.();
      // Tell the backend which Pi family member to boot.
      this._send({
        type: 'start_pi',
        data: { board: this.boardKind, ...this.startPayload },
      });
      if (this.quietBootDefault) {
        this._quiet = true;
        const label = this.quietBootLabel || this.boardKind;
        this._emitLocal(`[Velxio] Booting ${label} (Linux guest)`);
        this._quietTimer = setInterval(() => this._emitLocal('.', false), 4000);
      }
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
          // quietBoot: keep observing (boot marker + prompt waiters drive
          // guestSetup and the upload) but withhold the branded chatter.
          if (!this._quiet && this.onSerialData) {
            for (const ch of text) this.onSerialData(ch);
          }
          this._observeSerial(text);
          break;
        }
        case 'gpio_change': {
          const pin = msg.data.pin as number;
          const state = (msg.data.state as number) === 1;
          this.onPinChange?.(pin, state);
          break;
        }
        case 'gpio_setup': {
          const pin = msg.data.pin as number;
          const pull = msg.data.pull === 'pud_up' ? 1 : msg.data.pull === 'pud_down' ? 2 : 0;
          if (typeof pin === 'number') this.onPinPull?.(pin, pull);
          break;
        }
        case 'pi_bus_request': {
          const rid = msg.data.rid as number;
          const line = msg.data.line;
          if (typeof rid !== 'number' || typeof line !== 'string') break;
          let reply: string | null = null;
          try {
            reply = this.onBusRequest?.(rid, line) ?? null;
          } catch (e) {
            // A model that throws must not hang the guest on its timeout:
            // answer nothing, say why here. The line comes from the guest,
            // so it goes in as an argument, never as the format string, and
            // quoted: a newline in it cannot forge a second log entry.
            console.warn('[%s] bus request failed: %s', this.boardId, JSON.stringify(line.slice(0, 200)), e);
          }
          // A write the guest did not wait for (a display frame, a config
          // register) is applied and not answered: the backend holds no
          // request open for it.
          if (msg.data.noreply !== true) {
            this._send({ type: 'pi_bus_reply', data: { rid, line: reply } });
          }
          break;
        }
        case 'system':
          if (msg.data.event === 'bus_relay') {
            this.onBusRelay?.(Number(msg.data.version) || 1);
          }
          this.onSystemEvent?.(msg.data.event as string, msg.data);
          break;
        case 'display':
          this.onDisplay?.((msg.data.data as string) ?? '');
          break;
        case 'uart_tx': {
          const b64 = (msg.data.data as string) ?? '';
          if (b64) {
            try {
              this.onUartTx?.(
                new TextDecoder().decode(
                  Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0)),
                ),
              );
            } catch {
              /* malformed payload — never kill the session over it */
            }
          }
          break;
        }
        case 'gpio_pwm':
          this.onGpioPwm?.(
            (msg.data.pin as number) ?? 0,
            (msg.data.frequency as number) ?? 0,
            (msg.data.duty_cycle as number) ?? 0,
            (msg.data.event as string) ?? 'change',
          );
          break;
        case 'error':
          this.onError?.(msg.data.message as string, msg.data.code as string | undefined);
          break;
      }
    };

    socket.onclose = () => {
      this._connected = false;
      this.socket = null;
      this._resetBootState();
      this.onDisconnected?.();
    };

    socket.onerror = () => {
      this.onError?.('WebSocket error');
    };
  }

  disconnect(): void {
    if (this.socket) {
      // Tell backend to stop Pi before closing
      this._send({ type: 'stop_pi' });
      this.socket.close();
      this.socket = null;
    }
    this._connected = false;
    this._resetBootState();
  }

  /** Clear boot/prompt state and release any pending prompt waiters so an
   * in-flight upload resolves (rather than hanging) when the Pi stops. */
  private _resetBootState(): void {
    this._booted = false;
    this._serialTail = '';
    this._quiet = false;
    if (this._quietTimer) {
      clearInterval(this._quietTimer);
      this._quietTimer = null;
    }
    const waiters = this._promptWaiters;
    this._promptWaiters = [];
    for (const w of waiters) w();
  }

  /** Feed locally-generated status text to the serial consumers. */
  private _emitLocal(text: string, newline = true): void {
    if (!this.onSerialData) return;
    const chunk = newline ? `\r\n${text}` : text;
    for (const ch of chunk) this.onSerialData(ch);
  }

  /** Reveal (or re-hide) the guest's serial stream. Turning quiet off ends
   * the progress dots and prints a ready line. */
  setQuiet(on: boolean): void {
    if (this._quiet === on) return;
    this._quiet = on;
    if (!on) {
      if (this._quietTimer) {
        clearInterval(this._quietTimer);
        this._quietTimer = null;
      }
      this._emitLocal(' ready.\r\n');
    }
  }

  /** Send a byte to the Pi's ttyAMA0 (user serial) */
  sendSerialByte(byte: number): void {
    this._send({ type: 'serial_input', data: { bytes: [byte] } });
  }

  /** Send multiple bytes at once */
  sendSerialBytes(bytes: number[]): void {
    if (bytes.length === 0) return;
    this._send({ type: 'serial_input', data: { bytes } });
  }

  /** Write a UTF-8 string to the guest shell. */
  sendSerialText(text: string): void {
    this.sendSerialBytes(Array.from(new TextEncoder().encode(text)));
  }

  /**
   * Send a line to the guest shell and resolve once the shell prompt returns
   * (i.e. the command has been consumed and executed), or after `timeoutMs`.
   * This replaces fixed setTimeout pacing for uploads so long lines are not
   * dropped by the unflow-controlled console. Always resolves (never rejects)
   * so a missed prompt degrades to a time-bounded wait rather than a hang.
   */
  sendAndWaitForPrompt(text: string, timeoutMs = 5000): Promise<void> {
    return new Promise((resolve) => {
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        const i = this._promptWaiters.indexOf(waiter);
        if (i >= 0) this._promptWaiters.splice(i, 1);
        resolve();
      };
      const waiter = finish;
      const timer = setTimeout(finish, timeoutMs);
      // Forget any prompt already on screen so we wait for the NEXT one,
      // which only reappears after this command has run.
      this._serialTail = '';
      this._promptWaiters.push(waiter);
      this.sendSerialText(text);
    });
  }

  private static _stripAnsi(s: string): string {
    return s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b[=>]/g, '');
  }

  /** Update the rolling tail, fire onBooted once, and release prompt waiters. */
  private _observeSerial(text: string): void {
    this._serialTail = (this._serialTail + text).slice(-512);
    const clean = RaspberryPi3Bridge._stripAnsi(this._serialTail);
    if (!this._booted && (/login on 'hvc0'/.test(clean) || /:~[#$]/.test(clean))) {
      this._booted = true;
      this.onBooted?.();
    }
    // A shell prompt ends in "# " / "$ " (trailing space, no newline). Trim
    // only trailing spaces/tabs (not newlines) so command OUTPUT ending in
    // "#\n" is NOT mistaken for a prompt; heredoc continuation "> " is also
    // excluded since it ends in ">".
    const promptTail = clean.replace(/[ \t]+$/, '');
    if (this._promptWaiters.length && (promptTail.endsWith('#') || promptTail.endsWith('$'))) {
      const waiters = this._promptWaiters;
      this._promptWaiters = [];
      for (const w of waiters) w();
    }
  }

  /** Drive a GPIO pin from an external source (e.g. connected Arduino) */
  sendPinEvent(gpioPin: number, state: boolean): void {
    this._send({ type: 'gpio_in', data: { pin: gpioPin, state: state ? 1 : 0 } });
  }

  /** Bytes for the guest's HEADER UART RX (a wired board's TX). Distinct
   * from sendSerialBytes, which types into the console/shell. */
  sendUartBytes(bytes: number[]): void {
    if (!bytes.length) return;
    this._send({ type: 'pi_uart_rx', data: { bytes } });
  }

  /** Push canvas-fed named values (built-in sensors/buttons of overlay
   * boards). The guest polls them via SENS protocol requests. */
  setSensorState(values: Record<string, number>): void {
    this._send({ type: 'pi_sensor_state', data: { values } });
  }

  /**
   * Attach an I2C/SPI/UART slave model to the running Pi. The backend
   * pro overlay turns this into a PiSlaveRegistry entry that the
   * protocol dispatcher consults on each guest read. OSS images
   * silently drop the message.
   */
  attachSlave(spec: {
    bus_kind: 'i2c' | 'spi' | 'uart';
    bus_num: number;
    address?: number;
    cs?: number;
    model_id: string;
    config?: Record<string, unknown>;
  }): void {
    this._send({ type: 'pi_attach_slave', data: spec });
  }

  detachSlave(spec: {
    bus_kind: 'i2c' | 'spi' | 'uart';
    bus_num: number;
    address?: number;
    cs?: number;
  }): void {
    this._send({ type: 'pi_detach_slave', data: spec });
  }

  /** The I2C / SPI parts wired to this board, for the backend relay to
   * answer the guest from (`pi_bus_topology`). */
  sendBusTopology(topology: PiBusTopology): void {
    this._send({ type: 'pi_bus_topology', data: topology });
  }

  /** A register-file device's registers changed (`pi_bus_regs`). */
  sendBusRegs(bus: number, address: number, regsHex: string): void {
    this._send({ type: 'pi_bus_regs', data: { bus, addr: address, regs: regsHex } });
  }

  private _send(payload: unknown): void {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(payload));
    }
  }
}
