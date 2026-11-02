/**
 * Mount reseat policy: what the mount-time reseat (DynamicComponent) does
 * with a part once its pins are measurable.
 *
 *   'reseat' - re-derive its breadboard seats from geometry (the default:
 *              what every part did before this seam);
 *   'skip'   - keep the seats it has, and count the part as seated;
 *   'wait'   - not yet: ask again on the next poll.
 *
 * A drag, a rotation or a 'pininfo-change' reseats from geometry whatever
 * the policy says; only the reseat at mount asks. The pro overlay installs
 * a policy that keeps a loaded project's saved seats: a rotated part's pins
 * turn about its wrapper's centre, the wrapper's width includes its label,
 * and the label's width follows the font, so the same project re-derived
 * different holes in another browser (velxio/velxio-prod#20).
 */
export type MountReseat = 'reseat' | 'skip' | 'wait';

type MountReseatPolicy = (componentId: string, pinNames: readonly string[]) => MountReseat;

let _impl: MountReseatPolicy | null = null;

/** Installed by the pro overlay (mountPro). Pass null to clear (hot reload). */
export function installMountReseatPolicy(impl: MountReseatPolicy | null): void {
  _impl = impl;
}

/** What to do with part `componentId`, whose element now has pins `pinNames`. */
export function mountReseatPolicy(componentId: string, pinNames: readonly string[]): MountReseat {
  if (!_impl) return 'reseat';
  try {
    return _impl(componentId, pinNames);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[oss] mount reseat policy threw:', err);
    return 'reseat';
  }
}
