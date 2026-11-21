/**
 * PinPickerDialog
 *
 * Touch-friendly modal for picking a pin from a component or board. Shown
 * primarily on mobile when the user can't reliably hit a 12px pin overlay.
 *
 * Used in two flows:
 *   1. Wire in progress + user taps a component or board body → this dialog
 *      lists every pin so they can finish the wire by tapping a name.
 *   2. (Future) Long-press on a board → start a wire from a chosen pin.
 *
 * Touch propagation: same trick as SelectionActionBar / WireModeBanner — bind
 * native listeners to stop the canvas's own touch handler from running
 * preventDefault and swallowing our synthetic clicks.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SearchBar } from '../ui/SearchBar';

interface PinInfoLike {
  name: string;
  x: number;
  y: number;
  description?: string;
}

interface PinPickerDialogProps {
  /** Component or board ID — used by the parent to compute world-space pin coords. */
  targetId: string;
  /** Display label, e.g. "Arduino Uno" or "7 Segment". */
  title: string;
  /** Subtitle hint, e.g. "Tap a pin to connect". */
  subtitle?: string;
  /** Pin list to render. */
  pins: PinInfoLike[];
  onPinSelect: (targetId: string, pinName: string) => void;
  onClose: () => void;
  /** Optional rotate action — only meaningful for components. */
  onRotate?: () => void;
  /** Optional delete action — closes the dialog and removes the target. */
  onDelete?: () => void;
}

export const PinPickerDialog: React.FC<PinPickerDialogProps> = ({
  targetId,
  title,
  subtitle,
  pins,
  onPinSelect,
  onClose,
  onRotate,
  onDelete,
}) => {
  const { t } = useTranslation();
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const [filter, setFilter] = useState('');

  // Stop native touch events from reaching the simulator canvas listener.
  useEffect(() => {
    const el = overlayRef.current;
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
  }, []);

  const filteredPins = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return pins;
    return pins.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        (p.description && p.description.toLowerCase().includes(q)),
    );
  }, [pins, filter]);

  return (
    <div
      ref={overlayRef}
      role="dialog"
      aria-modal="true"
      aria-label={`Pick a pin on ${title}`}
      onClick={(e) => {
        // Click on backdrop (not the panel itself) closes the dialog.
        if (e.target === overlayRef.current) onClose();
      }}
      style={{
        position: 'absolute',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.5)',
        zIndex: 1100,
        display: 'flex',
        alignItems: 'flex-end',
        justifyContent: 'center',
        padding: 8,
        touchAction: 'none',
      }}
    >
      <div
        style={{
          background: 'var(--wb-5)',
          color: 'var(--wb-13)',
          border: '1px solid var(--wb-8)',
          borderRadius: 12,
          width: '100%',
          maxWidth: 420,
          maxHeight: '90%',
          display: 'flex',
          flexDirection: 'column',
          boxShadow: '0 -8px 24px rgba(0,0,0,0.6)',
          overflow: 'hidden',
          fontFamily:
            "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
        }}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '12px 14px',
            borderBottom: '1px solid var(--wb-7)',
            flexShrink: 0,
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 }}>
            <span style={{ fontSize: 14, fontWeight: 600 }}>{title}</span>
            {subtitle && (
              <span style={{ fontSize: 12, color: 'var(--wb-11)', marginTop: 2 }}>{subtitle}</span>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('editor.pinPicker.close')}
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--wb-12)',
              cursor: 'pointer',
              fontSize: 22,
              width: 36,
              height: 36,
              borderRadius: 6,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            ×
          </button>
        </div>

        {/* Filter input — handy when boards have 30+ pins */}
        {pins.length > 8 && (
          <div style={{ padding: '8px 12px', flexShrink: 0 }}>
            <SearchBar
              value={filter}
              onValueChange={setFilter}
              placeholder={t('editor.pinPicker.filterPins')}
            />
          </div>
        )}

        {/* Pin list */}
        <div
          style={{
            flex: 1,
            overflowY: 'auto',
            WebkitOverflowScrolling: 'touch',
            overscrollBehavior: 'contain',
            padding: '4px 8px 8px',
          }}
        >
          {filteredPins.length === 0 ? (
            <div style={{ padding: 16, color: 'var(--wb-11)', fontSize: 13 }}>{t('editor.pinPicker.noMatch')}</div>
          ) : (
            filteredPins.map((pin) => (
              <button
                key={pin.name}
                type="button"
                onClick={() => onPinSelect(targetId, pin.name)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  width: '100%',
                  textAlign: 'left',
                  padding: '12px 12px',
                  margin: '2px 0',
                  background: 'var(--wb-7)',
                  color: 'var(--wb-13)',
                  border: '1px solid transparent',
                  borderRadius: 6,
                  cursor: 'pointer',
                  fontSize: 14,
                  minHeight: 44,
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'var(--wb-8)';
                  e.currentTarget.style.borderColor = '#007acc';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'var(--wb-7)';
                  e.currentTarget.style.borderColor = 'transparent';
                }}
              >
                <span style={{ color: '#00d9ff', fontWeight: 600, marginRight: 10 }}>
                  {pin.name}
                </span>
                {pin.description && (
                  <span style={{ color: 'var(--wb-11)', fontSize: 12, flex: 1, minWidth: 0 }}>
                    {pin.description}
                  </span>
                )}
                <span
                  aria-hidden="true"
                  style={{ marginLeft: 'auto', color: '#007acc', fontSize: 16, fontWeight: 700 }}
                >
                  →
                </span>
              </button>
            ))
          )}
        </div>

        {/* Action footer — Rotate / Delete pinned at the bottom of the
            sheet so they're always reachable, mirroring the property
            dialog. Only rendered when the parent passes the handlers. */}
        {(onRotate || onDelete) && (
          <div
            style={{
              display: 'flex',
              gap: 8,
              padding: '10px 12px',
              borderTop: '1px solid var(--wb-7)',
              background: 'var(--wb-3)',
              flexShrink: 0,
            }}
          >
            {onRotate && (
              <button
                type="button"
                onClick={onRotate}
                style={footerButtonStyle}
                aria-label={t('editor.pinPicker.rotate')}
              >
                <RotateGlyph /> {t('editor.pinPicker.rotate')}
              </button>
            )}
            {onDelete && (
              <button
                type="button"
                onClick={onDelete}
                style={{
                  ...footerButtonStyle,
                  marginLeft: onRotate ? 0 : 'auto',
                  background: 'var(--color-feedback-error-soft)',
                  borderColor: 'var(--color-feedback-error-soft)',
                  color: 'var(--color-feedback-error)',
                }}
                aria-label={t('editor.pinPicker.delete')}
              >
                <TrashGlyph /> {t('editor.pinPicker.delete')}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

const footerButtonStyle: React.CSSProperties = {
  flex: 1,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 8,
  padding: '10px 12px',
  background: 'var(--wb-7)',
  color: 'var(--wb-13)',
  border: '1px solid var(--wb-8)',
  borderRadius: 6,
  cursor: 'pointer',
  fontSize: 14,
  minHeight: 44,
};

const RotateGlyph: React.FC = () => (
  <svg
    width={16}
    height={16}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <polyline points="23 4 23 10 17 10" />
    <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
  </svg>
);

const TrashGlyph: React.FC = () => (
  <svg
    width={16}
    height={16}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <polyline points="3 6 5 6 21 6" />
    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    <line x1="10" y1="11" x2="10" y2="17" />
    <line x1="14" y1="11" x2="14" y2="17" />
  </svg>
);
