/**
 * WireInProgressRenderer — live preview while drawing a wire.
 * Shows the fixed waypoints + a dynamic elbow segment to the mouse cursor.
 */

import React from 'react';
import type { WireInProgress } from '../../types/wire';
import { generatePreviewPath, generateOrthogonalPath } from '../../utils/wireUtils';

interface Props {
  wireInProgress: WireInProgress;
}

export const WireInProgressRenderer: React.FC<Props> = ({ wireInProgress }) => {
  const { startEndpoint, waypoints, color, currentX, currentY } = wireInProgress;

  const path = generatePreviewPath(
    { x: startEndpoint.x, y: startEndpoint.y },
    waypoints,
    currentX,
    currentY,
  );

  if (!path) return null;

  return (
    <g className="wire-in-progress" style={{ pointerEvents: 'none' }}>
      {/* Dark outline */}
      <path d={path} stroke="#1a1a1a" strokeWidth="5" fill="none" />

      {/* Colored wire */}
      <path d={path} stroke={color} strokeWidth="2" fill="none" />

      {/* Dashed overlay to indicate "in progress" */}
      <path
        d={path}
        stroke="#ffffff"
        strokeWidth="1.5"
        fill="none"
        strokeDasharray="6,4"
        opacity="0.5"
      />

      {/* Start pin marker */}
      <circle
        cx={startEndpoint.x}
        cy={startEndpoint.y}
        r="4"
        fill={color}
        stroke="white"
        strokeWidth="1.5"
      />

      {/* Waypoint markers (locked-in corners) */}
      {waypoints.map((wp, i) => (
        <circle key={i} cx={wp.x} cy={wp.y} r="3" fill={color} stroke="white" strokeWidth="1" />
      ))}

      {/* Cursor marker */}
      <circle
        cx={currentX}
        cy={currentY}
        r="4"
        fill={color}
        stroke="white"
        strokeWidth="1.5"
        opacity="0.7"
      />
    </g>
  );
};
