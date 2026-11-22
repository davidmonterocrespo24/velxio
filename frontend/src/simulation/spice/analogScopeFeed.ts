/**
 * Feed the oscilloscope's analog channels from the SPICE solver.
 *
 * Two facts about the engine shape everything here, and both are the opposite
 * of what a scope normally assumes:
 *
 *  - There is no streaming transient. The vendored WASM ngspice is
 *    single-threaded and every solve RELOADS the circuit and runs from t=0, so
 *    successive captures are not continuous with each other. Each capture is
 *    therefore presented as one triggered window — the way a real scope in
 *    Auto mode redraws a fresh sweep — never stitched into a running timeline
 *    that never happened.
 *  - Whether a transient runs at all is decided by circuit CONTENTS
 *    (`pickDynamicAnalysis` looks for a non-DC source or a driven reactive
 *    part). A plain resistor divider solves as `.op` and produces no waveform
 *    at all. So while an analog channel exists we ask for transient
 *    explicitly, and re-ask on a timer to keep the window fresh whenever the
 *    latest publish (a pin edge solved as an operating point) has no capture
 *    of its own.
 *
 * The subscription is driven by the channel list: no analog channels means no
 * forced transient and no timer, so a user who never probes a wire pays
 * nothing.
 */

import { useOscilloscopeStore } from '../../store/useOscilloscopeStore';
import { useElectricalStore } from '../../store/useElectricalStore';
import { requestElectricalResolve } from './electricalResolveHook';

/** How often to re-run the transient while an analog channel is live and
 *  the latest publish has no capture of its own.
 *
 *  A solve reloads and re-runs the whole circuit, so this is a real cost paid
 *  on the main worker; 250 ms keeps the trace visibly alive without competing
 *  with the MCU-edge solves that make LEDs respond. */
const RECAPTURE_MS = 250;

/** Nets the scope currently wants transient data for. Read by the store
 *  adapter to force `.tran` and to bound what gets materialised. */
let watchedNets: string[] = [];

export function analogScopeNets(): string[] {
  return watchedNets;
}

/** True while at least one analog channel is live AND capturing. */
export function analogScopeWantsTransient(): boolean {
  return watchedNets.length > 0;
}

let unsubscribeChannels: (() => void) | null = null;
let unsubscribeElectrical: (() => void) | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

function refreshWatchedNets(): void {
  const { channels, open, running } = useOscilloscopeStore.getState();
  // A closed or paused scope should not hold the solver in transient mode,
  // and neither should a channel whose probed pin left the circuit.
  const wanted =
    open && running
      ? channels.flatMap((c) => (c.kind === 'analog' && !c.lost ? [c.netName] : []))
      : [];
  const changed =
    wanted.length !== watchedNets.length || wanted.some((n, i) => n !== watchedNets[i]);
  if (!changed) return;
  watchedNets = wanted;

  if (watchedNets.length > 0) {
    if (timer === null) {
      timer = setInterval(() => {
        // A publish that carries its own capture is the latest sweep already:
        // the same deck re-solved draws the same one again, at the cost of a
        // whole transient, and a circuit with a periodic source runs its
        // start-up before every window it stores (velxio/velxio-prod#143).
        // An edge solved as an operating point publishes none; then a new
        // sweep is due, unless a step runs from that edge (stepWaveforms,
        // velxio/velxio-prod#153): its curve is the sweep, and a rebuild every
        // 250 ms would run it again.
        const { timeWaveforms, stepWaveforms } = useElectricalStore.getState();
        if (timeWaveforms || stepWaveforms) return;
        requestElectricalResolve();
      }, RECAPTURE_MS);
    }
    // Ask immediately so the first trace does not wait a whole interval.
    requestElectricalResolve();
  } else if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}

/** Copy the latest transient capture into every analog channel. That is the
 *  service's `scopeWaveforms`: the last capture the deck produced, which stays
 *  published across the pin edges solved after it as operating points, so the
 *  trace does not blank between two recaptures. A store written without one
 *  (a test, a direct caller) is read through its `timeWaveforms`.
 *
 *  Net names are positional and an edit can renumber them, so each probed
 *  channel is first pointed at the net its pin is on in this solve's
 *  pinNetMap (followProbes); an empty map is no solve yet and moves nothing. */
function publishCapture(): void {
  const { scopeWaveforms, timeWaveforms: current, pinNetMap } = useElectricalStore.getState();
  if (pinNetMap.size > 0) useOscilloscopeStore.getState().followProbes(pinNetMap);
  const timeWaveforms = scopeWaveforms ?? current;
  if (!timeWaveforms || timeWaveforms.time.length === 0) return;
  const { channels, pushAnalogBlock } = useOscilloscopeStore.getState();
  // SPICE works in seconds; every existing scope reader is in milliseconds.
  const timesMs = timeWaveforms.time.map((t) => t * 1000);
  for (const ch of channels) {
    if (ch.kind !== 'analog' || ch.lost) continue;
    const volts = timeWaveforms.nodes.get(ch.netName);
    if (volts && volts.length > 0) {
      pushAnalogBlock(ch.id, timesMs, volts);
      continue;
    }
    // Ground is a constant the solver never lists among its node voltages —
    // reporting "no data" for a probed GND wire would look like a bug.
    if (ch.netName === '0') {
      pushAnalogBlock(ch.id, timesMs, timesMs.map(() => 0));
    }
  }
}

/**
 * Start bridging SPICE transient captures into the scope. Idempotent; returns
 * a stop function. Called once from the editor's simulation bootstrap.
 */
export function startAnalogScopeFeed(): () => void {
  if (unsubscribeChannels) return stopAnalogScopeFeed;

  refreshWatchedNets();
  unsubscribeChannels = useOscilloscopeStore.subscribe(refreshWatchedNets);
  unsubscribeElectrical = useElectricalStore.subscribe(publishCapture);
  return stopAnalogScopeFeed;
}

export function stopAnalogScopeFeed(): void {
  unsubscribeChannels?.();
  unsubscribeChannels = null;
  unsubscribeElectrical?.();
  unsubscribeElectrical = null;
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
  watchedNets = [];
}
