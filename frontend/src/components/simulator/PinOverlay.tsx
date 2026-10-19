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
import { useIsCoarsePointer } from '../../utils/useTouchDevice';
import { rotatePinLocal } from '../../utils/pinPositionCalculator';
import { readPinInfo } from '../../utils/readPinInfo';

/** Minimum visual pin size in *world* pixels at zoom 1 */
const PIN_VISUAL = 12;

/** Desired minimum screen-space hit-target size for touch (px) */
const TOUCH_MIN_SCREEN_PX = 44;

/**
 * Hard ceiling for the world-space pin size, in CSS pixels.
 * At very low zoom, `TOUCH_MIN_SCREEN_PX / zoom` would otherwise produce
 * massive overlays that cover the whole board.
 */
const PIN_WORLD_MAX = 28;

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
  /** Extra offset to compensate for wrapper padding (4) + border (2) = 6 on each side. Default 6/6 for component wrappers. Pass 0 when the element has no wrapper (e.g. boards rendered without DynamicComponent). */
  wrapperOffsetX?: number;
  wrapperOffsetY?: number;
  /** Current canvas zoom level — used to keep touch targets usable at any zoom */
  zoom?: number;
  /**
   * CSS rotation (degrees) applied to the underlying DynamicComponent
   * wrapper. The overlay div lives OUTSIDE that wrapper so it doesn't
   * inherit the transform — without this prop we rotate the pin
   * coordinates manually around the wrapper's centre so the clickable
   * boxes follow the visually-rotated pin tips.
   */
  rotation?: number;
  /** Explicit unrotated box to rotate the pins about, top-left at the
   *  wrapper origin. Boards pass their footprint (no DynamicComponent
   *  wrapper to measure). */
  pivotBox?: { w: number; h: number };
  /** True while a wire is in progress — paints every square even on dense
   * components (breadboards) because they're all valid wire targets. */
  wiring?: boolean;
}

export const PinOverlay: React.FC<PinOverlayProps> = ({
  componentId,
  componentX,
  componentY,
  onPinClick,
  showPins,
  wrapperOffsetX = 6,
  wrapperOffsetY = 6,
  zoom = 1,
  rotation = 0,
  pivotBox,
  wiring = false,
}) => {
  const [pins, setPins] = useState<PinInfo[]>([]);
  const [wrapperBox, setWrapperBox] = useState<{ w: number; h: number } | null>(null);
  const isCoarse = useIsCoarsePointer();

  useEffect(() => {
    let raf = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tryRead = () => {
      const element = document.getElementById(componentId);
      const info = readPinInfo<PinInfo>(element);
      if (element && info) {
        setPins(info);
        // Capture the wrapper's unrotated bounding box for the rotation
        // pivot. offsetWidth/Height stay constant regardless of CSS
        // transforms, so they reflect the LAYOUT box — exactly what
        // CSS rotates around with transform-origin: center center.
        const wrapper = element.closest('.dynamic-component-wrapper') as HTMLElement | null;
        if (wrapper) {
          setWrapperBox({ w: wrapper.offsetWidth, h: wrapper.offsetHeight });
        }
        return true;
      }
      return false;
    };
    // Read immediately (correct when the element is already laid out), then
    // re-measure after layout. On import / undo / project load the component
    // mounts ALREADY rotated and its wokwi-element may not have its final size
    // on the mount tick — reading offsetWidth then bakes a wrong rotation pivot
    // that previously only refreshed when the user rotated again (issues #230,
    // #232). Re-running on `showPins` also re-measures right before the overlay
    // becomes visible, by which point the element is laid out.
    tryRead();
    raf = requestAnimationFrame(() => {
      if (!tryRead()) timer = setTimeout(tryRead, 50);
    });
    return () => {
      cancelAnimationFrame(raf);
      if (timer) clearTimeout(timer);
    };
  }, [componentId, rotation, showPins]);

  if (!showPins || pins.length === 0) {
    return null;
  }

  // On touch-primary devices, compute world-space size so the pin is at least
  // TOUCH_MIN_SCREEN_PX on screen — but clamp to PIN_WORLD_MAX so very low
  // zoom levels can't produce gigantic overlays. On desktop, keep PIN_VISUAL.
  const pinSize = isCoarse
    ? Math.min(PIN_WORLD_MAX, Math.max(PIN_VISUAL, TOUCH_MIN_SCREEN_PX / zoom))
    : PIN_VISUAL;
  const pinHalf = pinSize / 2;

  // On hover, squares stay invisible and only the ONE under the cursor lights
  // up (its own onMouseEnter paints it) — no wall of blue on any component.
  // While a wire is in progress every square paints: they're all valid targets.
  const subtle = !wiring;
  const baseBackground = subtle ? 'transparent' : 'rgba(0, 200, 255, 0.8)';
  const baseBorder = subtle ? '1.5px solid transparent' : '1.5px solid white';
  // Some elements expose one pad under two names at the same coordinates
  // (a XIAO's "D8" and its GPIO "7", a DevKit's "TX" and "16"). Only the
  // top-most square is hoverable, so its tooltip carries every name of that
  // pad — a user reading "7" on a pad silk-screened D8 wired an RGB LED one
  // pin off (2026-09-05) because the alias was the only name they could see.
  const namesAtPad = new Map<string, string[]>();
  for (const p of pins) {
    const key = `${p.x},${p.y}`;
    const names = namesAtPad.get(key) ?? [];
    names.push(p.name);
    namesAtPad.set(key, names);
  }
  const titleFor = (pin: PinInfo): string => {
    const names = namesAtPad.get(`${pin.x},${pin.y}`) ?? [pin.name];
    const others = names.filter((n) => n !== pin.name);
    return others.length ? `${pin.name} (${others.join(', ')})` : pin.name;
  };

  return (
    <div
      style={{
        position: 'absolute',
        left: `${componentX + wrapperOffsetX}px`,
        top: `${componentY + wrapperOffsetY}px`,
        pointerEvents: 'none',
        // Local to the owning component's stacking context (its wrapper in
        // SimulatorCanvas/BoardOnCanvas sets position + z-index): above the
        // component's own body/overlays only — a covering component hides
        // these pins along with the body.
        zIndex: 30,
      }}
    >
      {pins.map((pin, index) => {
        // Container origin in CANVAS = (componentX + wrapperOffsetX,
        // componentY + wrapperOffsetY) — i.e. shifted INTO the wrapper
        // by the wrapper's padding+border so pin.x can be added directly.
        // The wrapper itself sits at (componentX, componentY), so its
        // top-left in container-local coords is (-wrapperOffsetX,
        // -wrapperOffsetY). CSS rotates around the wrapper's centre.
        const { x: pinX, y: pinY } = rotatePinLocal(
          pin.x,
          pin.y,
          rotation,
          pivotBox ?? wrapperBox,
          wrapperOffsetX,
          wrapperOffsetY,
        );

        return (
          <div
            key={`${pin.name}-${index}`}
            data-pin-overlay="true"
            onMouseDown={(e) => {
              // Without this, press-and-drag on a pin square bubbles to the
              // canvas and pans it — a pin press must never move the canvas.
              e.stopPropagation();
            }}
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
              backgroundColor: baseBackground,
              border: baseBorder,
              cursor: 'crosshair',
              pointerEvents: 'all',
              transition: 'all 0.15s',
              touchAction: 'none',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.backgroundColor = 'rgba(0, 255, 100, 1)';
              e.currentTarget.style.border = '1.5px solid white';
              e.currentTarget.style.transform = 'scale(1.4)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.backgroundColor = baseBackground;
              e.currentTarget.style.border = baseBorder;
              e.currentTarget.style.transform = 'scale(1)';
            }}
            title={titleFor(pin)}
          />
        );
      })}
    </div>
  );
};
