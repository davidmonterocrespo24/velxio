import { useImperativeHandle, useRef, type ComponentPropsWithRef, type ReactNode } from 'react';
import { Search, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import './SearchBar.css';

interface SearchBarProps extends Pick<ComponentPropsWithRef<'input'>,
  'ref' | 'autoFocus' | 'onKeyDown' | 'aria-label'
> {
  className?: string;
  placeholder: string;
  value: string;
  onValueChange: (value: string) => void;
  clearLabel?: string;
  trailing?: ReactNode;
}

export function SearchBar({
  ref, className, placeholder, value, onValueChange, clearLabel, trailing, ...inputProps
}: SearchBarProps) {
  const { t } = useTranslation();
  const input = useRef<HTMLInputElement>(null);
  useImperativeHandle(ref, () => input.current!, []);

  return (
    <div className={className ? `ui-search-bar ${className}` : 'ui-search-bar'}>
      <Search size={16} aria-hidden />
      <input
        aria-label={placeholder}
        {...inputProps}
        ref={input}
        className="ui-search-input"
        type="search"
        placeholder={placeholder}
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
      />
      {trailing}
      {value && (
        <button
          type="button"
          className="ui-search-clear"
          aria-label={clearLabel ?? t('editor.componentPicker.clearSearch', 'Clear search')}
          onClick={() => {
            onValueChange('');
            input.current?.focus();
          }}
        >
          <X size={14} aria-hidden />
        </button>
      )}
    </div>
  );
}
