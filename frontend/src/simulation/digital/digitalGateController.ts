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
 * changed). With the engine off it is a no-op; mixed/analog circuits never
 * qualify as all-digital and stay on ngspice.
 */
import { useSimulatorStore } from '../../store/useSimulatorStore';
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

export function mountDigitalGateEngine(): () => void {
  if (typeof window === 'undefined' || !digitalGatesEnabled()) return () => {};

  let disposed = false;
  let net: DigitalNetwork | null = null;
  let structuralSig = '';
  let raf = 0;

  const sigOf = (st = useSimulatorStore.getState()) =>
    st.components.map((c) => c.id).join(',') + '|' + st.wires.length;

  const paint = () => {
    if (!net?.ok) return;
    for (const id of net.ledIds) {
      const el = document.getElementById(id) as LedEl | null;
      if (!el) continue;
      const lit = net.readLed(id) === 1;
      el.value = lit;
      el.brightness = lit ? 1 : 0;
    }
  };
  const schedulePaint = () => {
    if (disposed || raf) return;
    raf = requestAnimationFrame(() => { raf = 0; if (!disposed) paint(); });
  };

  // Build once; keep the network (and its flip-flop state) alive.
  const rebuild = () => {
    const st = useSimulatorStore.getState();
    structuralSig = sigOf(st);
    if (!isAllDigital(st.components as never[])) { net = null; return; }
    resetBusNets();
    const built = buildDigitalNetwork(st.components as never[], st.wires as never[], new PinManager());
    net = built.ok ? built : null;
    schedulePaint();
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
  // Rebuild only when the structure changes (load / add / remove / rewire) — NOT
  // on every property change, which would wipe sequential state.
  const unsub = useSimulatorStore.subscribe((n, p) => {
    if (n.components !== p.components || n.wires !== p.wires) {
      if (sigOf(n) !== structuralSig) rebuild();
    }
  });

  rebuild(); // initial

  return () => {
    disposed = true;
    if (raf) cancelAnimationFrame(raf);
    window.removeEventListener(PROPERTY_CHANGE_EVENT, onProp);
    unsub();
  };
}
