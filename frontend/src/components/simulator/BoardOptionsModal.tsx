import { useCallback, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { BoardKind } from '../../types/board';
import { BOARD_KIND_LABELS } from '../../types/board';
import type {
  ESP32BoardOptions,
  ESP32CoreSelect,
  SpiffsFile,
} from '../../types/boardOptions';
import {
  CORE_SELECT_OPTIONS,
  CPU_FREQ_OPTIONS,
  DEBUG_LEVEL_OPTIONS,
  FLASH_FREQ_OPTIONS,
  FLASH_MODE_OPTIONS,
  FLASH_SIZE_OPTIONS,
  PARTITION_SCHEME_FS_SIZE,
  PARTITION_SCHEME_LABELS,
  boardSupportsOpiPsram,
  boardSupportsPsram,
  getDefaultOptionsForKind,
} from '../../types/boardOptions';
import { showConfirmDialog } from '../../store/useMessageDialogStore';
import './BoardOptionsModal.css';

interface BoardOptionsModalProps {
  isOpen: boolean;
  boardId: string;
  boardKind: BoardKind;
  /** User-given board name (optional); shown in the subtitle when set. */
  boardName?: string;
  currentOptions: ESP32BoardOptions | undefined;
  spiffsFiles: SpiffsFile[];
  onClose: () => void;
  onApply: (next: ESP32BoardOptions) => void;
  onSpiffsChange: (next: SpiffsFile[]) => void;
}

type TabKey = 'options' | 'files';

const PARTITION_SCHEMES: (keyof typeof PARTITION_SCHEME_LABELS)[] = [
  'default',
  'defaults_ffat',
  'min_spiffs',
  'min_ffat',
  'no_ota',
  'no_fs',
  'huge_app',
  'large_spiffs',
  'rainmaker',
];

const MAX_FILE_BYTES = 1 * 1024 * 1024;       // 1 MB per file warning
const SOFT_TOTAL_CAP = 4 * 1024 * 1024;       // 4 MB total guardrail

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

async function readFileAsBase64(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let bin = '';
  // Chunk to avoid the call-stack ceiling on large files.
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export const BoardOptionsModal = ({
  isOpen,
  boardId,
  boardName,
  boardKind,
  currentOptions,
  spiffsFiles,
  onClose,
  onApply,
  onSpiffsChange,
}: BoardOptionsModalProps) => {
  const { t } = useTranslation();
  const seed = useMemo(
    // Stored options may name only some keys (an example's, or a board
    // kind's): the rest show the kind's defaults instead of empty selects.
    () => ({ ...getDefaultOptionsForKind(boardKind), ...(currentOptions ?? {}) }),
    [currentOptions, boardKind],
  );
  const [tab, setTab] = useState<TabKey>('options');
  const [draft, setDraft] = useState<ESP32BoardOptions>(seed);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const update = useCallback(
    (patch: Partial<ESP32BoardOptions>) => setDraft((d) => ({ ...d, ...patch })),
    [],
  );

  // Hooks must run on every render — bail out only AFTER all of them.
  if (!isOpen) return null;

  const showPsram = boardSupportsPsram(boardKind);
  const showOpi = boardSupportsOpiPsram(boardKind);

  const fsCapacity = PARTITION_SCHEME_FS_SIZE[draft.partitionScheme] ?? 0;
  const totalUploaded = spiffsFiles.reduce((sum, f) => sum + f.size, 0);
  const overSchemeCap = fsCapacity > 0 && totalUploaded > fsCapacity;
  const noFsButHasFiles = fsCapacity === 0 && spiffsFiles.length > 0;
  const nonDio = draft.flashMode !== 'dio';
  const sameCore = draft.eventsRunOnCore === draft.arduinoRunsOnCore;

  const handleApply = () => {
    // Strip PSRAM for boards that don't support it (e.g. C3) so a stale
    // value can't smuggle through to the backend.
    const sanitised: ESP32BoardOptions = { ...draft };
    if (!showPsram) sanitised.psram = 'disabled';
    if (!showOpi && sanitised.psram === 'opi') sanitised.psram = 'enabled';
    onApply(sanitised);
    onClose();
  };

  const handleFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const next: SpiffsFile[] = [...spiffsFiles];
    for (const f of Array.from(files)) {
      if (next.some((existing) => existing.name === f.name)) {
        const overwrite = await showConfirmDialog(
          t('editor.boardOptions.confirmOverwrite.message', { name: f.name }),
          {
            kind: 'error',
            title: t('editor.boardOptions.confirmOverwrite.title'),
            confirmLabel: t('editor.boardOptions.confirmOverwrite.confirm'),
            cancelLabel: t('editor.boardOptions.confirmOverwrite.cancel'),
            danger: true,
          },
        );
        if (!overwrite) continue;
      }
      const contentB64 = await readFileAsBase64(f);
      const entry: SpiffsFile = {
        name: f.name,
        contentB64,
        size: f.size,
      };
      const i = next.findIndex((existing) => existing.name === f.name);
      if (i >= 0) next[i] = entry;
      else next.push(entry);
    }
    onSpiffsChange(next);
  };

  const handleDelete = (name: string) => {
    onSpiffsChange(spiffsFiles.filter((f) => f.name !== name));
  };

  return (
    <div className="bom-overlay" onClick={onClose}>
      <div className="bom-modal" onClick={(e) => e.stopPropagation()}>
        <div className="bom-header">
          <div className="bom-title">
            <div className="bom-title-main">Board Options</div>
            <div className="bom-title-sub">
              {boardName?.trim() || BOARD_KIND_LABELS[boardKind]} - id {boardId}
            </div>
          </div>
          <button className="bom-close" onClick={onClose} aria-label="Close">
            &times;
          </button>
        </div>

        <div className="bom-tabs">
          <button
            className={`bom-tab ${tab === 'options' ? 'active' : ''}`}
            onClick={() => setTab('options')}
          >
            Board Options
          </button>
          <button
            className={`bom-tab ${tab === 'files' ? 'active' : ''}`}
            onClick={() => setTab('files')}
          >
            Filesystem Files ({spiffsFiles.length})
          </button>
        </div>

        <div className="bom-body">
          {tab === 'options' ? (
            <>
              <section className="bom-section">
                <h4 className="bom-section-title">Memory</h4>
                <div className="bom-row">
                  <label className="bom-label">Partition Scheme</label>
                  <div className="bom-control">
                    <select
                      className="bom-select"
                      value={draft.partitionScheme}
                      onChange={(e) =>
                        update({
                          partitionScheme: e.target.value as ESP32BoardOptions['partitionScheme'],
                        })
                      }
                    >
                      {PARTITION_SCHEMES.map((s) => (
                        <option key={s} value={s}>
                          {PARTITION_SCHEME_LABELS[s]}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
                <div className="bom-row">
                  <label className="bom-label">Flash Size</label>
                  <div className="bom-control">
                    <select
                      className="bom-select"
                      value={draft.flashSize}
                      onChange={(e) =>
                        update({ flashSize: e.target.value as ESP32BoardOptions['flashSize'] })
                      }
                    >
                      {FLASH_SIZE_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                    {draft.flashSize !== '4MB' && (
                      <span className="bom-badge bom-badge-warn">QEMU image grows</span>
                    )}
                  </div>
                </div>
              </section>

              <section className="bom-section">
                <h4 className="bom-section-title">Speed</h4>
                <div className="bom-row">
                  <label className="bom-label">CPU Frequency</label>
                  <div className="bom-control">
                    <select
                      className="bom-select"
                      value={draft.cpuFreqMHz}
                      onChange={(e) =>
                        update({
                          cpuFreqMHz: Number(e.target.value) as ESP32BoardOptions['cpuFreqMHz'],
                        })
                      }
                    >
                      {CPU_FREQ_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
                <div className="bom-row">
                  <label className="bom-label">Flash Frequency</label>
                  <div className="bom-control">
                    <select
                      className="bom-select"
                      value={draft.flashFreqMHz}
                      onChange={(e) =>
                        update({
                          flashFreqMHz: e.target.value as ESP32BoardOptions['flashFreqMHz'],
                        })
                      }
                    >
                      {FLASH_FREQ_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              </section>

              <section className="bom-section">
                <h4 className="bom-section-title">Flash</h4>
                <div className="bom-row">
                  <label className="bom-label">Flash Mode</label>
                  <div className="bom-control">
                    <select
                      className="bom-select"
                      value={draft.flashMode}
                      onChange={(e) =>
                        update({ flashMode: e.target.value as ESP32BoardOptions['flashMode'] })
                      }
                    >
                      {FLASH_MODE_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                    {nonDio && (
                      <span className="bom-badge bom-badge-error">
                        QEMU may fail to boot
                      </span>
                    )}
                  </div>
                </div>
              </section>

              {showPsram && (
                <section className="bom-section">
                  <h4 className="bom-section-title">PSRAM</h4>
                  <div className="bom-row">
                    <label className="bom-label">External PSRAM</label>
                    <div className="bom-control">
                      <select
                        className="bom-select"
                        value={draft.psram}
                        onChange={(e) =>
                          update({ psram: e.target.value as ESP32BoardOptions['psram'] })
                        }
                      >
                        <option value="disabled">Disabled</option>
                        <option value="enabled">Enabled</option>
                        {showOpi && <option value="opi">OPI PSRAM</option>}
                      </select>
                    </div>
                  </div>
                </section>
              )}

              <section className="bom-section">
                <h4 className="bom-section-title">Debug</h4>
                <div className="bom-row">
                  <label className="bom-label">Core Debug Level</label>
                  <div className="bom-control">
                    <select
                      className="bom-select"
                      value={draft.coreDebugLevel}
                      onChange={(e) =>
                        update({
                          coreDebugLevel: e.target
                            .value as ESP32BoardOptions['coreDebugLevel'],
                        })
                      }
                    >
                      {DEBUG_LEVEL_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              </section>

              <section className="bom-section">
                <h4 className="bom-section-title">Concurrency</h4>
                <div className="bom-row">
                  <label className="bom-label">Events Run On</label>
                  <div className="bom-control">
                    <select
                      className="bom-select"
                      value={draft.eventsRunOnCore}
                      onChange={(e) =>
                        update({ eventsRunOnCore: Number(e.target.value) as ESP32CoreSelect })
                      }
                    >
                      {CORE_SELECT_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
                <div className="bom-row">
                  <label className="bom-label">Arduino Runs On</label>
                  <div className="bom-control">
                    <select
                      className="bom-select"
                      value={draft.arduinoRunsOnCore}
                      onChange={(e) =>
                        update({ arduinoRunsOnCore: Number(e.target.value) as ESP32CoreSelect })
                      }
                    >
                      {CORE_SELECT_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                    {sameCore && (
                      <span className="bom-badge bom-badge-warn">
                        Both on same core
                      </span>
                    )}
                  </div>
                </div>
              </section>

              <section className="bom-section">
                <h4 className="bom-section-title">Tools</h4>
                <div className="bom-row">
                  <label className="bom-label">Erase Flash on Upload</label>
                  <div className="bom-control">
                    <input
                      className="bom-check"
                      type="checkbox"
                      checked={draft.eraseFlashOnUpload}
                      onChange={(e) => update({ eraseFlashOnUpload: e.target.checked })}
                    />
                    <span style={{ fontSize: 11, color: '#888' }}>
                      Zero NVS / SPIFFS before next run
                    </span>
                  </div>
                </div>
              </section>
            </>
          ) : (
            <SpiffsPanel
              files={spiffsFiles}
              fsCapacity={fsCapacity}
              totalUploaded={totalUploaded}
              overSchemeCap={overSchemeCap}
              noFsButHasFiles={noFsButHasFiles}
              fileInputRef={fileInputRef}
              onAdd={() => fileInputRef.current?.click()}
              onChange={handleFiles}
              onDelete={handleDelete}
            />
          )}
        </div>

        <div className="bom-footer">
          <button className="bom-btn bom-btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="bom-btn bom-btn-primary" onClick={handleApply}>
            Apply
          </button>
        </div>
      </div>
    </div>
  );
};

interface SpiffsPanelProps {
  files: SpiffsFile[];
  fsCapacity: number;
  totalUploaded: number;
  overSchemeCap: boolean;
  noFsButHasFiles: boolean;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  onAdd: () => void;
  onChange: (files: FileList | null) => void;
  onDelete: (name: string) => void;
}

const SpiffsPanel = ({
  files,
  fsCapacity,
  totalUploaded,
  overSchemeCap,
  noFsButHasFiles,
  fileInputRef,
  onAdd,
  onChange,
  onDelete,
}: SpiffsPanelProps) => {
  const overSoft = totalUploaded > SOFT_TOTAL_CAP;
  return (
    <>
      {noFsButHasFiles && (
        <div className="bom-warning">
          Selected partition scheme has no filesystem. Uploaded files will be
          ignored at flash time. Switch to a scheme like
          <code> default </code> or <code>min_spiffs</code> to keep them.
        </div>
      )}
      {overSchemeCap && (
        <div className="bom-warning">
          Total upload size ({fmtBytes(totalUploaded)}) exceeds the partition's
          SPIFFS capacity ({fmtBytes(fsCapacity)}). The image will not fit -
          remove files or pick a larger scheme.
        </div>
      )}
      {overSoft && !overSchemeCap && (
        <div className="bom-warning">
          Total upload size exceeds the recommended 4 MB cap. Save / load
          operations may slow down.
        </div>
      )}

      <div className="bom-spiffs-toolbar">
        <button className="bom-spiffs-add" onClick={onAdd}>
          Add file
        </button>
        <span className={`bom-spiffs-tally ${overSchemeCap ? 'over' : ''}`}>
          {fmtBytes(totalUploaded)}{' '}
          {fsCapacity > 0 ? `/ ${fmtBytes(fsCapacity)}` : '(no FS partition)'}
        </span>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        multiple
        style={{ display: 'none' }}
        onChange={(e) => {
          onChange(e.target.files);
          if (e.target) e.target.value = '';
        }}
      />

      {files.length === 0 ? (
        <div className="bom-spiffs-empty">
          No files. Click "Add file" to upload assets that will be flashed into
          the SPIFFS partition.
        </div>
      ) : (
        <table className="bom-spiffs-table">
          <thead>
            <tr>
              <th>Name</th>
              <th style={{ textAlign: 'right' }}>Size</th>
              <th style={{ textAlign: 'right' }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {files.map((f) => (
              <tr key={f.name}>
                <td className="bom-spiffs-name">
                  /{f.name}
                  {f.size > MAX_FILE_BYTES && (
                    <span
                      className="bom-badge bom-badge-warn"
                      style={{ marginLeft: 8 }}
                    >
                      large
                    </span>
                  )}
                </td>
                <td className="bom-spiffs-size">{fmtBytes(f.size)}</td>
                <td className="bom-spiffs-actions">
                  <button
                    className="bom-spiffs-delete"
                    onClick={() => onDelete(f.name)}
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
};
