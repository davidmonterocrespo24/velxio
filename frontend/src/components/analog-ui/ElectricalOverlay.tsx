/**
 * Floating SVG overlay that renders voltage labels at wire midpoints.
 * SPICE is always active; this overlay is visible whenever a solve has
 * landed. Reads voltages from `useElectricalStore.nodeVoltages` (updated
 * by the scheduler) and maps each wire to its net via the `pinNetMap` the
 * solver publishes alongside them.
 *
 * For nets with AC content (detected via `.tran` `timeWaveforms`) labels
 * show `~<RMS>` prefixed with a tilde to mark them as time-varying.
 *
 * This is a read-only, zero-interactivity layer — it sits ABOVE the wire
 * and component layers so labels remain legible without blocking clicks.
 *
 * Labels are HOVER-GATED. Showing every net at once buried dense boards
 * (a 4-digit 7-segment clock draws ~40 wires, so ~40 `0uV` pills covered
 * the breadboard). A label is drawn only when the user hovers its wire,
 * or hovers a component/board that wire lands on — so pointing at a part
 * reveals every voltage around it at once.
 */
import { useMemo } from 'react';
import { useElectricalStore } from '../../store/useElectricalStore';
import { useSimulatorStore } from '../../store/useSimulatorStore';
import { readSpan, spanStats } from '../../simulation/spice/waveformStats';
import { cssVar } from '../../lib/theme';
import { useResolvedTheme } from '../../hooks/useTheme';
import { isSeatWire } from '../../utils/breadboardNets';

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
  const timeWaveforms = useElectricalStore((s) => s.timeWaveforms);
  const pinNetMap = useElectricalStore((s) => s.pinNetMap);

  const wires = useSimulatorStore((s) => s.wires);
  // The SEATED boards' ids only, as one string: the boards array itself is
  // replaced on every serial flush, and the label memo must not rebuild at
  // that rate. (An unseated board's bb wires, a Wokwi import's, keep labels.)
  const boardIdsKey = useSimulatorStore((s) =>
    s.boards
      .filter((b) => b.seatedOn)
      .map((b) => b.id)
      .join('\u0000'),
  );

  const labels = useMemo(() => {
    if (Object.keys(nodeVoltages).length === 0) return [];
    // The stretch the meters read (whole periods, after settling), so a wire
    // label and a voltmeter on the same net agree (velxio/velxio-prod#100).
    const span = timeWaveforms ? readSpan(timeWaveforms.time, timeWaveforms.period) : null;

    // A board plugged into a breadboard owns one zero-length seat wire per
    // pin: labelling them would sprout a label on every pin of the board.
    // (boardIdsKey lists the seated boards only.)
    // A seated PART's seat wires keep theirs: hovering the part is how its
    // node voltages are read (its legs have no other wire of their own).
    const boardIds = new Set(boardIdsKey ? boardIdsKey.split('\u0000') : []);
    return wires
      .filter(
        (w) =>
          !(isSeatWire(w) && (boardIds.has(w.start.componentId) || boardIds.has(w.end.componentId))),
      )
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
  }, [wires, boardIdsKey, pinNetMap, nodeVoltages, timeWaveforms]);

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

  // SVG attributes cannot take a CSS custom property, so the overlay resolves
  // its tokens here. `theme` is read purely to re-resolve them when the user
  // switches appearance — cssVar caches per theme.
  const theme = useResolvedTheme();
  const probe = useMemo(
    () => ({
      labelBg: cssVar('--color-canvas-panel'),
      dc: cssVar('--color-probe-dc'),
      ac: cssVar('--color-probe-ac'),
    }),
    [theme],
  );
  return (
    <svg
      aria-hidden
      className="canvas-voltage-labels"
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: '100%',
        height: '100%',
        pointerEvents: 'none',
        zIndex: 1,
      }}
    >
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
