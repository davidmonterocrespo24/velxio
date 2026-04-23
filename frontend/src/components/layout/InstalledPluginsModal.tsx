/**
 * Installed Plugins panel — entry point for users to inspect, toggle,
 * uninstall, and configure the plugins they own (CORE-008).
 *
 * Pure render of `useInstalledPluginsStore.getRows()` — the store does
 * the join between PluginManager (running) and useMarketplaceStore
 * (installed). All side-effects (toggle, uninstall, refresh) go back
 * through the store.
 *
 * Three sub-components live in this file because they are tightly
 * coupled to the modal's layout and have no other call sites:
 *   - <PluginRow>  — one row per plugin (listing + actions)
 *   - <UninstallConfirm> — confirmation overlay before destructive op
 *   - <PluginSettingsDialog> — schema-driven form mounted via
 *     <SettingsForm /> (SDK-006b)
 */

import { useEffect, useState } from 'react';

import { useMarketplaceStore } from '../../store/useMarketplaceStore';
import {
  useInstalledPluginsStore,
  type PluginPanelRow,
} from '../../store/useInstalledPluginsStore';
import type { LoadLicenseReason } from '../../plugins/loader';
import { SettingsForm } from '../plugin-host/SettingsForm';
import { getSettingsRegistry } from '../../plugin-host/SettingsRegistry';
import { useLocale, useTranslate } from '../../i18n/useLocale';
import { setEditorLocale, supportedLocales } from '../../i18n/LocaleProvider';
import {
  getInstallFlowController,
  type InstallFlowController,
  type UpdateDecision,
} from '../../plugin-host/InstallFlowController';
import type { PluginManifest } from '@velxio/sdk';

/**
 * 24h cadence for the denylist refresh timer. A token revoked centrally
 * by Pro must take effect even on a long-running editor session — the
 * loader only re-checks denylist on actual load attempts, so we poke the
 * marketplace store on a slow timer to stay in sync.
 */
const DENYLIST_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;

interface InstalledPluginsModalProps {
  onClose: () => void;
}

export const InstalledPluginsModal: React.FC<InstalledPluginsModalProps> = ({ onClose }) => {
  const tick = useInstalledPluginsStore((s) => s.tick);
  const lastError = useInstalledPluginsStore((s) => s.lastError);
  const refresh = useInstalledPluginsStore((s) => s.refresh);
  const marketplaceStatus = useMarketplaceStore((s) => s.status);
  const authRequired = useMarketplaceStore((s) => s.authRequired);
  const t = useTranslate();

  const rows = useInstalledPluginsStore.getState().getRows();
  void tick; // re-render trigger — rows are read fresh on every render

  useEffect(() => {
    void useMarketplaceStore.getState().initialize();
  }, []);

  // Slow timer that pulls the denylist again every 24h. Cleared on
  // unmount so a closed-and-reopened modal does not stack timers.
  useEffect(() => {
    const refreshDenylist = useInstalledPluginsStore.getState().refreshDenylist;
    const handle = window.setInterval(() => {
      void refreshDenylist();
    }, DENYLIST_REFRESH_INTERVAL_MS);
    return () => window.clearInterval(handle);
  }, []);

  const [confirmUninstallId, setConfirmUninstallId] = useState<string | null>(null);
  const [settingsForId, setSettingsForId] = useState<string | null>(null);

  const settingsRow = settingsForId !== null
    ? rows.find((r) => r.id === settingsForId)
    : undefined;
  const uninstallRow = confirmUninstallId !== null
    ? rows.find((r) => r.id === confirmUninstallId)
    : undefined;

  return (
    <div style={styles.overlay} onClick={onClose}>
      <div style={styles.modal} onClick={(e) => e.stopPropagation()} role="dialog" aria-label={t('plugins.title')}>
        <header style={styles.header}>
          <h2 style={styles.title}>{t('plugins.title')}</h2>
          <div style={styles.headerActions}>
            <LocalePicker />
            <button onClick={() => void refresh()} style={styles.linkBtn}>
              {t('plugins.refresh')}
            </button>
            <a
              href="https://velxio.dev/marketplace"
              target="_blank"
              rel="noopener noreferrer"
              style={styles.marketplaceLink}
            >
              {t('plugins.marketplace')}
            </a>
            <button onClick={onClose} style={styles.closeBtn} aria-label={t('plugins.close')}>
              ×
            </button>
          </div>
        </header>

        <MarketplaceBanner status={marketplaceStatus} authRequired={authRequired} />

        {lastError !== null && (
          <div style={styles.errorBanner} role="alert">
            {lastError}
          </div>
        )}

        <div style={styles.list}>
          {rows.length === 0 ? (
            <EmptyState />
          ) : (
            rows.map((row) => (
              <PluginRow
                key={row.id}
                row={row}
                onUninstallClick={() => setConfirmUninstallId(row.id)}
                onSettingsClick={() => setSettingsForId(row.id)}
              />
            ))
          )}
        </div>
      </div>

      {uninstallRow !== undefined && (
        <UninstallConfirm
          row={uninstallRow}
          onCancel={() => setConfirmUninstallId(null)}
          onConfirm={async () => {
            await useInstalledPluginsStore.getState().uninstall(uninstallRow.id);
            setConfirmUninstallId(null);
          }}
        />
      )}
      {settingsRow !== undefined && (
        <PluginSettingsDialog
          row={settingsRow}
          onClose={() => setSettingsForId(null)}
        />
      )}
    </div>
  );
};

// ── LocalePicker ─────────────────────────────────────────────────────────

/**
 * Editor-wide language dropdown. Lives in the modal's header instead of
 * a dedicated Settings panel because today this is the only "preferences"
 * surface. When more cross-cutting settings appear, lift this into its
 * own `<EditorSettings />` panel and stop bundling it here.
 *
 * The picker writes through `setEditorLocale` which (a) persists to
 * `localStorage` and (b) drives the host's `LocaleStore` — same fan-out
 * that re-translates plugin UI in `onLocaleChange` listeners.
 */
const LocalePicker: React.FC = () => {
  const t = useTranslate();
  const locale = useLocale();
  return (
    <label style={styles.localePicker} aria-label={t('plugins.language')}>
      <span style={styles.localeLabel}>{t('plugins.language')}</span>
      <select
        value={locale}
        onChange={(e) => setEditorLocale(e.target.value)}
        style={styles.localeSelect}
        data-testid="editor-locale-picker"
      >
        {supportedLocales.map((loc) => (
          <option key={loc.code} value={loc.code}>
            {loc.flag} {loc.nativeName}
          </option>
        ))}
      </select>
    </label>
  );
};

// ── PluginRow ────────────────────────────────────────────────────────────

interface PluginRowProps {
  row: PluginPanelRow;
  onUninstallClick: () => void;
  onSettingsClick: () => void;
}

const PluginRow: React.FC<PluginRowProps> = ({ row, onUninstallClick, onSettingsClick }) => {
  const busy = useInstalledPluginsStore((s) => s.busyIds.has(row.id));
  const toggleEnabled = useInstalledPluginsStore((s) => s.toggleEnabled);
  const status = row.status;
  const isFailed = status === 'failed';

  return (
    <div style={{ ...styles.row, ...(isFailed ? styles.rowFailed : {}) }} data-testid={`plugin-row-${row.id}`}>
      <div style={styles.rowMain}>
        <div style={styles.rowHeader}>
          <div style={styles.rowTitle}>
            <span style={styles.indicator(row.enabled, status)} aria-hidden="true">
              {row.enabled ? '◉' : '○'}
            </span>
            <span style={styles.rowName}>{row.displayName}</span>
            <span style={styles.rowVersion}>v{row.version}</span>
          </div>
          <div style={styles.rowActions}>
            <button
              onClick={onSettingsClick}
              style={styles.iconBtn}
              title="Settings"
              aria-label={`Settings for ${row.displayName}`}
              disabled={busy}
            >
              ⚙
            </button>
            <button
              onClick={() => void toggleEnabled(row.id)}
              style={styles.iconBtn}
              title={row.enabled ? 'Disable' : 'Enable'}
              aria-label={row.enabled ? `Disable ${row.displayName}` : `Enable ${row.displayName}`}
              disabled={busy}
            >
              {row.enabled ? '⏸' : '▶'}
            </button>
            <button
              onClick={onUninstallClick}
              style={{ ...styles.iconBtn, ...styles.iconBtnDanger }}
              title="Uninstall"
              aria-label={`Uninstall ${row.displayName}`}
              disabled={busy}
            >
              🗑
            </button>
          </div>
        </div>
        <div style={styles.rowMeta}>
          {row.publisher !== undefined && (
            <span style={styles.metaItem}>by {row.publisher}</span>
          )}
          {row.category !== undefined && (
            <span style={styles.metaItem}>{row.category}</span>
          )}
          <StatusBadge status={status} />
          {row.latestVersion !== undefined && (
            <PluginUpdateBadge
              row={row}
              currentVersion={row.version}
              latestVersion={row.latestVersion}
              onRequestUninstall={onUninstallClick}
            />
          )}
        </div>
        {isFailed && row.error !== undefined && (
          <div style={styles.errorDetail}>
            <span style={styles.errorName}>{row.error.name}</span>
            <span>: {row.error.message}</span>
            <ReportIssueLink row={row} />
          </div>
        )}
        {row.licenseReason !== undefined && (
          <LicenseStatus reason={row.licenseReason} row={row} />
        )}
      </div>
    </div>
  );
};

// ── LicenseStatus ────────────────────────────────────────────────────────

/**
 * Per-reason license copy + CTA. Maps the typed `LoadLicenseReason` to
 * a one-line headline + an action the user can actually take. We pick
 * URLs from the manifest when present (publisher repo, author homepage)
 * and fall back to the Velxio Pro support pages.
 *
 * Keeping copy in this file (not in i18n bundles yet) is intentional —
 * SDK-005b will consume these strings via `useTranslation` once the
 * editor locale picker lands.
 */
const LicenseStatus: React.FC<{ reason: LoadLicenseReason; row: PluginPanelRow }> = ({
  reason,
  row,
}) => {
  const copy = LICENSE_COPY[reason];
  return (
    <div
      style={styles.licenseDetail}
      role="status"
      data-testid={`license-status-${row.id}`}
      data-reason={reason}
    >
      <span style={styles.licenseHeadline}>{copy.headline}</span>
      <span style={styles.licenseBody}>{copy.body}</span>
      <LicenseCta reason={reason} row={row} />
    </div>
  );
};

const LicenseCta: React.FC<{ reason: LoadLicenseReason; row: PluginPanelRow }> = ({
  reason,
  row,
}) => {
  switch (reason) {
    case 'expired':
      return (
        <a
          href="https://velxio.dev/marketplace/account/licenses"
          target="_blank"
          rel="noopener noreferrer"
          style={styles.licenseCta}
        >
          Renew license →
        </a>
      );
    case 'not-authenticated':
      return (
        <a href="/login" style={styles.licenseCta}>
          Sign in →
        </a>
      );
    case 'wrong-version':
      return (
        <a
          href={`https://velxio.dev/marketplace/${encodeURIComponent(row.id)}`}
          target="_blank"
          rel="noopener noreferrer"
          style={styles.licenseCta}
        >
          Update plugin →
        </a>
      );
    case 'wrong-user':
    case 'revoked':
    case 'bad-signature':
    case 'unknown-kid':
    case 'malformed':
      return (
        <a
          href="https://velxio.dev/support"
          target="_blank"
          rel="noopener noreferrer"
          style={styles.licenseCta}
        >
          Contact support →
        </a>
      );
    case 'wrong-plugin':
      return (
        <a
          href="https://velxio.dev/support"
          target="_blank"
          rel="noopener noreferrer"
          style={styles.licenseCta}
        >
          Contact support →
        </a>
      );
    case 'no-license':
      return (
        <a
          href={`https://velxio.dev/marketplace/${encodeURIComponent(row.id)}`}
          target="_blank"
          rel="noopener noreferrer"
          style={styles.licenseCta}
        >
          Buy license →
        </a>
      );
    default:
      return null;
  }
};

const LICENSE_COPY: Record<LoadLicenseReason, { headline: string; body: string }> = {
  'no-license': {
    headline: 'License required',
    body: 'This plugin needs a Pro license. You can buy or restore one from the marketplace.',
  },
  'not-authenticated': {
    headline: 'Sign in required',
    body: 'Sign in to your Velxio Pro account to unlock plugins you own.',
  },
  'wrong-user': {
    headline: 'License belongs to another account',
    body: 'The signed license on file does not match the signed-in user. Switch accounts or contact support.',
  },
  'wrong-version': {
    headline: 'Update plugin to a compatible version',
    body: 'Your license covers a different release line of this plugin.',
  },
  'wrong-plugin': {
    headline: 'License does not match this plugin',
    body: 'The signed license is for a different plugin id. Re-download from the marketplace.',
  },
  expired: {
    headline: 'License expired',
    body: 'Your subscription ended. Renew to continue using this plugin.',
  },
  revoked: {
    headline: 'License revoked',
    body: 'This license token has been revoked by the issuer. Contact support if you think this is a mistake.',
  },
  'bad-signature': {
    headline: 'License signature invalid',
    body: 'The signature on your license token did not verify. Re-download from the marketplace.',
  },
  'unknown-kid': {
    headline: 'License signed with an unknown key',
    body: 'Your editor build does not recognise the key id used on this license. Update Velxio.',
  },
  malformed: {
    headline: 'License token corrupted',
    body: 'The license payload is unreadable. Re-download from the marketplace.',
  },
};

// ── PluginUpdateBadge ────────────────────────────────────────────────────

/**
 * Pill that announces a newer version is available. Clicking it routes
 * through `InstallFlowController.requestUpdate` (SDK-008c) so the user
 * sees the permission diff before re-loading the worker. The badge is
 * suppressed automatically when the user has previously skipped the
 * exact version surfaced here (the store strips `latestVersion` from
 * the row before we render).
 */
const PluginUpdateBadge: React.FC<{
  row: PluginPanelRow;
  currentVersion: string;
  latestVersion: string;
  onRequestUninstall: () => void;
}> = ({ row, currentVersion, latestVersion, onRequestUninstall }) => {
  const onClick = async () => {
    let controller: InstallFlowController;
    try {
      controller = getInstallFlowController();
    } catch {
      // Controller is wired at editor startup; if absent we are inside
      // a stripped-down test render — best-effort no-op.
      return;
    }
    const installedManifest = row.entry?.manifest;
    if (installedManifest === undefined) return;
    const latestManifest = synthesizeLatestManifest(installedManifest, latestVersion);
    let decision: UpdateDecision;
    try {
      decision = await controller.requestUpdate(
        { manifest: installedManifest },
        { manifest: latestManifest },
      );
    } catch {
      // Busy: another flow is already open. Silently bail — the user
      // will see the existing modal.
      return;
    }
    if (decision.kind === 'uninstalled') onRequestUninstall();
    // 'updated' / 'skipped' / 'cancelled' need no extra UI hooks here:
    // - 'updated' will be wired to the loader reload by PRO-003.
    // - 'skipped' already persisted via the store's markVersionSkipped.
    // - 'cancelled' leaves the row untouched.
  };
  return (
    <button
      type="button"
      onClick={() => void onClick()}
      style={styles.updateBadge}
      title={`v${currentVersion} → v${latestVersion}`}
      data-testid="plugin-update-badge"
    >
      Update available — v{latestVersion}
    </button>
  );
};

/**
 * Until PRO-003 ships the marketplace catalog endpoint, the badge has no
 * way to fetch the *new* manifest's permissions. We synthesize one by
 * cloning the installed manifest and bumping `version`. The diff
 * machinery sees `added=∅` and the controller resolves through the
 * `auto-approve` path — i.e. the dialog stays closed for installs that
 * have not actually changed permissions. PRO-003 will replace this
 * synthesizer with the real catalog fetch.
 */
function synthesizeLatestManifest(
  installed: PluginManifest,
  latestVersion: string,
): PluginManifest {
  return { ...installed, version: latestVersion };
}

// ── StatusBadge ──────────────────────────────────────────────────────────

const StatusBadge: React.FC<{ status: PluginPanelRow['status'] }> = ({ status }) => {
  const palette = STATUS_PALETTE[status];
  return (
    <span
      style={{
        ...styles.statusBadge,
        background: palette.bg,
        color: palette.fg,
      }}
    >
      {palette.label}
    </span>
  );
};

const STATUS_PALETTE: Record<PluginPanelRow['status'], { bg: string; fg: string; label: string }> = {
  active:                { bg: '#0a3a1a', fg: '#5dd58c', label: 'Active' },
  loading:               { bg: '#283958', fg: '#9ec3ff', label: 'Loading…' },
  failed:                { bg: '#5a1a1a', fg: '#ff9595', label: 'Failed' },
  unloaded:              { bg: '#3c3c3c', fg: '#a0a0a0', label: 'Disabled' },
  paused:                { bg: '#3a2c0a', fg: '#f0c878', label: 'Paused' },
  'installed-not-loaded':{ bg: '#3c3c3c', fg: '#a0a0a0', label: 'Idle' },
  'no-license':          { bg: '#3a2c0a', fg: '#dda85c', label: 'License required' },
};

// ── ReportIssueLink ──────────────────────────────────────────────────────

const ReportIssueLink: React.FC<{ row: PluginPanelRow }> = ({ row }) => {
  // The manifest may carry author email or repository URL in extension
  // fields the SDK does not type narrowly. We probe both shapes.
  const m = (row.entry?.manifest ?? {}) as unknown as {
    author?: { email?: string; url?: string };
    publisher?: { email?: string; url?: string };
    repository?: { url?: string } | string;
  };
  const email = m.author?.email ?? m.publisher?.email;
  const repo = typeof m.repository === 'string'
    ? m.repository
    : m.repository?.url ?? m.author?.url ?? m.publisher?.url;
  if (email !== undefined) {
    const subject = encodeURIComponent(`Plugin ${row.id} v${row.version} failed in Velxio`);
    return (
      <a href={`mailto:${email}?subject=${subject}`} style={styles.reportLink}>
        Report issue
      </a>
    );
  }
  if (repo !== undefined) {
    return (
      <a href={repo} target="_blank" rel="noopener noreferrer" style={styles.reportLink}>
        Report issue
      </a>
    );
  }
  return null;
};

// ── MarketplaceBanner ────────────────────────────────────────────────────

const MarketplaceBanner: React.FC<{
  status: ReturnType<typeof useMarketplaceStore.getState>['status'];
  authRequired: boolean;
}> = ({ status, authRequired }) => {
  if (status.kind === 'available' && !authRequired) return null;
  if (status.kind === 'idle') return null;
  if (authRequired) {
    return (
      <div style={{ ...styles.bannerBase, ...styles.bannerWarn }}>
        Sign in to Velxio Pro to see your purchased plugins.
      </div>
    );
  }
  if (status.kind === 'probing') {
    return (
      <div style={{ ...styles.bannerBase, ...styles.bannerInfo }}>
        Checking marketplace…
      </div>
    );
  }
  if (status.kind === 'unavailable') {
    return (
      <div style={{ ...styles.bannerBase, ...styles.bannerNeutral }}>
        Marketplace {messageForReason(status.reason)}. You can still use locally-loaded plugins.
      </div>
    );
  }
  return null;
};

function messageForReason(reason: string): string {
  switch (reason) {
    case 'disabled':         return 'is disabled in this build';
    case 'not-found':        return 'is not deployed at this origin';
    case 'network':          return 'is unreachable';
    case 'http-error':       return 'returned an unexpected error';
    case 'malformed-metadata': return 'returned an invalid discovery doc';
    default:                 return 'is unavailable';
  }
}

// ── EmptyState ───────────────────────────────────────────────────────────

const EmptyState: React.FC = () => {
  const t = useTranslate();
  return (
    <div style={styles.empty}>
      <p style={styles.emptyTitle}>{t('plugins.empty.title')}</p>
      <p style={styles.emptyBody}>{t('plugins.empty.body')}</p>
      <a
        href="https://velxio.dev/marketplace"
        target="_blank"
        rel="noopener noreferrer"
        style={styles.emptyCta}
      >
        {t('plugins.empty.cta')}
      </a>
    </div>
  );
};

// ── UninstallConfirm ─────────────────────────────────────────────────────

const UninstallConfirm: React.FC<{
  row: PluginPanelRow;
  onCancel: () => void;
  onConfirm: () => void | Promise<void>;
}> = ({ row, onCancel, onConfirm }) => {
  const t = useTranslate();
  return (
    <div style={styles.overlayInner} onClick={onCancel}>
      <div style={styles.confirm} onClick={(e) => e.stopPropagation()}>
        <h3 style={styles.confirmTitle}>{t('plugins.uninstall.title', { name: row.displayName })}</h3>
        <p style={styles.confirmBody}>{t('plugins.uninstall.body1')}</p>
        <p style={styles.confirmBody}>{t('plugins.uninstall.body2')}</p>
        <div style={styles.confirmActions}>
          <button onClick={onCancel} style={styles.cancelBtn}>{t('common.cancel')}</button>
          <button onClick={() => void onConfirm()} style={styles.dangerBtn}>{t('plugins.uninstall.confirm')}</button>
        </div>
      </div>
    </div>
  );
};

// ── PluginSettingsDialog ─────────────────────────────────────────────────

const PluginSettingsDialog: React.FC<{
  row: PluginPanelRow;
  onClose: () => void;
}> = ({ row, onClose }) => {
  const t = useTranslate();
  const hasSchema = getSettingsRegistry().get(row.id) !== undefined;
  return (
    <div style={styles.overlayInner} onClick={onClose}>
      <div style={{ ...styles.confirm, width: 'min(560px, 92vw)' }} onClick={(e) => e.stopPropagation()}>
        <h3 style={styles.confirmTitle}>{t('plugins.settings.title', { name: row.displayName })}</h3>
        {hasSchema ? (
          <SettingsForm pluginId={row.id} />
        ) : (
          <>
            <p style={styles.confirmBody}>
              {t('plugins.settings.empty')}
              <code> ctx.settings.declare(...) </code>
            </p>
            {row.entry?.manifest !== undefined && (
              <details style={styles.details}>
                <summary style={styles.detailsSummary}>{t('plugins.settings.metadata')}</summary>
                <pre style={styles.metaPre}>{JSON.stringify(row.entry.manifest, null, 2)}</pre>
              </details>
            )}
          </>
        )}
        <div style={styles.confirmActions}>
          <button onClick={onClose} style={styles.primaryBtn}>{t('plugins.close')}</button>
        </div>
      </div>
    </div>
  );
};

// ── styles ───────────────────────────────────────────────────────────────

const styles = {
  overlay: {
    position: 'fixed' as const,
    inset: 0,
    background: 'rgba(0,0,0,.6)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000,
  },
  overlayInner: {
    position: 'fixed' as const,
    inset: 0,
    background: 'rgba(0,0,0,.6)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1001,
  },
  modal: {
    background: '#252526',
    border: '1px solid #3c3c3c',
    borderRadius: 8,
    padding: '1.5rem',
    width: 'min(640px, 92vw)',
    maxHeight: '80vh',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 12,
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
  },
  title: { color: '#ccc', margin: 0, fontSize: 18, fontWeight: 600 },
  headerActions: { display: 'flex', alignItems: 'center', gap: 10 },
  localePicker: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
  } as React.CSSProperties,
  localeLabel: {
    color: '#888',
    fontSize: 11,
    textTransform: 'uppercase' as const,
    letterSpacing: 0.5,
  },
  localeSelect: {
    background: '#1f1f20',
    border: '1px solid #3c3c3c',
    color: '#ccc',
    padding: '4px 8px',
    borderRadius: 4,
    fontSize: 12,
    cursor: 'pointer',
  } as React.CSSProperties,
  linkBtn: {
    background: 'transparent',
    border: '1px solid #555',
    color: '#ccc',
    padding: '4px 10px',
    borderRadius: 4,
    fontSize: 12,
    cursor: 'pointer',
  },
  marketplaceLink: {
    color: '#9ec3ff',
    fontSize: 12,
    textDecoration: 'none',
  },
  closeBtn: {
    background: 'transparent',
    border: 'none',
    color: '#ccc',
    fontSize: 22,
    cursor: 'pointer',
    padding: '0 4px',
    lineHeight: 1,
  },
  list: {
    overflowY: 'auto' as const,
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 1,
    background: '#1f1f20',
    border: '1px solid #2f2f30',
    borderRadius: 6,
  },
  row: {
    display: 'flex',
    alignItems: 'flex-start',
    background: '#252526',
    padding: '12px 14px',
  },
  rowFailed: { background: '#2a1d1d' },
  rowMain: { flex: 1, display: 'flex', flexDirection: 'column' as const, gap: 6 },
  rowHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  rowTitle: { display: 'flex', alignItems: 'center', gap: 8 },
  indicator: (enabled: boolean, status: PluginPanelRow['status']): React.CSSProperties => ({
    color: status === 'failed' ? '#ff9595'
      : status === 'active' ? '#5dd58c'
      : enabled ? '#9ec3ff'
      : '#777',
    fontSize: 14,
  }),
  rowName: { color: '#e0e0e0', fontSize: 14, fontWeight: 600 },
  rowVersion: { color: '#888', fontSize: 12, fontFamily: 'monospace' },
  rowActions: { display: 'flex', alignItems: 'center', gap: 4 },
  iconBtn: {
    background: 'transparent',
    border: '1px solid #3c3c3c',
    color: '#ccc',
    width: 28,
    height: 28,
    borderRadius: 4,
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 13,
  } as React.CSSProperties,
  iconBtnDanger: { borderColor: '#5a1a1a', color: '#ff9595' },
  rowMeta: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    color: '#888',
    fontSize: 12,
  },
  metaItem: { color: '#888' },
  statusBadge: {
    padding: '2px 8px',
    borderRadius: 10,
    fontSize: 11,
    fontWeight: 500,
  },
  errorDetail: {
    color: '#ff9595',
    fontSize: 12,
    fontFamily: 'monospace',
    background: '#1c1010',
    border: '1px solid #5a1a1a',
    borderRadius: 4,
    padding: '6px 8px',
    display: 'flex',
    flexWrap: 'wrap' as const,
    gap: 8,
  },
  errorName: { fontWeight: 600 },
  reportLink: { color: '#9ec3ff', textDecoration: 'underline', marginLeft: 'auto' },
  licenseDetail: {
    color: '#dda85c',
    fontSize: 12,
    background: '#2d2208',
    border: '1px solid #5e4814',
    borderRadius: 4,
    padding: '6px 8px',
    display: 'flex',
    flexWrap: 'wrap' as const,
    alignItems: 'center',
    gap: 8,
  } as React.CSSProperties,
  licenseHeadline: { fontWeight: 600, color: '#f0c878' },
  licenseBody: { color: '#c8a86c' },
  licenseCta: { color: '#9ec3ff', textDecoration: 'underline', marginLeft: 'auto' },
  updateBadge: {
    background: '#1a3a4a',
    color: '#7cd0ff',
    padding: '2px 8px',
    borderRadius: 10,
    fontSize: 11,
    fontWeight: 500,
    border: '1px solid #2a5a7a',
    cursor: 'pointer',
    fontFamily: 'inherit',
  } as React.CSSProperties,
  errorBanner: {
    background: '#5a1a1a',
    color: '#ff9595',
    padding: '8px 12px',
    borderRadius: 4,
    fontSize: 13,
  },
  bannerBase: {
    padding: '8px 12px',
    borderRadius: 4,
    fontSize: 13,
  } as React.CSSProperties,
  bannerInfo: { background: '#283958', color: '#9ec3ff' },
  bannerWarn: { background: '#3a2c0a', color: '#dda85c' },
  bannerNeutral: { background: '#2a2a2b', color: '#a0a0a0' },
  empty: {
    padding: '32px 20px',
    textAlign: 'center' as const,
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 8,
    color: '#888',
  },
  emptyTitle: { color: '#ccc', fontSize: 15, margin: 0, fontWeight: 600 },
  emptyBody: { color: '#888', fontSize: 13, margin: 0 },
  emptyCta: {
    color: '#9ec3ff',
    fontSize: 13,
    textDecoration: 'none',
    marginTop: 8,
  },
  confirm: {
    background: '#252526',
    border: '1px solid #3c3c3c',
    borderRadius: 8,
    padding: '1.5rem',
    width: 'min(440px, 92vw)',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 12,
  },
  confirmTitle: { color: '#ccc', margin: 0, fontSize: 16, fontWeight: 600 },
  confirmBody: { color: '#a0a0a0', margin: 0, fontSize: 13, lineHeight: 1.5 },
  confirmActions: {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: 8,
    marginTop: 4,
  },
  cancelBtn: {
    background: 'transparent',
    border: '1px solid #555',
    color: '#ccc',
    padding: '7px 14px',
    borderRadius: 4,
    cursor: 'pointer',
    fontSize: 13,
  },
  dangerBtn: {
    background: '#a02020',
    color: '#fff',
    border: 'none',
    padding: '7px 14px',
    borderRadius: 4,
    cursor: 'pointer',
    fontSize: 13,
    fontWeight: 500,
  },
  primaryBtn: {
    background: '#0e639c',
    color: '#fff',
    border: 'none',
    padding: '7px 14px',
    borderRadius: 4,
    cursor: 'pointer',
    fontSize: 13,
    fontWeight: 500,
  },
  details: {
    background: '#1f1f20',
    border: '1px solid #2f2f30',
    borderRadius: 4,
    padding: '8px 10px',
  } as React.CSSProperties,
  detailsSummary: { color: '#a0a0a0', fontSize: 12, cursor: 'pointer' },
  metaPre: {
    color: '#9ec3ff',
    fontSize: 11,
    fontFamily: 'monospace',
    margin: 0,
    marginTop: 6,
    maxHeight: 220,
    overflow: 'auto' as const,
  } as React.CSSProperties,
};
