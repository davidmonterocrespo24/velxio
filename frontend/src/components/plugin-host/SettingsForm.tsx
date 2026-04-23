/**
 * `<SettingsForm pluginId="…" />` — schema-driven plugin settings editor.
 *
 * Renders the live `SettingsSchema` declared via `ctx.settings.declare()`
 * as a form, validates each edit inline against the SDK's
 * `applyAndValidate`, and persists through the host registry's current
 * `SettingsBackend` (in-memory by default, IndexedDB once wired in
 * `App.tsx`).
 *
 * What this component does NOT do:
 *
 *   - It does NOT own the backend choice. `getSettingsRegistry()` is the
 *     single source of truth — wire IndexedDB once at boot.
 *   - It does NOT call the plugin's async `validate` itself; that runs
 *     inside `ctx.settings.set()` on the server side. We surface the
 *     resulting per-field errors here.
 *   - It does NOT show fields the schema doesn't declare. Unknown keys
 *     in persisted state are dropped by `applyAndValidate`; the form
 *     only renders what the live schema describes.
 *
 * The export/import buttons live in this component (single-plugin) so
 * they stay co-located with the form they round-trip. A "Export all
 * plugin settings" entry on the parent panel uses the same JSON shape
 * but operates over every persisted plugin id.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type FC,
} from 'react';

import {
  applyAndValidate,
  type SettingsLeafProperty,
  type SettingsProperty,
  type SettingsSchema,
  type SettingsValues,
  type SettingsValuesPrimitive,
} from '@velxio/sdk';

type SettingsStringProperty = Extract<SettingsLeafProperty, { type: 'string' }>;
type SettingsNumberProperty = Extract<SettingsLeafProperty, { type: 'number' | 'integer' }>;
type SettingsBooleanProperty = Extract<SettingsLeafProperty, { type: 'boolean' }>;
type SettingsArrayProperty = Extract<SettingsLeafProperty, { type: 'array' }>;

import { getSettingsRegistry } from '../../plugin-host/SettingsRegistry';

// ── Public API ────────────────────────────────────────────────────────────

export interface SettingsFormProps {
  readonly pluginId: string;
  /** Optional callback when a save flow finishes successfully. */
  readonly onSaved?: (values: SettingsValues) => void;
}

export const SettingsForm: FC<SettingsFormProps> = ({ pluginId, onSaved }) => {
  const subscribe = useCallback(
    (onChange: () => void) => getSettingsRegistry().subscribe(onChange),
    [],
  );
  const getEntry = useCallback(
    () => getSettingsRegistry().get(pluginId),
    [pluginId],
  );
  const entry = useSyncExternalStore(subscribe, getEntry);

  if (entry === undefined) {
    return (
      <div style={styles.empty}>
        <p style={styles.emptyText}>
          This plugin hasn't declared any settings. The author needs to call
          <code> ctx.settings.declare(...) </code> to expose configuration here.
        </p>
      </div>
    );
  }

  return (
    <SettingsFormBody
      key={pluginId + ':' + schemaFingerprint(entry.schema)}
      pluginId={pluginId}
      schema={entry.schema}
      onSaved={onSaved}
    />
  );
};

// ── Form body ─────────────────────────────────────────────────────────────

interface BodyProps {
  readonly pluginId: string;
  readonly schema: SettingsSchema;
  readonly onSaved?: (values: SettingsValues) => void;
}

type FieldErrors = Readonly<Record<string, string>>;

const SettingsFormBody: FC<BodyProps> = ({ pluginId, schema, onSaved }) => {
  const [values, setValues] = useState<SettingsValues>({} as SettingsValues);
  const [persisted, setPersisted] = useState<SettingsValues>({} as SettingsValues);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [rootError, setRootError] = useState<string | null>(null);
  const [resetConfirmOpen, setResetConfirmOpen] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);

  // Initial load — read once on mount + whenever the pluginId changes.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const initial = await getSettingsRegistry()
          .getBackend()
          .read(pluginId);
        const merged = applyAndValidate(schema, initial ?? {}, {} as SettingsValues);
        const seed = (merged.values ?? ({} as SettingsValues)) as SettingsValues;
        if (cancelled) return;
        setValues(seed);
        setPersisted(seed);
      } catch (err) {
        if (!cancelled) setRootError(formatError(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pluginId, schema]);

  // Compute live validation against the merged values whenever the user edits.
  const dirty = useMemo(() => !shallowEqualValues(values, persisted), [values, persisted]);
  const liveCheck = useMemo(
    () => applyAndValidate(schema, values, {} as SettingsValues),
    [schema, values],
  );
  const liveErrors: FieldErrors = useMemo(() => {
    if (liveCheck.ok) return {};
    return liveCheck.errors;
  }, [liveCheck]);

  // Surface either backend errors (from save) or live schema errors —
  // backend wins because they may include cross-field plugin-validate
  // rules that the schema can't see.
  const displayedErrors: FieldErrors = useMemo(
    () => ({ ...liveErrors, ...errors }),
    [liveErrors, errors],
  );

  const canSave = dirty && Object.keys(liveErrors).length === 0 && saveState !== 'saving';

  const updateField = (path: string, next: SettingsValuesPrimitive | undefined) => {
    setSaveState('idle');
    setRootError(null);
    setValues((prev) => setPath(prev, path, next));
    // Drop any backend error tied to this field — the user is editing it.
    setErrors((prev) => {
      if (!(path in prev)) return prev;
      const { [path]: _drop, ...rest } = prev;
      return rest;
    });
  };

  const onSave = async () => {
    setSaveState('saving');
    setRootError(null);
    try {
      const backend = getSettingsRegistry().getBackend();
      const entry = getSettingsRegistry().get(pluginId);
      if (entry === undefined) {
        setSaveState('error');
        setRootError('Plugin schema is no longer registered. Reload the editor and try again.');
        return;
      }
      const result = applyAndValidate(schema, values, {} as SettingsValues);
      if (!result.ok) {
        setErrors(result.errors);
        setSaveState('error');
        return;
      }
      const candidate = result.values!;
      // Run the plugin's async validator if any. Mirrors what
      // `createPluginSettings.set()` does so the form's behavior is
      // identical regardless of who triggered the save.
      if (entry.validate) {
        const pluginCheck = await entry.validate(candidate);
        if (!pluginCheck.ok) {
          setErrors(pluginCheck.errors);
          setSaveState('error');
          return;
        }
      }
      await backend.write(pluginId, candidate);
      // Update the registry's cache so subsequent `ctx.settings.get()`
      // calls return the new values without a backend round-trip.
      const cached = getSettingsRegistry().get(pluginId);
      if (cached) cached.cachedValues = candidate;
      setPersisted(candidate);
      setValues(candidate);
      setErrors({});
      setSaveState('saved');
      onSaved?.(candidate);
    } catch (err) {
      setSaveState('error');
      setRootError(formatError(err));
    }
  };

  const onResetConfirmed = async () => {
    setResetConfirmOpen(false);
    setSaveState('saving');
    setRootError(null);
    try {
      const backend = getSettingsRegistry().getBackend();
      const result = applyAndValidate(schema, {}, {} as SettingsValues);
      const cleared = (result.values ?? ({} as SettingsValues)) as SettingsValues;
      await backend.write(pluginId, cleared);
      const cached = getSettingsRegistry().get(pluginId);
      if (cached) cached.cachedValues = cleared;
      setValues(cleared);
      setPersisted(cleared);
      setErrors({});
      setSaveState('saved');
      onSaved?.(cleared);
    } catch (err) {
      setSaveState('error');
      setRootError(formatError(err));
    }
  };

  const onExport = () => {
    const blob = new Blob([JSON.stringify({ pluginId, values: persisted }, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${pluginId}-settings.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const onImport = async (file: File) => {
    setImportError(null);
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      // Two accepted shapes: `{ pluginId, values }` (single-plugin export)
      // or a bare values object. We don't enforce the pluginId match —
      // the schema validation rejects anything that doesn't belong.
      const incoming: unknown = parsed && typeof parsed === 'object' && 'values' in parsed
        ? (parsed as { values: unknown }).values
        : parsed;
      if (incoming === null || typeof incoming !== 'object' || Array.isArray(incoming)) {
        setImportError('Imported file does not look like a settings JSON object.');
        return;
      }
      const result = applyAndValidate(
        schema,
        incoming as Record<string, unknown>,
        {} as SettingsValues,
      );
      const next = (result.values ?? ({} as SettingsValues)) as SettingsValues;
      setValues(next);
      setSaveState('idle');
      if (!result.ok) {
        setErrors(result.errors);
        setImportError('Imported values failed validation — review the highlighted fields.');
      } else {
        setErrors({});
      }
    } catch (err) {
      setImportError(formatError(err));
    }
  };

  return (
    <div style={styles.form}>
      {schema.title !== undefined && <h4 style={styles.title}>{schema.title}</h4>}
      {schema.description !== undefined && (
        <p style={styles.description}>{schema.description}</p>
      )}

      <div style={styles.fieldList}>
        {Object.entries(schema.properties).map(([key, prop]) => (
          <FieldRow
            key={key}
            path={key}
            prop={prop}
            value={getPath(values, key)}
            error={displayedErrors[key]}
            innerErrors={prop.type === 'object' ? collectInnerErrors(displayedErrors, key) : {}}
            required={schema.required?.includes(key) ?? false}
            onChange={updateField}
          />
        ))}
      </div>

      {rootError !== null && <div style={styles.rootError}>{rootError}</div>}
      {importError !== null && <div style={styles.rootError}>{importError}</div>}
      {displayedErrors['__root__'] !== undefined && (
        <div style={styles.rootError}>{displayedErrors['__root__']}</div>
      )}

      <div style={styles.actions}>
        <button
          type="button"
          onClick={onSave}
          disabled={!canSave}
          style={canSave ? styles.primaryBtn : styles.primaryBtnDisabled}
        >
          {saveState === 'saving' ? 'Saving…' : saveState === 'saved' ? 'Saved' : 'Save'}
        </button>
        <button
          type="button"
          onClick={() => setResetConfirmOpen(true)}
          style={styles.secondaryBtn}
          disabled={saveState === 'saving'}
        >
          Reset to defaults
        </button>
        <span style={styles.spacer} />
        <button type="button" onClick={onExport} style={styles.linkBtn}>
          Export
        </button>
        <label style={styles.linkBtnLabel}>
          Import
          <input
            type="file"
            accept="application/json"
            style={styles.fileInput}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void onImport(file);
              e.target.value = '';
            }}
          />
        </label>
      </div>

      {resetConfirmOpen && (
        <div style={styles.confirmInline}>
          <span style={styles.confirmText}>
            Reset all settings for this plugin to schema defaults?
          </span>
          <button
            type="button"
            onClick={() => setResetConfirmOpen(false)}
            style={styles.secondaryBtn}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void onResetConfirmed()}
            style={styles.dangerBtn}
          >
            Reset
          </button>
        </div>
      )}
    </div>
  );
};

// ── Field row ─────────────────────────────────────────────────────────────

interface FieldRowProps {
  readonly path: string;
  readonly prop: SettingsProperty;
  readonly value: unknown;
  readonly error: string | undefined;
  readonly innerErrors: Readonly<Record<string, string>>;
  readonly required: boolean;
  readonly onChange: (path: string, next: SettingsValuesPrimitive | undefined) => void;
}

const FieldRow: FC<FieldRowProps> = ({
  path,
  prop,
  value,
  error,
  innerErrors,
  required,
  onChange,
}) => {
  if (prop.type === 'object') {
    const innerObj = (value as Record<string, unknown> | undefined) ?? {};
    return (
      <fieldset style={styles.fieldset}>
        <legend style={styles.legend}>
          {prop.title ?? path}
          {required && <span style={styles.required}>*</span>}
        </legend>
        {prop.description !== undefined && (
          <p style={styles.fieldHint}>{prop.description}</p>
        )}
        {Object.entries(prop.properties).map(([innerKey, innerProp]) => (
          <FieldRow
            key={innerKey}
            path={`${path}.${innerKey}`}
            prop={innerProp}
            value={innerObj[innerKey]}
            error={innerErrors[innerKey]}
            innerErrors={{}}
            required={prop.required?.includes(innerKey) ?? false}
            onChange={onChange}
          />
        ))}
      </fieldset>
    );
  }

  return (
    <div style={styles.field}>
      <label style={styles.fieldLabel} htmlFor={path}>
        {prop.title ?? path}
        {required && <span style={styles.required}>*</span>}
      </label>
      {prop.description !== undefined && (
        <p style={styles.fieldHint}>{prop.description}</p>
      )}
      <LeafControl path={path} prop={prop} value={value} onChange={onChange} />
      {error !== undefined && <div style={styles.fieldError}>{error}</div>}
    </div>
  );
};

// ── Type-dispatched controls ──────────────────────────────────────────────

interface LeafControlProps {
  readonly path: string;
  readonly prop: SettingsLeafProperty;
  readonly value: unknown;
  readonly onChange: (path: string, next: SettingsValuesPrimitive | undefined) => void;
}

const LeafControl: FC<LeafControlProps> = ({ path, prop, value, onChange }) => {
  if (prop.type === 'string') return <StringControl path={path} prop={prop} value={value} onChange={onChange} />;
  if (prop.type === 'number' || prop.type === 'integer')
    return <NumberControl path={path} prop={prop} value={value} onChange={onChange} />;
  if (prop.type === 'boolean')
    return <BooleanControl path={path} prop={prop} value={value} onChange={onChange} />;
  if (prop.type === 'array')
    return <StringArrayControl path={path} prop={prop} value={value} onChange={onChange} />;
  return null;
};

const StringControl: FC<{
  path: string;
  prop: SettingsStringProperty;
  value: unknown;
  onChange: LeafControlProps['onChange'];
}> = ({ path, prop, value, onChange }) => {
  const stringValue = typeof value === 'string' ? value : '';
  if (prop.enum !== undefined) {
    return (
      <select
        id={path}
        value={stringValue}
        onChange={(e) => onChange(path, e.target.value)}
        style={styles.input}
      >
        {prop.enum.map((opt) => (
          <option key={opt} value={opt}>{opt}</option>
        ))}
      </select>
    );
  }
  if (prop.format === 'multiline') {
    return (
      <textarea
        id={path}
        value={stringValue}
        onChange={(e) => onChange(path, e.target.value)}
        style={{ ...styles.input, minHeight: 80, fontFamily: 'monospace' }}
      />
    );
  }
  const inputType = prop.format === 'password' ? 'password'
    : prop.format === 'email' ? 'email'
    : prop.format === 'url' ? 'url'
    : 'text';
  return (
    <input
      id={path}
      type={inputType}
      value={stringValue}
      onChange={(e) => onChange(path, e.target.value)}
      style={styles.input}
    />
  );
};

const NumberControl: FC<{
  path: string;
  prop: SettingsNumberProperty;
  value: unknown;
  onChange: LeafControlProps['onChange'];
}> = ({ path, prop, value, onChange }) => {
  const display = typeof value === 'number' ? String(value) : (typeof value === 'string' ? value : '');
  return (
    <input
      id={path}
      type="number"
      value={display}
      min={prop.minimum}
      max={prop.maximum}
      step={prop.multipleOf ?? (prop.type === 'integer' ? 1 : undefined)}
      onChange={(e) => {
        const raw = e.target.value;
        if (raw === '') return onChange(path, undefined);
        const n = Number(raw);
        // Pass through the *number* if parseable so downstream validation
        // sees the right type; otherwise keep the raw string and let
        // applyAndValidate flag the error.
        if (Number.isFinite(n)) onChange(path, n);
        else onChange(path, raw);
      }}
      style={styles.input}
    />
  );
};

const BooleanControl: FC<{
  path: string;
  prop: SettingsBooleanProperty;
  value: unknown;
  onChange: LeafControlProps['onChange'];
}> = ({ path, value, onChange }) => {
  const checked = value === true;
  return (
    <label style={styles.toggle}>
      <input
        id={path}
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(path, e.target.checked)}
      />
      <span>{checked ? 'On' : 'Off'}</span>
    </label>
  );
};

const StringArrayControl: FC<{
  path: string;
  prop: SettingsArrayProperty;
  value: unknown;
  onChange: LeafControlProps['onChange'];
}> = ({ path, value, onChange }) => {
  const items = Array.isArray(value) ? (value as string[]) : [];
  const [draft, setDraft] = useState('');

  const addItem = () => {
    const trimmed = draft.trim();
    if (trimmed === '') return;
    const next = [...items, trimmed];
    onChange(path, next);
    setDraft('');
  };
  const removeItem = (idx: number) => {
    const next = items.filter((_, i) => i !== idx);
    onChange(path, next);
  };

  return (
    <div style={styles.tagList}>
      <div style={styles.tagRow}>
        {items.map((item, idx) => (
          <span key={`${item}::${idx}`} style={styles.tag}>
            {item}
            <button
              type="button"
              onClick={() => removeItem(idx)}
              style={styles.tagRemove}
              aria-label={`Remove ${item}`}
            >
              ×
            </button>
          </span>
        ))}
      </div>
      <div style={styles.tagAddRow}>
        <input
          id={path}
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              addItem();
            }
          }}
          style={styles.input}
          placeholder="Type and press Enter"
        />
        <button type="button" onClick={addItem} style={styles.secondaryBtn}>Add</button>
      </div>
    </div>
  );
};

// ── Helpers ───────────────────────────────────────────────────────────────

function setPath(values: SettingsValues, path: string, next: SettingsValuesPrimitive | undefined): SettingsValues {
  const dotIdx = path.indexOf('.');
  if (dotIdx === -1) {
    const out: Record<string, unknown> = { ...values };
    if (next === undefined) delete out[path];
    else out[path] = next;
    return out as SettingsValues;
  }
  const head = path.slice(0, dotIdx);
  const tail = path.slice(dotIdx + 1);
  const inner = (values[head] as Record<string, unknown> | undefined) ?? {};
  const innerOut = { ...inner };
  if (next === undefined) delete innerOut[tail];
  else innerOut[tail] = next;
  return { ...values, [head]: innerOut } as SettingsValues;
}

function getPath(values: SettingsValues, path: string): unknown {
  const dotIdx = path.indexOf('.');
  if (dotIdx === -1) return values[path];
  const head = path.slice(0, dotIdx);
  const tail = path.slice(dotIdx + 1);
  const inner = values[head] as Record<string, unknown> | undefined;
  return inner?.[tail];
}

function collectInnerErrors(errors: FieldErrors, prefix: string): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  const dotPrefix = `${prefix}.`;
  for (const [k, v] of Object.entries(errors)) {
    if (k.startsWith(dotPrefix)) out[k.slice(dotPrefix.length)] = v;
  }
  return out;
}

function shallowEqualValues(a: SettingsValues, b: SettingsValues): boolean {
  // JSON equality is fine here — values are bounded (32 KB cap) and the
  // shape is restricted to primitives + string arrays + one-level
  // objects. A reference-stable diff would gain us nothing.
  return JSON.stringify(a) === JSON.stringify(b);
}

function schemaFingerprint(schema: SettingsSchema): string {
  // A re-declare with a different shape should reset the form's local
  // state. We key the body by this fingerprint so React unmounts the
  // old body and mounts a fresh one with the new schema.
  return JSON.stringify(schema);
}

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

// ── Styles ────────────────────────────────────────────────────────────────

const styles: Record<string, CSSProperties> = {
  empty: {
    padding: '12px 14px',
    background: '#1f1f20',
    border: '1px solid #2f2f30',
    borderRadius: 6,
  },
  emptyText: { color: '#aaa', fontSize: 13, margin: 0 },
  form: { display: 'flex', flexDirection: 'column', gap: 12 },
  title: { color: '#e0e0e0', fontSize: 15, fontWeight: 600, margin: 0 },
  description: { color: '#aaa', fontSize: 12, margin: 0 },
  fieldList: { display: 'flex', flexDirection: 'column', gap: 14 },
  field: { display: 'flex', flexDirection: 'column', gap: 4 },
  fieldset: {
    border: '1px solid #3c3c3c',
    borderRadius: 6,
    padding: '10px 12px',
    margin: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
  },
  legend: { color: '#ccc', fontSize: 13, padding: '0 6px' },
  fieldLabel: { color: '#ccc', fontSize: 13, fontWeight: 500 },
  fieldHint: { color: '#888', fontSize: 11, margin: 0 },
  required: { color: '#ff9595', marginLeft: 4 },
  input: {
    background: '#1f1f20',
    color: '#e0e0e0',
    border: '1px solid #3c3c3c',
    borderRadius: 4,
    padding: '6px 8px',
    fontSize: 13,
    fontFamily: 'inherit',
    width: '100%',
    boxSizing: 'border-box',
  },
  fieldError: { color: '#ff9595', fontSize: 11 },
  rootError: {
    color: '#ff9595',
    fontSize: 12,
    background: '#2a1d1d',
    border: '1px solid #5a2929',
    borderRadius: 4,
    padding: '6px 10px',
  },
  toggle: { display: 'flex', alignItems: 'center', gap: 8, color: '#ccc', fontSize: 13 },
  tagList: { display: 'flex', flexDirection: 'column', gap: 6 },
  tagRow: { display: 'flex', flexWrap: 'wrap', gap: 4 },
  tag: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    background: '#3c3c3c',
    color: '#e0e0e0',
    borderRadius: 12,
    padding: '2px 8px',
    fontSize: 12,
  },
  tagRemove: {
    background: 'transparent',
    border: 'none',
    color: '#aaa',
    cursor: 'pointer',
    fontSize: 14,
    lineHeight: 1,
    padding: 0,
  },
  tagAddRow: { display: 'flex', gap: 6, alignItems: 'center' },
  actions: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 4, flexWrap: 'wrap' },
  spacer: { flex: 1 },
  primaryBtn: {
    background: '#0e639c',
    color: '#fff',
    border: 'none',
    borderRadius: 4,
    padding: '6px 14px',
    fontSize: 13,
    cursor: 'pointer',
  },
  primaryBtnDisabled: {
    background: '#2a3a48',
    color: '#7a8a98',
    border: 'none',
    borderRadius: 4,
    padding: '6px 14px',
    fontSize: 13,
    cursor: 'not-allowed',
  },
  secondaryBtn: {
    background: 'transparent',
    color: '#ccc',
    border: '1px solid #555',
    borderRadius: 4,
    padding: '6px 12px',
    fontSize: 13,
    cursor: 'pointer',
  },
  dangerBtn: {
    background: '#7a2929',
    color: '#fff',
    border: 'none',
    borderRadius: 4,
    padding: '6px 12px',
    fontSize: 13,
    cursor: 'pointer',
  },
  linkBtn: {
    background: 'transparent',
    color: '#9ec3ff',
    border: 'none',
    fontSize: 12,
    cursor: 'pointer',
    padding: '6px 8px',
  },
  linkBtnLabel: {
    background: 'transparent',
    color: '#9ec3ff',
    fontSize: 12,
    cursor: 'pointer',
    padding: '6px 8px',
    display: 'inline-flex',
    alignItems: 'center',
  },
  fileInput: { display: 'none' },
  confirmInline: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    background: '#2a1d1d',
    border: '1px solid #5a2929',
    borderRadius: 4,
    padding: '8px 10px',
  },
  confirmText: { color: '#ccc', fontSize: 12, flex: 1 },
};
