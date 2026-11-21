import { Children, isValidElement, useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type ReactElement, type ReactNode } from 'react';
import { Check, ChevronDown } from 'lucide-react';

interface DropdownSelectProps extends Pick<ButtonHTMLAttributes<HTMLButtonElement>,
  'id' | 'className' | 'disabled' | 'style' | 'title' | 'aria-label' | 'aria-labelledby' | 'aria-describedby'
> {
  value: string | number;
  children: ReactNode;
  onValueChange: (value: string) => void;
}

type SelectOption = { value: string | number; children: ReactNode; disabled?: boolean };

export function DropdownSelect({
  id, value, children, onValueChange, className, disabled, ...attributes
}: DropdownSelectProps) {
  const generatedId = useId();
  const controlId = id ?? generatedId;
  const options = Children.toArray(children)
    .filter((child): child is ReactElement<SelectOption> => isValidElement<SelectOption>(child) && child.type === 'option')
    .map((option) => option.props);
  const selected = options.find((option) => String(option.value) === String(value));
  const triggerClass = ['dropdown-select', className].filter(Boolean).join(' ');
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const typeahead = useRef({ text: '', time: 0 });
  const listId = `${controlId}-options`;

  useEffect(() => {
    if (!open) return;
    const closeOnLayoutChange = (event: Event) => {
      const list = popup.current;
      if (event.target instanceof Node && list?.contains(event.target)) return;
      list?.hidePopover();
    };
    window.addEventListener('resize', closeOnLayoutChange);
    window.addEventListener('scroll', closeOnLayoutChange, true);
    return () => {
      window.removeEventListener('resize', closeOnLayoutChange);
      window.removeEventListener('scroll', closeOnLayoutChange, true);
    };
  }, [open]);

  if (typeof HTMLElement === 'undefined' || typeof HTMLElement.prototype.showPopover !== 'function') {
    return (
      <select
        {...attributes}
        id={controlId}
        className={`${triggerClass} dropdown-select-native`}
        disabled={disabled || options.length === 0}
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
      >
        {children}
      </select>
    );
  }

  const close = () => {
    popup.current?.hidePopover();
    trigger.current?.focus({ preventScroll: true });
  };

  return (
    <>
      <button
        {...attributes}
        ref={trigger}
        id={controlId}
        type="button"
        className={`${triggerClass} dropdown-select-trigger`}
        disabled={disabled || options.length === 0}
        popoverTarget={listId}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
          event.preventDefault();
          if (!popup.current?.matches(':popover-open')) event.currentTarget.click();
        }}
      >
        <span>{selected?.children ?? options[0]?.children}</span>
        <ChevronDown size={15} aria-hidden />
      </button>
      <div
        ref={popup}
        id={listId}
        popover="auto"
        className="dropdown-select-options dropdown-panel"
        role="listbox"
        aria-labelledby={attributes['aria-labelledby'] ?? controlId}
        onBeforeToggle={(event) => {
          const button = trigger.current;
          if (event.newState !== 'open' || !button) return;
          const rect = button.getBoundingClientRect();
          const container = button.parentElement;
          const bounds = container?.getBoundingClientRect() ?? rect;
          const style = container && getComputedStyle(container);
          const leftGap = rect.left - bounds.left - (style ? parseFloat(style.paddingLeft) + parseFloat(style.borderLeftWidth) : 0);
          const rightGap = bounds.right - rect.right - (style ? parseFloat(style.paddingRight) + parseFloat(style.borderRightWidth) : 0);
          const fillsContainer = leftGap < 1 && rightGap < 1;
          const width = Math.min(fillsContainer ? rect.width : Math.max(rect.width, 144), window.innerWidth - 16);
          const left = rightGap + 1 < leftGap ? rect.right - width : rect.left;
          const below = window.innerHeight - rect.bottom - 12;
          const above = rect.top - 12;
          const openAbove = below < 48 && above > below;
          Object.assign(event.currentTarget.style, {
            top: openAbove ? 'auto' : `${rect.bottom + 4}px`,
            bottom: openAbove ? `${window.innerHeight - rect.top + 4}px` : 'auto',
            left: `${Math.max(8, Math.min(left, window.innerWidth - width - 8))}px`,
            width: `${width}px`,
            maxHeight: `${Math.max(0, Math.min(280, openAbove ? above : below))}px`,
          });
        }}
        onToggle={(event) => {
          const visible = event.newState === 'open';
          setOpen(visible);
          if (visible) {
            const list = event.currentTarget;
            typeahead.current = { text: '', time: 0 };
            (list.querySelector<HTMLButtonElement>('[aria-selected="true"]:enabled') ?? list.querySelector<HTMLButtonElement>('button:enabled'))?.focus();
          }
        }}
        onBlur={(event) => {
          if (event.relatedTarget && event.relatedTarget !== trigger.current &&
            !event.currentTarget.contains(event.relatedTarget)) event.currentTarget.hidePopover();
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            close();
            return;
          }
          const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:enabled')];
          const focused = buttons.indexOf(document.activeElement as HTMLButtonElement);
          if (event.key.length === 1 && event.key.trim() && !event.ctrlKey && !event.metaKey && !event.altKey) {
            const time = Date.now();
            const key = event.key.toLocaleLowerCase();
            const previous = typeahead.current;
            const text = time - previous.time < 500 && previous.text !== key ? previous.text + key : key;
            typeahead.current = { text, time };
            const ordered = [...buttons.slice(focused + 1), ...buttons.slice(0, focused + 1)];
            ordered.find((button) => button.textContent?.trim().toLocaleLowerCase().startsWith(text))?.focus();
            return;
          }
          if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault();
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 :
            focused + (event.key === 'ArrowUp' ? -1 : 1);
          buttons[Math.max(0, Math.min(next, buttons.length - 1))]?.focus();
        }}
      >
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            role="option"
            tabIndex={-1}
            aria-selected={option === selected}
            disabled={option.disabled}
            onClick={() => {
              close();
              if (option !== selected) onValueChange(String(option.value));
            }}
          >
            <span>{option.children}</span>
            {option === selected && <Check size={14} aria-hidden />}
          </button>
        ))}
      </div>
    </>
  );
}
