/**
 * Pads of ordinary parts that behave like a custom-chip output pin.
 *
 * A Grove relay or motor-driver brick switches its load from screw terminals,
 * and nothing inside the brick joins those terminals to the signal pin: the
 * coil is not connected to the contacts, exactly as a MOSFET's gate is not
 * connected to its channel. So a load wired to a terminal walks the net
 * looking for a board pin, finds none, and resolves to nothing — the part can
 * never drive it, however faithfully the brick's own simulation runs.
 *
 * Custom chips already solved this problem: an output pin with no board GPIO
 * on its net gets a stable synthetic pin NUMBER (see ./syntheticPins), so the
 * chip's driver and every component on that net share one PinManager key. This
 * module is the seam that lets any part opt a NAMED PAD into the same
 * treatment — the wire walk mints `syntheticChipPin(componentId, padName)` for
 * it just as it would for a chip pin, and the part's own simulation mirrors
 * its output state onto that key.
 *
 * Registration is by metadata id, so it covers every instance of the part on
 * the canvas. Kept dependency-light for the same reason as syntheticPins: both
 * the trace (simulation/PinTrace) and the pro-side drive resolver import it,
 * and neither may pull in React or the store.
 */

/** metadataId -> the pad names of that part which are chip-like. */
const chipLikePads = new Map<string, Set<string>>();

/**
 * Declare `pads` as the chip-like pads of `metadataId`. Registering the same
 * id again REPLACES its set, so a def that loses a pad stops claiming it —
 * module registries re-run on a hot reload, and a merge would leave the pad
 * behind forever.
 */
export function registerChipLikePads(metadataId: string, pads: readonly string[]): void {
  chipLikePads.set(metadataId, new Set(pads));
}

/** True if this part's pad was registered as chip-like. */
export function isChipLikePad(metadataId: string | undefined, pinName: string): boolean {
  if (metadataId === undefined) return false;
  return chipLikePads.get(metadataId)?.has(pinName) ?? false;
}

/** Drop every registration. Tests only — the registry is a module singleton. */
export function resetChipLikePadsForTest(): void {
  chipLikePads.clear();
}
