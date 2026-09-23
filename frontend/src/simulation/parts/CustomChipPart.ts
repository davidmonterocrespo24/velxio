/**
 * Custom Chip part — registers the 'custom-chip' metadata id with the
 * PartSimulationRegistry. On every sim start (hexEpoch change), instantiates
 * a ChipInstance per Custom Chip on the canvas and disposes it on cleanup.
 *
 * Wires are resolved using the standard `getArduinoPinHelper` provided by
 * DynamicComponent — chip pin names from chip.json get mapped to real
 * Arduino pin numbers based on the diagram's wire connections.
 */
import { PartSimulationRegistry } from './PartSimulationRegistry';
import {
  ChipInstance,
  decodeWasmBase64,
  ensureUartBridge,
  getSimulatorBridges,
  avrUartTx,
  getI2CBus,
  detectSimulatorKind,
} from '../customChips';
import { hostsChipsInWorker } from '../customChips/simulatorBridges';
import { b64ToBytes, inflateZlib, spliceFramebufferRows } from '../customChips/inflateZlib';
import type { ChipFramebufferFrame } from '../Esp32Bridge';
import { chipVirtualPin } from '../customChips/chipVirtualPin';
import { useSimulatorStore } from '../../store/useSimulatorStore';
import { useElectricalStore } from '../../store/useElectricalStore';
import { normalizeChipPinNames } from '../customChips/chipJson';
import { clearChipDrives } from '../customChips/chipPinDrives';
import { isSyntheticChipPin } from '../customChips/syntheticPins';
import { resolveChipNetMembers, resolveChipOwnerBoardId } from '../customChips/chipNets';
import { classifyPin } from '../../utils/boardProtocols';
import { requestElectricalResolve } from '../spice/electricalResolveHook';
import { runChipAttachExtensions } from '../customChips/chipAttachExtensions';
import { createUartBitBanger, type UartBitBanger } from '../customChips/uartBitBang';
import { setAdcVoltage, analogRailVolts } from './partUtils';

// Physical-key (KeyboardEvent.code) -> Galaksija keyboard matrix offset, from
// the libretro Galaksija core's keyMap. The chip's set_key takes this offset;
// reading 0x2000+offset on the bus returns pressed/released.
const GALAKSIJA_KEY_OFFSET: Record<string, number> = {
  KeyA: 1,
  KeyB: 2,
  KeyC: 3,
  KeyD: 4,
  KeyE: 5,
  KeyF: 6,
  KeyG: 7,
  KeyH: 8,
  KeyI: 9,
  KeyJ: 10,
  KeyK: 11,
  KeyL: 12,
  KeyM: 13,
  KeyN: 14,
  KeyO: 15,
  KeyP: 16,
  KeyQ: 17,
  KeyR: 18,
  KeyS: 19,
  KeyT: 20,
  KeyU: 21,
  KeyV: 22,
  KeyW: 23,
  KeyX: 24,
  KeyY: 25,
  KeyZ: 26,
  ArrowUp: 27,
  ArrowDown: 28,
  ArrowLeft: 29,
  Backspace: 29,
  ArrowRight: 30,
  Space: 31,
  Digit0: 32,
  Digit1: 33,
  Digit2: 34,
  Digit3: 35,
  Digit4: 36,
  Digit5: 37,
  Digit6: 38,
  Digit7: 39,
  Digit8: 40,
  Digit9: 41,
  Semicolon: 42,
  Quote: 43,
  Comma: 44,
  Equal: 45,
  Period: 46,
  Slash: 47,
  Enter: 48,
  Tab: 49,
  Delete: 51,
  ShiftLeft: 53,
  ShiftRight: 53,
};

PartSimulationRegistry.register('custom-chip', {
  attachEvents: (_element, simulator, getArduinoPin, componentId) => {
    const sim = simulator as any;

    const component = useSimulatorStore.getState().components.find((c) => c.id === componentId);
    if (!component) {
      console.warn(`[custom-chip] component ${componentId} not found in store`);
      return () => {};
    }

    const props = component.properties as Record<string, unknown>;
    const wasmBase64 = String(props.wasmBase64 ?? '');
    const chipJsonStr = String(props.chipJson ?? '{}');
    if (!wasmBase64) {
      console.info(`[custom-chip] ${componentId} has no compiled WASM yet — skipping.`);
      return () => {};
    }

    let pins: string[] = [];
    let display: { width: number; height: number } | null = null;
    try {
      // An empty chipJson (agent-placed chip before programming) is not an
      // error — treat it like a pinless chip rather than throwing on ''.
      const obj = chipJsonStr.trim() ? JSON.parse(chipJsonStr) : {};
      pins = normalizeChipPinNames(obj.pins);
      if (
        obj.display &&
        typeof obj.display.width === 'number' &&
        typeof obj.display.height === 'number'
      ) {
        display = { width: obj.display.width, height: obj.display.height };
      }
    } catch (e) {
      console.warn(`[custom-chip] ${componentId} chip.json parse error:`, e);
      return () => {};
    }
    if (pins.length === 0) {
      console.warn(`[custom-chip] ${componentId} declares no pins — chip will be inert.`);
    }

    // Pull saved attribute values from the component's properties. Numeric
    // values feed vx_attr_read; strings feed vx_attr_string_read.
    const attrsObj: Record<string, number> = {};
    const strAttrsObj: Record<string, string> = {};
    try {
      const raw = (props.attrs ?? {}) as Record<string, unknown>;
      for (const [k, v] of Object.entries(raw)) {
        const n = typeof v === 'number' ? v : parseFloat(String(v));
        if (!Number.isNaN(n)) attrsObj[k] = n;
        else if (typeof v === 'string') strAttrsObj[k] = v;
      }
    } catch {
      /* ignore */
    }

    // Pull external ROM bytes (base64-encoded) if the chip's program lives
    // in a project file like .s / .hex / .bin compiled to romBytes by the
    // backend. CPU-emulator chips use this via vx_rom_size / vx_rom_read.
    let romBytes: Uint8Array | null = null;
    const romB64 = String(props.romBytes ?? '');
    if (romB64) {
      try {
        const bin = atob(romB64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        romBytes = bytes;
      } catch (e) {
        console.warn(`[custom-chip] ${componentId} romBytes is not valid base64:`, e);
      }
    }

    // ── ESP32 path ──────────────────────────────────────────────────────────
    // The chip's WASM runs in the backend QEMU worker process so I2C events
    // are answered synchronously. See docs/wiki/custom-chips-esp32-backend-runtime.md.
    //
    // IMPORTANT: only take this path for actual ESP32 simulators. We cannot
    // gate on `typeof sim.registerSensor === 'function'` because AVR and
    // RP2040 simulators also expose `registerSensor` for I2C sensor proxies —
    // taking that branch on AVR routes the chip to the (non-existent) ESP32
    // backend and the client-side ChipInstance never runs.
    //
    // The same shim also fronts an overlay's in-browser ESP32 engine, which
    // has no worker either: it answers hostsChipsInWorker() false and the
    // chip takes the browser path below, like any other browser board.
    if (
      detectSimulatorKind(sim) === 'esp32' &&
      typeof sim.registerSensor === 'function' &&
      hostsChipsInWorker(sim)
    ) {
      // Resolve each chip pin name → ESP32 GPIO via the diagram's wires. The
      // backend runtime uses this to call qemu_picsimlab_set_pin when the chip
      // does vx_pin_write, and to read live GPIO state for vx_pin_read.
      const pinMap: Record<string, number> = {};
      for (const name of pins) {
        if (!name) continue;
        const gpio = getArduinoPin(name);
        // Synthetic pin numbers (100000+) are a browser-side PinManager key for
        // a chip pin with no board GPIO on its net. They are not GPIOs, and the
        // worker would hand one straight to qemu_picsimlab_set_pin. Such a pin
        // belongs to `nets` below, or to nothing at all.
        if (gpio !== null && gpio >= 0 && !isSyntheticChipPin(gpio)) pinMap[name] = gpio;
      }

      // Chip-to-chip nets. A pin wired only to another chip's pin has no GPIO
      // and so is absent from pinMap; the worker's ChipNetBus carries it
      // instead, and `remote` marks a net whose other end is a chip on a
      // different board (a second QEMU worker) for the interconnect to bridge.
      const nets = resolveChipNetMembers(useSimulatorStore.getState(), componentId);

      // Which board UART each wired GPIO belongs to. The chip's vx_uart_attach
      // names its own RX/TX pins, and the backend runtime turns those into
      // GPIOs through pinMap; this table is the last hop, GPIO to UART number,
      // and it is board-specific so it has to come from here. Without it every
      // chip landed on one fixed UART whatever the diagram said, which put a
      // module wired to Serial2 on the wrong end of the board.
      const uartMap: Record<number, number> = {};
      {
        const st = useSimulatorStore.getState();
        const ownerId = resolveChipOwnerBoardId(st, componentId);
        const ownerKind = st.boards.find((b) => b.id === ownerId)?.boardKind;
        if (ownerKind) {
          for (const gpio of Object.values(pinMap)) {
            const role = classifyPin(ownerKind, String(gpio));
            if (role.kind === 'uart-tx' || role.kind === 'uart-rx') {
              uartMap[gpio] = role.uart;
            }
          }
        }
      }

      // The worker keys sensor records by pin and a chip has none: each chip
      // gets its own synthetic slot (see chipVirtualPin), so live attribute
      // updates and a detach reach this chip and not the last one registered.
      const virtualPin = chipVirtualPin(componentId);
      try {
        sim.registerSensor('custom-chip', virtualPin, {
          wasm_b64: wasmBase64,
          attrs: attrsObj,
          pin_map: pinMap,
          nets,
          uart_map: uartMap,
          // The worker allocates the framebuffer vx_framebuffer_init hands the
          // chip, and needs the id to send the rows back to THIS element.
          component_id: componentId,
          display: display ?? undefined,
        });
        console.info(
          `[custom-chip:${componentId}] sent to backend ESP32 worker (chip runs synchronously inside QEMU process). pinMap=${JSON.stringify(pinMap)} nets=${JSON.stringify(nets)} uartMap=${JSON.stringify(uartMap)}`,
        );
      } catch (e) {
        console.error(`[custom-chip:${componentId}] failed to register on ESP32 backend:`, e);
      }
      // A display chip's pixels come back from the worker as `chip_framebuffer`
      // rows (see Esp32Bridge.onChipFramebuffer). Kept in a full RGBA image here
      // so a partial frame (the rows a driver's window touched) lands on top of
      // what was already drawn, and painted at most once per animation frame —
      // the worker flushes at ~20 fps, but nothing obliges the browser to
      // repaint faster than it displays.
      let offFramebuffer: () => void = () => {};
      const bridge = (
        sim as { getBridge?: () => { onChipFramebuffer?: unknown } }
      ).getBridge?.() as
        | { onChipFramebuffer: ((id: string, frame: ChipFramebufferFrame) => void) | null }
        | undefined;
      const chipEl = document.getElementById(componentId) as
        | (HTMLElement & { paintFramebuffer?: (rgba: Uint8Array, w: number, h: number) => void })
        | null;
      if (bridge && display && typeof chipEl?.paintFramebuffer === 'function') {
        const image = new Uint8Array(display.width * display.height * 4);
        let dirty = false;
        let paintHandle: number | null = null;
        let queue: Promise<void> = Promise.resolve();
        let gone = false;
        const paint = () => {
          paintHandle = null;
          if (gone || !dirty) return;
          dirty = false;
          try {
            chipEl.paintFramebuffer!(image, display.width, display.height);
          } catch {
            /* swallow */
          }
        };
        const prev = bridge.onChipFramebuffer;
        bridge.onChipFramebuffer = (id, frame) => {
          prev?.(id, frame);
          if (id !== componentId || gone) return;
          // Frames are applied in arrival order: inflate is async, and two
          // in flight at once could land the older rows on top of the newer.
          queue = queue
            .then(async () => {
              if (gone) return;
              if (frame.width !== display.width || frame.height !== display.height) return;
              const rows = await inflateZlib(b64ToBytes(frame.rowsZlibB64));
              spliceFramebufferRows(image, frame.width, frame.y0, frame.y1, rows);
              dirty = true;
              if (paintHandle === null) paintHandle = requestAnimationFrame(paint);
            })
            .catch((e) => {
              console.warn(`[custom-chip:${componentId}] framebuffer frame dropped:`, e);
            });
        };
        offFramebuffer = () => {
          gone = true;
          if (paintHandle !== null) cancelAnimationFrame(paintHandle);
          bridge.onChipFramebuffer = prev;
        };
      }
      // Overlay extensions (e.g. pro live sensor controls) hook the chip
      // lifecycle here; pure OSS registers none.
      const cleanupExtensions = runChipAttachExtensions({
        kind: 'esp32',
        componentId,
        simulator: sim,
        virtualPin,
      });
      // Cleanup: tell the worker the chip is gone. While the guest runs this
      // is a live detach (a chip deleted from the canvas leaves the bus and
      // every dispatch list); on Stop the bridge drops the record from the
      // list it would replay at the next Run, and the part re-registers when
      // it attaches again. The same cleanup as the ePaper part.
      return () => {
        offFramebuffer();
        cleanupExtensions();
        try {
          sim.unregisterSensor?.(virtualPin);
        } catch {
          /* bridge gone */
        }
      };
    }
    // ── End ESP32 path ──────────────────────────────────────────────────────

    // Resolve every chip pin name to its wired Arduino pin (if any).
    const wires = new Map<string, number>();
    for (const name of pins) {
      if (!name) continue;
      const arduinoPin = getArduinoPin(name);
      if (arduinoPin !== null && arduinoPin >= 0) {
        wires.set(name, arduinoPin);
      }
    }

    // Convert the attribute maps into Maps for the JS runtime.
    const attrs = new Map<string, number>(Object.entries(attrsObj));
    const strAttrs = new Map<string, string>(Object.entries(strAttrsObj));

    // Lazily install the per-simulator UART bridge. Idempotent — safe to call
    // even if other custom chips have already wired it up. SPI needs nothing
    // here: the chip joins the board's bus from vx_spi_attach, with the pins of
    // its own config, and a chip that never calls it stays off SPI entirely.
    ensureUartBridge(sim);
    const bridges = getSimulatorBridges(sim);

    // Async create — wrap so we can dispose even if create is still in-flight
    // when the user stops the simulation.
    let instance: ChipInstance | null = null;
    let uartListener: ((byte: number) => void) | null = null;
    let uartBitBanger: UartBitBanger | null = null;
    let rafHandle = 0;
    let disposed = false;
    let keyboardCleanup: (() => void) | undefined;
    let extensionCleanup: (() => void) | undefined;

    (async () => {
      try {
        const wasm = decodeWasmBase64(wasmBase64);
        const inst = await ChipInstance.create({
          wasm,
          componentId,
          pinManager: sim.pinManager,
          // Polymorphic I2C: AVR returns the I2CBusManager directly, RP2040
          // and a browser-hosted ESP32 (in-browser engine) a thin adapter,
          // anything else null (chip won't get I2C).
          i2cBus: getI2CBus(sim, 0) as any,
          wires,
          attrs,
          strAttrs,
          display,
          romBytes,
          log: (s) => console.log(`[chip:${componentId}] ${s.replace(/\n$/, '')}`),
        });
        if (disposed) {
          inst.dispose();
          return;
        }
        instance = inst;

        // Register the board-injection hooks BEFORE start(): chip_setup
        // fires the initial OUTPUT_HIGH/LOW levels (and may write pins /
        // the DAC synchronously), and those must reach the board too.
        inst.onDacWrite((pinName, voltage) => {
          const boardPin = wires.get(pinName);
          if (boardPin == null || isSyntheticChipPin(boardPin)) return;
          const rail = analogRailVolts(sim);
          setAdcVoltage(sim, boardPin, Math.max(0, Math.min(voltage, rail)));
        });
        inst.onDigitalWrite((pinName, value) => {
          const boardPin = wires.get(pinName);
          if (boardPin == null || isSyntheticChipPin(boardPin)) return;
          try {
            (sim as { setPinState?: (pin: number, state: boolean) => void }).setPinState?.(
              boardPin,
              value,
            );
          } catch {
            /* board not ready yet */
          }
        });

        inst.start();

        // Overlay extensions (e.g. pro live sensor controls) hook the chip
        // lifecycle here; pure OSS registers none.
        extensionCleanup = runChipAttachExtensions({
          kind: 'browser',
          componentId,
          simulator: sim,
          instance: inst,
          wires,
        });

        // Bridge UART: AVR Serial.write(byte) → chip.feedUart(byte).
        // Chip's vx_uart_write(byte) → the board:
        //   - TX wired to the hardware RX (pin 0) or unwired → USART inject
        //     (Serial.read / the monitor), the historical path.
        //   - TX wired to any other GPIO on an AVR board → bit-banged 8N1 on
        //     that pin, so SoftwareSerial(rx=that pin) actually receives.
        //     Before this, GPIO-wired chip streams (the NMEA GPS scenario)
        //     delivered nothing at all.
        //
        // An ESP32-kind simulator hosting the chip in the browser (an
        // overlay's in-browser engine) is left to the attach extensions: the
        // engine publishes its UART bytes on the overlay's own bus, and the
        // shim's onSerialData is never invoked, so there is nothing here to
        // listen on. Pure OSS never reaches this branch with kind esp32.
        if (inst.hasUart && detectSimulatorKind(sim) !== 'esp32') {
          uartListener = (byte: number) => inst.feedUart(byte);
          bridges.uartListeners.add(uartListener);
          const route = inst.getUartTxRoute();
          const gpioTarget =
            detectSimulatorKind(sim) === 'avr' &&
            route?.txArduinoPin != null &&
            !isSyntheticChipPin(route.txArduinoPin) &&
            route.txArduinoPin !== 0;
          if (gpioTarget && route) {
            uartBitBanger = createUartBitBanger(
              sim as never,
              route.txArduinoPin as number,
              route.baud,
              `chip:${componentId}`,
            );
            inst.onUartTx((byte) => uartBitBanger?.write(byte));
          } else {
            inst.onUartTx((byte) => avrUartTx(sim, byte));
          }
        }

        // Bridge framebuffer → chip's web component canvas (when chip has display).
        // The runtime reports every vx_buffer_write; a driver painting a 480x320
        // window pixel by pixel makes hundreds of thousands of them per screen,
        // and repainting the canvas on each one froze the tab (issue #338). So
        // the callback only notes that the buffer moved, and the rAF tick below
        // paints it at most once per frame.
        const el = document.getElementById(componentId) as HTMLElement | null;
        let framebufferDirty: { rgba: Uint8Array; width: number; height: number } | null = null;
        if (el && typeof (el as any).paintFramebuffer === 'function' && inst.hasFramebuffer) {
          inst.onFramebufferUpdate((rgba, width, height) => {
            framebufferDirty = { rgba, width, height };
          });
        }
        const paintFramebufferIfDirty = () => {
          const fb = framebufferDirty;
          if (!fb || !el) return;
          framebufferDirty = null;
          try {
            (el as any).paintFramebuffer(fb.rgba, fb.width, fb.height);
          } catch {
            /* swallow */
          }
        };

        // Bridge the browser keyboard → a chip's memory-mapped keyboard (a chip
        // exporting set_key, e.g. galaksija-keyboard). Maps physical keys
        // (e.code) to the chip's matrix offsets. Ignores keystrokes while an
        // editable element (the code editor, an input) is focused so typing code
        // is never hijacked; the user types into the computer by clicking the
        // canvas first. Held keys send one press (the chip's firmware handles
        // auto-repeat).
        if (inst.hasKeyboard && typeof window !== 'undefined') {
          const editable = () => {
            const a = document.activeElement as HTMLElement | null;
            return (
              !!a &&
              (a.tagName === 'INPUT' ||
                a.tagName === 'TEXTAREA' ||
                a.isContentEditable ||
                a.closest('.monaco-editor') != null)
            );
          };
          const onDown = (e: KeyboardEvent) => {
            if (e.repeat || editable()) return;
            const o = GALAKSIJA_KEY_OFFSET[e.code];
            if (o !== undefined) {
              instance?.setKey(o, true);
              e.preventDefault();
            }
          };
          const onUp = (e: KeyboardEvent) => {
            if (editable()) return;
            const o = GALAKSIJA_KEY_OFFSET[e.code];
            if (o !== undefined) instance?.setKey(o, false);
          };
          window.addEventListener('keydown', onDown);
          window.addEventListener('keyup', onUp);
          keyboardCleanup = () => {
            window.removeEventListener('keydown', onDown);
            window.removeEventListener('keyup', onUp);
          };
        }

        // Drive the chip's timer-based execution every frame. Chips that
        // register a periodic `vx_timer_create` (e.g. a CPU-emulator chip
        // stepping its core, or a sensor publishing samples) need a
        // host-side tick to fire those callbacks — without this loop the
        // WASM is loaded but never executes anything past chip_setup().
        // We feed wall-clock nanoseconds; the chip's WasiShim already
        // exposes the same epoch via vx_sim_now_nanos.
        const tick = () => {
          if (disposed || !instance) return;
          // Whatever the chip drew since the last frame reaches the canvas now,
          // running or stopped — a stopped chip still shows its last picture.
          paintFramebufferIfDirty();
          // Freeze the chip while the simulation is stopped — but keep the rAF
          // alive so Run resumes instantly.
          //   - Board-less: driven by the editor Run/Stop via the electrical
          //     "paused" flag.
          //   - With board(s): the chip must ALSO stop when the user hits Stop,
          //     which sets board.running=false. Gating only on board presence
          //     (the old `!boardless`) left the chip ticking forever after Stop.
          const simState = useSimulatorStore.getState();
          const boardless = simState.boards.length === 0;
          const runnable = boardless
            ? !useElectricalStore.getState().paused
            : simState.boards.some((b) => b.running);
          if (runnable) {
            try {
              // Cap per-frame compute at 6 ms so a slow multi-chip bus (a Z80
              // running real-time over the settle kernel) degrades to a slower
              // boot instead of freezing the tab. Fast single-chip examples
              // finish their due fires well under the budget, so they are
              // unaffected and still run at real time.
              instance.tickTimers(BigInt(Math.floor(performance.now() * 1_000_000)), 6);
            } catch (e) {
              console.error(`[custom-chip:${componentId}] tickTimers threw:`, e);
            }
          }
          rafHandle = requestAnimationFrame(tick);
        };
        rafHandle = requestAnimationFrame(tick);
      } catch (e) {
        console.error(`[custom-chip] ${componentId} failed to load:`, e);
      }
    })();

    return () => {
      disposed = true;
      if (extensionCleanup) extensionCleanup();
      if (rafHandle) cancelAnimationFrame(rafHandle);
      rafHandle = 0;
      if (uartListener) bridges.uartListeners.delete(uartListener);
      if (uartBitBanger) {
        uartBitBanger.dispose();
        uartBitBanger = null;
      }
      if (keyboardCleanup) keyboardCleanup();
      if (instance) instance.dispose();
      instance = null;
      // Drop this chip's SPICE voltage sources so a stopped chip stops
      // driving its nets, and re-solve so the LEDs fall dark.
      clearChipDrives(componentId);
      requestElectricalResolve();
    };
  },
});
