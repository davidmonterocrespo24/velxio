/**
 * connectAnalogInputsToMcu — bridge SPICE node voltages to MCU ADCs.
 *
 * Subscribes to the electrical store and injects voltages into the
 * running MCU sims (AVR / RP2040 / ESP32 QEMU) so that `analogRead`
 * in user sketches returns physically-correct values.
 *
 * Solver-agnostic by design: this module knows ONLY the electrical
 * store shape (`nodeVoltages`, `pinNetMap`, `timeWaveforms`) — it
 * doesn't care which solver produced them.  Replacing
 * CircuitScheduler with the CircuitSimulationService doesn't touch
 * this file.
 *
 * Three paths:
 *   • DC (.op): scalar `setAdcVoltage(sim, gpioPin, v)` per channel.
 *   • AC (.tran), AVR/RP2040: patch `onADCRead` so every analogRead
 *     samples the per-net waveform at the *exact wall-clock time*
 *     of the read.  Eliminates aliasing.
 *   • AC (.tran), ESP32: push the entire waveform to the QEMU MMIO
 *     via `setAdcWaveform` — QEMU does its own interpolation.
 *
 * A part that models its OWN analog output (a pulse sensor's PPG waveform, a
 * sensor module with no SPICE model that writes its channel directly) owns
 * that pin, exactly as on the digital side — see `partPinOwnership`. All three
 * paths below skip an owned pin. The older `sourcedNets` gate cannot stand in
 * for that: the moment the user draws the wires the part needs, the net is
 * component-backed and solves at whatever the passives say, which for an
 * unmodelled sensor output is a phantom 0 V that stomps the part on every
 * solve.
 *
 * Extracted from the legacy `subscribeToStore.ts::wireElectricalSolver`
 * during Phase 1c step C of the mixed-mode migration.
 */
import {
  useSimulatorStore,
  getBoardSimulator,
} from '../../store/useSimulatorStore';
import { useElectricalStore } from '../../store/useElectricalStore';
import { setAdcVoltage } from '../parts/partUtils';
import { isPartOwnedPin } from '../partPinOwnership';
import type { BoardKind } from '../../types/board';
import { interpolateAt } from './waveformStats';
import { boardPinToNumber } from '../../utils/boardPinMapping';
import { getProBoard } from '../../lib/proBoardRegistry';

// Which Arduino-style pin name maps to which ADC channel, per board.
function adcRange(
  prefix: string,
  start: number,
  count: number,
  firstChannel = 0,
): Array<{ pinName: string; channel: number }> {
  return Array.from({ length: count }, (_, i) => ({
    pinName: `${prefix}${start + i}`,
    channel: firstChannel + i,
  }));
}

/** An explicit GPIO list in channel order, like the classic ESP32's ADC2. */
function adcList(
  prefix: string,
  gpios: readonly number[],
  firstChannel: number,
): Array<{ pinName: string; channel: number }> {
  return gpios.map((gpio, i) => ({ pinName: `${prefix}${gpio}`, channel: firstChannel + i }));
}

/** Classic ESP32 ADC2 channel -> GPIO (soc/esp32/include/soc/adc_channel.h). */
const ESP32_ADC2_GPIOS = [4, 0, 2, 15, 13, 12, 14, 27, 25, 26] as const;

const ADC_6CH = adcRange('A', 0, 6);
const ADC_8CH = adcRange('A', 0, 8);
const ADC_16CH = adcRange('A', 0, 16);

/**
 * Which pin names on each board are ADC inputs.
 *
 * Exported because the scope's probe resolver needs the same answer: an
 * analogRead pin carries a VOLTAGE, so a wire landing on it must be plotted as
 * an analog trace, not as the logic level its Arduino pin number would suggest
 * (A0 is pin 14 on an Uno, and a square wave of a divider tap is nonsense).
 * One table, so the two cannot drift.
 */
export const ADC_PIN_MAP: Partial<Record<BoardKind, Array<{ pinName: string; channel: number }>>> = {
  // AVR
  'arduino-uno': ADC_6CH,
  'arduino-nano': ADC_8CH,
  'arduino-mega': ADC_16CH,
  // ATtiny85: ADC channels live on PORTB pins, not on A0..An.
  // Wires reference the chip's own pin names (PB5/PB2/PB4/PB3).
  //   PB5 -> ADC0  PB2 -> ADC1  PB4 -> ADC2  PB3 -> ADC3
  attiny85: [
    { pinName: 'PB5', channel: 0 },
    { pinName: 'PB2', channel: 1 },
    { pinName: 'PB4', channel: 2 },
    { pinName: 'PB3', channel: 3 },
  ],

  // RP2040
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

  // ESP32 — pinNames here are lookup keys into pinNetMap, so they MUST be
  // the boards' REAL silkscreen names. The old 'GPIO32'-style keys never
  // matched the bare-number pin names actual wires carry ('34', '4', 'A0'),
  // so the SPICE->ADC path silently skipped every esp32-family pin
  // (2026-07 emulation-gaps audit; divider circuits read 0 forever).
  // Both ADC units. ADC2 (GPIO4/0/2/15/13/12/14/27/25/26 = ch0-9) is listed
  // at channel 10 + ch, the second-unit convention the S3 entry below already
  // used; the bridges turn it into their engine's own addressing. Until
  // 2026-10-29 only ADC1 was here, so a solve never reached an ADC2 pin: a pH
  // probe on GPIO27 and an NTC on GPIO26 read 0.0 and -90 C in a user project.
  esp32: [...adcRange('', 32, 8), ...adcList('', ESP32_ADC2_GPIOS, 10)],
  'esp32-devkit-c-v4': [...adcRange('', 32, 8), ...adcList('', ESP32_ADC2_GPIOS, 10)],
  'esp32-cam': [...adcRange('', 32, 8), ...adcList('', ESP32_ADC2_GPIOS, 10)],
  'wemos-lolin32-lite': [...adcRange('GPIO', 32, 8), ...adcList('GPIO', ESP32_ADC2_GPIOS, 10)],
  // S3: ADC1 GPIO1-10 (ch0-9) and ADC2 GPIO11-20 (10 + ch0-9).
  'esp32-s3': [...adcRange('', 1, 10), ...adcRange('', 11, 10, 10)],
  'xiao-esp32-s3': adcRange('D', 0, 9),
  'arduino-nano-esp32': adcRange('A', 0, 8),
  'esp32-c3': adcRange('', 0, 6),
  'xiao-esp32-c3': adcRange('D', 0, 4),
  'aitewinrobot-esp32c3-supermini': adcRange('', 0, 6),
};

function avrPinFromName(_name: string, channel: number): number {
  return 14 + channel;
}
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
  'arduino-nano-esp32': avrPinFromName,
  'esp32-c3': gpioPinFromName,
  'xiao-esp32-c3': gpioPinFromName,
  'aitewinrobot-esp32c3-supermini': gpioPinFromName,
};

/**
 * Which pads on this board reach the ADC.
 *
 * ADC_PIN_MAP is keyed by the BoardKind union, so an overlay board — whose kind
 * is a runtime string, not a member of that union — could never appear in it
 * and was skipped outright. A board registered through proBoardRegistry
 * declares its own list instead (ProBoardDef.adcPins).
 */
function adcPinsFor(kind: BoardKind): Array<{ pinName: string; channel: number }> | undefined {
  return ADC_PIN_MAP[kind] ?? getProBoard(kind)?.adcPins;
}

/** Silkscreen name -> GPIO for the ADC injection. ESP32-family boards go
 * through the canonical boardPinToNumber table (nano-esp32 'A0' -> GPIO1,
 * xiao 'D1' -> GPIO2, bare '34' -> 34, ...); AVR/ATtiny/Pico keep their
 * legacy per-kind converters (their sims expect Arduino pin numbers, not
 * GPIOs — e.g. uno 'A0' -> 14). */
function gpioForBoardPin(kind: BoardKind, pinName: string, channel: number): number {
  if (kind === 'esp32' || kind.startsWith('esp32') || kind.startsWith('xiao-esp32')
      || kind === 'arduino-nano-esp32' || kind === 'wemos-lolin32-lite'
      || kind === 'aitewinrobot-esp32c3-supermini') {
    const n = boardPinToNumber(kind, pinName);
    if (n != null && n >= 0) return n;
  }
  // An overlay board owns its pad->GPIO mapping (ProBoardDef.pinToNumber);
  // ADC_PIN_TO_GPIO cannot hold it for the same union reason as above.
  const proDef = getProBoard(kind);
  if (proDef?.pinToNumber) {
    const n = proDef.pinToNumber(pinName);
    if (n != null && n >= 0) return n;
  }
  const legacy = ADC_PIN_TO_GPIO[kind];
  return legacy ? legacy(pinName, channel) : -1;
}

export function connectAnalogInputsToMcu(): () => void {
  const patchedAdcs = new WeakSet<object>();
  const qemuWaveformChannels = new Set<string>();
  // Phase 1d #10 — warn-once set so ADC-clip messages don't spam the
  // console.  Key is `${boardId}:${pinName}`.
  const clipWarned = new Set<string>();
  let replayStartMs = 0;
  let replayEpochLatched = false;

  function injectVoltagesIntoADC() {
    const { nodeVoltages, pinNetMap, sourcedNets } = useElectricalStore.getState();
    const { boards } = useSimulatorStore.getState();
    for (const board of boards) {
      const adcPins = adcPinsFor(board.boardKind);
      if (!adcPins) continue;
      const sim = getBoardSimulator(board.id);
      if (!sim) continue;
      const vMax = board.boardKind.startsWith('esp32') ? 3.3 : 5.0;
      for (const { pinName, channel } of adcPins) {
        const netName = pinNetMap.get(`${board.id}:${pinName}`);
        if (!netName) continue;
        // Only push nets a real SPICE element drives. A part with no SPICE
        // model (analog-joystick, sensor modules that inject directly) gets
        // an auto pull-down, solves to 0 V, and this loop used to stomp the
        // part's own setAdcVoltage() with that phantom 0 on every solve —
        // the part read dead no matter what it wrote.
        if (sourcedNets.size > 0 && !sourcedNets.has(netName)) continue;
        const v = nodeVoltages[netName];
        if (v == null) continue;
        // A number the solver could not produce is not a voltage. ngspice
        // answers a transient step it cannot take with NaN for every node at
        // once, and NaN survives Math.max/Math.min unchanged — so the ADC
        // would read it as a conversion. Hold the last real one instead.
        // Same guard as the digital path (issue #333).
        if (!Number.isFinite(v)) continue;
        const clamped = Math.max(0, Math.min(vMax, v));
        const gpioPin = gpioForBoardPin(board.boardKind, pinName, channel);
        if (gpioPin < 0) continue;
        // A part drives this channel itself — leave it alone (see above).
        if (isPartOwnedPin(board.id, gpioPin)) continue;
        setAdcVoltage(sim, gpioPin, clamped);
      }
    }
  }

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

  function pushEsp32Waveforms() {
    const { boards } = useSimulatorStore.getState();
    const { pinNetMap, timeWaveforms } = useElectricalStore.getState();
    for (const board of boards) {
      const adcPins = adcPinsFor(board.boardKind);
      if (!adcPins) continue;
      const sim = getBoardSimulator(board.id);
      if (!sim) continue;
      const shim = sim as unknown as {
        setAdcWaveform?: (pin: number, samples: Uint16Array, periodNs: number) => boolean;
      };
      if (typeof shim.setAdcWaveform !== 'function') continue;
      const gpioFn = (pn: string, ch: number) => gpioForBoardPin(board.boardKind, pn, ch);
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
            // Phase 1d #10 — count clip events to surface ESP32 ADC
            // range violations once per pin.  If more than 10% of
            // samples land outside [0, 3.3] V, warn the user; a
            // rectifier without a clamp is the canonical case.
            let clipped = 0;
            let observedMin = Infinity;
            let observedMax = -Infinity;
            for (let i = 0; i < samples.length; i++) {
              const s = samples[i];
              if (s < observedMin) observedMin = s;
              if (s > observedMax) observedMax = s;
              if (s < 0 || s > 3.3) clipped++;
              const v = Math.max(0, Math.min(3.3, s));
              u12[i] = Math.round((v / 3.3) * 4095);
            }
            const clipKey = `${boardId}:${pinName}`;
            if (clipped > samples.length / 10 && !clipWarned.has(clipKey)) {
              clipWarned.add(clipKey);
              // eslint-disable-next-line no-console
              console.warn(
                `[adc-clip] ${clipKey}: ${clipped}/${samples.length} samples outside [0, 3.3] V (range ${observedMin.toFixed(2)}…${observedMax.toFixed(2)} V). ESP32 ADC reads will saturate at the rails. Add a divider or clamp if you need the full swing.`,
              );
            }
            const gpioPin = gpioFn(pinName, channel);
            if (gpioPin < 0) continue;
            if (isPartOwnedPin(boardId, gpioPin)) continue;
            shim.setAdcWaveform(gpioPin, u12, periodNs);
            qemuWaveformChannels.add(`${boardId}:${channel}`);
            seen.add(channel);
          }
        }
      }

      // Clear channels that previously had a waveform but don't now.
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
    pushEsp32Waveforms();
    const { boards } = useSimulatorStore.getState();
    for (const board of boards) {
      const adcPins = adcPinsFor(board.boardKind);
      if (!adcPins) continue;
      const sim = getBoardSimulator(board.id);
      if (!sim) continue;
      const adc = (sim as unknown as { getADC?: () => object | null }).getADC?.();
      if (!adc || patchedAdcs.has(adc)) continue;
      const boardId = board.id;

      const channelToNet = new Map<number, string>();
      const refreshChannelMap = () => {
        channelToNet.clear();
        const { pinNetMap } = useElectricalStore.getState();
        for (const { pinName, channel } of adcPins) {
          const net = pinNetMap.get(`${boardId}:${pinName}`);
          if (net) channelToNet.set(channel, net);
        }
      };

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
            const clamped = Math.max(0, Math.min(3.3, v));
            self.channelValues[channel] = Math.round((clamped / 3.3) * 4095);
          }
          originalOnADCRead(channel);
        };
        patchedAdcs.add(adc);
        continue;
      }

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
        let voltage = 0;
        switch (input.type) {
          case 2: // Constant
            voltage = input.voltage ?? 0;
            break;
          case 0: {
            // SingleEnded
            const ch = input.channel ?? 0;
            const net = channelToNet.get(ch);
            const waveV = net ? sampleWaveformAtNow(net) : undefined;
            voltage = waveV ?? self.channelValues[ch] ?? 0;
            break;
          }
          case 1: {
            // Differential
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
          case 3: // Temperature
            voltage = 0.378125;
            break;
        }
        const rawValue = (voltage / self.referenceVoltage) * 1024;
        const result = Math.min(Math.max(Math.floor(rawValue), 0), 1023);
        self.cpu.addClockEvent(() => self.completeADCRead(result), self.sampleCycles);
      };
      patchedAdcs.add(adc);
    }
  }

  // Re-inject + re-hook on every solve result.
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

  // Re-hook when boards change (loadHex creates fresh ADC instances).
  const unsubBoards = useSimulatorStore.subscribe((state, prev) => {
    if (state.boards !== prev.boards) {
      const { nodeVoltages } = useElectricalStore.getState();
      if (Object.keys(nodeVoltages).length > 0) injectVoltagesIntoADC();
      installAdcReadHooks();
    }
  });

  // Initial pass — examples that pre-populate the store before mount.
  injectVoltagesIntoADC();
  installAdcReadHooks();

  return () => {
    unsubResult();
    unsubBoards();
  };
}
