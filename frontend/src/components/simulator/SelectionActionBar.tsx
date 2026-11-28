/**
 * SelectionActionBar
 *
 * Floating toolbar pinned to the top-center of the simulator canvas. Visible
 * whenever the user has something selected (wire / component / board). Gives
 * touch users a clear way to delete or rotate a selection without keyboard
 * shortcuts or right-click — the only way these actions were available before.
 *
 * Renders nothing when nothing is selected.
 *
 * Touch propagation note: the simulator canvas binds *native* touch listeners
 * with `addEventListener` and calls `preventDefault()` on touchend, which
 * suppresses the synthetic `click` event for buttons rendered above the
 * canvas. We therefore call `stopPropagation()` on the *native* touchstart
 * (React's synthetic stopPropagation does not affect native listeners) and
 * also wire each button to fire on `touchend` directly so taps work.
 */

import { RotateIcon, TrashCanIcon } from '../ui/CustomIcons';
import { X } from 'lucide-react';
import React, { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { WIRE_KEY_COLORS } from '../../utils/wireUtils';

export type SelectionKind = 'wire' | 'component' | 'board';

interface SelectionActionBarProps {
  kind: SelectionKind | null;
  /** Human label, e.g. "Wire", "Arduino Uno", "LED" */
  label: string;
  /** Show the rotate button (components only). */
  canRotate?: boolean;
  onDelete: () => void;
  onRotate?: () => void;
  onDeselect: () => void;
  onColorChange?: (color: string) => void;
  currentColor?: string;
}

const ICON_SIZE = 16;

/**
 * Bind native touch listeners to a button so taps fire the action even when
 * the simulator canvas (with its own native `addEventListener('touchend')`
 * + preventDefault) would otherwise swallow the synthetic click.
 *
 * Strategy: stopPropagation on the native touchstart so the canvas listener
 * never sees the event, and call the handler directly on touchend. This
 * runs as a layout effect so the handler closure is current after every
 * render — no ref-during-render hacks needed.
 */
function useTouchSafeAction(
  ref: React.RefObject<HTMLElement | null>,
  handler: () => void,
) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const stopNative = (e: Event) => e.stopPropagation();
    const onTouchEndNative = (e: TouchEvent) => {
      e.stopPropagation();
      e.preventDefault();
      handler();
    };
    el.addEventListener('touchstart', stopNative, { passive: false });
    el.addEventListener('touchend', onTouchEndNative, { passive: false });
    return () => {
      el.removeEventListener('touchstart', stopNative);
      el.removeEventListener('touchend', onTouchEndNative);
    };
  }, [ref, handler]);
}

export const SelectionActionBar: React.FC<SelectionActionBarProps> = ({
  kind,
  label,
  canRotate,
  onDelete,
  onRotate,
  onDeselect,
  onColorChange,
  currentColor,
}) => {
  const { t } = useTranslation();
  const [showPalette, setShowPalette] = React.useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const deleteRef = useRef<HTMLButtonElement | null>(null);
  const rotateRef = useRef<HTMLButtonElement | null>(null);
  const deselectRef = useRef<HTMLButtonElement | null>(null);
  const colorToggleRef = useRef<HTMLButtonElement | null>(null);

  // Reset the palette when the selection kind or colour-change handler changes
  // (i.e. the user switched from one wire to another, or deselected).
  useEffect(() => {
    setShowPalette(false);
  }, [kind, onColorChange]);

  // Stop native touch events from reaching the canvas listener so it can't
  // call preventDefault on touchend (which would kill the synthetic click).
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const stop = (e: Event) => e.stopPropagation();
    el.addEventListener('touchstart', stop, { passive: false });
    el.addEventListener('touchmove', stop, { passive: false });
    el.addEventListener('touchend', stop, { passive: false });
    el.addEventListener('mousedown', stop);
    return () => {
      el.removeEventListener('touchstart', stop);
      el.removeEventListener('touchmove', stop);
      el.removeEventListener('touchend', stop);
      el.removeEventListener('mousedown', stop);
    };
  }, [kind]);

  useTouchSafeAction(deleteRef, onDelete);
  useTouchSafeAction(rotateRef, onRotate ?? noop);
  useTouchSafeAction(deselectRef, onDeselect);
  useTouchSafeAction(colorToggleRef, () => setShowPalette(!showPalette));

  if (!kind) return null;

  return (
    <div
      ref={containerRef}
      role="toolbar"
      aria-label={t('editor.selectionBar.label')}
      className="selection-action-bar"
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      style={{
        position: 'absolute',
        top: 12,
        left: '50%',
        transform: 'translateX(-50%)',
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        background: 'var(--wb-3)',
        border: '1px solid var(--wb-7)',
        borderRadius: 8,
        padding: '6px 8px',
        boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
        zIndex: 50,
        fontSize: 13,
        color: 'var(--wb-13)',
        pointerEvents: 'auto',
        touchAction: 'none',
      }}
    >
      <span
        style={{
          padding: '0 8px 0 4px',
          color: 'var(--wb-12)',
          maxWidth: 180,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {label}
      </span>

      {kind === 'wire' && onColorChange && (
        <div style={{ display: 'flex', alignItems: 'center', position: 'relative' }}>
          <button
            type="button"
            ref={colorToggleRef}
            onClick={() => setShowPalette(!showPalette)}
            style={{ ...buttonStyle, padding: '6px 8px' }}
            title={t('editor.selectionBar.changeColor')}
            aria-label={t('editor.selectionBar.changeColor')}
          >
            <div
              style={{
                width: 20,
                height: 20,
                borderRadius: '50%',
                backgroundColor: currentColor || '#22c55e',
                border: '2px solid rgba(255,255,255,0.2)',
              }}
            />
          </button>

          {showPalette && (
            <div
              style={{
                position: 'absolute',
                top: '100%',
                marginTop: 8,
                left: '50%',
                transform: 'translateX(-50%)',
                display: 'flex',
                flexWrap: 'wrap',
                gap: 8,
                padding: '10px',
                background: 'var(--wb-3)',
                border: '1px solid var(--wb-7)',
                borderRadius: 8,
                boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
                justifyContent: 'center',
                width: 240,
                zIndex: 101,
              }}
            >
              {Object.values(WIRE_KEY_COLORS).map((color) => (
                <ColorButton
                  key={color}
                  color={color}
                  isSelected={color.toLowerCase() === currentColor?.toLowerCase()}
                  onClick={() => {
                    onColorChange(color);
                    setShowPalette(false);
                  }}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {canRotate && onRotate && (
        <button
          type="button"
          ref={rotateRef}
          onClick={onRotate}
          style={buttonStyle}
          title={t('editor.selectionBar.rotate90')}
          aria-label={t('editor.selectionBar.rotate')}
        >
          <RotateIcon size={ICON_SIZE} aria-hidden />
          <span className="selection-action-bar__label" style={buttonLabelStyle}>
            {t('editor.selectionBar.rotate')}
          </span>
        </button>
      )}

      <button
        type="button"
        ref={deleteRef}
        onClick={onDelete}
        style={{ ...buttonStyle, color: 'var(--color-feedback-error)' }}
        title={t(`editor.selectionBar.deleteKind.${kind}`)}
        aria-label={t(`editor.selectionBar.deleteKind.${kind}`)}
      >
        <TrashCanIcon size={ICON_SIZE} aria-hidden />
        <span className="selection-action-bar__label" style={buttonLabelStyle}>
          {t('editor.selectionBar.delete')}
        </span>
      </button>

      <button
        type="button"
        ref={deselectRef}
        onClick={onDeselect}
        style={{ ...buttonStyle, padding: '6px 8px' }}
        title={t('editor.selectionBar.deselect')}
        aria-label={t('editor.selectionBar.deselect')}
      >
        <X size={ICON_SIZE} aria-hidden />
      </button>
    </div>
  );
};

const ColorButton: React.FC<{
  color: string;
  isSelected: boolean;
  onClick: () => void;
}> = ({ color, isSelected, onClick }) => {
  const ref = useRef<HTMLButtonElement | null>(null);
  useTouchSafeAction(ref, onClick);

  return (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      style={{
        width: 22,
        height: 22,
        borderRadius: '50%',
        backgroundColor: color,
        border: isSelected ? '2px solid var(--wb-13)' : '1px solid rgba(255,255,255,0.2)',
        cursor: 'pointer',
        padding: 0,
        flexShrink: 0,
        boxShadow: isSelected ? '0 0 6px rgba(255,255,255,0.5)' : 'none',
      }}
      title={color}
    />
  );
};

const noop = () => {};

const buttonStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '6px 10px',
  background: 'transparent',
  border: '1px solid transparent',
  borderRadius: 6,
  color: 'inherit',
  cursor: 'pointer',
  fontSize: 13,
  lineHeight: 1,
  minHeight: 36, // touch-friendly hit target
};

const buttonLabelStyle: React.CSSProperties = {
  // Hidden on very narrow toolbars; kept visible by default for clarity
};
