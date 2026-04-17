/**
 * Dynamic Component Renderer
 *
 * Generic component that renders any wokwi-element web component dynamically.
 * Replaces individual React wrapper components (LED.tsx, Resistor.tsx, etc.)
 *
 * Features:
 * - Creates web component from metadata
 * - Syncs React props to web component properties
 * - Extracts pinInfo from DOM for wire connections
 * - Handles component lifecycle
 */

import React, { useRef, useEffect, useCallback } from 'react';
import type { ComponentMetadata } from '../types/component-metadata';
import { useSimulatorStore } from '../store/useSimulatorStore';
import { PartSimulationRegistry } from '../simulation/parts';
import { isBoardComponent, boardPinToNumber } from '../utils/boardPinMapping';

interface DynamicComponentProps {
  id: string;
  metadata: ComponentMetadata;
  properties: Record<string, any>;
  x?: number;
  y?: number;
  isSelected?: boolean;
  onMouseDown?: (e: React.MouseEvent) => void;
  onDoubleClick?: (e: React.MouseEvent) => void;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
  onPinInfoReady?: (pinInfo: any[]) => void;
}

export const DynamicComponent: React.FC<DynamicComponentProps> = ({
  id,
  metadata,
  properties,
  x = 0,
  y = 0,
  isSelected = false,
  onMouseDown,
  onDoubleClick,
  onMouseEnter,
  onMouseLeave,
  onPinInfoReady,
}) => {
  const elementRef = useRef<HTMLElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const mountedRef = useRef(false);

  const handleComponentEvent = useSimulatorStore((s) => s.handleComponentEvent);
  const running = useSimulatorStore((s) => s.running);
  const simulator = useSimulatorStore((s) => s.simulator);
  // hexEpoch increments each time a new hex is loaded, triggering a fresh
  // attachEvents call (and re-registration of I2C devices on the new bus).
  // We intentionally do NOT depend on `running` so that I2C displays and
  // other protocol parts (SSD1306, DS1307 …) are NOT torn down and
  // re-created on every stop/play cycle — which previously caused the
  // display to flash blank and lose its frame buffer.
  const hexEpoch = useSimulatorStore((s) => s.hexEpoch);

  // Track wires connected to this component so attachEvents re-runs when
  // wires are added or removed (e.g. disconnecting an LED cathode from GND).
  const wireFingerprint = useSimulatorStore((s) => {
    const myWires = s.wires.filter(
      w => w.start.componentId === id || w.end.componentId === id
    );
    return myWires.map(w => w.id).join(',');
  });

  // Check if component is interactive (has simulation logic with attachEvents)
  const logic = PartSimulationRegistry.get(metadata.id || id.split('-')[0]);
  const isInteractive = logic?.attachEvents !== undefined;

  /**
   * Sync React properties to Web Component
   */
  useEffect(() => {
    if (!elementRef.current) return;

    Object.entries(properties).forEach(([key, value]) => {
      try {
        (elementRef.current as any)[key] = value;
      } catch (error) {
        console.warn(`Failed to set property ${key} on ${metadata.tagName}:`, error);
      }
    });
  }, [properties, metadata.tagName]);

  /**
   * Extract pinInfo from web component after it initializes
   */
  useEffect(() => {
    if (!elementRef.current || !onPinInfoReady) return;

    // Wait for web component to fully initialize
    const checkPinInfo = () => {
      try {
        const pinInfo = (elementRef.current as any)?.pinInfo;
        if (pinInfo && Array.isArray(pinInfo) && pinInfo.length > 0) {
          onPinInfoReady(pinInfo);
          return true;
        }
      } catch {
        // Element not ready yet
      }
      return false;
    };

    // Try immediately
    if (checkPinInfo()) return;

    // Otherwise poll every 100ms for up to 2 seconds
    const interval = setInterval(() => {
      if (checkPinInfo()) {
        clearInterval(interval);
      }
    }, 100);

    const timeout = setTimeout(() => {
      clearInterval(interval);
    }, 2000);

    return () => {
      clearInterval(interval);
      clearTimeout(timeout);
    };
  }, [onPinInfoReady]);

  /**
   * Handle mouse events
   */
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (onMouseDown) {
        e.stopPropagation();
        onMouseDown(e);
      }
    },
    [onMouseDown]
  );

  const handleDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      if (onDoubleClick) {
        e.stopPropagation();
        onDoubleClick(e);
      }
    },
    [onDoubleClick]
  );

  /**
   * Mount web component (only once)
   */
  useEffect(() => {
    if (!containerRef.current) return;

    // Prevent double-mount in React StrictMode
    if (mountedRef.current) {
      return;
    }

    const element = document.createElement(metadata.tagName);
    element.id = id;

    // Set initial properties
    Object.entries(properties).forEach(([key, value]) => {
      try {
        (element as any)[key] = value;
      } catch (error) {
        console.warn(`Failed to set initial property ${key}:`, error);
      }
    });

    containerRef.current.appendChild(element);
    elementRef.current = element;
    mountedRef.current = true;

    return () => {
      if (containerRef.current && element.parentNode === containerRef.current) {
        containerRef.current.removeChild(element);
      }
      elementRef.current = null;
      mountedRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [metadata.tagName, id]); // Only re-create if tagName or id changes

  /**
   * Attach component-specific DOM events (like button presses)
   */
  useEffect(() => {
    const el = elementRef.current;
    if (!el) return;

    const onButtonPress = (e: Event) => handleComponentEvent(id, 'button-press', e);
    const onButtonRelease = (e: Event) => handleComponentEvent(id, 'button-release', e);

    el.addEventListener('button-press', onButtonPress);
    el.addEventListener('button-release', onButtonRelease);

    const logic = PartSimulationRegistry.get(metadata.id || id.split('-')[0]);

    let cleanupSimulationEvents: (() => void) | undefined;
    if (logic && logic.attachEvents && simulator) {
      // Helper to find Arduino pin connected to a component pin.
      // Traces through passive components (resistors) so that a circuit like
      //   LED-cathode → resistor → GND  returns -1 (GND) instead of null.
      const getArduinoPin = (componentPinName: string): number | null => {
        const state = useSimulatorStore.getState();

        // Passive component metadataIds that are electrically transparent.
        const PASSIVE = new Set(['resistor', 'resistor-us']);

        // Depth-limited BFS: trace from (fromId, fromPin) through wires,
        // traversing through passive components to reach a board pin.
        const trace = (fromId: string, fromPin: string, depth: number): number | null => {
          if (depth > 6) return null;

          const wires = state.wires.filter(
            w => (w.start.componentId === fromId && w.start.pinName === fromPin) ||
              (w.end.componentId === fromId && w.end.pinName === fromPin)
          );

          for (const w of wires) {
            const selfEp  = (w.start.componentId === fromId && w.start.pinName === fromPin) ? w.start : w.end;
            const otherEp = selfEp === w.start ? w.end : w.start;

            if (isBoardComponent(otherEp.componentId)) {
              // Direct board connection
              const boardKind = state.boards.find((b) => b.id === otherEp.componentId)?.boardKind
                ?? otherEp.componentId;
              const pin = boardPinToNumber(boardKind, otherEp.pinName);
              if (pin !== null) return pin;
            } else {
              // Intermediate passive component — traverse through it
              const comp = state.components.find(c => c.id === otherEp.componentId);
              if (comp && PASSIVE.has(comp.metadataId)) {
                // Resistors have two pins; find the other one to continue tracing
                const otherPin = otherEp.pinName === '1' ? '2' : '1';
                const result = trace(otherEp.componentId, otherPin, depth + 1);
                if (result !== null) return result;
              }
            }
          }
          return null;
        };

        return trace(id, componentPinName, 0);
      };

      cleanupSimulationEvents = logic.attachEvents(el, simulator, getArduinoPin, id);
    }

    return () => {
      if (cleanupSimulationEvents) cleanupSimulationEvents();

      el.removeEventListener('button-press', onButtonPress);
      el.removeEventListener('button-release', onButtonRelease);
    };
  }, [id, handleComponentEvent, metadata.id, simulator, hexEpoch, wireFingerprint]);

  return (
    <div
      className="dynamic-component-wrapper"
      style={{
        position: 'absolute',
        left: `${x}px`,
        top: `${y}px`,
        cursor: running && isInteractive ? 'pointer' : 'move',
        border: isSelected ? '2px dashed #007acc' : '2px solid transparent',
        borderRadius: '4px',
        padding: '4px',
        userSelect: 'none',
        zIndex: isSelected ? 5 : 1,
        pointerEvents: 'auto',
        transform: properties.rotation ? `rotate(${properties.rotation}deg)` : undefined,
        transformOrigin: 'center center',
      }}
      onMouseDown={handleMouseDown}
      onDoubleClick={handleDoubleClick}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      data-component-id={id}
      data-component-type={metadata.id}
    >
      {/* Container for web component */}
      <div ref={containerRef} className="web-component-container" />

      {/* Component label */}
      <div
        className="component-label"
        style={{
          fontSize: '11px',
          textAlign: 'center',
          marginTop: '4px',
          color: '#666',
          pointerEvents: 'none',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '4px',
        }}
      >
        {properties.pin !== undefined
          ? `Pin ${properties.pin}`
          : metadata.name}
        {properties.protocol && (
          <span
            style={{
              fontSize: '9px',
              padding: '1px 4px',
              borderRadius: '3px',
              backgroundColor: properties.protocol === 'spi' ? '#e67e22' : '#3498db',
              color: '#fff',
              fontWeight: 600,
              textTransform: 'uppercase',
              lineHeight: '1.2',
            }}
          >
            {String(properties.protocol)}
          </span>
        )}
      </div>
    </div>
  );
};

/**
 * Helper function to create a component instance from metadata
 */
export function createComponentFromMetadata(
  metadata: ComponentMetadata,
  x: number,
  y: number
): {
  id: string;
  metadataId: string;
  x: number;
  y: number;
  properties: Record<string, any>;
} {
  return {
    id: `${metadata.id}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    metadataId: metadata.id,
    x,
    y,
    properties: { ...metadata.defaultValues },
  };
}
