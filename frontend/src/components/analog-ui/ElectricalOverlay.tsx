/**
 * Floating SVG overlay that renders voltage labels at wire midpoints.
 * SPICE is always active; this overlay is visible whenever a solve has
 * landed. Reads voltages from `useElectricalStore.nodeVoltages` (updated
 * by the scheduler) and maps wires to nets via `buildWireNetMap`.
 *
 * For nets with AC content (detected via `.tran` `timeWaveforms`) labels
 * show `~<RMS>` prefixed with a tilde to mark them as time-varying. A
 * summary pill in the top-left advertises DC vs AC analysis mode.
 *
 * This is a read-only, zero-interactivity layer — it sits ABOVE the wire
 * layer but below the component layer so labels remain legible without
 * blocking clicks.
 */
import { useMemo } from 'react';
import { useElectricalStore } from '../../store/useElectricalStore';
import { useSimulatorStore } from '../../store/useSimulatorStore';
import { buildWireNetMap } from '../../simulation/spice/NetlistBuilder';
import { BOARD_PIN_GROUPS } from '../../simulation/spice/boardPinGroups';
import { rms, isAC } from '../../simulation/spice/waveformStats';

function formatV(v: number): string {
  const abs = Math.abs(v);
  if (abs < 1e-3) return `${(v * 1e6).toFixed(0)}uV`;
  if (abs < 1) return `${(v * 1e3).toFixed(1)}mV`;
  if (abs < 100) return `${v.toFixed(2)}V`;
  return `${v.toFixed(1)}V`;
}

export function ElectricalOverlay() {
  const nodeVoltages = useElectricalStore((s) => s.nodeVoltages);
  const converged = useElectricalStore((s) => s.converged);
  const error = useElectricalStore((s) => s.error);
  const solveMs = useElectricalStore((s) => s.lastSolveMs);
  const analysisMode = useElectricalStore((s) => s.analysisMode);
  const timeWaveforms = useElectricalStore((s) => s.timeWaveforms);

  const wires = useSimulatorStore((s) => s.wires);
  const components = useSimulatorStore((s) => s.components);
  const boards = useSimulatorStore((s) => s.boards);

  const labels = useMemo(() => {
    if (Object.keys(nodeVoltages).length === 0) return [];

    const boardsForSpice = boards.map((b) => {
      const pg = BOARD_PIN_GROUPS[b.boardKind] ?? BOARD_PIN_GROUPS.default;
      return {
        id: b.id,
        vcc: pg.vcc,
        groundPinNames: pg.gnd,
        vccPinNames: pg.vcc_pins,
        pins: {},
      };
    });
    const compsForSpice = components.map((c) => ({
      id: c.id,
      metadataId: c.metadataId,
      properties: c.properties ?? {},
    }));
    const wiresForSpice = wires.map((w) => ({
      id: w.id,
      start: { componentId: w.start.componentId, pinName: w.start.pinName },
      end: { componentId: w.end.componentId, pinName: w.end.pinName },
    }));

    const wireNetMap = buildWireNetMap({
      components: compsForSpice,
      wires: wiresForSpice,
      boards: boardsForSpice,
    });

    return wires
      .map((w) => {
        const mx = (w.start.x + w.end.x) / 2;
        const my = (w.start.y + w.end.y) / 2;
        const netName = wireNetMap.get(w.id);
        const samples = netName ? timeWaveforms?.nodes.get(netName) : undefined;
        const ac = samples && samples.length > 0 && isAC(samples);
        const displayV = ac ? rms(samples!) : netName ? nodeVoltages[netName] : undefined;
        return { id: w.id, x: mx, y: my, v: displayV, netName, ac };
      })
      .filter((l) => l.v !== undefined && l.netName !== '0');
  }, [wires, components, boards, nodeVoltages, timeWaveforms]);

  const modeBadge = analysisMode === 'tran' ? 'AC' : 'DC';
  const badgeColor = analysisMode === 'tran' ? '#4dd0e1' : '#ffa500';

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
          fill="rgba(26, 26, 26, 0.85)"
          stroke={error ? '#ff6666' : badgeColor}
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
          fill={error ? '#ff9999' : '#ffa500'}
          fontFamily="monospace"
        >
          SPICE {summaryLines.join(' ')}
        </text>
      </g>

      {/* Per-wire voltage labels */}
      {labels.map((l) => (
        <g key={l.id} transform={`translate(${l.x}, ${l.y})`}>
          <rect
            x={-22}
            y={-9}
            rx={3}
            ry={3}
            width={44}
            height={16}
            fill="rgba(0, 0, 0, 0.75)"
            stroke={l.ac ? '#4dd0e1' : 'none'}
            strokeWidth={l.ac ? 0.5 : 0}
          />
          <text
            x={0}
            y={4}
            textAnchor="middle"
            fontSize={10}
            fontFamily="monospace"
            fill={l.ac ? '#4dd0e1' : '#ffd700'}
          >
            {l.ac ? `~${formatV(l.v!)}` : formatV(l.v!)}
          </text>
        </g>
      ))}
    </svg>
  );
}
