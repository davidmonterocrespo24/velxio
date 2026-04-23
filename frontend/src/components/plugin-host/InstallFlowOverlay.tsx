/**
 * `<InstallFlowOverlay />` — mounts the active install/update dialog
 * driven by `InstallFlowController` (SDK-008c).
 *
 * The overlay subscribes to the controller via `useSyncExternalStore` so
 * the host shell only re-renders when the modal opens or closes — not on
 * every controller internal mutation. Mount this component once, near
 * the root of the editor tree (after `<AppHeader />` and before any
 * other modals); it renders nothing while no flow is pending.
 */

import { useCallback, useSyncExternalStore } from 'react';

import { PluginConsentDialog, type PluginIdentity } from './PluginConsentDialog';
import { PluginUpdateDiffDialog } from './PluginUpdateDiffDialog';
import {
  getInstallFlowController,
  type ActiveDialog,
  type InstallFlowController,
} from '../../plugin-host/InstallFlowController';

interface InstallFlowOverlayProps {
  /**
   * Optional explicit controller injection — used by tests and Storybook
   * stories. Production code lets the overlay pull the singleton via
   * `getInstallFlowController()`.
   */
  readonly controller?: InstallFlowController;
}

export const InstallFlowOverlay: React.FC<InstallFlowOverlayProps> = ({ controller }) => {
  const ctl = controller ?? getInstallFlowController();
  const subscribe = useCallback(
    (listener: () => void) => ctl.subscribe(listener),
    [ctl],
  );
  const getSnapshot = useCallback(() => ctl.getActiveDialog(), [ctl]);
  const active = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  if (active === null) return null;
  if (active.kind === 'install') return <RenderInstall active={active} />;
  return <RenderUpdate active={active} />;
};

const RenderInstall: React.FC<{ active: Extract<ActiveDialog, { kind: 'install' }> }> = ({
  active,
}) => {
  const identity = manifestToIdentity(active.manifest);
  return (
    <PluginConsentDialog
      plugin={identity}
      permissions={active.manifest.permissions ?? []}
      {...(active.httpAllowlist !== undefined ? { httpAllowlist: active.httpAllowlist } : {})}
      onConfirm={active.onConfirm}
      onCancel={active.onCancel}
    />
  );
};

const RenderUpdate: React.FC<{ active: Extract<ActiveDialog, { kind: 'update' }> }> = ({
  active,
}) => {
  const identity = manifestToIdentity(active.manifest);
  return (
    <PluginUpdateDiffDialog
      plugin={identity}
      fromVersion={active.fromVersion}
      toVersion={active.toVersion}
      decision={active.decision}
      {...(active.httpAllowlist !== undefined ? { httpAllowlist: active.httpAllowlist } : {})}
      onUpdate={active.onUpdate}
      onSkipVersion={active.onSkipVersion}
      onUninstall={active.onUninstall}
      onCancel={active.onCancel}
    />
  );
};

/**
 * Project the SDK's `PluginManifest` shape to the `<PluginConsentDialog>`'s
 * `PluginIdentity`. The dialog is intentionally manifest-agnostic so it
 * stays usable from Storybook and tests; this is the one mapping point.
 */
function manifestToIdentity(manifest: {
  readonly id: string;
  readonly name?: string;
  readonly version: string;
  readonly publisher?: { readonly name?: string } | string;
  readonly icon?: string;
}): PluginIdentity {
  const publisherName =
    typeof manifest.publisher === 'string'
      ? manifest.publisher
      : manifest.publisher?.name;
  return {
    id: manifest.id,
    displayName: manifest.name ?? manifest.id,
    version: manifest.version,
    ...(publisherName !== undefined ? { publisher: publisherName } : {}),
    ...(manifest.icon !== undefined ? { iconUrl: manifest.icon } : {}),
  };
}

export const _manifestToIdentityForTests = manifestToIdentity;
