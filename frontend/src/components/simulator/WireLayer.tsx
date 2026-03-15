import React from 'react';
import { useSimulatorStore } from '../../store/useSimulatorStore';
import { WireRenderer } from './WireRenderer';
import { WireInProgressRenderer } from './WireInProgressRenderer';

export interface SegmentHandle {
  segIndex: number;
  axis: 'horizontal' | 'vertical';
  mx: number; // midpoint X
  my: number; // midpoint Y
}

interface WireLayerProps {
  hoveredWireId: string | null;
  /** Segment drag preview: overrides the path of a specific wire */
  segmentDragPreview: { wireId: string; overridePath: string } | null;
  /** Handles to render for the selected wire */
  segmentHandles: SegmentHandle[];
  /** Called when user starts dragging a handle (passes segIndex) */
  onHandleMouseDown: (e: React.MouseEvent, segIndex: number) => void;
}

export const WireLayer: React.FC<WireLayerProps> = ({
  hoveredWireId,
  segmentDragPreview,
  segmentHandles,
  onHandleMouseDown,
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
            segmentDragPreview?.wireId === wire.id
              ? segmentDragPreview.overridePath
              : undefined
          }
        />
      ))}

      {/* Segment handles for the selected wire */}
      {segmentHandles.map((handle) => (
        <circle
          key={handle.segIndex}
          cx={handle.mx}
          cy={handle.my}
          r={7}
          fill="white"
          stroke="#007acc"
          strokeWidth={2}
          style={{ pointerEvents: 'all', cursor: handle.axis === 'horizontal' ? 'ns-resize' : 'ew-resize' }}
          onMouseDown={(e) => onHandleMouseDown(e, handle.segIndex)}
        />
      ))}

      {wireInProgress && (
        <WireInProgressRenderer wireInProgress={wireInProgress} />
      )}
    </svg>
  );
};
