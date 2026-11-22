import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  BOARD_KIND_FQBN,
  BOARD_SUPPORTS_ESPIDF,
  BOARD_SUPPORTS_MICROPYTHON,
  type BoardInstance,
  type LanguageMode,
} from '../../types/board';
import { showConfirmDialog } from '../../store/useMessageDialogStore';
import { useProjectStore } from '../../store/useProjectStore';
import { useSimulatorStore } from '../../store/useSimulatorStore';
import { editorLanguages } from '../../lib/editorLanguages';
import { EditorQuickPick } from './EditorQuickPick';

function boardLanguages(board: BoardInstance | undefined) {
  const options: { id: LanguageMode; label: string }[] = [];
  if (!board) return options;
  if (BOARD_KIND_FQBN[board.boardKind]) options.push({ id: 'arduino', label: 'Arduino C++' });
  if (BOARD_SUPPORTS_MICROPYTHON.has(board.boardKind))
    options.push({ id: 'micropython', label: 'MicroPython' });
  if (BOARD_SUPPORTS_ESPIDF.has(board.boardKind)) options.push({ id: 'espidf', label: 'ESP-IDF' });
  return options.length > 1 ? options : [];
}

export function EditorLanguagePicker({
  board,
  onDetectLanguage,
  onRename,
  onClose,
}: {
  board?: BoardInstance;
  onDetectLanguage: () => string | undefined;
  onRename: (id: string) => boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [error, setError] = useState('');
  const applyFileLanguage = (id: string) => {
    if (onRename(id)) onClose();
    else
      setError(
        t('editor.language.renameConflict', 'That filename is already in use in this folder.'),
      );
  };
  const autoDetect = () => {
    const language = onDetectLanguage();
    if (language) applyFileLanguage(language);
    else
      setError(
        t('editor.language.detectFailed', 'Could not detect a language. Select one from the list.'),
      );
  };
  const applyBoardLanguage = async (mode: LanguageMode) => {
    onClose();
    if (!board || board.languageMode === mode) return;
    const version = useProjectStore.getState().workspaceVersion;
    const confirmed = await showConfirmDialog(
      t(
        'editor.language.boardReplaceFiles',
        'Changing the board language replaces its files with a starter sketch.',
      ),
      {
        title: t('editor.language.boardChangeTitle', 'Change board language?'),
        confirmLabel: t('editor.language.boardChange', 'Change language'),
        danger: true,
      },
    );
    if (confirmed && version === useProjectStore.getState().workspaceVersion) {
      useSimulatorStore.getState().setBoardLanguageMode(board.id, mode);
    }
  };

  return (
    <EditorQuickPick
      label={t('editor.language.select', 'Select Language Mode')}
      error={error}
      onClose={onClose}
      onSearch={() => setError('')}
      groups={[
        {
          label: t('editor.language.file', 'File language'),
          items: [
            {
              id: 'auto-detect',
              label: t('editor.language.autoDetect', 'Auto Detect'),
              run: autoDetect,
            },
            ...editorLanguages.map(({ id, label }) => ({
              id,
              label,
              detail: id,
              run: () => applyFileLanguage(id),
            })),
          ],
        },
        {
          label: t('editor.language.board', 'Board language'),
          items: boardLanguages(board).map(({ id, label }) => ({
            id,
            label,
            selected: board?.languageMode === id,
            run: () => void applyBoardLanguage(id),
          })),
        },
      ]}
    />
  );
}
