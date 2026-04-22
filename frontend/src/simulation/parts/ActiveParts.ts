/**
 * Active semiconductor metadata registry.
 *
 * Unlike passive components (R, L, C) — whose behaviour the digital pin
 * tracer can approximate — active devices (transistors, op-amps, regulators,
 * relays, optocouplers, diodes, batteries) have polarity, non-linear I-V
 * curves, or reverse-leakage that only a full circuit solver can represent
 * faithfully. Velxio always runs SPICE so every circuit is solved with
 * real-world fidelity; this set is retained as documentation of the active
 * device catalogue and for any future UI that needs to flag them.
 *
 * These parts are intentionally **not** registered in
 * `PartSimulationRegistry` with `attachEvents`. Two reasons:
 *   - No digital `attachEvents` makes sense for a MOSFET (it's not a pushbutton),
 *     and a no-op entry would flip the canvas cursor to "pointer" — implying
 *     user interaction where there is none.
 *   - The generic self-managed rule in `SimulatorCanvas` already treats every
 *     SPICE-mapped component (via `isSpiceMapped()`) as authoritative-to-SPICE
 *     — so their digital pin state is NOT echoed back into the Zustand store.
 *     That single rule prevents the 490 Hz PWM-driven feedback loop that would
 *     otherwise reset the solver debounce and silently stop every active-
 *     semiconductor circuit from being simulated.
 */
export const ACTIVE_METADATA_IDS: ReadonlySet<string> = new Set([
  // MOSFETs
  'mosfet-2n7000',
  'mosfet-irf540',
  'mosfet-irf9540',
  'mosfet-fqp27p06',
  // BJTs
  'bjt-2n2222',
  'bjt-2n3055',
  'bjt-2n3906',
  'bjt-bc547',
  'bjt-bc557',
  // Optocouplers
  'opto-4n25',
  'opto-pc817',
  // Electromechanical / integrated drivers
  'relay',
  'motor-driver-l293d',
  // Op-amps
  'opamp-ideal',
  'opamp-lm358',
  'opamp-lm741',
  'opamp-lm324',
  'opamp-tl072',
  // Voltage regulators
  'reg-7805',
  'reg-7812',
  'reg-7905',
  'reg-lm317',
  // Diodes
  'diode',
  'diode-1n4148',
  'diode-1n4007',
  'diode-1n5817',
  'diode-1n5819',
  'zener-1n4733',
  // Sources
  'battery-9v',
  'battery-aa',
  'battery-coin-cell',
  // Light-sensitive
  'photodiode',
]);

/** Convenience helper — returns `true` if the metadataId needs SPICE. */
export function isActiveComponent(metadataId: string): boolean {
  return ACTIVE_METADATA_IDS.has(metadataId);
}
