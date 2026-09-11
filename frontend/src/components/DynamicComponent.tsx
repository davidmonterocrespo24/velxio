/**
 * Dynamic Component Renderer
 *
 * Generic component that renders any wokwi-element web component dynamically.
 * Replaces individual React wrapper components (LED.tsx, Resistor.tsx, etc.)
 *
 * Features:
 * - Creates web component from metadata
 * - Syncs React props to web component properties
 * - Extracts pinInfo from DOM for wire connections
 * - Handles component lifecycle
 */

import React, { useRef, useEffect, useCallback, useReducer } from 'react';
import type { ComponentMetadata } from '../types/component-metadata';
import { useSimulatorStore, getBoardSimulator } from '../store/useSimulatorStore';
import { useElectricalStore } from '../store/useElectricalStore';
import { useEditorStore } from '../store/useEditorStore';
import { buildProjectSdImage, decodeSdFiles } from '../utils/sdCardFiles';
import { PartSimulationRegistry } from '../simulation/parts';
import { dispatchSensorUpdate } from '../simulation/SensorUpdateRegistry';
import { isPiBoardKind } from '../types/board';
import { isKeyBindable, formatKeyLabel } from '../utils/keyButtonBindings';
import {
  createDefaultPinResolver,
  createSpiceResolvedPinResolver,
  configFromLogicFamily,
  type PinResolver,
} from '../simulation/PinResolver';
import { boardPinGroupFor } from '../simulation/spice/boardPinGroups';
import { traceDetailed } from '../simulation/PinTrace';
import { withPartPinOwnership, releasePartPins } from '../simulation/partPinOwnership';
import { getMixedModeScheduler } from '../simulation/spice/MixedModeScheduler';
import { getBoardLogicFamily } from '../simulation/LogicFamilies';
import { getSensorControlForComponent } from '../simulation/sensorControlConfig';

// Side-effect imports: register every web component we'll create at runtime.
// `@wokwi/elements` covers the upstream catalog; `../velxio-elements` adds
// the velxio-local elements (e.g. <velxio-capacitor-electrolytic>,
// <velxio-instr-voltmeter>) that don't exist upstream.
import '@wokwi/elements';
import '../velxio-elements';
import './velxio-components/Ssd1306I2cElement'; // registers velxio-ssd1306-i2c-4pin (4-pin I2C OLED)

// The wire-graph walk that answers "which board pin owns this component pin"
// lives in simulation/PinTrace so the store can ask the SAME question when it
// pre-registers backend sensors. Re-exported here: it was this module's API.
export { traceDetailed };

interface DynamicComponentProps {
  id: string;
  metadata: ComponentMetadata;
  properties: Record<string, any>;
  x?: number;
  y?: number;
  isSelected?: boolean;
  isHovered?: boolean;
  onMouseDown?: (e: React.MouseEvent) => void;
  /** Right click: the canvas opens the properties + pins dialog here. */
  onContextMenu?: (e: React.MouseEvent) => void;
  /** The on-canvas shortcut some parts show (the microSD card's "SD files"
   *  chip) asks the canvas to open the same inspector, left-click, any mode. */
  onOpenInspector?: (e: React.MouseEvent) => void;
  onDoubleClick?: (e: React.MouseEvent) => void;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
  onPinInfoReady?: (pinInfo: any[]) => void;
}

export const DynamicComponent: React.FC<DynamicComponentProps> = ({
  id,
  metadata,
  properties,
  x = 0,
  y = 0,
  isSelected = false,
  isHovered = false,
  onMouseDown,
  onContextMenu,
  onOpenInspector,
  onDoubleClick,
  onMouseEnter,
  onMouseLeave,
  onPinInfoReady,
}) => {
  const elementRef = useRef<HTMLElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const mountedRef = useRef(false);

  const handleComponentEvent = useSimulatorStore((s) => s.handleComponentEvent);
  const running = useSimulatorStore((s) => s.running);
  const simulator = useSimulatorStore((s) => s.simulator);
  // Board-less SPICE circuits (digital / analog gallery) have no MCU to
  // run, so `running` is always false — but interactive parts like
  // slide-switches and pushbuttons should still show a pointer cursor
  // and let the user click them. We treat board-less + un-paused as
  // "interactive" so the cursor + dialog gating mirror the MCU mode.
  const boardCount = useSimulatorStore((s) => s.boards.length);
  const electricalPaused = useElectricalStore((s) => s.paused);
  const interactionRunning = running || (boardCount === 0 && !electricalPaused);
  // hexEpoch increments each time a new hex is loaded, triggering a fresh
  // attachEvents call (and re-registration of I2C devices on the new bus).
  // We intentionally do NOT depend on `running` so that I2C displays and
  // other protocol parts (SSD1306, DS1307 …) are NOT torn down and
  // re-created on every stop/play cycle — which previously caused the
  // display to flash blank and lose its frame buffer.
  const hexEpoch = useSimulatorStore((s) => s.hexEpoch);
  // Runtime burnout (P4): destroyed parts render charred + a smoke badge.
  const isBurnt = useSimulatorStore((s) => s.burntComponents.has(id));

  // Track wires connected to this component so attachEvents re-runs when
  // wires are added or removed (e.g. disconnecting an LED cathode from GND).
  const wireFingerprint = useSimulatorStore((s) => {
    const myWires = s.wires.filter((w) => w.start.componentId === id || w.end.componentId === id);
    return myWires.map((w) => w.id).join(',');
  });

  // A custom chip attaches at hexEpoch time and skips itself when it has no
  // compiled WASM yet. Board-less circuits never load a hex, so without this
  // fingerprint a chip compiled AFTER being dropped (file-explorer hammer)
  // stayed inert forever — attachEvents had nothing to re-trigger it. Keyed
  // on sourceHash + wasm length so the debounced properties.attrs mirror from
  // live sliders does NOT churn the effect.
  const chipWasmFingerprint = useSimulatorStore((s) => {
    if (metadata.id !== 'custom-chip') return '';
    const c = s.components.find((cc) => cc.id === id);
    const p = (c?.properties ?? {}) as Record<string, unknown>;
    return `${String(p.sourceHash ?? '')}:${String(p.wasmBase64 ?? '').length}`;
  });

  // Check if component is interactive (has simulation logic with attachEvents)
  const logic = PartSimulationRegistry.get(metadata.id || id.split('-')[0]);
  const isInteractive = logic?.attachEvents !== undefined;

  // Live-controls hint: while the sim runs, a chip whose instance exposes
  // sensor controls (sliders/buttons) gets a small badge so users learn the
  // click-for-panel affordance. The per-instance resolver registers inside
  // attachEvents (an effect), i.e. AFTER the render that flipped
  // interactionRunning — the delayed bump re-checks once it has settled.
  const [, bumpControlHint] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (!interactionRunning || metadata.id !== 'custom-chip') return;
    const t = setTimeout(bumpControlHint, 150);
    return () => clearTimeout(t);
  }, [interactionRunning, metadata.id, chipWasmFingerprint]);
  // Parts with a file store the inspector manages (metadata.sdSlot marks a
  // part with its own TF slot, the Round Display; the standalone card is
  // keyed by id like everywhere else in the SD path).
  const hasSdShortcut =
    Boolean(onOpenInspector) && (metadata.id === 'microsd-card' || metadata.sdSlot === true);
  const showControlHint =
    interactionRunning &&
    metadata.id === 'custom-chip' &&
    getSensorControlForComponent({ id, metadataId: metadata.id, properties }) !== undefined;

  /**
   * Sync React properties to Web Component.
   *
   * Values arriving as strings (agent set_component_property, the text
   * inputs in the property dialog) are coerced to the type of the
   * metadata DEFAULT for that key. Without this, `el.digits = '4'`
   * (string) silently breaks wokwi elements that strict-match
   * (`switch (this.digits) { case 4: ... }` -> falls back to the 1-digit
   * pinout), and `'false'` stays truthy for boolean props like colon.
   */
  // Last property values actually applied to the element. Used to detect
  // real changes below — the store hands us a NEW properties object on every
  // update even when the values are identical, and the change-notification
  // path (dispatch 'input' → part sim → emitPropertyChange → store) would
  // otherwise echo forever.
  const appliedPropsRef = useRef<Record<string, unknown>>({});

  useEffect(() => {
    if (!elementRef.current) return;

    let changed = false;
    const numericChanges: Record<string, number> = {};
    Object.entries(properties).forEach(([key, value]) => {
      try {
        // Display framebuffers round-trip through saved projects as strings
        // ('' — the generated metadata lists imageData as a text prop).
        // Assigning that string clobbers the element's live ImageData and
        // crashes wokwi-elements' firstUpdated (putImageData TypeError).
        if (key === 'imageData' && !(value instanceof ImageData)) return;
        let coerced: any = value;
        if (typeof value === 'string') {
          const def = metadata.defaultValues?.[key];
          if (typeof def === 'number' && value.trim() !== '' && !Number.isNaN(Number(value))) {
            coerced = Number(value);
          } else if (typeof def === 'boolean') {
            coerced = value === 'true' || value === '1';
          }
        }
        (elementRef.current as any)[key] = coerced;
        if (appliedPropsRef.current[key] !== coerced) {
          appliedPropsRef.current[key] = coerced;
          changed = true;
          if (typeof coerced === 'number') numericChanges[key] = coerced;
        }
      } catch (error) {
        console.warn(`Failed to set property ${key} on ${metadata.tagName}:`, error);
      }
    });

    // A bare property assignment is invisible to the part simulators: they
    // bind to DOM events ('input'/'change' — how the element's own knob
    // notifies) or to the SensorUpdateRegistry (how the sensor panel
    // notifies). Programmatic writes — the agent's set_component_property,
    // values restored from a saved project, the property dialog — used to
    // reach the ELEMENT but never the running simulation, so a pot "set" to
    // 800 kept reading ADC 0 until a human touched its knob. Notify both
    // channels, only on real value changes (see appliedPropsRef above).
    if (changed) {
      try {
        elementRef.current.dispatchEvent(new Event('input'));
        elementRef.current.dispatchEvent(new Event('change'));
        if (Object.keys(numericChanges).length) {
          dispatchSensorUpdate(id, numericChanges);
        }
      } catch (error) {
        console.warn(`Failed to notify simulation of ${metadata.tagName} change:`, error);
      }
    }
  }, [properties, metadata.tagName, id]);

  /**
   * Property changes that swap the element's pin SET (7segment digits,
   * LED flip, display pins edge) re-render asynchronously and announce
   * themselves with a 'pininfo-change' event. Re-derive the breadboard
   * seating then — reseating synchronously on the property write would
   * read the STALE pinout and seat ghost pins.
   */
  useEffect(() => {
    const el = elementRef.current;
    if (!el) return;
    const onPinInfoChange = () => {
      try {
        useSimulatorStore.getState().reseatComponentOnBreadboard(id);
      } catch {
        // headless / tests
      }
    };
    el.addEventListener('pininfo-change', onPinInfoChange);
    return () => el.removeEventListener('pininfo-change', onPinInfoChange);
  }, [id, metadata.tagName]);

  /**
   * Reseat once the element's geometry first becomes measurable.
   *
   * A part can land in the store at its FINAL position before its element
   * mounts — the agent streams add_component + a seating move in one batch,
   * and `updateComponent`'s reseat then finds no DOM (computeSeating null)
   * and keeps the (empty) seating. Nothing re-derived it afterwards: the
   * seat-correction skips when the position needs no nudge, and
   * 'pininfo-change' only fires on pin-SET swaps, not on plain init. So the
   * part had no bb wires until the user dragged it or reloaded — a clock
   * started by the agent in that window ran against a dead display, while
   * reload+run worked (bb wires are persisted). Deriving the seating at
   * mount closes that hole for every path (agent, load, undo).
   */
  useEffect(() => {
    const tryReseat = () => {
      try {
        const pinInfo = (elementRef.current as any)?.pinInfo;
        if (pinInfo && Array.isArray(pinInfo) && pinInfo.length > 0) {
          useSimulatorStore.getState().reseatComponentOnBreadboard(id);
          return true;
        }
      } catch {
        // element not ready yet / headless tests
      }
      return false;
    };
    // Wires resolve through the same pinInfo, and the canvas' load-settle
    // timers (100/300/500ms) can ALL fire before this element is findable —
    // an overlay-defined custom element upgrades when its (large) chunk
    // lands, and on the example route the wires themselves are stored after
    // further awaits. So: the first time THIS part's pinInfo is actually
    // readable from the DOM, re-derive every wire endpoint. Measured on
    // staging: without this, all four wires to the part sat on its corner
    // until the user nudged something.
    const tryWires = () => {
      try {
        const el = document.getElementById(id) as (HTMLElement & { pinInfo?: unknown[] }) | null;
        if (el && Array.isArray(el.pinInfo) && el.pinInfo.length > 0) {
          useSimulatorStore.getState().recalculateAllWirePositions();
          return true;
        }
      } catch {
        // headless tests
      }
      return false;
    };

    const reseated = tryReseat();
    const wired = tryWires();
    if (reseated && wired) return;
    // Poll until both settle. 10s, not 2s: the overlay chunk that defines
    // the element can take that long on a slow connection, and giving up
    // early is exactly the corner-wire bug again.
    let done = { reseat: reseated, wires: wired };
    const interval = setInterval(() => {
      if (!done.reseat) done.reseat = tryReseat();
      if (!done.wires) done.wires = tryWires();
      if (done.reseat && done.wires) clearInterval(interval);
    }, 100);
    const timeout = setTimeout(() => clearInterval(interval), 10000);
    return () => {
      clearInterval(interval);
      clearTimeout(timeout);
    };
  }, [id, metadata.tagName]);

  /**
   * Extract pinInfo from web component after it initializes
   */
  useEffect(() => {
    if (!elementRef.current || !onPinInfoReady) return;

    // Wait for web component to fully initialize
    const checkPinInfo = () => {
      try {
        const pinInfo = (elementRef.current as any)?.pinInfo;
        if (pinInfo && Array.isArray(pinInfo) && pinInfo.length > 0) {
          onPinInfoReady(pinInfo);
          return true;
        }
      } catch {
        // Element not ready yet
      }
      return false;
    };

    // Try immediately
    if (checkPinInfo()) return;

    // Otherwise poll every 100ms for up to 2 seconds
    const interval = setInterval(() => {
      if (checkPinInfo()) {
        clearInterval(interval);
      }
    }, 100);

    const timeout = setTimeout(() => {
      clearInterval(interval);
    }, 2000);

    return () => {
      clearInterval(interval);
      clearTimeout(timeout);
    };
  }, [onPinInfoReady]);

  /**
   * Handle mouse events
   */
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (!onMouseDown) return;
      // Don't swallow the pointerdown for wokwi components that own their
      // own pointer interaction (rotary knobs, pushbuttons, slide-switches,
      // joysticks, keypads, encoders). For those the wokwi element binds
      // pointerdown/move/up on its shadow-DOM SVG; if we call
      // stopPropagation() in the capture phase here the internal logic
      // never sees the event and the knob can't rotate, the button never
      // reports pressed, etc.
      //
      // EVERY OTHER component (sensors, displays, LEDs, resistors, even
      // ones with attachEvents for the sensor-update / SPICE-prop bridge)
      // expects clicks to bubble up to the canvas → open the property
      // dialog or grab for drag-to-rearrange. The previous "swallow only
      // when isInteractive" heuristic was too broad: it included DHT22,
      // HC-SR04, NTC, photoresistor, LED, etc. — all of which have
      // attachEvents but no internal pointer handler, so clicks on them
      // SHOULD bubble. With the broad guard, those dialogs never opened.
      //
      // The whitelist below is tight on purpose: only add a tag name when
      // the wokwi element actually has its own pointerdown handler that
      // the user needs to reach. If a new interactive part is added,
      // append its tag here.
      const target = e.target as HTMLElement;
      // The part's own shortcut chip (SD files) is a button: it must neither
      // start a drag nor reach the canvas selection logic.
      if (target.closest?.('.velxio-part-shortcut')) {
        e.stopPropagation();
        return;
      }
      const tag = target.tagName?.toLowerCase() ?? '';
      const ownsPointer =
        interactionRunning &&
        (tag === 'wokwi-pushbutton' ||
          tag === 'wokwi-pushbutton-6mm' ||
          tag === 'wokwi-potentiometer' ||
          tag === 'wokwi-slide-potentiometer' ||
          tag === 'wokwi-slide-switch' ||
          tag === 'wokwi-dip-switch-8' ||
          tag === 'wokwi-analog-joystick' ||
          tag === 'wokwi-ky-040' ||
          tag === 'wokwi-membrane-keypad' ||
          tag === 'wokwi-rotary-dialer' ||
          // Rule-6a escape hatch: a (possibly private-overlay) element whose
          // surface IS the interaction — a touch screen — declares it via a
          // property instead of this list growing pro tag names. While the
          // sim runs, touching it must touch, not drag: the Round Display's
          // glass was painting the green dot AND dragging the shield around.
          (target as { ownsPointer?: boolean }).ownsPointer === true);
      if (ownsPointer) {
        // A declared touch SCREEN (ownsPointer property, not the wokwi tag
        // list): its model listens on POINTER events — a separate stream —
        // so stopping THIS mousedown costs it nothing, and it must be
        // stopped: left-drag that reaches the canvas background pans the
        // whole world under the finger mid-swipe. Wokwi knobs keep the
        // legacy pass-through, their internal handlers may bind this very
        // mouse event.
        if ((target as { ownsPointer?: boolean }).ownsPointer === true) e.stopPropagation();
        // Let the component own this pointerdown.
        return;
      }
      e.stopPropagation();
      onMouseDown(e);
    },
    [onMouseDown, interactionRunning],
  );

  const handleDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      if (onDoubleClick) {
        e.stopPropagation();
        onDoubleClick(e);
      }
    },
    [onDoubleClick],
  );

  /**
   * Mount web component (only once)
   */
  useEffect(() => {
    if (!containerRef.current) return;

    // Prevent double-mount in React StrictMode
    if (mountedRef.current) {
      return;
    }

    const element = document.createElement(metadata.tagName);
    element.id = id;

    // Set initial properties
    Object.entries(properties).forEach(([key, value]) => {
      try {
        // Same guard as the property-sync effect above: the persisted
        // imageData string must never replace the element's live ImageData
        // (it crashes wokwi-elements' firstUpdated on mount).
        if (key === 'imageData' && !(value instanceof ImageData)) return;
        (element as any)[key] = value;
      } catch (error) {
        console.warn(`Failed to set initial property ${key}:`, error);
      }
    });

    containerRef.current.appendChild(element);
    elementRef.current = element;
    mountedRef.current = true;

    return () => {
      if (containerRef.current && element.parentNode === containerRef.current) {
        containerRef.current.removeChild(element);
      }
      elementRef.current = null;
      mountedRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [metadata.tagName, id]); // Only re-create if tagName or id changes

  /**
   * Attach component-specific DOM events (like button presses)
   */
  useEffect(() => {
    const el = elementRef.current;
    if (!el) return;

    const onButtonPress = (e: Event) => handleComponentEvent(id, 'button-press', e);
    const onButtonRelease = (e: Event) => handleComponentEvent(id, 'button-release', e);

    el.addEventListener('button-press', onButtonPress);
    el.addEventListener('button-release', onButtonRelease);

    const logic = PartSimulationRegistry.get(metadata.id || id.split('-')[0]);

    let cleanupSimulationEvents: (() => void) | undefined;
    if (logic && logic.attachEvents) {
      // Board-less circuits (analog/digital SPICE examples) have no MCU
      // simulator, but input parts (switches, buttons, DIP switches) still
      // need their `change`/`button-press` events to fire `emitPropertyChange`
      // so the SPICE solver re-runs. Every part already guards its
      // `simulator.setPinState` / `pinManager.onPinChange` calls behind a
      // null pin lookup (`getArduinoPin` returns null when there's no board),
      // so the stub below is enough — it satisfies the type signature without
      // doing anything when called.
      // A Linux-guest board (Raspberry Pi family, UNIHIKER) has no MCU
      // emulator in the browser: the guest IS the CPU. Its simulatorMap entry
      // is the PiBridgeShim the store installs at addBoard — the object that
      // routes `setPinState` to the guest (`gpio_in`, the canvas-fed `pin<N>`
      // value) and to the PinManager, hosts the I2C / SPI device models the
      // guest's bus requests are answered against, and refuses an analog
      // input with a reason. A hand-rolled stub used to stand here instead
      // and, taking precedence over `getBoardSimulator`, kept every I2C part
      // off the board's bus.
      const { piBoardId, wiredBoardId } = (() => {
        const st = useSimulatorStore.getState();
        const ownPins = new Set<string>();
        for (const w of st.wires) {
          if (w.start.componentId === id) ownPins.add(w.start.pinName);
          if (w.end.componentId === id) ownPins.add(w.end.pinName);
        }
        let anyBoardId: string | null = null;
        for (const pinName of ownPins) {
          const { boardId } = traceDetailed(st, id, pinName, 0);
          const board = boardId ? st.boards.find((b) => b.id === boardId) : undefined;
          if (!board) continue;
          if (anyBoardId === null) anyBoardId = board.id;
          if (isPiBoardKind(board.boardKind)) return { piBoardId: board.id, wiredBoardId: board.id };
        }
        return { piBoardId: null, wiredBoardId: anyBoardId };
      })();
      const piSimulator = piBoardId ? (getBoardSimulator(piBoardId) ?? null) : null;

      // Route the part to the simulator of the board it is actually WIRED
      // to. The legacy store `simulator` is the shared AVR instance: handing
      // it to a part on an ESP32 board silently voided every direct analog
      // injection — setAdcVoltage() hit the AVR branch, GPIO 32-39 fell
      // outside its 14-19 window, and the part (analog-joystick was the
      // reported one) read 0 forever while pots survived only via the SPICE
      // solve. getBoardSimulator() returns the per-board shim (ESP32 bridge
      // shim, RP2040, AVR) that partUtils' dispatch understands.
      const wiredSimulator = wiredBoardId ? getBoardSimulator(wiredBoardId) ?? null : null;
      const stubSimulator =
        piSimulator ??
        wiredSimulator ??
        simulator ??
        ({
          setPinState: () => {},
          isRunning: () => false,
          // Board-less circuits have no MCU simulator, but a custom chip still
          // needs a real PinManager so its digital pin writes/reads reach the
          // components wired to it (LEDs, buttons, other chips). Hand it the
          // shared flat PinManager that SimulatorCanvas subscribes LEDs to, so
          // both sides talk on the same numeric/synthetic pin ids. Falls back
          // to a no-op only if even that isn't ready yet.
          pinManager:
            (useSimulatorStore.getState().pinManager as any) ?? {
              onPinChange: () => () => {},
              triggerPinChange: () => {},
            },
        } as any);
      // Helper to find Arduino pin connected to a component pin.
      // Traces through electrically-transparent passive components so that a
      // circuit like  LED-cathode → resistor → GND  returns -1 (GND) instead
      // of null. Delegates to the module-level `traceDetailed`.
      //
      // Two call shapes are supported because this same function is passed
      // BOTH to PartSimulationRegistry handlers (which call it as
      // `getArduinoPin(componentPinName)`) AND to `createDefaultPinResolver`
      // as a `PinTracer` (which calls it as `tracePin(componentId,
      // componentPinName)`). When the second arg is present we treat the
      // first as a componentId override; otherwise we use the closure-
      // captured component id. The previous single-arg signature silently
      // matched the PinTracer 2-arg call as `(componentId, undefined)` —
      // traceDetailed then looked up a pin literally named "rgb-led-1" on
      // component "rgb-led-1", got null, and the PinResolver reported
      // FLOATING forever (the canonical "wokwi-rgb-led never lights up
      // even though SPICE is driving R/G/B" symptom).
      const getArduinoPin = (
        componentIdOrPin: string,
        maybePinName?: string,
      ): number | null => {
        const state = useSimulatorStore.getState();
        const componentId = maybePinName !== undefined ? componentIdOrPin : id;
        const componentPinName =
          maybePinName !== undefined ? maybePinName : componentIdOrPin;
        return traceDetailed(state, componentId, componentPinName, 0).arduinoPin;
      };

      // PinResolver factory — Phase 0 of the mixed-mode simulator project
      // (see project/sim-mixedmode/ in the velxio-prod repo). For now it
      // wraps getArduinoPin + pinManager.onPinChange — zero behavioral
      // change vs the legacy path. Phase 1+ will swap in a SPICE-resolved
      // implementation that watches node voltages and threshold-converts
      // to logic states.
      const simState = useSimulatorStore.getState();
      const ownerBoard =
        simState.boards.find((b) => b.id === simState.activeBoardId) ?? null;
      const ownerBoardVcc =
        (ownerBoard && boardPinGroupFor(ownerBoard.boardKind).vcc) ?? 5;
      const getPinResolver = (componentPinName: string): PinResolver | null => {
        const state = useSimulatorStore.getState();
        const pinManager = (stubSimulator as {
          pinManager?: {
            onPinChange?: (pin: number, cb: (pin: number, state: boolean) => void) => () => void;
            getPinState?: (pin: number) => boolean | null;
          };
        }).pinManager;

        // Phase 1b: detect whether the path between this component pin and
        // an Arduino pin passes through any active device (BJT, MOSFET,
        // op-amp, diode, regulator).  If yes → use the SPICE-resolved
        // resolver flavor so the digital state is derived from real node
        // voltages (handles transistor inversion, op-amp gain, diode
        // forward-drop, etc.).  If no → use the legacy digital fast-path
        // (zero SPICE cost, identical to Phase 0 behavior).
        const detailed = traceDetailed(state, id, componentPinName, 0);
        if (detailed.crossedActiveDevice) {
          const scheduler = getMixedModeScheduler();
          // Phase 3: threshold model from the OWNER BOARD's logic family
          // (e.g. AVR_HC for Uno, LVCMOS33 for ESP32).  Includes Schmitt
          // hysteresis when the family declares it.  Phase 3 continued
          // will let individual components override via a `logicFamily`
          // field in components-metadata.json so e.g. a 74HC14 input
          // gets Schmitt behavior even when driven from an AVR.
          const family = ownerBoard
            ? getBoardLogicFamily(ownerBoard.boardKind)
            : { vcc: ownerBoardVcc, vil: ownerBoardVcc / 2, vih: ownerBoardVcc / 2 };
          return createSpiceResolvedPinResolver(
            id,
            componentPinName,
            scheduler,
            configFromLogicFamily(family),
          );
        }

        return createDefaultPinResolver(
          id,
          componentPinName,
          {
            components: state.components,
            boards: state.boards,
            wires: state.wires,
            ownerBoard,
            ownerBoardVcc,
            subscribeArduinoPin: (pin, cb) => {
              if (!pinManager?.onPinChange) return () => {};
              return pinManager.onPinChange(pin, cb);
            },
            readArduinoPin: (pin) => {
              if (!pinManager?.getPinState) return null;
              try {
                return pinManager.getPinState(pin);
              } catch {
                return null;
              }
            },
          },
          getArduinoPin,
        );
      };

      // microSD auto-copy (free, Wokwi model): bake the project's workspace
      // files into a FAT16 image the card serves over SD-over-SPI. Paid uploads
      // (the "SD Card" panel) will merge into this list in a later phase.
      if (metadata.id === 'microsd-card') {
        try {
          const uploaded = decodeSdFiles(properties.sdFiles); // paid uploads (if any)
          (el as unknown as { sdImageData?: Uint8Array }).sdImageData =
            buildProjectSdImage(useEditorStore.getState().files, uploaded);
        } catch (e) {
          console.warn('[microsd] SD image build failed:', e);
        }
      }

      // Every pin this part drives itself becomes ITS pin for as long as it is
      // attached, so the SPICE-threshold input path leaves that line alone (see
      // simulation/partPinOwnership). Claims are implicit — a part that never
      // drives a pin never takes one — and released in the cleanup below, so a
      // rewire or an unmount hands the pin straight back to the circuit.
      releasePartPins(id);
      const ownedSimulator = withPartPinOwnership(
        stubSimulator,
        piBoardId ?? wiredBoardId ?? useSimulatorStore.getState().activeBoardId ?? null,
        id,
        metadata.id,
      );

      // A part that throws while attaching must not take the editor with it.
      // `piBoardKind` was referenced here but never destructured, so every
      // DHT22 or HC-SR04 wired to a Pi-family board threw a ReferenceError out
      // of attachEvents — and with no error boundary anywhere in this app, the
      // whole React root unmounted. The user did not get a broken sensor, they
      // got a blank white page, on a canvas they could no longer edit to undo
      // it. One missing identifier should cost one dead part, not the app.
      try {
        cleanupSimulationEvents = logic.attachEvents(
          el,
          ownedSimulator,
          getArduinoPin,
          id,
          getPinResolver,
        );
      } catch (e) {
        console.error(`[part] ${metadata.id} (${id}) failed to attach:`, e);
        cleanupSimulationEvents = undefined;
      }
    }

    return () => {
      if (cleanupSimulationEvents) cleanupSimulationEvents();
      releasePartPins(id);

      el.removeEventListener('button-press', onButtonPress);
      el.removeEventListener('button-release', onButtonRelease);
    };
  }, [id, handleComponentEvent, metadata.id, simulator, hexEpoch, wireFingerprint, chipWasmFingerprint]);

  // The wrapper uses `onMouseDownCapture` (not `onMouseDown`) so it sees
  // the mousedown BEFORE the inner wokwi-element. Interactive wokwi parts
  // (pushbutton, slide-switch, potentiometer …) call stopPropagation in
  // their own bubble-phase handlers, which used to prevent any drag from
  // starting once the simulator was running. Capture phase fires first
  // and lets the canvas's drag-threshold logic distinguish click vs drag
  // at mouseup time — so the user can rearrange interactive components
  // while simulation is live.
  return (
    <div
      className={`dynamic-component-wrapper${isBurnt ? ' velxio-burnt' : ''}${
        isSelected ? ' velxio-ants' : ''
      }`}
      style={{
        position: 'absolute',
        left: `${x}px`,
        top: `${y}px`,
        cursor: interactionRunning && isInteractive ? 'pointer' : 'move',
        // The selection outline itself is the .velxio-ants pseudo-element
        // (a static dashed border cannot be animated). The transparent
        // border stays so selecting does not shift the body by 2px.
        border: '2px solid transparent',
        borderRadius: '4px',
        padding: '4px',
        userSelect: 'none',
        // Drag-to-front (zRaise) beats the static layers: a part dragged onto
        // a board — or a board dragged onto a part — the last one dragged
        // paints on top. Untouched parts keep the classic selected/idle z.
        // Local order inside .component-interactive-group only. The
        // drag-to-front rank is applied on that GROUP (SimulatorCanvas) —
        // a z set here is clamped by the group's stacking context and could
        // never lift the part above a dragged board.
        zIndex: isSelected ? 5 : 1,
        pointerEvents: 'auto',
        transform: properties.rotation ? `rotate(${properties.rotation}deg)` : undefined,
        transformOrigin: 'center center',
      }}
      onMouseDownCapture={handleMouseDown}
      // Capture phase: interactive parts (pushbutton, switch, pot) stop
      // propagation in their own handlers, which would otherwise swallow the
      // right click before the canvas ever saw it.
      onContextMenuCapture={onContextMenu}
      onTouchStartCapture={(e) => {
        // Mobile mirror of the ownsPointer guard: while the sim runs, a
        // finger on a declared touch screen is INPUT for the screen (its
        // pointer handlers still fire), never a canvas pan/drag gesture.
        const t = e.target as { ownsPointer?: boolean };
        if (interactionRunning && t.ownsPointer === true) e.stopPropagation();
      }}
      onDoubleClick={handleDoubleClick}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      data-component-id={id}
      data-component-type={metadata.id}
    >
      {/* Container for web component */}
      <div ref={containerRef} className="web-component-container" />

      {/* Live-controls hint: this chip has a slider/button panel — click it */}
      {showControlHint && !isBurnt && (
        <div
          className="velxio-control-hint"
          title="Live controls — click the chip"
          aria-hidden="true"
          style={{
            position: 'absolute',
            top: '-7px',
            right: '-7px',
            width: '18px',
            height: '18px',
            borderRadius: '50%',
            background: '#7c3aed',
            border: '1.5px solid #c4b5fd',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            pointerEvents: 'none',
            zIndex: 6,
            boxShadow: '0 0 6px rgba(124, 58, 237, 0.8)',
          }}
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round">
            <line x1="4" y1="7" x2="20" y2="7" />
            <circle cx="9" cy="7" r="2.6" fill="#fff" stroke="none" />
            <line x1="4" y1="17" x2="20" y2="17" />
            <circle cx="15" cy="17" r="2.6" fill="#fff" stroke="none" />
          </svg>
        </div>
      )}

      {/* Runtime-burnout smoke badge (P4) */}
      {isBurnt && (
        <div
          className="velxio-burnt-smoke"
          aria-hidden="true"
          style={{ position: 'absolute', top: '-7px', right: '-7px', pointerEvents: 'none', zIndex: 6 }}
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
            <circle cx="8" cy="14" r="5" fill="#6b7280" opacity="0.85" />
            <circle cx="14" cy="11" r="6" fill="#9ca3af" opacity="0.85" />
            <circle cx="17" cy="16" r="4" fill="#4b5563" opacity="0.85" />
            <circle cx="11" cy="8" r="3.5" fill="#9ca3af" opacity="0.7" />
          </svg>
        </div>
      )}

      {/* Component label — revealed on hover/selection only.
          A dense board (e.g. 8 vertical resistors at 19 px pitch) turned into
          a wall of overlapping "Resistor 220 Ω" text that hid the breadboard
          holes and the parts themselves. Hidden with OPACITY, never
          `display`/`position`: pinPositionCalculator derives the rotation
          pivot from `wrapper.offsetHeight`, so taking the label out of flow
          would move every rotated component's pins. */}
      <div
        className="component-label"
        style={{
          fontSize: '11px',
          textAlign: 'center',
          marginTop: '4px',
          color: '#666',
          pointerEvents: 'none',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '4px',
          opacity: isHovered || isSelected || hasSdShortcut ? 1 : 0,
          transition: 'opacity 120ms ease-out',
        }}
      >
        {properties.pin !== undefined ? `Pin ${properties.pin}` : metadata.name}
        {/* The card's files live in the inspector, which only a right-click
            reached: nobody found the upload there. This chip is the visible
            way in, and it stays up while the simulation runs too (the live
            "Card contents" listing is most useful then). */}
        {hasSdShortcut && (
          <button
            type="button"
            className="velxio-part-shortcut"
            title="Files on the SD card: upload your own, download what the sketch wrote"
            onClick={onOpenInspector}
            style={{
              pointerEvents: 'auto',
              cursor: 'pointer',
              fontSize: '10px',
              fontWeight: 600,
              lineHeight: '1.2',
              padding: '2px 7px',
              borderRadius: '10px',
              border: '1px solid #0071e3',
              background: '#0071e3',
              color: '#fff',
              whiteSpace: 'nowrap',
              display: 'inline-flex',
              alignItems: 'center',
              gap: '4px',
            }}
          >
            <svg width="9" height="11" viewBox="0 0 9 11" fill="none" aria-hidden="true">
              <path d="M3 0.5h5.5v10h-8v-7.5z" stroke="#fff" strokeWidth="1" strokeLinejoin="round" />
              <path d="M2.5 2.5v2M4.5 2.5v2M6.5 2.5v2" stroke="#fff" strokeWidth="1" />
            </svg>
            SD files
          </button>
        )}
        {isKeyBindable(metadata.id) && typeof properties.key === 'string' && properties.key && (
          <span
            style={{
              fontSize: '9px',
              padding: '1px 5px',
              borderRadius: '3px',
              backgroundColor: '#2d2d2d',
              color: '#ddd',
              border: '1px solid #555',
              borderBottomWidth: '2px',
              fontFamily: "'SFMono-Regular', Consolas, 'Liberation Mono', monospace",
              fontWeight: 600,
              lineHeight: '1.3',
              whiteSpace: 'nowrap',
            }}
          >
            {formatKeyLabel(properties.key)}
          </span>
        )}
        {properties.protocol && (
          <span
            style={{
              fontSize: '9px',
              padding: '1px 4px',
              borderRadius: '3px',
              backgroundColor: properties.protocol === 'spi' ? '#e67e22' : '#3498db',
              color: '#fff',
              fontWeight: 600,
              textTransform: 'uppercase',
              lineHeight: '1.2',
            }}
          >
            {String(properties.protocol)}
          </span>
        )}
      </div>
    </div>
  );
};

/**
 * Helper function to create a component instance from metadata
 */
export function createComponentFromMetadata(
  metadata: ComponentMetadata,
  x: number,
  y: number,
): {
  id: string;
  metadataId: string;
  x: number;
  y: number;
  properties: Record<string, any>;
} {
  // Underscore separators (not '-') so the resulting id is safe to embed
  // in SPICE component / source names. ngspice's WASM build truncates
  // vector keys at '-', which broke branch-current lookups for any LED /
  // ammeter wired up by the user (visible symptom: correct node voltage,
  // dark LED). Also strip '-' from metadata.id (e.g. 'led-bar-graph') so
  // the prefix doesn't reintroduce a hyphen.
  const safePrefix = metadata.id.replace(/-/g, '_');
  const properties: Record<string, any> = { ...metadata.defaultValues };
  // Resistors default to vertical: they read better, take less horizontal
  // space, and drop straight into breadboard columns (their pin span
  // bridges the center trench). Covers 'resistor' and every preconfigured
  // 'resistor-<value>' variant; anything with an explicit rotation in its
  // metadata defaults keeps it.
  if (metadata.id.startsWith('resistor') && properties.rotation === undefined) {
    properties.rotation = 90;
  }
  return {
    id: `${safePrefix}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    metadataId: metadata.id,
    x,
    y,
    properties,
  };
}
