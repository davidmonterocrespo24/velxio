/**
 * connectMcuEdgesToService — bridges MCU pin transitions to the
 * CircuitSimulationService, completing the mixed-mode loop.
 *
 * Without this wiring, the service only re-solves on canvas changes —
 * MCU edges propagate via PinManager → component handlers directly,
 * but SPICE never sees them.  This module:
 *
 *   1. Subscribes to each board's PinManager for every pin referenced
 *      by a wire (i.e., pins that appear in the SPICE netlist).
 *   2. Hands every edge to `service.handleMcuEdge(boardId, pinName,
 *      state, vcc, guestMs)` as it happens, stamped with the board's own
 *      clock when the engine has one.
 *
 * Nothing is coalesced here any more. Until 2026-10 this module kept the
 * last state per pin for 16 ms and the service queued last-state-wins on
 * top of that, and between the two a level that lasted less than a solve
 * plus a gap was never seen by the solver: a 50 ms step of a 16-LED scan
 * lit only the LEDs at the turnarounds. The service's PadTimeline now
 * integrates every edge in time and bounds the solver by solving each
 * distinct pad state once per window, so the right place for an edge is
 * the timeline, at once, with its time.
 *
 * Lifecycle: mount alongside the service in EditorPage.  Re-subscribes
 * when boards change (board lifecycle = new PinManager instance).
 */
import {
  useSimulatorStore,
  getBoardPinManager,
  getBoardSimulator,
} from '../../store/useSimulatorStore';
import { stm32LinearToPinName, stm32PinNameToLinear } from '../Stm32Bridge';
import { isStm32BoardKind, isPiBoardKind } from '../../types/board';
import type { BoardKind } from '../../types/board';
import { useElectricalStore } from '../../store/useElectricalStore';
import { boardPinGroupFor } from './boardPinGroups';
import { pinNameToArduinoPin } from './collectPinStates';
import type { CircuitSimulationService } from './CircuitSimulationService';

/**
 * The board's own clock in milliseconds, or null when the engine keeps
 * none the service can read. Same two doors as parts/partUtils'
 * `guestMillis` (not imported: that module pulls an engine in). Read on
 * every edge, so it stays two property lookups and a division.
 */
function guestMsOf(sim: unknown): number | null {
  const s = sim as {
    getGuestMicros?: () => number;
    getCurrentCycles?: () => number;
    getClockHz?: () => number;
  } | undefined;
  if (!s) return null;
  if (typeof s.getGuestMicros === 'function') {
    const us = s.getGuestMicros();
    return Number.isFinite(us) && us >= 0 ? us / 1000 : null;
  }
  if (typeof s.getCurrentCycles === 'function' && typeof s.getClockHz === 'function') {
    const cycles = s.getCurrentCycles();
    const hz = s.getClockHz();
    return Number.isFinite(cycles) && cycles >= 0 && Number.isFinite(hz) && hz > 0
      ? (cycles / hz) * 1000
      : null;
  }
  return null;
}

/**
 * Wire MCU pin transitions to the service.  Returns an unsubscribe
 * handle.  Idempotent — calling twice double-subscribes; callers
 * should hold a single instance per editor mount.
 */
export function connectMcuEdgesToService(service: CircuitSimulationService): () => void {
  // Per-board, per-pin subscriptions (Arduino pin number → unsubscribe).
  const boardSubs = new Map<string, Map<number, () => void>>();
  function arduinoPinToName(arduinoPin: number, boardKind: string): string | null {
    // Reverse of pinNameToArduinoPin in subscribeToStore.ts.  Both
    // need to live until subscribeToStore is deleted; trade-off
    // accepted for now since the mapping is per-board-family.
    if (boardKind === 'arduino-uno' || boardKind === 'arduino-nano' || boardKind === 'arduino-mega') {
      if (arduinoPin >= 14 && arduinoPin <= 21) return `A${arduinoPin - 14}`;
      return String(arduinoPin);
    }
    if (boardKind === 'raspberry-pi-pico' || boardKind === 'pi-pico-w') {
      return `GP${arduinoPin}`;
    }
    if (boardKind.startsWith('esp32')) {
      return `GPIO${arduinoPin}`;
    }
    // STM32 wires reference port-style names (PA0 / PC13); its PinManager is
    // keyed on the linear pin index. Without this reverse mapping the MCU-edge
    // listener never attaches ("13" ≠ "PC13") — previously masked because
    // PinManager requested a full re-solve on EVERY mcu edge; now that the
    // full tick only fires on first classification, this fine-grained path
    // must actually cover STM32.
    if (isStm32BoardKind(boardKind)) {
      return stm32LinearToPinName(arduinoPin);
    }
    // Raspberry Pi (Linux boards) wires use GPIO-style names like ESP32.
    if (isPiBoardKind(boardKind)) {
      return `GPIO${arduinoPin}`;
    }
    // ATtiny85 wires reference port-style names (PB0..PB5), matching the
    // netlist pin names from collectPinStates. Without this, the reverse
    // mapping returns "1" instead of "PB1", so the MCU-edge listener is
    // never attached (pin name not in `pinsInCircuit`) and the SPICE
    // V-source is never altered on digitalWrite LOW — the LED latches ON
    // (and analogWrite duty changes never re-solve). See pinNameToArduinoPin.
    if (boardKind === 'attiny85') {
      return `PB${arduinoPin}`;
    }
    return String(arduinoPin);
  }

  /**
   * Look up which pin names this board actually wires into the SPICE
   * netlist.  Reads from `pinNetMap` (populated after each solve) so
   * we subscribe to ~3-8 pins per board instead of all 64.
   *
   * Phase 1d #11: previously we subscribed to every Arduino pin 0..63
   * "since unused listeners are free" — true for AVR (8 pins) but
   * spammy for ESP32 (40+ GPIOs × multiple boards = thousands of
   * dead listeners).  Now scoped to pins the circuit references.
   */
  function pinsInCircuit(boardId: string): Set<string> {
    const { pinNetMap } = useElectricalStore.getState();
    const pins = new Set<string>();
    for (const key of pinNetMap.keys()) {
      const idx = key.indexOf(':');
      if (idx < 0) continue;
      if (key.slice(0, idx) === boardId) pins.add(key.slice(idx + 1));
    }
    return pins;
  }

  function subscribeBoard(boardId: string, boardKind: string): void {
    const pm = getBoardPinManager(boardId);
    if (!pm) return;
    const group = boardPinGroupFor(boardKind);
    const vcc = group.vcc;

    const pinSubs = new Map<number, () => void>();
    boardSubs.set(boardId, pinSubs);

    const wanted = pinsInCircuit(boardId);

    // Resolve which (pin number, pin name) pairs to listen on.
    //
    // When the netlist has been solved at least once, `wanted` holds the
    // EXACT pin names the wires reference ('2', 'A0', 'GP4', 'PC13', …) —
    // the same names collectPinStates keyed the V-sources on. Map each of
    // those through the SAME name→number function so the listener fires
    // on the right PinManager pin AND `handleMcuEdge` receives the name
    // whose `v_<board>_<name>` source actually exists (fast alterSource
    // path, no per-edge rebuild). The previous approach reversed pin
    // NUMBERS to names instead ('GPIO2' on ESP32) which never matched the
    // wire names, so every resubscription after a mid-run pinNetMap
    // change (e.g. a gpio_pull reported by pure ESP-IDF's gpio_reset_pin)
    // silently detached all MCU-edge listeners and froze LEDs.
    //
    // Before the first solve (`wanted` empty) fall back to the historical
    // 0..63 sweep with the reverse-mapped names.
    const listenPins: Array<{ pin: number; pinName: string }> = [];
    if (wanted.size > 0) {
      const isStm32 = isStm32BoardKind(boardKind);
      for (const pinName of wanted) {
        const pin = isStm32
          ? stm32PinNameToLinear(pinName)
          : pinNameToArduinoPin(pinName, boardKind as BoardKind);
        if (pin < 0) continue;
        listenPins.push({ pin, pinName });
      }
    } else {
      for (let pin = 0; pin < 64; pin++) {
        const pinName = arduinoPinToName(pin, boardKind);
        if (!pinName) continue;
        listenPins.push({ pin, pinName });
      }
    }

    const sim = getBoardSimulator(boardId);
    for (const { pin, pinName } of listenPins) {
      const unsub = pm.onPinChange(pin, (_p, state) => {
        // Suppress digital edges when the pin has active PWM. The OCR-based
        // PWM duty is converted to a DC-averaged voltage in NetlistBuilder
        // (`state.duty * board.vcc`), giving smooth analog dimming. If we
        // also let the Timer1/Timer2-driven port toggles fire alterSource,
        // each PWM cycle's HIGH/LOW transition would race with the duty
        // average and force the V-source to bounce between 0 and vcc —
        // making `analogWrite(pin, 128)` look like a binary blink instead
        // of a steady 2.5 V (Fade-LED example regression).
        if (pm.getPwmValue(pin) > 0) return;
        void service.handleMcuEdge(boardId, pinName, state, vcc, guestMsOf(sim));
      });
      pinSubs.set(pin, unsub);

      // Re-tick when PWM duty changes so the duty-averaged V-source picks
      // up new analogWrite values. Without this, duty stays whatever it was
      // at first solve and `analogWrite()` in a loop never updates the
      // visible LED. Throttled to ~60 Hz to amortise the netlist-rebuild
      // cost (the firmware ramps brightness every 30 ms in the canonical
      // Fade-LED example, well within this budget).
      let pwmTickPending = false;
      const unsubPwm = pm.onPwmChange(pin, () => {
        if (pwmTickPending) return;
        pwmTickPending = true;
        setTimeout(() => {
          pwmTickPending = false;
          void service.tick();
        }, 16);
      });
      pinSubs.set(pin + 1000, unsubPwm); // key offset to avoid collision
    }
  }

  function unsubscribeBoard(boardId: string): void {
    const pinSubs = boardSubs.get(boardId);
    if (!pinSubs) return;
    for (const unsub of pinSubs.values()) unsub();
    boardSubs.delete(boardId);
  }

  function syncBoardSubscriptions(): void {
    const boards = useSimulatorStore.getState().boards;
    const wanted = new Set(boards.map((b) => b.id));
    for (const id of Array.from(boardSubs.keys())) {
      if (!wanted.has(id)) unsubscribeBoard(id);
    }
    for (const b of boards) {
      if (!boardSubs.has(b.id)) subscribeBoard(b.id, b.boardKind);
    }
  }

  syncBoardSubscriptions();

  const unsubBoards = useSimulatorStore.subscribe((state, prev) => {
    if (state.boards !== prev.boards) syncBoardSubscriptions();
  });

  // Re-subscribe when the pinNetMap changes — a new wire / removed
  // wire might add or drop pins that need listeners.  Drop ALL subs
  // and re-create from the new pinNetMap (cheap: a Map clear and
  // ~10 pm.onPinChange calls).
  const unsubElectrical = useElectricalStore.subscribe((state, prev) => {
    if (state.pinNetMap === prev.pinNetMap) return;
    const boards = useSimulatorStore.getState().boards;
    for (const id of Array.from(boardSubs.keys())) unsubscribeBoard(id);
    for (const b of boards) subscribeBoard(b.id, b.boardKind);
  });

  return () => {
    unsubBoards();
    unsubElectrical();
    for (const pinSubs of boardSubs.values()) {
      for (const unsub of pinSubs.values()) unsub();
    }
    boardSubs.clear();
  };
}
