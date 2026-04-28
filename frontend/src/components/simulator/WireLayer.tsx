import React from 'react';
import { useSimulatorStore } from '../../store/useSimulatorStore';
import { WireRenderer } from './WireRenderer';
import { WireInProgressRenderer } from './WireInProgressRenderer';

const isTouchDevice =
  typeof window !== 'undefined' && ('ontouchstart' in window || navigator.maxTouchPoints > 0);

export interface SegmentHandle {
  segIndex: number;
  axis: 'horizontal' | 'vertical';
  mx: number; // midpoint X
  my: number; // midpoint Y
}

export interface WaypointHandle {
  /** Index of this waypoint in the wire's waypoints[] array */
  index: number;
  x: number;
  y: number;
}

export interface AlignmentGuide {
  axis: 'x' | 'y';
  /** World coordinate of the guide line (x for vertical, y for horizontal) */
  value: number;
}

interface WireLayerProps {
  hoveredWireId: string | null;
  /** Segment drag preview: overrides the path of a specific wire */
  segmentDragPreview: { wireId: string; overridePath: string } | null;
  /** Handles to render for the selected wire */
  segmentHandles: SegmentHandle[];
  /** Bend-point handles to render for the selected wire */
  waypointHandles: WaypointHandle[];
  /** Alignment guides shown while dragging */
  alignmentGuides?: AlignmentGuide[];
  /** Called when user starts dragging a segment handle (passes segIndex) */
  onHandleMouseDown: (e: React.MouseEvent, segIndex: number) => void;
  /** Called when user starts dragging a segment handle via touch (passes segIndex) */
  onHandleTouchStart?: (e: React.TouchEvent, segIndex: number) => void;
  /** Called when user starts dragging a waypoint handle */
  onWaypointMouseDown: (e: React.MouseEvent, waypointIndex: number) => void;
  /** Called when user starts dragging a waypoint handle via touch */
  onWaypointTouchStart?: (e: React.TouchEvent, waypointIndex: number) => void;
}

export const WireLayer: React.FC<WireLayerProps> = ({
  hoveredWireId,
  segmentDragPreview,
  segmentHandles,
  waypointHandles,
  alignmentGuides,
  onHandleMouseDown,
  onHandleTouchStart,
  onWaypointMouseDown,
  onWaypointTouchStart,
}) => {
  const wires = useSimulatorStore((s) => s.wires);
  const wireInProgress = useSimulatorStore((s) => s.wireInProgress);
  const selectedWireId = useSimulatorStore((s) => s.selectedWireId);

  return (
    <svg
      className="wire-layer"
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: '100%',
        height: '100%',
        overflow: 'visible',
        pointerEvents: 'none',
        zIndex: 35,
      }}
    >
      {wires.map((wire) => (
        <WireRenderer
          key={wire.id}
          wire={wire}
          isSelected={wire.id === selectedWireId}
          isHovered={wire.id === hoveredWireId}
          overridePath={
            segmentDragPreview?.wireId === wire.id ? segmentDragPreview.overridePath : undefined
          }
        />
      ))}

      {/* Alignment guides — full-canvas dashed lines snap-targets while dragging */}
      {alignmentGuides?.map((g, i) =>
        g.axis === 'x' ? (
          <line
            key={`guide-${i}`}
            x1={g.value}
            y1={-100000}
            x2={g.value}
            y2={100000}
            stroke="#00d9ff"
            strokeWidth={1}
            strokeDasharray="4,4"
            opacity={0.85}
          />
        ) : (
          <line
            key={`guide-${i}`}
            x1={-100000}
            y1={g.value}
            x2={100000}
            y2={g.value}
            stroke="#00d9ff"
            strokeWidth={1}
            strokeDasharray="4,4"
            opacity={0.85}
          />
        ),
      )}

      {/* Segment handles for the selected wire */}
      {segmentHandles.map((handle) => (
        <circle
          key={`seg-${handle.segIndex}`}
          data-wire-handle="segment"
          cx={handle.mx}
          cy={handle.my}
          r={isTouchDevice ? 14 : 7}
          fill="white"
          stroke="#007acc"
          strokeWidth={2}
          style={{
            pointerEvents: 'all',
            cursor: handle.axis === 'horizontal' ? 'ns-resize' : 'ew-resize',
            touchAction: 'none',
          }}
          onMouseDown={(e) => onHandleMouseDown(e, handle.segIndex)}
          onTouchStart={(e) => onHandleTouchStart?.(e, handle.segIndex)}
        />
      ))}

      {/* Waypoint handles — bend points that drag freely in any direction */}
      {waypointHandles.map((handle) => (
        <circle
          key={`wp-${handle.index}`}
          data-wire-handle="waypoint"
          cx={handle.x}
          cy={handle.y}
          r={isTouchDevice ? 12 : 6}
          fill="#007acc"
          stroke="white"
          strokeWidth={2}
          style={{
            pointerEvents: 'all',
            cursor: 'move',
            touchAction: 'none',
          }}
          onMouseDown={(e) => onWaypointMouseDown(e, handle.index)}
          onTouchStart={(e) => onWaypointTouchStart?.(e, handle.index)}
        />
      ))}

      {wireInProgress && <WireInProgressRenderer wireInProgress={wireInProgress} />}
    </svg>
  );
};
