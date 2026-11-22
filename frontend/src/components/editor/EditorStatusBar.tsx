import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Indentation } from '../../store/useEditorPreferences';
import { EditorQuickPick } from './EditorQuickPick';

export interface EditorStatus {
  line: number;
  column: number;
  indentation: Indentation & { indentSize: number };
}

const viewActions = [
  ['indentUsingSpaces', 'Indent Using Spaces'],
  ['indentUsingTabs', 'Indent Using Tabs'],
  ['changeTabDisplaySize', 'Change Tab Display Size'],
] as const;

const fileActions = [
  ['detectIndentation', 'Detect Indentation from Content'],
  ['indentationToSpaces', 'Convert Indentation to Spaces'],
  ['indentationToTabs', 'Convert Indentation to Tabs'],
  ['trimTrailingWhitespace', 'Trim Trailing Whitespace'],
] as const;

type WidthAction = (typeof viewActions)[number][0];

export type IndentationChange =
  | { action: WidthAction; size: number }
  | { action: (typeof fileActions)[number][0] };

export function EditorStatusBar({
  status,
  readOnly,
  onIndentation,
  onGoToLine,
  languageLabel,
  onSelectLanguage,
}: {
  status: EditorStatus | null;
  readOnly: boolean;
  onIndentation: (change: IndentationChange) => void;
  onGoToLine: () => void;
  languageLabel: string;
  onSelectLanguage?: () => void;
}) {
  const { t } = useTranslation();
  const [step, setStep] = useState<WidthAction | 'actions' | null>(null);
  if (!status) return <div className="editor-status-bar" />;

  const finish = (change: IndentationChange) => {
    setStep(null);
    // Let the dialog release focus before running the command in Monaco.
    requestAnimationFrame(() => onIndentation(change));
  };
  const currentSize =
    step === 'indentUsingSpaces' ? status.indentation.indentSize : status.indentation.tabSize;
  return (
    <div className="editor-status-bar" aria-label={t('editor.status.label', 'Editor status')}>
      <button
        type="button"
        title={t('editor.status.goToLine', 'Go to Line / Column')}
        onClick={onGoToLine}
      >
        {t('editor.status.position', 'Ln {{line}}, Col {{column}}', {
          line: status.line,
          column: status.column,
        })}
      </button>
      <button
        type="button"
        className="editor-status-indent"
        aria-haspopup="dialog"
        aria-expanded={!!step}
        disabled={readOnly}
        onClick={() => setStep('actions')}
      >
        {status.indentation.insertSpaces
          ? t('editor.status.spaces', 'Spaces: {{size}}', { size: status.indentation.indentSize })
          : t('editor.status.tabs', 'Tab Size: {{size}}', { size: status.indentation.tabSize })}
      </button>
      {onSelectLanguage ? (
        <button
          type="button"
          aria-haspopup="dialog"
          className="editor-status-language"
          title={t('editor.language.select', 'Select Language Mode')}
          onClick={onSelectLanguage}
        >
          {languageLabel}
        </button>
      ) : (
        <span>{languageLabel}</span>
      )}
      {step === 'actions' && !readOnly && (
        <EditorQuickPick
          key="actions"
          label={t('editor.status.selectAction', 'Select Action')}
          onClose={() => setStep(null)}
          groups={[
            {
              label: t('editor.status.setIndentation', 'Set indentation'),
              items: viewActions.map(([action, label]) => ({
                id: action,
                label: t(`editor.status.${action}`, label),
                run: () => setStep(action),
              })),
            },
            {
              label: t('editor.status.convertFile', 'Convert file'),
              items: fileActions.map(([action, label]) => ({
                id: action,
                label: t(`editor.status.${action}`, label),
                run: () => finish({ action }),
              })),
            },
          ]}
        />
      )}
      {step && step !== 'actions' && !readOnly && (
        <EditorQuickPick
          key={step}
          label={
            step === 'changeTabDisplaySize'
              ? t('editor.status.pickTabWidth', 'Select Tab Display Size')
              : t('editor.status.pickIndentSize', 'Select Indentation Size')
          }
          onClose={() => setStep(null)}
          groups={[
            {
              items: [1, 2, 3, 4, 5, 6, 7, 8].map((size) => ({
                id: String(size),
                label: String(size),
                selected: size === currentSize,
                detail:
                  size === currentSize ? t('editor.status.currentSize', 'Current size') : undefined,
                run: () => finish({ action: step, size }),
              })),
            },
          ]}
        />
      )}
    </div>
  );
}
