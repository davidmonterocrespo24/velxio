import { useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import {
  getEditorCommandsVersion,
  hasEditorCommand,
  runEditorCommand,
  subscribeEditorCommands,
} from '../../lib/editorCommands';

export function EditorAccountMenuItems({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  useSyncExternalStore(subscribeEditorCommands, getEditorCommandsVersion);

  // Account commands are registered by the hosted app for its current session.
  const items = [
    { id: 'account.myProjects', label: t('header.auth.myProjects', 'My projects') },
    { id: 'account.login', label: t('header.auth.signIn', 'Sign in') },
  ] as const;
  const actions = items.filter(({ id }) => hasEditorCommand(id));

  return (
    <>
      {actions.map(({ id, label }) => (
        <button
          key={id}
          type="button"
          role="menuitem"
          className="emb-item"
          onClick={() => {
            onClose();
            runEditorCommand(id);
          }}
        >
          {label}
        </button>
      ))}
      {actions.length > 0 && import.meta.env.VITE_PRO_BUILD && <div className="emb-separator" />}
      {actions.length === 0 && !import.meta.env.VITE_PRO_BUILD && (
        <p className="emb-account-empty">
          {t('editor.activity.accountUnavailable', 'Accounts are unavailable in this build.')}
        </p>
      )}
      <div data-velxio-slot="user-menu" style={{ display: 'contents' }} onClick={onClose} />
    </>
  );
}
