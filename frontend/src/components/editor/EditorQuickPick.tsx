import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

interface QuickPickItem {
  id: string;
  label: string;
  detail?: string;
  selected?: boolean;
  run: () => void;
}

export interface QuickPickGroup {
  label?: string;
  items: QuickPickItem[];
}

export function EditorQuickPick({
  label,
  groups,
  onClose,
  error,
  onSearch,
}: {
  label: string;
  groups: QuickPickGroup[];
  onClose: () => void;
  error?: string;
  onSearch?: () => void;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    input.current?.focus();
    return () => element?.close();
  }, []);

  const term = query.trim().toLowerCase();
  const visible = groups
    .map(({ label: groupLabel, items }) => ({
      label: groupLabel,
      items: items.filter(
        (item) => item.label.toLowerCase().includes(term) || item.id.toLowerCase().includes(term),
      ),
    }))
    .filter(({ items }) => items.length > 0);

  return (
    <dialog
      ref={dialog}
      className="editor-quick-pick"
      aria-label={label}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      onKeyDown={(event) => {
        const choices = Array.from(event.currentTarget.querySelectorAll('button'));
        if (event.target === input.current && event.key === 'Enter') {
          event.preventDefault();
          const selected = query
            ? choices[0]
            : choices.find((choice) => choice.getAttribute('aria-pressed') === 'true');
          (selected ?? choices[0])?.click();
        }
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
        event.preventDefault();
        const index = choices.findIndex((choice) => choice === document.activeElement);
        const next = index + (event.key === 'ArrowDown' ? 1 : -1);
        if (next < 0) input.current?.focus();
        else choices[Math.min(next, choices.length - 1)]?.focus();
      }}
    >
      <div className="editor-quick-pick-content">
        <input
          ref={input}
          type="search"
          value={query}
          aria-label={label}
          placeholder={label}
          onChange={(event) => {
            setQuery(event.target.value);
            onSearch?.();
          }}
        />
        {error && (
          <p className="editor-quick-pick-error" role="alert">
            {error}
          </p>
        )}
        <div className="editor-quick-pick-options">
          {visible.map(({ label: groupLabel, items }) => (
            <section key={groupLabel ?? label} aria-label={groupLabel}>
              {groupLabel && <h2>{groupLabel}</h2>}
              {items.map((item) => (
                <button type="button" key={item.id} aria-pressed={item.selected} onClick={item.run}>
                  {item.label}
                  {item.detail && <span>{item.detail}</span>}
                </button>
              ))}
            </section>
          ))}
          {visible.length === 0 && <p>{t('editor.quickPick.noMatches', 'No matches.')}</p>}
        </div>
      </div>
    </dialog>
  );
}
