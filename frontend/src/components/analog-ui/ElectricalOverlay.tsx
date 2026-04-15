/**
 * Floating SVG overlay that renders voltage labels at wire midpoints.
 * Only visible when electrical mode is active. Reads voltages from
 * `useElectricalStore.nodeVoltages` (updated by the scheduler).
 *
 * This is a read-only, zero-interactivity layer — it sits ABOVE the wire
 * layer but below the component layer so labels remain legible without
 * blocking clicks.
 */
import { useMemo } from 'react';
import { useElectricalStore } from '../../store/useElectricalStore';
import { useSimulatorStore } from '../../store/useSimulatorStore';

function formatV(v: number): string {
  const abs = Math.abs(v);
  if (abs < 1e-3) return `${(v * 1e6).toFixed(1)}µV`;
  if (abs < 1) return `${(v * 1e3).toFixed(1)}mV`;
  if (abs < 100) return `${v.toFixed(2)}V`;
  return `${v.toFixed(1)}V`;
}

export function ElectricalOverlay() {
  const mode = useElectricalStore((s) => s.mode);
  const nodeVoltages = useElectricalStore((s) => s.nodeVoltages);
  const converged = useElectricalStore((s) => s.converged);
  const error = useElectricalStore((s) => s.error);
  const solveMs = useElectricalStore((s) => s.lastSolveMs);

  const wires = useSimulatorStore((s) => s.wires);

  // Pre-compute midpoint labels from wires (we don't currently map wire → net,
  // but for the initial version we label every wire's midpoint with all the
  // voltages the solver emitted and let the user cross-check).
  const labels = useMemo(() => {
    if (mode === 'off') return [];
    return wires.map((w) => {
      const mx = (w.start.x + w.end.x) / 2;
      const my = (w.start.y + w.end.y) / 2;
      return { id: w.id, x: mx, y: my };
    });
  }, [wires, mode]);

  if (mode === 'off') return null;

  // A summary pill in the top-left of the canvas
  const summaryLines: string[] = [];
  if (error) summaryLines.push(`⚠ ${error}`);
  else if (!converged) summaryLines.push('⚠ did not converge');
  else {
    const n = Object.keys(nodeVoltages).length;
    summaryLines.push(`${n} nets • solved in ${solveMs.toFixed(0)} ms`);
  }

  return (
    <svg
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: '100%',
        height: '100%',
        pointerEvents: 'none',
        zIndex: 20,
      }}
    >
      {/* Summary pill */}
      <g transform="translate(12, 12)">
        <rect
          x={0}
          y={0}
          rx={4}
          ry={4}
          width={260}
          height={28}
          fill="rgba(26, 26, 26, 0.85)"
          stroke={error ? '#ff6666' : '#ffa500'}
        />
        <text x={10} y={19} fontSize={12} fill={error ? '#ff9999' : '#ffa500'}>
          {summaryLines.join(' · ')}
        </text>
      </g>

      {/* Per-wire midpoint markers (minimal — only a small dot so we don't
          clutter until we have wire→net mapping in Phase 8.3.1) */}
      {labels.map((l) => (
        <circle key={l.id} cx={l.x} cy={l.y} r={2} fill="#ffa50055" />
      ))}
    </svg>
  );
}
