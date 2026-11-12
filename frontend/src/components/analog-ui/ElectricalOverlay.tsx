/**
 * Floating SVG overlay that renders voltage labels at wire midpoints.
 * SPICE is always active; this overlay is visible whenever a solve has
 * landed. Reads voltages from `useElectricalStore.nodeVoltages` (updated
 * by the scheduler) and maps each wire to its net via the `pinNetMap` the
 * solver publishes alongside them.
 *
 * For nets with AC content (detected via `.tran` `timeWaveforms`) labels
 * show `~<RMS>` prefixed with a tilde to mark them as time-varying. A
 * summary pill in the top-left advertises DC vs AC analysis mode.
 *
 * This is a read-only, zero-interactivity layer — it sits ABOVE the wire
 * layer but below the component layer so labels remain legible without
 * blocking clicks.
 *
 * Labels are HOVER-GATED. Showing every net at once buried dense boards
 * (a 4-digit 7-segment clock draws ~40 wires, so ~40 `0uV` pills covered
 * the breadboard). A label is drawn only when the user hovers its wire,
 * or hovers a component/board that wire lands on — so pointing at a part
 * reveals every voltage around it at once. The summary pill always shows.
 */
import { useMemo } from 'react';
import { useElectricalStore } from '../../store/useElectricalStore';
import { useSimulatorStore } from '../../store/useSimulatorStore';
import { readSpan, spanStats } from '../../simulation/spice/waveformStats';
import { cssVar } from '../../lib/theme';
import { useResolvedTheme } from '../../hooks/useTheme';

function formatV(v: number): string {
  const abs = Math.abs(v);
  if (abs < 1e-3) return `${(v * 1e6).toFixed(0)}uV`;
  if (abs < 1) return `${(v * 1e3).toFixed(1)}mV`;
  if (abs < 100) return `${v.toFixed(2)}V`;
  return `${v.toFixed(1)}V`;
}

interface ElectricalOverlayProps {
  /** Wire currently under the cursor (canvas-level hit test). */
  hoveredWireId?: string | null;
  /** Component under the cursor — reveals every wire touching it. */
  hoveredComponentId?: string | null;
  /** Board under the cursor — same, for wires landing on board pins. */
  hoveredBoardId?: string | null;
}

export function ElectricalOverlay({
  hoveredWireId = null,
  hoveredComponentId = null,
  hoveredBoardId = null,
}: ElectricalOverlayProps = {}) {
  const nodeVoltages = useElectricalStore((s) => s.nodeVoltages);
  const converged = useElectricalStore((s) => s.converged);
  const error = useElectricalStore((s) => s.error);
  const solveMs = useElectricalStore((s) => s.lastSolveMs);
  const analysisMode = useElectricalStore((s) => s.analysisMode);
  const timeWaveforms = useElectricalStore((s) => s.timeWaveforms);
  const pinNetMap = useElectricalStore((s) => s.pinNetMap);

  const wires = useSimulatorStore((s) => s.wires);

  const labels = useMemo(() => {
    if (Object.keys(nodeVoltages).length === 0) return [];
    // The stretch the meters read (whole periods, after settling), so a wire
    // label and a voltmeter on the same net agree (velxio/velxio-prod#100).
    const span = timeWaveforms ? readSpan(timeWaveforms.time, timeWaveforms.period) : null;

    return wires
      .map((w) => {
        const mx = (w.start.x + w.end.x) / 2;
        const my = (w.start.y + w.end.y) / 2;
        // Ask the solver which net this wire sits on. Re-deriving it here
        // from wires + boards looked equivalent and was not: any disagreement
        // with the netlist (an unlisted board GND pin, a wire with a length)
        // shifts the auto-generated n<N> names and the label then reports a
        // NEIGHBOURING net's voltage. An endpoint absent from the map means
        // the netlist did not place that pin, so there is nothing to show.
        const netName =
          pinNetMap.get(`${w.start.componentId}:${w.start.pinName}`) ??
          pinNetMap.get(`${w.end.componentId}:${w.end.pinName}`);
        const samples = netName ? timeWaveforms?.nodes.get(netName) : undefined;
        const stats = samples && span && timeWaveforms ? spanStats(timeWaveforms.time, samples, span) : null;
        const ac = stats !== null && stats.max - stats.min > 1e-4;
        const displayV = ac ? stats!.rms : netName ? nodeVoltages[netName] : undefined;
        return {
          id: w.id,
          x: mx,
          y: my,
          v: displayV,
          netName,
          ac,
          // Endpoint owners, so hovering a part can reveal its wires.
          a: w.start.componentId,
          b: w.end.componentId,
        };
      })
      .filter((l) => l.v !== undefined && l.netName !== '0');
  }, [wires, pinNetMap, nodeVoltages, timeWaveforms]);

  // Hover gate kept in its own memo so the label list above does not rebuild
  // every time the cursor moves.
  const visibleLabels = useMemo(() => {
    if (!hoveredWireId && !hoveredComponentId && !hoveredBoardId) return [];
    return labels.filter(
      (l) =>
        l.id === hoveredWireId ||
        (hoveredComponentId !== null && (l.a === hoveredComponentId || l.b === hoveredComponentId)) ||
        (hoveredBoardId !== null && (l.a === hoveredBoardId || l.b === hoveredBoardId)),
    );
  }, [labels, hoveredWireId, hoveredComponentId, hoveredBoardId]);

  const modeBadge = analysisMode === 'tran' ? 'AC' : 'DC';
  // SVG attributes cannot take a CSS custom property, so the overlay resolves
  // its tokens here. `theme` is read purely to re-resolve them when the user
  // switches appearance — cssVar caches per theme.
  const theme = useResolvedTheme();
  const probe = useMemo(
    () => ({
      labelBg: cssVar('--color-canvas-label-bg'),
      dc: cssVar('--color-probe-dc'),
      dcDim: cssVar('--color-probe-dc-dim'),
      ac: cssVar('--color-probe-ac'),
      error: cssVar('--color-probe-error'),
      errorDim: cssVar('--color-probe-error-dim'),
    }),
    [theme],
  );
  const badgeColor = analysisMode === 'tran' ? probe.ac : probe.dcDim;

  const summaryLines: string[] = [];
  if (error) summaryLines.push(`Warning: ${error}`);
  else if (!converged) summaryLines.push('Warning: did not converge');
  else {
    const n = Object.keys(nodeVoltages).length;
    summaryLines.push(`${n} nets | ${solveMs.toFixed(0)} ms`);
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
      {/* Summary pill with AC/DC badge */}
      <g transform="translate(12, 12)">
        <rect
          x={0}
          y={0}
          rx={4}
          ry={4}
          width={250}
          height={24}
          fill={probe.labelBg}
          stroke={error ? probe.errorDim : badgeColor}
        />
        <rect
          x={4}
          y={4}
          rx={2}
          ry={2}
          width={22}
          height={16}
          fill={badgeColor}
          opacity={0.2}
          stroke={badgeColor}
        />
        <text
          x={15}
          y={16}
          fontSize={10}
          fill={badgeColor}
          fontFamily="monospace"
          textAnchor="middle"
          fontWeight="bold"
        >
          {modeBadge}
        </text>
        <text
          x={32}
          y={17}
          fontSize={11}
          fill={error ? probe.error : probe.dcDim}
          fontFamily="monospace"
        >
          SPICE {summaryLines.join(' ')}
        </text>
      </g>

      {/* Per-wire voltage labels — only for what the cursor is on */}
      {visibleLabels.map((l) => (
        <g key={l.id} transform={`translate(${l.x}, ${l.y})`}>
          <rect
            x={-22}
            y={-9}
            rx={3}
            ry={3}
            width={44}
            height={16}
            fill={probe.labelBg}
            stroke={l.ac ? probe.ac : 'none'}
            strokeWidth={l.ac ? 0.5 : 0}
          />
          <text
            x={0}
            y={4}
            textAnchor="middle"
            fontSize={10}
            fontFamily="monospace"
            fill={l.ac ? probe.ac : probe.dc}
          >
            {l.ac ? `~${formatV(l.v!)}` : formatV(l.v!)}
          </text>
        </g>
      ))}
    </svg>
  );
}
