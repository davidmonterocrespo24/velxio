/**
 * The voltage on a chip's pad, as the circuit solve publishes it.
 *
 * `vx_pin_read_analog` answers this in every host, and this is the one place
 * the number comes from: the browser runtime reads it straight from the
 * electrical store, and the tab's copy of a chip that runs elsewhere (a QEMU
 * worker, the host beside a Linux guest) publishes the same numbers to that
 * host as `pad_volts`, keyed by the chip's own pin names, once when it ships
 * the chip and again whenever the solve moves one of them. The two hosts
 * therefore agree by construction (finding
 * vx-pin-read-analog-answers-neither-host-the-solve).
 *
 * A pad is WIRED when the diagram puts it on a net: NetlistBuilder keys the
 * pin-to-net map by every wire endpoint, so a pad nobody drew a wire to is
 * absent from it and reads as in the air. A model whose UI control stands in
 * for a missing wire (the Grove ADS1115's sliders) asks `vx_pin_wired` and
 * uses the control only then.
 */
import { useElectricalStore } from '../../store/useElectricalStore';

/** The net the diagram puts this pad on, or undefined when no wire reaches it. */
export function padNet(componentId: string, pad: string): string | undefined {
  if (!componentId) return undefined;
  return useElectricalStore.getState().pinNetMap.get(`${componentId}:${pad}`);
}

/**
 * The solved voltage on the pad's net, or null when the pad is on no net or
 * the solve has no finite number for it (a net the netlist did not stamp, a
 * step that did not converge).
 */
export function padVolts(componentId: string, pad: string): number | null {
  const net = padNet(componentId, pad);
  if (!net) return null;
  if (net === '0') return 0;
  const v = useElectricalStore.getState().nodeVoltages[net];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * The solved main supply rail (the board's logic VCC: 3.3 V on an ESP32 or a
 * Pico, 5 V on an Uno), or null before the first solve stamps it.
 */
export function logicRailVolts(): number | null {
  const v = useElectricalStore.getState().nodeVoltages['vcc_rail'];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Calls `cb` after every solve that published new node voltages. */
export function onSolve(cb: () => void): () => void {
  return useElectricalStore.subscribe((s, prev) => {
    if (s.nodeVoltages !== prev.nodeVoltages) cb();
  });
}

/**
 * What a remote host is told about a chip's pads: for each chip pin name, the
 * solved voltage of the pad it is, or null for a pad in the air. `pinPads`
 * maps chip pin names to the component's pad names (they are the same for a
 * plain custom chip; a Grove module names them apart, see ChipInstanceOptions
 * busPads). Every pad is listed, null included, so a wire removed since the
 * last publication reaches the host as an unwiring and not as silence.
 */
export function padVoltsFor(
  componentId: string,
  pinPads: Iterable<readonly [string, string]>,
): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const [pin, pad] of pinPads) out[pin] = padVolts(componentId, pad);
  return out;
}

/** Two publications say the same thing: nothing to send. */
export function samePadVolts(
  a: Record<string, number | null> | null,
  b: Record<string, number | null>,
): boolean {
  if (!a) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of kb) if (!(k in a) || a[k] !== b[k]) return false;
  return true;
}
