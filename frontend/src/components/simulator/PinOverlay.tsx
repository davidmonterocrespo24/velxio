/**
 * PinOverlay Component
 *
 * Renders clickable pin indicators over components to enable wire creation.
 * Shows when hovering over a component or when creating a wire.
 *
 * On touch devices the hit-target is scaled up inversely to the canvas zoom
 * so the *screen-space* tap area stays at least ~40px regardless of zoom level.
 */

import React, { useEffect, useState } from 'react';

/** Detect touch-capable device once */
const isTouchDevice =
  typeof window !== 'undefined' && ('ontouchstart' in window || navigator.maxTouchPoints > 0);

/** Minimum visual pin size in *world* pixels at zoom 1 */
const PIN_VISUAL = 12;

/** Desired minimum screen-space hit-target size for touch (px) */
const TOUCH_MIN_SCREEN_PX = 44;

interface PinInfo {
  name: string;
  x: number; // CSS pixels
  y: number; // CSS pixels
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
  /** Current canvas zoom level — used to keep touch targets usable at any zoom */
  zoom?: number;
}

export const PinOverlay: React.FC<PinOverlayProps> = ({
  componentId,
  componentX,
  componentY,
  onPinClick,
  showPins,
  wrapperOffsetX = 4,
  wrapperOffsetY = 6,
  zoom = 1,
}) => {
  const [pins, setPins] = useState<PinInfo[]>([]);

  useEffect(() => {
    const tryRead = () => {
      const element = document.getElementById(componentId);
      if (element && (element as any).pinInfo) {
        setPins((element as any).pinInfo);
        return true;
      }
      return false;
    };
    if (!tryRead()) {
      // Retry once after a tick in case the element sets pinInfo asynchronously (e.g. via useEffect)
      const t = setTimeout(tryRead, 50);
      return () => clearTimeout(t);
    }
  }, [componentId]);

  if (!showPins || pins.length === 0) {
    return null;
  }

  // On touch devices, compute world-space size so the pin is at least
  // TOUCH_MIN_SCREEN_PX on screen.  On desktop, keep the original 12px.
  const pinSize = isTouchDevice ? Math.max(PIN_VISUAL, TOUCH_MIN_SCREEN_PX / zoom) : PIN_VISUAL;
  const pinHalf = pinSize / 2;

  return (
    <div
      style={{
        position: 'absolute',
        left: `${componentX + wrapperOffsetX}px`,
        top: `${componentY + wrapperOffsetY}px`,
        pointerEvents: 'none',
        zIndex: 30, // Above wires (20) and components, below modals/dialogs (1000+)
      }}
    >
      {pins.map((pin, index) => {
        const pinX = pin.x;
        const pinY = pin.y;

        return (
          <div
            key={`${pin.name}-${index}`}
            data-pin-overlay="true"
            onClick={(e) => {
              e.stopPropagation();
              onPinClick(
                componentId,
                pin.name,
                componentX + wrapperOffsetX + pinX,
                componentY + wrapperOffsetY + pinY,
              );
            }}
            onTouchEnd={(e) => {
              e.stopPropagation();
              e.preventDefault();
              onPinClick(
                componentId,
                pin.name,
                componentX + wrapperOffsetX + pinX,
                componentY + wrapperOffsetY + pinY,
              );
            }}
            style={{
              position: 'absolute',
              left: `${pinX - pinHalf}px`,
              top: `${pinY - pinHalf}px`,
              width: `${pinSize}px`,
              height: `${pinSize}px`,
              borderRadius: '3px',
              backgroundColor: 'rgba(0, 200, 255, 0.8)',
              border: '1.5px solid white',
              cursor: 'crosshair',
              pointerEvents: 'all',
              transition: 'all 0.15s',
              touchAction: 'none',
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
