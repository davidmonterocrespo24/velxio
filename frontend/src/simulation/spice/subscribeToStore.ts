/**
 * Hooks up the electrical solver to the main simulator store:
 *   - subscribe to components, wires, pin changes
 *   - on change, build the input and request a solve
 *   - inject node voltages back into ADC channels
 *
 * Called once at app startup (typically from EditorPage or main.tsx).
 * Returns an `unsubscribe()` for cleanup.
 */
import {
  useSimulatorStore,
  getBoardSimulator,
  getBoardPinManager,
} from '../../store/useSimulatorStore';
import { useElectricalStore } from '../../store/useElectricalStore';
import { buildInputFromStore } from './storeAdapter';
import { setAdcVoltage } from '../parts/partUtils';
import type { PinSourceState } from './types';
import type { BoardKind } from '../../types/board';
import { BOARD_PIN_GROUPS } from './boardPinGroups';
import { interpolateAt } from './waveformStats';

// Which Arduino-style pin name maps to which ADC channel, per board.
// Used to inject SPICE-solved voltages back into the MCU's ADC peripheral.
function adcRange(prefix: string, start: number, count: number) {
  return Array.from({ length: count }, (_, i) => ({
    pinName: `${prefix}${start + i}`,
    channel: i,
  }));
}

const ADC_6CH = adcRange('A', 0, 6); // A0..A5
const ADC_8CH = adcRange('A', 0, 8); // A0..A7
const ADC_16CH = adcRange('A', 0, 16); // A0..A15

const ADC_PIN_MAP: Partial<Record<BoardKind, Array<{ pinName: string; channel: number }>>> = {
  // AVR boards
  'arduino-uno': ADC_6CH,
  'arduino-nano': ADC_8CH,
  'arduino-mega': ADC_16CH,
  attiny85: adcRange('A', 0, 4), // A0..A3 (PB2-PB5)

  // RP2040 boards — 4 ADC channels (GP26-GP29)
  'raspberry-pi-pico': [
    { pinName: 'GP26', channel: 0 },
    { pinName: 'GP27', channel: 1 },
    { pinName: 'GP28', channel: 2 },
    { pinName: 'GP29', channel: 3 },
  ],
  'pi-pico-w': [
    { pinName: 'GP26', channel: 0 },
    { pinName: 'GP27', channel: 1 },
    { pinName: 'GP28', channel: 2 },
    { pinName: 'GP29', channel: 3 },
  ],

  // ESP32 variants — most GPIOs can be ADC but the common ones are:
  // ADC1: GPIO 32-39 (channels 0-7), ADC2: GPIO 0,2,4,12-15,25-27
  // Simplified to the 8 most-used pins (GPIO 32-39 = ADC1)
  esp32: adcRange('GPIO', 32, 8),
  'esp32-devkit-c-v4': adcRange('GPIO', 32, 8),
  'esp32-cam': adcRange('GPIO', 32, 8),
  'wemos-lolin32-lite': adcRange('GPIO', 32, 8),

  // ESP32-S3 — ADC1 channels on GPIO 1-10, ADC2 on GPIO 11-20
  'esp32-s3': adcRange('GPIO', 1, 10),
  'xiao-esp32-s3': adcRange('GPIO', 1, 10),
  'arduino-nano-esp32': adcRange('A', 0, 8),

  // ESP32-C3 — ADC1 channels on GPIO 0-4, ADC2 on GPIO 5
  'esp32-c3': adcRange('GPIO', 0, 6),
  'xiao-esp32-c3': adcRange('GPIO', 0, 6),
  'aitewinrobot-esp32c3-supermini': adcRange('GPIO', 0, 6),
};

/**
 * Convert an ADC pin name + channel to the GPIO pin number that
 * `setAdcVoltage()` (partUtils) expects, per board family.
 *
 *   AVR:   A0→14, A1→15, ... (analog pins start at 14)
 *   RP2040: GP26→26, GP27→27, ... (GPIO number directly)
 *   ESP32:  GPIO32→32, ... or A0→channel-dependent (GPIO number)
 */
function avrPinFromName(_name: string, channel: number): number {
  return 14 + channel;
}
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function gpioPinFromName(name: string, _channel: number): number {
  const m = name.match(/(\d+)$/);
  return m ? parseInt(m[1], 10) : -1;
}

const ADC_PIN_TO_GPIO: Partial<Record<BoardKind, (pinName: string, channel: number) => number>> = {
  'arduino-uno': avrPinFromName,
  'arduino-nano': avrPinFromName,
  'arduino-mega': avrPinFromName,
  attiny85: avrPinFromName,

  'raspberry-pi-pico': gpioPinFromName,
  'pi-pico-w': gpioPinFromName,

  esp32: gpioPinFromName,
  'esp32-devkit-c-v4': gpioPinFromName,
  'esp32-cam': gpioPinFromName,
  'wemos-lolin32-lite': gpioPinFromName,
  'esp32-s3': gpioPinFromName,
  'xiao-esp32-s3': gpioPinFromName,
  'arduino-nano-esp32': avrPinFromName, // uses A0-A7 naming
  'esp32-c3': gpioPinFromName,
  'xiao-esp32-c3': gpioPinFromName,
  'aitewinrobot-esp32c3-supermini': gpioPinFromName,
};

/**
 * Convert a board pin name (e.g. "9", "A0", "GP26", "GPIO32") to the
 * Arduino-style pin number that PinManager uses internally.
 * Returns -1 if the name doesn't map to a GPIO pin.
 */
function pinNameToArduinoPin(pinName: string, boardKind: BoardKind): number {
  const group = BOARD_PIN_GROUPS[boardKind] ?? BOARD_PIN_GROUPS.default;
  // Skip power/ground pins — they're handled as canonical nets
  if (group.gnd.includes(pinName) || group.vcc_pins.includes(pinName)) return -1;

  // RP2040: "GP26" → 26
  if (pinName.startsWith('GP')) {
    const n = parseInt(pinName.slice(2), 10);
    return Number.isFinite(n) ? n : -1;
  }
  // ESP32: "GPIO32" → 32
  if (pinName.startsWith('GPIO')) {
    const n = parseInt(pinName.slice(4), 10);
    return Number.isFinite(n) ? n : -1;
  }
  // AVR analog: "A0" → 14, "A1" → 15, ...
  if (/^A\d+$/.test(pinName)) {
    return 14 + parseInt(pinName.slice(1), 10);
  }
  // Bare numeric: "9" → 9, "13" → 13
  if (/^\d+$/.test(pinName)) {
    return parseInt(pinName, 10);
  }
  return -1;
}

/**
 * Collect MCU output pin states from PinManager for pins that participate
 * in the circuit (i.e., are referenced by wires).
 */
function collectPinStates(
  boardId: string,
  boardKind: BoardKind,
  wires: Array<{
    start: { componentId: string; pinName: string };
    end: { componentId: string; pinName: string };
  }>,
): Record<string, PinSourceState> {
  const pm = getBoardPinManager(boardId);
  if (!pm) return {};
  const group = BOARD_PIN_GROUPS[boardKind] ?? BOARD_PIN_GROUPS.default;
  const vcc = group.vcc;

  const result: Record<string, PinSourceState> = {};
  // Gather all pin names wired to this board
  const pinNames = new Set<string>();
  for (const w of wires) {
    if (w.start.componentId === boardId) pinNames.add(w.start.pinName);
    if (w.end.componentId === boardId) pinNames.add(w.end.pinName);
  }

  for (const pinName of pinNames) {
    const arduinoPin = pinNameToArduinoPin(pinName, boardKind);
    if (arduinoPin < 0) continue;
    const pwmDuty = pm.getPwmValue(arduinoPin);
    if (pwmDuty > 0) {
      result[pinName] = { type: 'pwm', duty: pwmDuty };
    } else if (pm.getPinState(arduinoPin)) {
      result[pinName] = { type: 'digital', v: vcc };
    }
    // If pin is LOW or unknown, don't add — treated as input/floating by SPICE
  }
  return result;
}

const SPICE_DEBUG = true;
const spiceLog = (...a: unknown[]) => {
  if (SPICE_DEBUG) console.log('[spice]', ...a);
};

export function wireElectricalSolver(): () => void {
  spiceLog('wireElectricalSolver mounted');

  // Cache the last solve input JSON to skip redundant solves.
  // This is critical: without it, the periodic timer floods the scheduler
  // with identical requests, delaying the result that carries updated
  // pin states (e.g. PWM) until after the simulation stops.
  let lastInputJson = '';

  function maybeSolve() {
    const storeState = useSimulatorStore.getState();
    const snap = {
      components: storeState.components,
      wires: storeState.wires,
      boards: storeState.boards.map((b) => ({
        id: b.id,
        boardKind: b.boardKind,
        pinStates: collectPinStates(b.id, b.boardKind, storeState.wires),
      })),
    };
    const input = buildInputFromStore(snap);

    // Deduplicate: skip if the input hasn't changed since the last solve.
    const inputJson = JSON.stringify(input);
    if (inputJson === lastInputJson) {
      spiceLog('maybeSolve skipped (input unchanged)');
      return;
    }
    lastInputJson = inputJson;

    spiceLog('maybeSolve → triggerSolve', {
      components: input.components.length,
      wires: input.wires.length,
      boards: input.boards.length,
      analysis: input.analysis,
    });

    // pinNetMap is now built inside buildNetlist() from the same UF and
    // returned via CircuitScheduler → ElectricalSolveResult → store.
    useElectricalStore.getState().triggerSolve(input);
  }

  function injectVoltagesIntoADC() {
    const { nodeVoltages, pinNetMap } = useElectricalStore.getState();
    const { boards } = useSimulatorStore.getState();
    for (const board of boards) {
      const adcPins = ADC_PIN_MAP[board.boardKind];
      if (!adcPins) continue;
      const sim = getBoardSimulator(board.id);
      if (!sim) continue;
      const vMax = board.boardKind.startsWith('esp32') ? 3.3 : 5.0;
      for (const { pinName, channel } of adcPins) {
        const netName = pinNetMap.get(`${board.id}:${pinName}`);
        if (!netName) continue;
        const v = nodeVoltages[netName];
        if (v == null) continue;
        const clamped = Math.max(0, Math.min(vMax, v));
        const gpioPin = ADC_PIN_TO_GPIO[board.boardKind]?.(pinName, channel);
        if (gpioPin != null) setAdcVoltage(sim, gpioPin, clamped);
      }
    }
  }

  // ── Per-read ADC waveform sampling ──────────────────────────────────────
  // When a circuit contains an AC source, SPICE returns a `.tran` result with
  // per-node waveform samples. We override `MCU.onADCRead` so that every
  // `analogRead` interpolates the waveform at the *exact wall-clock time of
  // the read*. That puts every guest-visible ADC sample in the right phase,
  // regardless of the sketch's sample rate (up to Nyquist for the waveform).
  //
  // Why not a RAF loop? An earlier version pushed `channelValues[ch]` once
  // per animation frame (~60 Hz). But 60 Hz aliases with 50 Hz signals, and
  // within a single frame every `analogRead` returns the same stale value —
  // collapsing the 400-sample `.tran` LUT to a 60 Hz zero-order hold. The
  // per-read hook eliminates both issues and is strictly more faithful, so
  // the RAF loop was retired. See `docs/wiki/circuit-emulation-adc-aliasing.md`.
  const patchedAdcs = new WeakSet<object>();

  // Wall-clock epoch for "t=0 of the signal generator". Latched the first
  // time a `.tran` result arrives, so the sampler's phase is stable across
  // re-solves that produce an identical waveform.
  let replayStartMs = 0;
  let replayEpochLatched = false;

  function sampleWaveformAtNow(net: string): number | undefined {
    const { timeWaveforms } = useElectricalStore.getState();
    if (!timeWaveforms) return undefined;
    const samples = timeWaveforms.nodes.get(net);
    if (!samples) return undefined;
    const times = timeWaveforms.time;
    const periodS = times[times.length - 1];
    if (!(periodS > 0)) return undefined;
    const t = ((performance.now() - replayStartMs) / 1000) % periodS;
    return interpolateAt(times, samples, t);
  }

  // Track which `(boardId, channel)` pairs currently have a waveform pushed
  // to QEMU so we can clear it when the circuit turns DC or the component is
  // removed. Key format: `${boardId}:${channel}`.
  const qemuWaveformChannels = new Set<string>();

  function pushEsp32Waveforms() {
    const { boards } = useSimulatorStore.getState();
    const { pinNetMap, timeWaveforms } = useElectricalStore.getState();
    for (const board of boards) {
      const adcPins = ADC_PIN_MAP[board.boardKind];
      if (!adcPins) continue;
      const sim = getBoardSimulator(board.id);
      if (!sim) continue;
      // Only ESP32 QEMU-bridged shims have setAdcWaveform.
      const shim = sim as unknown as {
        setAdcWaveform?: (pin: number, samples: Uint16Array, periodNs: number) => boolean;
      };
      if (typeof shim.setAdcWaveform !== 'function') continue;

      const gpioFn = ADC_PIN_TO_GPIO[board.boardKind];
      if (!gpioFn) continue;
      const boardId = board.id;
      const seen = new Set<number>();

      if (timeWaveforms && timeWaveforms.time.length > 1) {
        const period = timeWaveforms.time[timeWaveforms.time.length - 1];
        if (period > 0) {
          const periodNs = Math.round(period * 1e9);
          for (const { pinName, channel } of adcPins) {
            const net = pinNetMap.get(`${boardId}:${pinName}`);
            const samples = net ? timeWaveforms.nodes.get(net) : undefined;
            if (!samples || samples.length === 0) continue;
            const u12 = new Uint16Array(samples.length);
            for (let i = 0; i < samples.length; i++) {
              const v = Math.max(0, Math.min(3.3, samples[i]));
              u12[i] = Math.round((v / 3.3) * 4095);
            }
            const gpioPin = gpioFn(pinName, channel);
            if (gpioPin < 0) continue;
            shim.setAdcWaveform(gpioPin, u12, periodNs);
            qemuWaveformChannels.add(`${boardId}:${channel}`);
            seen.add(channel);
          }
        }
      }

      // Clear any channels that previously had a waveform but don't anymore
      // (e.g. circuit became DC after a component edit).
      for (const { pinName, channel } of adcPins) {
        const key = `${boardId}:${channel}`;
        if (qemuWaveformChannels.has(key) && !seen.has(channel)) {
          const gpioPin = gpioFn(pinName, channel);
          if (gpioPin < 0) continue;
          shim.setAdcWaveform(gpioPin, new Uint16Array(0), 0);
          qemuWaveformChannels.delete(key);
        }
      }
    }
  }

  function installAdcReadHooks() {
    // ESP32 is handled by its dedicated waveform-push path (no in-process
    // onADCRead to patch — QEMU does the interpolation on MMIO read).
    pushEsp32Waveforms();

    const { boards } = useSimulatorStore.getState();
    for (const board of boards) {
      const adcPins = ADC_PIN_MAP[board.boardKind];
      if (!adcPins) continue;
      const sim = getBoardSimulator(board.id);
      if (!sim) continue;
      const adc = (sim as unknown as { getADC?: () => object | null }).getADC?.();
      if (!adc || patchedAdcs.has(adc)) continue;
      const boardId = board.id;

      // Build channel → SPICE net for this board.
      const channelToNet = new Map<number, string>();
      const refreshChannelMap = () => {
        channelToNet.clear();
        const { pinNetMap } = useElectricalStore.getState();
        for (const { pinName, channel } of adcPins) {
          const net = pinNetMap.get(`${boardId}:${pinName}`);
          if (net) channelToNet.set(channel, net);
        }
      };

      // AVR vs RP2040 detection. RP2040's RPADC exposes `resolution: 12` and a
      // `sampleAlarm` scheduler; AVR's ADC exposes `sampleCycles` + `cpu`.
      const isRp2040 = 'resolution' in (adc as object);

      if (isRp2040) {
        const self = adc as unknown as {
          channelValues: number[];
          onADCRead: (channel: number) => void;
        };
        const originalOnADCRead = self.onADCRead.bind(self);
        self.onADCRead = function (channel: number) {
          if (channelToNet.size === 0) refreshChannelMap();
          const net = channelToNet.get(channel);
          const v = net ? sampleWaveformAtNow(net) : undefined;
          if (v != null) {
            // RP2040 ADC is 12-bit, 0-3.3V full scale.
            const clamped = Math.max(0, Math.min(3.3, v));
            self.channelValues[channel] = Math.round((clamped / 3.3) * 4095);
          }
          originalOnADCRead(channel);
        };
        patchedAdcs.add(adc);
        spiceLog('installed RP2040 onADCRead hook', { boardId });
        continue;
      }

      // AVR path — override entirely because the real implementation computes
      // the raw 10-bit value from channelValues and calls completeADCRead via
      // cpu.addClockEvent. We must re-implement that path but with the voltage
      // sampled from the SPICE waveform at the exact read moment.
      const self = adc as unknown as {
        channelValues: Array<number | undefined>;
        referenceVoltage: number;
        sampleCycles: number;
        cpu: { addClockEvent: (fn: () => void, cycles: number) => void };
        completeADCRead: (value: number) => void;
        onADCRead: (input: {
          type: number;
          channel?: number;
          voltage?: number;
          positiveChannel?: number;
          negativeChannel?: number;
          gain?: number;
        }) => void;
      };
      self.onADCRead = function (input) {
        if (channelToNet.size === 0) refreshChannelMap();
        const ADCMuxInputType_SingleEnded = 0;
        const ADCMuxInputType_Differential = 1;
        const ADCMuxInputType_Constant = 2;
        const ADCMuxInputType_Temperature = 3;
        let voltage = 0;
        switch (input.type) {
          case ADCMuxInputType_Constant:
            voltage = input.voltage ?? 0;
            break;
          case ADCMuxInputType_SingleEnded: {
            const ch = input.channel ?? 0;
            const net = channelToNet.get(ch);
            const waveV = net ? sampleWaveformAtNow(net) : undefined;
            voltage = waveV ?? self.channelValues[ch] ?? 0;
            break;
          }
          case ADCMuxInputType_Differential: {
            const pos = input.positiveChannel ?? 0;
            const neg = input.negativeChannel ?? 0;
            const gain = input.gain ?? 1;
            const vPos =
              sampleWaveformAtNow(channelToNet.get(pos) ?? '') ?? self.channelValues[pos] ?? 0;
            const vNeg =
              sampleWaveformAtNow(channelToNet.get(neg) ?? '') ?? self.channelValues[neg] ?? 0;
            voltage = gain * (vPos - vNeg);
            break;
          }
          case ADCMuxInputType_Temperature:
            voltage = 0.378125;
            break;
        }
        const rawValue = (voltage / self.referenceVoltage) * 1024;
        const result = Math.min(Math.max(Math.floor(rawValue), 0), 1023);
        self.cpu.addClockEvent(() => self.completeADCRead(result), self.sampleCycles);
      };
      patchedAdcs.add(adc);
      spiceLog('installed AVR onADCRead hook', { boardId });
    }
  }

  // Re-solve on components / wires changes.
  const unsubSim = useSimulatorStore.subscribe((state, prev) => {
    if (state.components !== prev.components || state.wires !== prev.wires) {
      maybeSolve();
    }
  });

  // On every solve result:
  //   - DC solve (`.op`): push scalar voltages into `channelValues[]`.
  //   - AC solve (`.tran`): install/refresh the per-read `onADCRead` hook so
  //     every future `analogRead` interpolates the waveform. Latch the
  //     wall-clock epoch on first `.tran` arrival so the signal phase is
  //     stable across downstream re-solves.
  const unsubResult = useElectricalStore.subscribe((state, prev) => {
    if (state.nodeVoltages !== prev.nodeVoltages || state.timeWaveforms !== prev.timeWaveforms) {
      injectVoltagesIntoADC();
      if (state.timeWaveforms && !replayEpochLatched) {
        replayStartMs = performance.now();
        replayEpochLatched = true;
      }
      installAdcReadHooks();
    }
  });

  // Examples are loaded by `ExampleLoaderPage` *before* navigating to the
  // editor, so by the time this subscriber attaches, `setComponents` /
  // `setWires` have already fired and will never fire again — no subscription
  // event ever reaches `unsubSim`. Kick off a solve on mount so the rectifier
  // (and every other AC example that arrives via deep link) gets its waveform
  // computed. Install hooks so any AVR/RP2040 that already booted gets them.
  maybeSolve();
  installAdcReadHooks();

  // Expose a debug helper so the user can run `window.__spiceDebug()` at any
  // time from DevTools and get a complete snapshot of the electrical state.
  (window as unknown as { __spiceDebug?: () => void }).__spiceDebug = () => {
    const es = useElectricalStore.getState();
    const ss = useSimulatorStore.getState();
    const a0Key = ss.boards[0] ? `${ss.boards[0].id}:A0` : '(no-board)';
    const a0Net = es.pinNetMap.get(a0Key);
    console.log('[spice] DEBUG DUMP', {
      analysisMode: es.analysisMode,
      converged: es.converged,
      error: es.error,
      lastSolveMs: es.lastSolveMs,
      nodeVoltageCount: Object.keys(es.nodeVoltages).length,
      nodeVoltageSample: Object.entries(es.nodeVoltages).slice(0, 8),
      pinNetMapSize: es.pinNetMap.size,
      pinNetEntries: [...es.pinNetMap.entries()],
      a0Key,
      a0Net,
      a0InstantV: a0Net ? es.nodeVoltages[a0Net] : undefined,
      hasTimeWaveforms: !!es.timeWaveforms,
      waveformNodeKeys: es.timeWaveforms ? [...es.timeWaveforms.nodes.keys()] : [],
      waveformTimeFirst: es.timeWaveforms?.time[0],
      waveformTimeLast: es.timeWaveforms?.time[es.timeWaveforms.time.length - 1],
      waveformSamples: a0Net && es.timeWaveforms?.nodes.get(a0Net)?.slice(0, 10),
      replayEpochLatched,
      replayEpochMsAgo: replayEpochLatched ? +(performance.now() - replayStartMs).toFixed(0) : null,
      boards: ss.boards.map((b) => ({ id: b.id, kind: b.boardKind, running: b.running })),
      components: ss.components.map((c) => ({ id: c.id, meta: c.metadataId })),
      wireCount: ss.wires.length,
      submittedNetlist: es.submittedNetlist,
    });

    // Dump the live ADC state so we can confirm the per-read hook is attached
    // and what channelValues look like for each running board.
    for (const b of ss.boards) {
      const sim = getBoardSimulator(b.id);
      if (!sim) {
        console.log(`[spice] board ${b.id}: no simulator`);
        continue;
      }
      const adc = (
        sim as unknown as { getADC?: () => { channelValues?: ArrayLike<number> } | null }
      ).getADC?.();
      const cycles = (sim as unknown as { getCurrentCycles?: () => number }).getCurrentCycles?.();
      const values = adc?.channelValues ? Array.from(adc.channelValues).slice(0, 6) : null;
      const valuesStr = values
        ? `[${values.map((v) => (typeof v === 'number' ? v.toFixed(3) : String(v))).join(', ')}]`
        : 'null';
      console.log(
        `[spice] board ${b.id}: sim=${(sim as object).constructor?.name} running=${b.running} adc=${!!adc} patched=${adc ? patchedAdcs.has(adc) : false} cycles=${cycles} simT=${typeof cycles === 'number' ? (cycles / 16_000_000).toFixed(3) + 's' : 'n/a'} channelValues=${valuesStr}`,
      );
    }
  };
  console.log('[spice] call window.__spiceDebug() anytime to inspect state');

  // Re-install hooks and re-inject DC whenever boards change (e.g. `loadHex`
  // creates a fresh AVRADC instance that needs the waveform hook on it).
  const unsubBoards = useSimulatorStore.subscribe((state, prev) => {
    if (state.boards !== prev.boards) {
      const { nodeVoltages } = useElectricalStore.getState();
      if (Object.keys(nodeVoltages).length > 0) {
        injectVoltagesIntoADC();
      }
      installAdcReadHooks();
    }
  });

  // Periodic re-solve while any board is running, so SPICE picks up
  // MCU pin-state changes (e.g. analogWrite → PWM → voltage source).
  let solveInterval: ReturnType<typeof setInterval> | null = null;
  const SOLVE_INTERVAL_MS = 200;

  function updateSolveTimer() {
    const anyRunning = useSimulatorStore.getState().boards.some((b) => b.running);
    if (anyRunning) {
      if (!solveInterval) {
        solveInterval = setInterval(maybeSolve, SOLVE_INTERVAL_MS);
      }
    } else if (solveInterval) {
      clearInterval(solveInterval);
      solveInterval = null;
    }
  }

  const unsubRunning = useSimulatorStore.subscribe((state, prev) => {
    const wasRunning = prev.boards.some((b) => b.running);
    const nowRunning = state.boards.some((b) => b.running);
    if (wasRunning !== nowRunning) updateSolveTimer();
  });

  return () => {
    unsubSim();
    unsubResult();
    unsubBoards();
    unsubRunning();
    if (solveInterval) clearInterval(solveInterval);
  };
}
