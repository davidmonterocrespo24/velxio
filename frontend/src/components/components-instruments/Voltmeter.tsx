/**
 * Voltmeter — probe component that displays the voltage between V+ and V-.
 *
 * Renders as a simple SVG with two pin stubs and a live reading. Velxio
 * registers it through the standard metadata path (`instr-voltmeter`).
 * The SPICE emission is handled by `componentToSpice` which inserts a
 * 10 MΩ sense resistor across the terminals.
 */
import { useMemo } from 'react';
import { useElectricalStore } from '../../store/useElectricalStore';
import { useSimulatorStore } from '../../store/useSimulatorStore';
import { buildPinNetLookup, readVoltmeter } from '../../simulation/spice/probes';
import { BOARD_PIN_GROUPS } from '../../simulation/spice/boardPinGroups';

interface VoltmeterProps {
  id: string;
}

export function Voltmeter({ id }: VoltmeterProps) {
  const mode = useElectricalStore((s) => s.mode);
  const nodeVoltages = useElectricalStore((s) => s.nodeVoltages);
  const converged = useElectricalStore((s) => s.converged);
  const error = useElectricalStore((s) => s.error);
  const wires = useSimulatorStore((s) => s.wires);
  const boards = useSimulatorStore((s) => s.boards);

  const reading = useMemo(() => {
    if (mode === 'off') {
      return { kind: 'voltmeter' as const, value: 0, unit: '—' as const, display: '— off', stale: true };
    }
    const groundPins = boards.flatMap((b) =>
      (BOARD_PIN_GROUPS[b.boardKind] ?? BOARD_PIN_GROUPS.default).gnd.map((pin) => ({
        componentId: b.id,
        pinName: pin,
      })),
    );
    const vccPins = boards.flatMap((b) =>
      (BOARD_PIN_GROUPS[b.boardKind] ?? BOARD_PIN_GROUPS.default).vcc_pins.map((pin) => ({
        componentId: b.id,
        pinName: pin,
      })),
    );
    const netLookup = buildPinNetLookup(wires, groundPins, vccPins);
    return readVoltmeter(
      { id, metadataId: 'instr-voltmeter', properties: {} },
      netLookup,
      {
        nodeVoltages,
        branchCurrents: {},
        converged,
        error,
        solveMs: 0,
        submittedNetlist: '',
      },
    );
  }, [mode, nodeVoltages, wires, boards, id, converged, error]);

  return (
    <div
      data-component-id={id}
      data-metadata-id="instr-voltmeter"
      style={{
        width: 100,
        height: 60,
        background: '#1f1f1f',
        border: '2px solid #ffa500',
        borderRadius: 6,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        color: reading.stale ? '#666' : '#ffa500',
        fontFamily: 'monospace',
        fontSize: 13,
      }}
    >
      <div style={{ fontSize: 9, letterSpacing: 1 }}>V METER</div>
      <div style={{ fontSize: 15, fontWeight: 'bold' }}>{reading.display}</div>
    </div>
  );
}
