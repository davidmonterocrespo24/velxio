import { useTranslation } from 'react-i18next';
import type { useComponentKeyBinding } from '../../hooks/useComponentKeyBinding';
import { formatKeyLabel } from '../../utils/keyButtonBindings';

type ComponentKeyBindingFieldProps = ReturnType<typeof useComponentKeyBinding> & {
  inspector?: boolean;
};

export function ComponentKeyBindingField({
  inspector = false,
  boundKey,
  capturingKey,
  keyInUseElsewhere,
  onToggleCapture,
  onClear,
}: ComponentKeyBindingFieldProps) {
  const { t } = useTranslation();

  return (
    <div className={inspector ? 'pid-keybind' : 'property-edit-section'}>
      <div className={inspector ? 'pid-row' : 'property-edit-row'}>
        <label className={inspector ? 'pid-keybind-title' : 'property-edit-label'}>
          {inspector && (
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <rect x="2" y="6" width="20" height="12" rx="2" />
              <path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10" />
            </svg>
          )}
          {t('editor.componentProps.keyboardKey')}
        </label>
        <div className="keybind-controls">
          <button
            type="button"
            className={`keybind-chip${capturingKey ? ' keybind-chip--capturing' : ''}${
              !boundKey && !capturingKey ? ' keybind-chip--empty' : ''
            }`}
            onClick={onToggleCapture}
          >
            {capturingKey
              ? t('editor.componentProps.pressAKey')
              : boundKey
                ? formatKeyLabel(boundKey)
                : t('editor.componentProps.assignKey')}
          </button>
          {boundKey && !capturingKey && (
            <button
              type="button"
              className="keybind-clear"
              title={t('editor.componentProps.clearKey')}
              onClick={onClear}
            >
              ×
            </button>
          )}
        </div>
      </div>
      <div className={inspector ? 'pid-keybind-help' : 'keybind-help'}>
        {t('editor.componentProps.keyboardHint')}
      </div>
      {keyInUseElsewhere && <div className="keybind-hint">{t('editor.componentProps.keyInUse')}</div>}
    </div>
  );
}
