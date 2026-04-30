/**
 * EPaperPart — simulation hook for the SSD168x ePaper family.
 *
 * Registers all five Phase-1 panel kinds against a single `attachEvents`
 * factory. Internally the factory:
 *
 *   - Decodes SPI bytes via `SSD168xDecoder` (browser-side AVR / RP2040).
 *   - Subscribes to `bridge.onEpaperUpdate` (ESP32 backend renders).
 *   - Tracks DC + CS + RST pins via `pinManager.onPinChange`.
 *   - On flush: paints the latched framebuffer to the element's `<canvas>`
 *     via `putImageData()` (RAF-batched), drives BUSY HIGH for `refreshMs`,
 *     then back LOW so firmware busy-waits see realistic timing.
 *
 * Per the plan in `C:\Users\David\.claude\plans\ahora-integrarlo-en-el-greedy-stearns.md`,
 * this is the only file that touches the simulator-specific surface — the
 * decoder is pure data and the Web Component is pure presentation.
 */

import { PartSimulationRegistry, type AnySimulator } from './PartSimulationRegistry';
import { SSD168xDecoder, type Frame } from '../displays/SSD168xDecoder';
import {
  UC8159cDecoder,
  type UC8159cFrame,
  ACEP_PALETTE_RGB,
} from '../displays/UC8159cDecoder';
import { PANEL_CONFIGS, getPanelConfig, PANEL_IDS } from '../displays/EPaperPanels';
import { RP2040Simulator } from '../RP2040Simulator';
import type { AVRSimulator } from '../AVRSimulator';

// ── Types ────────────────────────────────────────────────────────────────────

interface AvrLikeSimulator {
  spi?: { onByte: (value: number) => void; completeTransfer: (resp: number) => void };
  pinManager?: { onPinChange(pin: number, cb: (p: number, state: boolean) => void): () => void };
}

interface Esp32LikeSimulator {
  pinManager: { onPinChange(pin: number, cb: (p: number, state: boolean) => void): () => void };
  // The shim exposes the underlying bridge so we can subscribe to backend frames.
  getBridge?: () => {
    onEpaperUpdate:
      | ((
          componentId: string,
          frame: { width: number; height: number; b64: string; refreshMs: number },
        ) => void)
      | null;
    sendSensorAttach: (type: string, pin: number, properties: Record<string, unknown>) => void;
    sendPinEvent: (gpio: number, state: boolean) => void;
  };
  registerSensor?: (type: string, pin: number, properties: Record<string, unknown>) => boolean;
  unregisterSensor?: (pin: number) => void;
}

// Pin name → panel-side label. The Web Component exposes them as
// 'GND', 'VCC', 'SCK', 'SDI', 'CS', 'DC', 'RST', 'BUSY'.
const PIN_DC = 'DC';
const PIN_CS = 'CS';
const PIN_RST = 'RST';
const PIN_BUSY = 'BUSY';

// ── Helpers ──────────────────────────────────────────────────────────────────

function isRP2040(sim: AnySimulator): sim is RP2040Simulator {
  return sim instanceof RP2040Simulator;
}

function isAvr(sim: AnySimulator): sim is AVRSimulator {
  // AVR exposes an `spi` member with `onByte`/`completeTransfer`.
  const s = sim as AvrLikeSimulator;
  return !!s.spi && typeof s.spi.onByte === 'function';
}

function isEsp32Shim(sim: AnySimulator): sim is Esp32LikeSimulator {
  const s = sim as Esp32LikeSimulator;
  return typeof s.getBridge === 'function' && typeof s.registerSensor === 'function';
}

/** Decode a base64 string to a Uint8Array. Used for ESP32 backend frames. */
function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Render an SSD168x palette frame (0=black, 1=white, 2=red) into RGBA on canvas.
 */
function paintFrame(ctx: CanvasRenderingContext2D, frame: Frame): void {
  const { width, height, pixels } = frame;
  const id = ctx.createImageData(width, height);
  for (let i = 0; i < pixels.length; i++) {
    const v = pixels[i];
    const o = i * 4;
    if (v === 0) {
      id.data[o] = 0x20;
      id.data[o + 1] = 0x20;
      id.data[o + 2] = 0x20;
    } else if (v === 2) {
      id.data[o] = 0xc0;
      id.data[o + 1] = 0x10;
      id.data[o + 2] = 0x10;
    } else {
      id.data[o] = 0xf4;
      id.data[o + 1] = 0xf1;
      id.data[o + 2] = 0xe8;
    }
    id.data[o + 3] = 0xff;
  }
  ctx.putImageData(id, 0, 0);
}

/**
 * Render a UC8159c ACeP 7-colour frame using the palette table.
 * Palette indices 7+ render as white (clean state).
 */
function paintAcePFrame(ctx: CanvasRenderingContext2D, frame: UC8159cFrame): void {
  const { width, height, pixels } = frame;
  const id = ctx.createImageData(width, height);
  for (let i = 0; i < pixels.length; i++) {
    const idx = pixels[i];
    const rgb = ACEP_PALETTE_RGB[idx] ?? ACEP_PALETTE_RGB[1];
    const o = i * 4;
    id.data[o] = rgb[0];
    id.data[o + 1] = rgb[1];
    id.data[o + 2] = rgb[2];
    id.data[o + 3] = 0xff;
  }
  ctx.putImageData(id, 0, 0);
}

// ── Hook factory ─────────────────────────────────────────────────────────────

const epaperSimulation = {
  attachEvents: (
    element: HTMLElement,
    simulator: AnySimulator,
    getArduinoPinHelper: (componentPinName: string) => number | null,
    componentId: string,
  ) => {
    const cleanups: Array<() => void> = [];

    // ── Resolve panel config from the Web Component's panel-kind attr ─────
    const panelKind =
      (element.getAttribute && element.getAttribute('panel-kind')) ?? 'epaper-1in54-bw';
    const cfg = getPanelConfig(panelKind);
    const explicitRefreshMs = parseFloat(element.getAttribute('refresh-ms') ?? '');
    const refreshMs = !isNaN(explicitRefreshMs) && explicitRefreshMs > 0
      ? explicitRefreshMs
      : cfg.refreshMs;

    // ── Canvas plumbing ──────────────────────────────────────────────────
    const initCanvas = (): CanvasRenderingContext2D | null => {
      const cv = (element as any).canvas as HTMLCanvasElement | null;
      if (!cv) return null;
      // Paint the idle "paper" colour so a freshly-mounted panel doesn't
      // show as a transparent rectangle before the first refresh.
      const ctx = cv.getContext('2d');
      if (ctx) {
        ctx.fillStyle = '#f4f1e8';
        ctx.fillRect(0, 0, cfg.width, cfg.height);
      }
      return ctx;
    };
    let ctx = initCanvas();
    const onCanvasReady = () => {
      ctx = initCanvas();
    };
    element.addEventListener('canvas-ready', onCanvasReady);
    cleanups.push(() => element.removeEventListener('canvas-ready', onCanvasReady));

    // ── BUSY pulse plumbing ──────────────────────────────────────────────
    let busyTimer: ReturnType<typeof setTimeout> | null = null;
    const setBusy = (state: boolean) => {
      (element as any).busy = state;
      // Drive BUSY pin low (LOW = ready) or high (HIGH = refreshing).
      const busyPin = getArduinoPinHelper(PIN_BUSY);
      if (busyPin === null) return;
      if (isAvr(simulator)) {
        (simulator as any).setPinState?.(busyPin, state);
      } else if (isRP2040(simulator)) {
        (simulator as any).setPinState?.(busyPin, state);
      } else if (isEsp32Shim(simulator)) {
        // ESP32 BUSY is driven by the backend on the same pin via
        // qemu_picsimlab_set_pin; the shim's setPinState delegates to it.
        (simulator as any).setPinState?.(busyPin, state);
      }
    };

    const pulseBusy = (ms: number) => {
      setBusy(true);
      if (busyTimer) clearTimeout(busyTimer);
      busyTimer = setTimeout(() => {
        busyTimer = null;
        setBusy(false);
      }, ms);
    };
    cleanups.push(() => {
      if (busyTimer) clearTimeout(busyTimer);
    });

    // ── RAF-batched flush ────────────────────────────────────────────────
    // Both decoder families produce {width, height, pixels: Uint8Array}.
    // The palette interpretation differs (B/W/R vs ACeP 7-colour), so we
    // dispatch on `cfg.palette` rather than the structural type.
    type AnyFrame = Frame | UC8159cFrame;
    let pendingFrame: AnyFrame | null = null;
    let rafId: number | null = null;
    const scheduleFlush = (frame: AnyFrame) => {
      pendingFrame = frame;
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        if (!pendingFrame) return;
        if (!ctx) ctx = initCanvas();
        if (ctx) {
          if (cfg.palette === 'acep') paintAcePFrame(ctx, pendingFrame as UC8159cFrame);
          else paintFrame(ctx, pendingFrame as Frame);
        }
        pendingFrame = null;
      });
    };
    cleanups.push(() => {
      if (rafId !== null) cancelAnimationFrame(rafId);
    });

    // ── Browser-side decoder + SPI hook (AVR / RP2040) ───────────────────
    const installBrowserPath = () => {
      // Pick the decoder that matches the panel's controller family. Both
      // expose .feed(byte, dcHigh) + .reset() so the SPI hook below stays
      // family-agnostic.
      const decoder =
        cfg.controllerFamily === 'uc8159c'
          ? new UC8159cDecoder({
              width: cfg.width,
              height: cfg.height,
              onFlush: (frame) => {
                scheduleFlush(frame);
                pulseBusy(refreshMs);
              },
            })
          : new SSD168xDecoder({
              width: cfg.width,
              height: cfg.height,
              onFlush: (frame) => {
                scheduleFlush(frame);
                pulseBusy(refreshMs);
              },
            });

      // CS / DC / RST pin tracking.
      let csLow = false; // start with CS de-asserted (idle)
      let dcHigh = false;
      const dcPin = getArduinoPinHelper(PIN_DC);
      const csPin = getArduinoPinHelper(PIN_CS);
      const rstPin = getArduinoPinHelper(PIN_RST);

      const pm =
        (simulator as AvrLikeSimulator).pinManager ??
        ((simulator as unknown as { pinManager: any }).pinManager as any);
      if (pm) {
        if (dcPin !== null) {
          cleanups.push(
            pm.onPinChange(dcPin, (_p: number, s: boolean) => {
              dcHigh = s;
            }),
          );
        }
        if (csPin !== null) {
          cleanups.push(
            pm.onPinChange(csPin, (_p: number, s: boolean) => {
              csLow = !s;
            }),
          );
        }
        if (rstPin !== null) {
          cleanups.push(
            pm.onPinChange(rstPin, (_p: number, s: boolean) => {
              // RST is active LOW: a falling edge resets the controller.
              if (!s) decoder.reset();
            }),
          );
        }
      }

      // SPI byte source: AVR or RP2040.
      if (isRP2040(simulator)) {
        const sim = simulator as RP2040Simulator;
        const rp = (sim as any).rp2040 as
          | { spi: Array<{ onTransmit: (v: number) => void; completeTransmit: (v: number) => void }> }
          | undefined;
        if (rp?.spi?.length) {
          // SPI0 covers the GxEPD2 default pinmap (GP18=SCK, GP19=MOSI).
          // Hook both buses; whichever the user wired will do the work.
          for (let bus = 0; bus < rp.spi.length; bus++) {
            const spi = rp.spi[bus];
            const prev = spi.onTransmit;
            spi.onTransmit = (value: number) => {
              if (csLow || csPin === null) decoder.feed(value, dcHigh);
              spi.completeTransmit(0xff);
            };
            cleanups.push(() => {
              spi.onTransmit = prev;
            });
          }
        }
      } else if (isAvr(simulator)) {
        const spi = (simulator as AvrLikeSimulator).spi!;
        const prev = spi.onByte.bind(spi);
        spi.onByte = (value: number) => {
          if (csLow || csPin === null) decoder.feed(value, dcHigh);
          spi.completeTransfer(0xff);
        };
        cleanups.push(() => {
          spi.onByte = prev;
        });
      }
    };

    // ── ESP32 backend path (decoded frames arrive over WS) ───────────────
    const installEsp32Path = () => {
      if (!isEsp32Shim(simulator)) return;
      const bridge = simulator.getBridge!();

      // Tell the backend to spin up an SSD168x slave for this component.
      const dcPin = getArduinoPinHelper(PIN_DC) ?? -1;
      const csPin = getArduinoPinHelper(PIN_CS) ?? -1;
      const rstPin = getArduinoPinHelper(PIN_RST) ?? -1;
      const busyPin = getArduinoPinHelper(PIN_BUSY) ?? -1;

      // Use a virtual-pin slot so the existing sensor wiring fits. The
      // backend matches by component_id, so the pin is just a transport
      // key; we use the DC pin number when valid, else 0xFF.
      const virtualPin = dcPin >= 0 ? dcPin : 0xff;
      simulator.registerSensor!('epaper-ssd168x', virtualPin, {
        component_id: componentId,
        panel_kind: panelKind,
        controller_family: cfg.controllerFamily,
        width: cfg.width,
        height: cfg.height,
        dc_pin: dcPin,
        cs_pin: csPin,
        rst_pin: rstPin,
        busy_pin: busyPin,
        refresh_ms: refreshMs,
      });

      const prev = bridge.onEpaperUpdate;
      bridge.onEpaperUpdate = (id, frame) => {
        prev?.(id, frame);
        if (id !== componentId) return;
        const palette = b64ToBytes(frame.b64);
        scheduleFlush({ width: frame.width, height: frame.height, pixels: palette });
        pulseBusy(frame.refreshMs);
      };

      cleanups.push(() => {
        // Restore the previous handler.
        bridge.onEpaperUpdate = prev;
        simulator.unregisterSensor?.(virtualPin);
      });
    };

    // ── Pick the path ────────────────────────────────────────────────────
    if (isEsp32Shim(simulator)) {
      installEsp32Path();
    } else if (isAvr(simulator) || isRP2040(simulator)) {
      installBrowserPath();
    }
    // Other simulators (RiscV, Esp32C3, …) silently no-op for now; the
    // canvas stays in its idle paper colour. See plan §"Out of scope".

    // ── Cleanup ──────────────────────────────────────────────────────────
    return () => {
      while (cleanups.length) {
        try {
          cleanups.pop()?.();
        } catch {
          /* ignore individual handler errors */
        }
      }
    };
  },
};

// ── Register all five panel variants under the same factory ──────────────────

for (const id of PANEL_IDS) {
  PartSimulationRegistry.register(id, epaperSimulation);
}

// Re-export so callers can introspect the supported set.
export const EPAPER_PANEL_IDS = PANEL_IDS;
export { PANEL_CONFIGS };
