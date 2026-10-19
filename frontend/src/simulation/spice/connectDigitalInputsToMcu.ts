/**
 * connectDigitalInputsToMcu — drive ESP32 digital input pins from the
 * solved circuit, so `digitalRead()` reflects the REAL wiring.
 *
 * The ESP32 runs in backend QEMU; its GPIO input register is fed only by
 * whatever the host injects via `esp32_gpio_in`. Historically a button was
 * faked by the part layer (BasicParts seeds the pin HIGH and toggles it on
 * press) — which ignores the actual circuit, so a mis-wired button still
 * "worked". This connector replaces that for ESP32: after every SPICE solve
 * it thresholds each input pin's net voltage and pushes the logic level into
 * QEMU. Now the internal pull-up (modelled as a netlist resistor), the button
 * switch, the GND connection and any short are all honoured — a button wired
 * to the wrong terminal reads stuck-LOW, exactly like real silicon.
 *
 * Mirrors `connectAnalogInputsToMcu` (ADC path) and `connectChipInputsToSolve`
 * (custom-chip path): it knows ONLY the electrical store shape.
 *
 * Only pins the MCU is NOT actively driving as outputs are injected, so we
 * never fight a `digitalWrite`. Every simulator that opts in with
 * `spiceDrivenInputs` takes this path — AVR, RP2040, STM32 and the ESP32
 * bridges all do today.
 *
 * TWO kinds of pin are left alone, and the reason is the same for both: some
 * parts have no electrical model at all, so the solved node says nothing about
 * what they are doing.
 *  - pins a PART drives itself (simulation/partPinOwnership): an HC-SR04's
 *    ECHO pulse, a DHT22's frame, a rotary encoder's edges;
 *  - pins the board's own bridge reports as sensor-owned (`ownsPin`), which is
 *    what a backend- or engine-emulated sensor registers.
 * The older `sourcedNets` gate below tried to cover this by skipping nets no
 * component sits on, and that works right up until the user wires the sensor
 * the way real hardware needs it — a pull-up, or the level divider a 5 V
 * HC-SR04 needs to talk to a 3.3 V pad. Then the net IS component-backed, it
 * solves at whatever the passives say (~0 V, since nothing models the sensor's
 * output), and this connector pins the very line the sensor is answering on.
 */
import { useSimulatorStore, getBoardSimulator, getBoardPinManager } from '../../store/useSimulatorStore';
import { isPartOwnedPin } from '../partPinOwnership';
import { useElectricalStore } from '../../store/useElectricalStore';
import { isStm32BoardKind } from '../../types/board';
import type { BoardKind } from '../../types/board';
import { stm32PinNameToLinear } from '../Stm32Bridge';
import { boardPinToNumber } from '../../utils/boardPinMapping';
import { sanitizeSpiceId } from './NetlistBuilder';

// 3.3 V LVCMOS thresholds with a hysteresis band so a node hovering near the
// midpoint doesn't chatter. A pulled-up idle input sits at ~3.3 V and a
// pressed button pulls it to ~0 V, so the band is rarely entered.
const V_HIGH = 2.0;
const V_LOW = 0.8;

/** Map a board pin name to a plain GPIO number, or -1 if it isn't one we
 *  drive digitally (GND/VCC/UART-named pads, etc.). Delegates to the
 *  canonical silkscreen->GPIO table so labeled pins resolve too — the old
 *  digits/GPIO-only regex returned -1 for nano-esp32 'D2'/'A0', which left
 *  INPUT_PULLUP buttons permanently LOW on that family (2026-07 audit). */
function gpioFromPinName(name: string, boardKind: BoardKind): number {
  const n = boardPinToNumber(boardKind, name);
  if (n != null) return n;
  if (/^\d+$/.test(name)) return parseInt(name, 10); // "4", "15"
  const m = name.match(/^GPIO(\d+)$/i) || name.match(/^GP(\d+)$/i);
  return m ? parseInt(m[1], 10) : -1;
}

export function connectDigitalInputsToMcu(): () => void {
  // Last logic level pushed per `${boardId}:${gpio}`, so we only emit edges
  // and the hysteresis band can hold the previous level. This connector is
  // the sole writer of ESP32 input pins, so the cache tracks QEMU's state.
  const lastLevel = new Map<string, boolean>();

  function injectDigitalInputs() {
    const { nodeVoltages, pinNetMap, sourcedNets, voltageSources } = useElectricalStore.getState();
    const sources = new Set(voltageSources ?? []);
    const { boards } = useSimulatorStore.getState();
    for (const board of boards) {
      const sim = getBoardSimulator(board.id) as
        | {
            setPinState?: (pin: number, state: boolean) => void;
            spiceDrivenInputs?: boolean;
            /** Optional seam: pins the simulator/bridge drives itself. */
            ownsPin?: (pin: number) => boolean;
          }
        | null;
      if (!sim?.spiceDrivenInputs || typeof sim.setPinState !== 'function') continue;
      const pm = getBoardPinManager(board.id);
      const driven = pm ? pm.getOutputPins() : new Set<number>();
      const prefix = `${board.id}:`;
      // STM32 names pins PA0/PC13/… and its PinManager + setPinState key on the
      // linear pin (port*16+pin); every other board uses plain GPIO numbers.
      const isStm32 = isStm32BoardKind(board.boardKind);
      for (const [key, net] of pinNetMap) {
        if (!key.startsWith(prefix)) continue;
        const pinName = key.slice(prefix.length);
        const gpio = isStm32 ? stm32PinNameToLinear(pinName) : gpioFromPinName(pinName, board.boardKind);
        if (gpio < 0) continue;
        if (driven.has(gpio)) continue; // the MCU drives this pin (digitalWrite)
        // A deck that still carries this pad's OWN source is stale: the pad
        // was an output when the netlist was built and has since been reset
        // (Stop, Reset) or released (pinMode(INPUT)). Its net solves at the
        // level the pad itself last drove, and pushing that back in would
        // make the firmware read its own ghost. Measured on the Grove relay
        // example: Stop with the contact closed re-latched the relay and the
        // motor ran at full speed with the board powered off. Forget the
        // memory too, so the first honest solve after the rebuild is emitted
        // even if it agrees with what was pushed before.
        if (sources.has(`v_${sanitizeSpiceId(board.id)}_${sanitizeSpiceId(pinName)}`.toLowerCase())) {
          lastLevel.delete(`${board.id}:${gpio}`);
          continue;
        }
        // A part that models this line ITSELF (an HC-SR04's ECHO pulse, a
        // DHT22's frame, an encoder's edges) owns it — see partPinOwnership.
        // The `sourcedNets` gate below cannot protect those: the moment the
        // user adds the pull-up or the level divider real hardware needs, the
        // net is component-backed and solves at whatever the passives say,
        // which is not what the part is driving.
        if (isPartOwnedPin(board.id, gpio) || sim.ownsPin?.(gpio)) {
          // Forget what we last pushed here. While the part drove the line the
          // guest's level was whatever the part made it, so the moment the
          // part lets go (rewire, unmount, detach) the next solve must emit
          // even if the circuit happens to agree with our stale memory.
          lastLevel.delete(`${board.id}:${gpio}`);
          continue;
        }
        // Only drive pins whose net is backed by a real source/element (rail,
        // pull, button switch, divider, cross-board output, …). A net that is
        // only floating (an event-driven part like a rotary encoder / keypad
        // that has no SPICE model) is left to the part layer, which seeds the
        // pin directly — otherwise its ~0 V floating read would force it LOW
        // and fight the part. This is what makes it safe to enable
        // spiceDrivenInputs on the AVR (which has many such part-driven pins).
        if (!sourcedNets.has(net)) continue;
        const v = nodeVoltages[net];
        if (v == null) continue;
        // A number the solver could not produce is not a level. ngspice hands
        // back NaN / Infinity for a node whose transient step never converged,
        // and a circuit full of relay coils gives it plenty of chances: an
        // ideal switch, a flyback diode and 20 mH is a stiff little system. A
        // NaN fails both threshold tests, so it used to fall through to the
        // `prev ?? false` below and every input pin on the board went LOW in
        // the same pass — which reads exactly like several buttons pressed at
        // once, out of nowhere, and recovering by itself (issue #333). Hold
        // what the pin already had and wait for a solve that means something.
        if (!Number.isFinite(v)) continue;
        const stateKey = `${board.id}:${gpio}`;
        const prev = lastLevel.get(stateKey);
        let next: boolean;
        if (v >= V_HIGH) next = true;
        else if (v <= V_LOW) next = false;
        else if (prev !== undefined) next = prev; // inside the band — hold
        // A node sitting in the undefined band with no history is not
        // something to have an opinion about: real silicon reads it as
        // whatever its own input stage decides, and inventing a LOW here
        // pushed a falling edge into the guest that no circuit asked for.
        else continue;
        if (prev === next) continue;
        lastLevel.set(stateKey, next);
        sim.setPinState(gpio, next);
      }
    }
  }

  const unsubResult = useElectricalStore.subscribe((state, prev) => {
    if (state.nodeVoltages !== prev.nodeVoltages) injectDigitalInputs();
  });
  // Reset the cache when boards change (Run / Reset spawns a fresh QEMU whose
  // GPIO inputs default LOW, so we must re-emit even unchanged levels).
  const unsubBoards = useSimulatorStore.subscribe((state, prev) => {
    if (state.boards !== prev.boards) lastLevel.clear();
  });
  // Initial pass for examples that pre-populate the store before mount.
  injectDigitalInputs();
  return () => {
    unsubResult();
    unsubBoards();
  };
}
