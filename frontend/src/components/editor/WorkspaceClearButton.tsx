import { Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

export function WorkspaceClearButton({ onClear, title }: { onClear: () => void; title: string }) {
  const { t } = useTranslation();
  return (
    <button type="button" className="workspace-panel-clear" onClick={onClear} title={title}>
      <Trash2 size={13} aria-hidden />
      {t('editor.serial.clear', 'Clear')}
    </button>
  );
}
