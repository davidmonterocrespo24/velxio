/**
 * Component Property Dialog
 *
 * Displays component properties and actions when a component is selected.
 * Shows pin roles, rotation, and delete options.
 */

import React, { useEffect, useState, useRef } from 'react';
import type { ComponentMetadata } from '../../types/component-metadata';
import './ComponentPropertyDialog.css';

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
}) => {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [dialogPosition, setDialogPosition] = useState({ x: 0, y: 0 });

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
        <button
          className="property-close-button"
          onClick={onClose}
          title="Close"
        >
          ×
        </button>
      </div>

      {/* Pin Roles Section */}
      {pinInfo.length > 0 && (
        <div className="pin-roles-section">
          <div className="pin-roles-label">Pin Roles:</div>
          {pinInfo.map((pin) => (
            <div key={pin.name} className="pin-role-item">
              <span className="pin-name">• {pin.name}</span>
              {pin.description && (
                <span className="pin-description"> ({pin.description})</span>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Current Arduino Pin Assignment */}
      {componentProperties.pin !== undefined && (
        <div className="pin-assignment-section">
          <div className="pin-assignment-label">Arduino Pin:</div>
          <div className="pin-assignment-value">
            {componentProperties.pin >= 14
              ? `A${componentProperties.pin - 14}`
              : `D${componentProperties.pin}`}
          </div>
        </div>
      )}

      {/* Editable Properties (select dropdowns) */}
      {componentMetadata.properties
        .filter((p: any) => p.control === 'select' && p.options)
        .length > 0 && (
        <div className="property-edit-section">
          {componentMetadata.properties
            .filter((p: any) => p.control === 'select' && p.options)
            .map((prop: any) => (
              <div key={prop.name} className="property-edit-row">
                <label className="property-edit-label">
                  {prop.description || prop.name}
                </label>
                <select
                  className="property-edit-select"
                  value={String(componentProperties[prop.name] ?? prop.defaultValue ?? '')}
                  onChange={(e) =>
                    onPropertyChange?.(componentId, prop.name, e.target.value)
                  }
                >
                  {prop.options.map((opt: string) => (
                    <option key={opt} value={opt}>
                      {opt.toUpperCase()}
                    </option>
                  ))}
                </select>
              </div>
            ))}
        </div>
      )}

      {/* Action Buttons */}
      <div className="property-actions">
        <button
          className="property-action-button rotate-button"
          onClick={() => onRotate(componentId)}
          title="Rotate 90°"
        >
          Rotate
        </button>
        <button
          className="property-action-button delete-button"
          onClick={() => {
            if (window.confirm(`Delete ${componentMetadata.name}?`)) {
              onDelete(componentId);
            }
          }}
          title="Delete component"
        >
          Delete
        </button>
      </div>
    </div>
  );
};
