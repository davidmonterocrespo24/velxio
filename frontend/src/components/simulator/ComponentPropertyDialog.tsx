/**
 * Component Property Dialog
 *
 * Displays component properties and actions when a component is selected.
 * Shows pin roles, rotation, and delete options.
 */

import { DropdownSelect } from '../ui/DropdownSelect';
import React, { useEffect, useState, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { ComponentMetadata } from '../../types/component-metadata';
import { SdCardPanel } from './SdCardPanel';
import type { UploadedSdFile } from '../../utils/sdCardFiles';
import { isKeyBindable } from '../../utils/keyButtonBindings';
import { useComponentKeyBinding } from '../../hooks/useComponentKeyBinding';
import { ComponentKeyBindingField } from './ComponentKeyBindingField';
import './ComponentPropertyDialog.css';

function isEditable(prop: any): boolean {
  if (prop.control === 'select' && prop.options) return true;
  if (prop.control === 'text' || prop.control === 'number') return true;
  return false;
}

interface ComponentPropertyDialogProps {
  componentId: string;
  componentMetadata: ComponentMetadata;
  componentProperties: Record<string, any>;
  position: { x: number; y: number };
  pinInfo: Array<{ name: string; x: number; y: number; signals?: any[]; description?: string }>;
  onClose: () => void;
  onRotate: (componentId: string) => void;
  onDelete: (componentId: string) => void;
  onPropertyChange?: (componentId: string, propertyName: string, value: unknown) => void;
  /**
   * Called when the user taps a pin row in the "Pin Roles" list. Used as a
   * touch-friendly alternative to picking pins from the canvas overlay (where
   * a fingertip is bigger than the pin). The dialog closes; the parent starts
   * or finishes a wire from the chosen pin.
   */
  onPinSelect?: (componentId: string, pinName: string) => void;
  /**
   * If true, the pin rows render as primary actions (e.g. "Connect to D2")
   * because a wire is already in progress and tapping a pin will *finish* the
   * wire here. When false the rows say "Start wire from D2".
   */
  wireInProgress?: boolean;
}

export const ComponentPropertyDialog: React.FC<ComponentPropertyDialogProps> = ({
  componentId,
  componentMetadata,
  componentProperties,
  position,
  pinInfo,
  onClose,
  onRotate,
  onDelete,
  onPropertyChange,
  onPinSelect,
  wireInProgress,
}) => {
  const { t } = useTranslation();
  const dialogRef = useRef<HTMLDivElement>(null);
  const [dialogPosition, setDialogPosition] = useState({ x: 0, y: 0 });
  // Two-step delete: first click arms the action (footer flips to a
  // "Delete X?" confirm prompt), second click commits. Replaces the old
  // window.confirm() call which was visually jarring on mobile.
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const keyBinding = useComponentKeyBinding(componentId, componentProperties.key, onPropertyChange);

  // Calculate dialog position on mount — clamp within canvas viewport
  useEffect(() => {
    if (!dialogRef.current) return;

    const dialogWidth = dialogRef.current.offsetWidth || 220;
    const dialogHeight = dialogRef.current.offsetHeight || 200;
    const canvasElement = document.querySelector('.canvas-content');
    if (!canvasElement) return;

    const canvasWidth = canvasElement.clientWidth;
    const canvasHeight = canvasElement.clientHeight;

    // Position to the right of the component (screen coords already include pan+zoom)
    let x = position.x + 120;
    let y = position.y;

    // If off-screen right, position to the left
    if (x + dialogWidth > canvasWidth) {
      x = Math.max(10, position.x - dialogWidth - 10);
    }

    // Clamp horizontal
    x = Math.max(10, Math.min(x, canvasWidth - dialogWidth - 10));

    // Clamp vertical — ensure dialog stays fully visible
    y = Math.max(10, Math.min(y, canvasHeight - dialogHeight - 10));

    setDialogPosition({ x, y });
  }, [position]);

  // Close on Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  // Close when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dialogRef.current && !dialogRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    // Delay to avoid immediate close from the click that opened the dialog
    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside);
    }, 100);

    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [onClose]);

  return (
    <div
      ref={dialogRef}
      className="component-property-dialog"
      style={{
        left: `${dialogPosition.x}px`,
        top: `${dialogPosition.y}px`,
      }}
      onClick={(e) => e.stopPropagation()}
    >
      {/* Header */}
      <div className="component-property-header">
        <span className="component-property-title">{componentMetadata.name}</span>
        <button className="property-close-button" onClick={onClose} title={t('editor.componentProps.close')}>
          ×
        </button>
      </div>

      {/* Scrollable middle: everything between the header and the action
          footer goes here so the action buttons stay pinned at the bottom on
          mobile (where the dialog uses a flex column layout). */}
      <div className="component-property-body">

      {/* Pin Roles Section — when onPinSelect is provided each row becomes a
          touch-friendly button that starts (or finishes) a wire from that pin.
          On a phone this is the primary way to wire things up: tapping a pin
          name in a list is much easier than poking a 12px overlay with a
          fingertip. */}
      {pinInfo.length > 0 && (
        <div className="pin-roles-section">
          <div className="pin-roles-label">
            {onPinSelect
              ? wireInProgress
                ? t('editor.componentProps.tapToConnect')
                : t('editor.componentProps.tapToWire')
              : t('editor.componentProps.pinRoles')}
          </div>
          {pinInfo.map((pin) => {
            const isInteractive = Boolean(onPinSelect);
            const handle = () => onPinSelect?.(componentId, pin.name);
            return (
              <div
                key={pin.name}
                role={isInteractive ? 'button' : undefined}
                tabIndex={isInteractive ? 0 : undefined}
                className={`pin-role-item${isInteractive ? ' pin-role-item--interactive' : ''}`}
                onClick={isInteractive ? handle : undefined}
                onKeyDown={
                  isInteractive
                    ? (e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          handle();
                        }
                      }
                    : undefined
                }
              >
                <span className="pin-name">• {pin.name}</span>
                {pin.description && <span className="pin-description"> ({pin.description})</span>}
                {isInteractive && (
                  <span className="pin-role-action" aria-hidden="true">
                    →
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Current Arduino Pin Assignment */}
      {componentProperties.pin !== undefined && (
        <div className="pin-assignment-section">
          <div className="pin-assignment-label">{t('editor.componentProps.arduinoPin')}</div>
          <div className="pin-assignment-value">
            {componentProperties.pin >= 14
              ? `A${componentProperties.pin - 14}`
              : `D${componentProperties.pin}`}
          </div>
        </div>
      )}

      {/* Editable Properties (select dropdowns + text/number inputs) */}
      {componentMetadata.properties.filter((p: any) => isEditable(p)).length > 0 && (
        <div className="property-edit-section">
          {componentMetadata.properties
            .filter((p: any) => isEditable(p))
            .map((prop: any) => {
              const current = String(componentProperties[prop.name] ?? prop.defaultValue ?? '');
              if (prop.control === 'select' && prop.options) {
                return (
                  <div key={prop.name} className="property-edit-row">
                    <label className="property-edit-label">{prop.description || prop.name}</label>
                    <DropdownSelect
                      className="property-edit-select"
                      value={current}
                      onValueChange={(value) => onPropertyChange?.(componentId, prop.name, value)}
                    >
                      {prop.options.map((opt: string) => (
                        <option key={opt} value={opt}>
                          {opt.toUpperCase()}
                        </option>
                      ))}
                    </DropdownSelect>
                  </div>
                );
              }
              return (
                <div key={prop.name} className="property-edit-row">
                  <label className="property-edit-label">{prop.description || prop.name}</label>
                  <input
                    type={prop.control === 'number' ? 'number' : 'text'}
                    className="property-edit-input"
                    value={current}
                    onChange={(e) => onPropertyChange?.(componentId, prop.name, e.target.value)}
                  />
                </div>
              );
            })}
        </div>
      )}

      {isKeyBindable(componentMetadata.id) && (
        <ComponentKeyBindingField {...keyBinding} />
      )}

      {/* microSD card — upload your own files (paid). Free auto-copy of the
          project's files happens at simulation start, not here. Parts that
          carry their OWN TF slot (metadata.sdSlot, e.g. the Seeed Round
          Display shield) get the same panel: their attach reads
          properties.sdFiles when it builds the card image. */}
      {(componentMetadata.id === 'microsd-card' || componentMetadata.sdSlot === true) && (
        <SdCardPanel
          files={(componentProperties.sdFiles as UploadedSdFile[] | undefined) ?? []}
          onChange={(next) => onPropertyChange?.(componentId, 'sdFiles', next)}
          boardId={componentMetadata.sdSlot === true ? componentId : undefined}
          componentId={componentMetadata.sdSlot === true ? undefined : componentId}
        />
      )}

      </div>{/* /component-property-body */}

      {/* Action Buttons — flips into a confirm-delete prompt when armed. */}
      <div className="property-actions">
        {confirmingDelete ? (
          <>
            <span className="property-confirm-label">
              {t('editor.componentProps.confirmDelete', { name: componentMetadata.name })}
            </span>
            <button
              className="property-action-button rotate-button"
              onClick={() => setConfirmingDelete(false)}
              title={t('editor.componentProps.cancel')}
            >
              {t('editor.componentProps.cancel')}
            </button>
            <button
              className="property-action-button delete-button"
              onClick={() => {
                setConfirmingDelete(false);
                onDelete(componentId);
              }}
              title={t('editor.componentProps.confirmDeleteTitle')}
            >
              {t('editor.componentProps.delete')}
            </button>
          </>
        ) : (
          <>
            <button
              className="property-action-button rotate-button"
              onClick={() => onRotate(componentId)}
              title={t('editor.componentProps.rotate90')}
            >
              {t('editor.componentProps.rotate')}
            </button>
            <button
              className="property-action-button delete-button"
              onClick={() => setConfirmingDelete(true)}
              title={t('editor.componentProps.deleteTitle')}
            >
              {t('editor.componentProps.delete')}
            </button>
          </>
        )}
      </div>
    </div>
  );
};
