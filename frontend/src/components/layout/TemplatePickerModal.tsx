/**
 * "New from template" picker — surfaces every template that any installed
 * plugin contributed via `ctx.templates.register()` and lets the user
 * instantiate one into the active workspace.
 *
 * The component is a pure read of `getTemplateRegistry().list()`; the
 * registry's `subscribe()` event drives re-renders so a plugin loading
 * after the modal opened still appears without remounting.
 *
 * Wire coordinates are NOT carried in `TemplateDefinition.snapshot.wires`
 * (the SDK schema only persists `componentId/pinName`), so this file is
 * responsible for resolving them after the components mount. We do that
 * on a two-frame microtask delay — the first frame mounts the React
 * component, the second gives wokwi-elements time to initialize their
 * `pinInfo` array. Pins that still don't resolve fall back to (0, 0);
 * they will snap into place the next time `updateWirePositions()` runs
 * (e.g. on the first drag).
 */

import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { RegisteredTemplate } from '@velxio/sdk';

import { useEditorStore } from '../../store/useEditorStore';
import { useSimulatorStore } from '../../store/useSimulatorStore';
import { getTemplateRegistry } from '../../plugin-host/TemplateRegistry';
import { calculatePinPosition } from '../../utils/pinPositionCalculator';
import type { Wire } from '../../types/wire';

interface TemplatePickerModalProps {
  onClose: () => void;
}

export const TemplatePickerModal: React.FC<TemplatePickerModalProps> = ({ onClose }) => {
  const templates = useTemplates();
  const [selectedId, setSelectedId] = useState<string | null>(
    templates.length > 0 ? templates[0].definition.id : null,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const grouped = useMemo(() => groupByCategory(templates), [templates]);
  const selected = templates.find((t) => t.definition.id === selectedId);

  const handleInstantiate = async (template: RegisteredTemplate) => {
    setError(null);
    setBusy(true);
    try {
      await instantiateTemplate(template);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <div style={styles.overlay} onClick={onClose}>
      <div
        style={styles.modal}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="New from template"
      >
        <header style={styles.header}>
          <h2 style={styles.title}>New from template</h2>
          <button onClick={onClose} style={styles.closeBtn} aria-label="Close">
            ×
          </button>
        </header>

        {templates.length === 0 ? (
          <EmptyState />
        ) : (
          <div style={styles.body}>
            <aside style={styles.list} data-testid="template-list">
              {grouped.map(([category, items]) => (
                <section key={category} style={styles.categorySection}>
                  <h3 style={styles.categoryHeader}>{categoryLabel(category)}</h3>
                  <ul style={styles.categoryList}>
                    {items.map((template) => (
                      <li key={template.definition.id}>
                        <button
                          type="button"
                          onClick={() => setSelectedId(template.definition.id)}
                          style={{
                            ...styles.listItem,
                            ...(selectedId === template.definition.id
                              ? styles.listItemActive
                              : {}),
                          }}
                          data-testid={`template-list-item-${template.definition.id}`}
                        >
                          <span style={styles.listItemName}>{template.definition.name}</span>
                          <span style={styles.listItemPlugin}>
                            {template.pluginId === '<host>'
                              ? 'built-in'
                              : `via ${template.pluginId}`}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </aside>
            <section style={styles.preview}>
              {selected !== undefined ? (
                <TemplatePreview
                  template={selected}
                  busy={busy}
                  error={error}
                  onInstantiate={() => void handleInstantiate(selected)}
                />
              ) : (
                <p style={styles.previewMuted}>Select a template to preview.</p>
              )}
            </section>
          </div>
        )}
      </div>
    </div>
  );
};

// ── Sub-components ────────────────────────────────────────────────────────

interface TemplatePreviewProps {
  template: RegisteredTemplate;
  busy: boolean;
  error: string | null;
  onInstantiate: () => void;
}

const TemplatePreview: React.FC<TemplatePreviewProps> = ({
  template,
  busy,
  error,
  onInstantiate,
}) => {
  const def = template.definition;
  return (
    <div style={styles.previewBody} data-testid={`template-preview-${def.id}`}>
      <div style={styles.previewHeader}>
        {def.thumbnail !== undefined && def.thumbnail.length > 0 ? (
          <img src={def.thumbnail} alt="" style={styles.previewThumb} />
        ) : (
          <div style={styles.previewThumbPlaceholder} aria-hidden>
            ⚙
          </div>
        )}
        <div style={styles.previewMeta}>
          <h4 style={styles.previewTitle}>{def.name}</h4>
          <p style={styles.previewBoard}>
            <span style={styles.tag}>{def.snapshot.board}</span>
            <DifficultyDots difficulty={def.difficulty} />
          </p>
        </div>
      </div>
      <p style={styles.previewDescription}>{def.description}</p>
      {def.tags !== undefined && def.tags.length > 0 && (
        <div style={styles.tagRow}>
          {def.tags.map((tag) => (
            <span key={tag} style={styles.tagChip}>
              #{tag}
            </span>
          ))}
        </div>
      )}
      {def.readme !== undefined && def.readme.length > 0 && (
        <details style={styles.readme}>
          <summary style={styles.readmeSummary}>Readme</summary>
          <pre style={styles.readmeBody}>{def.readme}</pre>
        </details>
      )}
      {error !== null && (
        <div role="alert" style={styles.errorBanner}>
          {error}
        </div>
      )}
      <div style={styles.previewActions}>
        <button
          type="button"
          onClick={onInstantiate}
          disabled={busy}
          style={{
            ...styles.primaryBtn,
            ...(busy ? styles.primaryBtnDisabled : {}),
          }}
          data-testid="template-instantiate-btn"
        >
          {busy ? 'Loading…' : 'Use this template'}
        </button>
        <span style={styles.warning}>This replaces the current sketch and canvas.</span>
      </div>
    </div>
  );
};

const DifficultyDots: React.FC<{ difficulty: number }> = ({ difficulty }) => (
  <span style={styles.difficulty} aria-label={`Difficulty ${difficulty} of 5`}>
    {[1, 2, 3, 4, 5].map((n) => (
      <span
        key={n}
        style={{
          ...styles.difficultyDot,
          background: n <= difficulty ? '#0e639c' : '#3c3c3c',
        }}
      />
    ))}
  </span>
);

const EmptyState: React.FC = () => (
  <div style={styles.empty} data-testid="template-empty-state">
    <p style={styles.emptyTitle}>No templates installed yet</p>
    <p style={styles.emptyBody}>
      Install a plugin from the marketplace to add starter projects to this list.
    </p>
    <a
      href="https://velxio.dev/marketplace"
      target="_blank"
      rel="noopener noreferrer"
      style={styles.marketplaceLink}
    >
      Browse marketplace →
    </a>
  </div>
);

// ── Wiring ────────────────────────────────────────────────────────────────

/**
 * Subscribe to the template registry via `useSyncExternalStore` so any
 * plugin load/unload that mutates the registry triggers a re-render
 * without us managing a setState dance.
 */
function useTemplates(): ReadonlyArray<RegisteredTemplate> {
  return useSyncExternalStore(
    (cb) => getTemplateRegistry().subscribe(cb),
    () => getTemplateRegistry().list(),
    () => getTemplateRegistry().list(),
  );
}

function groupByCategory(
  templates: ReadonlyArray<RegisteredTemplate>,
): Array<[string, RegisteredTemplate[]]> {
  const buckets = new Map<string, RegisteredTemplate[]>();
  for (const t of templates) {
    const cat = t.definition.category;
    const arr = buckets.get(cat);
    if (arr === undefined) buckets.set(cat, [t]);
    else arr.push(t);
  }
  return Array.from(buckets.entries()).sort((a, b) => a[0].localeCompare(b[0]));
}

function categoryLabel(category: string): string {
  switch (category) {
    case 'beginner':
      return 'Beginner';
    case 'intermediate':
      return 'Intermediate';
    case 'advanced':
      return 'Advanced';
    case 'showcase':
      return 'Showcase';
    default:
      return category;
  }
}

/**
 * Drop the current workspace and load the snapshot. Order matters:
 *   1. Replace files first so the editor has a coherent view.
 *   2. Set board kind (avoids a transient mismatch between board and
 *      components that target it).
 *   3. Replace components and wait one paint so wokwi-elements can
 *      instantiate `pinInfo` on each new node.
 *   4. Resolve wire endpoints to canvas coordinates and set them.
 */
async function instantiateTemplate(template: RegisteredTemplate): Promise<void> {
  const { snapshot } = template.definition;
  const editorStore = useEditorStore.getState();
  const simulatorStore = useSimulatorStore.getState();

  editorStore.loadFiles(snapshot.files.map((f) => ({ name: f.name, content: f.content })));
  simulatorStore.setBoardType(snapshot.board as Parameters<typeof simulatorStore.setBoardType>[0]);
  simulatorStore.setComponents(
    snapshot.components.map((c) => ({
      id: c.id,
      metadataId: c.metadataId,
      x: c.x,
      y: c.y,
      properties: c.properties ? { ...c.properties } : {},
    })),
  );

  // Allow React to render and wokwi-elements to mount their `pinInfo`.
  // Two frames is empirically enough — the first paints the node, the
  // second gives the custom element's `connectedCallback` a chance to
  // populate pin metadata.
  await waitTwoFrames();

  const componentLookup = new Map(snapshot.components.map((c) => [c.id, c]));
  const wires: Wire[] = snapshot.wires.map((w) => {
    const startComp = componentLookup.get(w.start.componentId);
    const endComp = componentLookup.get(w.end.componentId);
    const startPos = startComp
      ? calculatePinPosition(w.start.componentId, w.start.pinName, startComp.x, startComp.y)
      : null;
    const endPos = endComp
      ? calculatePinPosition(w.end.componentId, w.end.pinName, endComp.x, endComp.y)
      : null;
    return {
      id: w.id,
      color: w.color ?? '#1a73e8',
      waypoints: [],
      start: {
        componentId: w.start.componentId,
        pinName: w.start.pinName,
        x: startPos?.x ?? 0,
        y: startPos?.y ?? 0,
      },
      end: {
        componentId: w.end.componentId,
        pinName: w.end.pinName,
        x: endPos?.x ?? 0,
        y: endPos?.y ?? 0,
      },
    };
  });

  simulatorStore.setWires(wires);
}

function waitTwoFrames(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => resolve());
    });
  });
}

// ── Styles ────────────────────────────────────────────────────────────────

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
  modal: {
    background: '#252526',
    border: '1px solid #3c3c3c',
    borderRadius: 8,
    padding: '1.5rem',
    width: 'min(880px, 94vw)',
    maxHeight: '82vh',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 14,
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
  },
  title: { color: '#ccc', margin: 0, fontSize: 18, fontWeight: 600 },
  closeBtn: {
    background: 'transparent',
    border: 'none',
    color: '#ccc',
    fontSize: 22,
    cursor: 'pointer',
    padding: '0 4px',
    lineHeight: 1,
  },
  body: {
    display: 'grid' as const,
    gridTemplateColumns: '260px 1fr',
    gap: 16,
    minHeight: 360,
    flex: 1,
    overflow: 'hidden' as const,
  },
  list: {
    overflowY: 'auto' as const,
    paddingRight: 4,
    borderRight: '1px solid #2d2d2d',
  },
  categorySection: { marginBottom: 16 },
  categoryHeader: {
    color: '#7e8a98',
    fontSize: 11,
    textTransform: 'uppercase' as const,
    letterSpacing: 0.5,
    margin: '0 0 6px 4px',
  },
  categoryList: { listStyle: 'none', margin: 0, padding: 0 },
  listItem: {
    display: 'flex',
    flexDirection: 'column' as const,
    width: '100%',
    background: 'transparent',
    border: '1px solid transparent',
    borderRadius: 4,
    padding: '6px 8px',
    cursor: 'pointer',
    color: '#ccc',
    textAlign: 'left' as const,
    marginBottom: 2,
  },
  listItemActive: {
    background: 'rgba(14, 99, 156, 0.18)',
    border: '1px solid #0e639c',
  },
  listItemName: { fontSize: 13, fontWeight: 500 },
  listItemPlugin: { fontSize: 11, color: '#7e8a98', marginTop: 2 },
  preview: {
    overflowY: 'auto' as const,
    paddingLeft: 4,
  },
  previewMuted: { color: '#7e8a98', fontSize: 13 },
  previewBody: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 14,
  },
  previewHeader: {
    display: 'flex',
    gap: 14,
    alignItems: 'center',
  },
  previewThumb: {
    width: 96,
    height: 64,
    borderRadius: 4,
    objectFit: 'cover' as const,
    background: '#1e1e1e',
  },
  previewThumbPlaceholder: {
    width: 96,
    height: 64,
    borderRadius: 4,
    background: '#1e1e1e',
    color: '#3c3c3c',
    fontSize: 32,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  previewMeta: { display: 'flex', flexDirection: 'column' as const, gap: 4, flex: 1 },
  previewTitle: { color: '#ccc', margin: 0, fontSize: 16, fontWeight: 600 },
  previewBoard: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    margin: 0,
    fontSize: 12,
    color: '#7e8a98',
  },
  previewDescription: { color: '#bdbdbd', fontSize: 13, lineHeight: 1.5, margin: 0 },
  tag: {
    background: '#1e1e1e',
    border: '1px solid #3c3c3c',
    borderRadius: 3,
    padding: '1px 6px',
    color: '#9ec3ff',
    fontSize: 11,
  },
  tagRow: { display: 'flex', flexWrap: 'wrap' as const, gap: 6 },
  tagChip: {
    background: '#1e1e1e',
    border: '1px solid #2d2d2d',
    borderRadius: 10,
    padding: '2px 8px',
    color: '#9d9d9d',
    fontSize: 11,
  },
  readme: { borderTop: '1px solid #2d2d2d', paddingTop: 8 },
  readmeSummary: { color: '#9ec3ff', cursor: 'pointer', fontSize: 12 },
  readmeBody: {
    color: '#bdbdbd',
    fontSize: 12,
    background: '#1e1e1e',
    padding: 10,
    borderRadius: 4,
    overflow: 'auto' as const,
    margin: '8px 0 0 0',
    maxHeight: 200,
    whiteSpace: 'pre-wrap' as const,
  },
  difficulty: { display: 'inline-flex', gap: 3 },
  difficultyDot: { width: 8, height: 8, borderRadius: '50%', display: 'inline-block' },
  errorBanner: {
    background: 'rgba(244, 71, 71, .12)',
    border: '1px solid #f44747',
    color: '#f5a5a5',
    padding: '6px 10px',
    borderRadius: 4,
    fontSize: 12,
  },
  previewActions: { display: 'flex', alignItems: 'center', gap: 12, marginTop: 6 },
  primaryBtn: {
    background: '#0e639c',
    border: 'none',
    color: '#fff',
    padding: '8px 16px',
    borderRadius: 4,
    cursor: 'pointer',
    fontSize: 13,
    fontWeight: 500,
  },
  primaryBtnDisabled: { opacity: 0.6, cursor: 'not-allowed' as const },
  warning: { color: '#7e8a98', fontSize: 11 },
  empty: {
    padding: '40px 20px',
    textAlign: 'center' as const,
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    gap: 8,
  },
  emptyTitle: { color: '#ccc', fontSize: 14, margin: 0 },
  emptyBody: { color: '#7e8a98', fontSize: 12, margin: 0 },
  marketplaceLink: {
    color: '#9ec3ff',
    fontSize: 12,
    textDecoration: 'none',
    marginTop: 6,
  },
};
