/**
 * PinOverlay Component
 *
 * Renders clickable pin indicators over components to enable wire creation.
 * Shows when hovering over a component or when creating a wire.
 */

import React, { useEffect, useState } from 'react';

interface PinInfo {
  name: string;
  x: number;  // CSS pixels
  y: number;  // CSS pixels
  signals?: Array<{ type: string; signal?: string }>;
}

interface PinOverlayProps {
  componentId: string;
  componentX: number;
  componentY: number;
  onPinClick: (componentId: string, pinName: string, x: number, y: number) => void;
  showPins: boolean;
  /** Extra offset to compensate for wrapper padding/border. Default: 4 (x), 6 (y) for component wrappers. Pass 0 when the element has no wrapper. */
  wrapperOffsetX?: number;
  wrapperOffsetY?: number;
}

export const PinOverlay: React.FC<PinOverlayProps> = ({
  componentId,
  componentX,
  componentY,
  onPinClick,
  showPins,
  wrapperOffsetX = 4,
  wrapperOffsetY = 6,
}) => {
  const [pins, setPins] = useState<PinInfo[]>([]);

  useEffect(() => {
    // Get pin info from wokwi-element
    const element = document.getElementById(componentId);
    if (element && (element as any).pinInfo) {
      setPins((element as any).pinInfo);
    }
  }, [componentId]);

  if (!showPins || pins.length === 0) {
    return null;
  }

  return (
    <div
      style={{
        position: 'absolute',
        left: `${componentX + wrapperOffsetX}px`,
        top: `${componentY + wrapperOffsetY}px`,
        pointerEvents: 'none',
        zIndex: 10, // Above wires (1) and components, below modals/dialogs (1000+)
      }}
    >
      {pins.map((pin) => {
        // Pin coordinates are already in CSS pixels
        const pinX = pin.x;
        const pinY = pin.y;

        const handleActivate = (e: React.MouseEvent | React.TouchEvent) => {
          e.stopPropagation();
          onPinClick(componentId, pin.name, componentX + wrapperOffsetX + pinX, componentY + wrapperOffsetY + pinY);
        };

        return (
          <div
            key={pin.name}
            data-pin-component-id={componentId}
            data-pin-name={pin.name}
            onClick={handleActivate}
            onTouchEnd={handleActivate}
            style={{
              position: 'absolute',
              left: `${pinX - 4}px`,
              top: `${pinY - 4}px`,
              width: '8px',
              height: '8px',
              borderRadius: '2px',
              backgroundColor: 'rgba(0, 200, 255, 0.8)',
              border: '1.5px solid white',
              cursor: 'crosshair',
              pointerEvents: 'all',
              transition: 'all 0.15s',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.backgroundColor = 'rgba(0, 255, 100, 1)';
              e.currentTarget.style.transform = 'scale(1.4)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.backgroundColor = 'rgba(0, 200, 255, 0.8)';
              e.currentTarget.style.transform = 'scale(1)';
            }}
            title={pin.name}
          />
        );
      })}
    </div>
  );
};
