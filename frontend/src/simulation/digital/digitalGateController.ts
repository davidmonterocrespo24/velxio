/**
 * digitalGateController — Phase 2 of project/digital-gate-engine/.
 *
 * Mounts the digital gate engine into the live app: when the engine is on (the
 * default; `?digitalgates=off` turns it off) and the board-less circuit is
 * all-digital, it builds the network from the store,
 * settles it on the multichip-bus kernel, and pushes the resolved levels onto
 * the real `wokwi-led` DOM elements. ngspice is told to skip all-digital
 * circuits (CircuitSimulationService guard) so the two motors do not fight.
 *
 * The network is built ONCE and kept alive; a switch toggle applies
 * incrementally via setSwitch (NOT a rebuild). That is essential for SEQUENTIAL
 * circuits — rebuilding resets flip-flop state, so a counter would never count.
 * A rebuild happens only on a structural change (components added/removed, wires
 * changed) or a new setting on a signal generator, whose waveform the network is
 * built with. With the engine off it is a no-op; mixed/analog circuits never
 * qualify as all-digital and stay on ngspice.
 *
 * A generator whose level moves (a square, a sine across the threshold) is a
 * clock: while the circuit is not frozen (the toolbar's Stop sets the
 * electrical store's `paused`), every animation frame runs the network on by
 * the time the frame took, at most MAX_FRAME_S, and the LEDs show the share of
 * that time they were lit (velxio/velxio-prod#146).
 */
import { useSimulatorStore } from '../../store/useSimulatorStore';
import { useElectricalStore } from '../../store/useElectricalStore';
import { PinManager } from '../PinManager';
import { resetBusNets } from '../customChips/busNets';
import {
  buildDigitalNetwork,
  digitalGatesEnabled,
  isAllDigital,
  type DigitalNetwork,
  type DigitalComponent,
} from './digitalGateEngine';
import { PROPERTY_CHANGE_EVENT, type PropertyChangeDetail } from '../parts/partUtils';

interface LedEl extends HTMLElement {
  value?: boolean;
  brightness?: number;
}

const kind = (c: DigitalComponent) => String(c.metadataId ?? c.type ?? '').replace(/^velxio-/, '').replace(/^wokwi-/, '');

/** The longest step one frame may take: a tab coming back from the
 *  background does not replay its absence in one go. */
const MAX_FRAME_S = 0.1;

/** The settings a generator's waveform is built from (generatorWave). */
const generatorSettings = (c: DigitalComponent): string => {
  const p = c.properties ?? {};
  return [p.waveform, p.frequency, p.amplitude, p.offset].map((v) => String(v ?? '')).join('/');
};

export function mountDigitalGateEngine(): () => void {
  if (typeof window === 'undefined' || !digitalGatesEnabled()) return () => {};

  let disposed = false;
  let net: DigitalNetwork | null = null;
  let structuralSig = '';
  let raf = 0;
  let clockRaf = 0;
  let lastFrameMs: number | null = null;

  const sigOf = (st = useSimulatorStore.getState()) =>
    st.components.map((c) => c.id).join(',') + '|' + st.wires.length + '|' +
    (st.components as DigitalComponent[])
      .filter((c) => kind(c) === 'signal-generator')
      .map((c) => `${c.id}=${generatorSettings(c)}`)
      .join(',');

  // What each LED was last painted with: a clock repaints every frame, and
  // an LED whose brightness did not move is left alone.
  const painted = new Map<string, number>();
  const paint = () => {
    if (!net?.ok) return;
    for (const id of net.ledIds) {
      const el = document.getElementById(id) as LedEl | null;
      if (!el) continue;
      // Under a clock an LED is as bright as the share of the frame it was lit.
      const brightness = net.hasClocks ? net.ledDuty(id) : net.readLed(id);
      if (net.hasClocks && painted.get(id) === brightness && el.brightness === brightness) continue;
      painted.set(id, brightness);
      el.value = brightness > 0;
      el.brightness = brightness;
    }
  };
  const schedulePaint = () => {
    if (disposed || raf) return;
    raf = requestAnimationFrame(() => { raf = 0; if (!disposed) paint(); });
  };

  // The clocks: one step per animation frame, by the frame's own time.
  const clockFrame = (frameMs: number) => {
    clockRaf = 0;
    if (disposed || !net?.ok || !net.hasClocks) return;
    const paused = useElectricalStore.getState().paused;
    if (!paused && lastFrameMs !== null) {
      const dt = Math.min(MAX_FRAME_S, Math.max(0, (frameMs - lastFrameMs) / 1000));
      if (dt > 0) {
        net.advance(net.now() + dt);
        paint();
      }
    }
    lastFrameMs = paused ? null : frameMs;
    clockRaf = requestAnimationFrame(clockFrame);
  };
  const startClocks = () => {
    if (clockRaf) cancelAnimationFrame(clockRaf);
    clockRaf = 0;
    lastFrameMs = null;
    if (net?.ok && net.hasClocks) clockRaf = requestAnimationFrame(clockFrame);
  };

  // Build once; keep the network (and its flip-flop state) alive.
  const rebuild = () => {
    const st = useSimulatorStore.getState();
    structuralSig = sigOf(st);
    if (!isAllDigital(st.components as never[])) { net = null; startClocks(); return; }
    resetBusNets();
    const built = buildDigitalNetwork(st.components as never[], st.wires as never[], new PinManager());
    net = built.ok ? built : null;
    painted.clear();
    schedulePaint();
    startClocks();
  };

  // A switch toggle: apply incrementally so flip-flop state is preserved.
  const onProp = (evt: Event) => {
    if (!net?.ok) return;
    const { componentId, propName, value } = (evt as CustomEvent<PropertyChangeDetail>).detail;
    if (propName !== 'value') return;
    const c = useSimulatorStore.getState().components.find((x) => x.id === componentId);
    if (!c || kind(c as DigitalComponent) !== 'slide-switch') return;
    net.setSwitch(componentId, Number(value) === 1 ? 1 : 0);
    schedulePaint();
  };

  window.addEventListener(PROPERTY_CHANGE_EVENT, onProp);
  // Rebuild only when the structure changes (load / add / remove / rewire) or a
  // generator gets a new setting — NOT on every property change, which would
  // wipe sequential state.
  const unsub = useSimulatorStore.subscribe((n, p) => {
    if (n.components !== p.components || n.wires !== p.wires) {
      if (sigOf(n) !== structuralSig) rebuild();
    }
  });

  rebuild(); // initial

  return () => {
    disposed = true;
    if (raf) cancelAnimationFrame(raf);
    if (clockRaf) cancelAnimationFrame(clockRaf);
    window.removeEventListener(PROPERTY_CHANGE_EVENT, onProp);
    unsub();
  };
}
