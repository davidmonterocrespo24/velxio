/**
 * Voltmeter — probe component that displays the voltage between V+ and V-.
 *
 * For DC nets the display is a single scalar (e.g. "3.300 V"). For nets
 * with AC content (reflected in `.tran` `timeWaveforms`) the display shows
 * RMS prominently with peak and DC underneath — the convention of real
 * bench DMMs in AC-V mode.
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
  const nodeVoltages = useElectricalStore((s) => s.nodeVoltages);
  const converged = useElectricalStore((s) => s.converged);
  const error = useElectricalStore((s) => s.error);
  const timeWaveforms = useElectricalStore((s) => s.timeWaveforms);
  const wires = useSimulatorStore((s) => s.wires);
  const boards = useSimulatorStore((s) => s.boards);

  const reading = useMemo(() => {
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
        pinNetMap: new Map(),
        analysisMode: timeWaveforms ? 'tran' : 'op',
        timeWaveforms,
      },
      timeWaveforms,
    );
  }, [nodeVoltages, wires, boards, id, converged, error, timeWaveforms]);

  const color = reading.stale ? '#666' : '#ffa500';
  const height = reading.ac ? 78 : 60;

  return (
    <div
      data-component-id={id}
      data-metadata-id="instr-voltmeter"
      style={{
        width: 110,
        height,
        background: '#1f1f1f',
        border: '2px solid #ffa500',
        borderRadius: 6,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        color,
        fontFamily: 'monospace',
        fontSize: 13,
        padding: '2px 4px',
        boxSizing: 'border-box',
      }}
    >
      <div style={{ fontSize: 9, letterSpacing: 1, opacity: 0.8 }}>
        V METER {reading.ac ? '~AC' : 'DC'}
      </div>
      <div style={{ fontSize: reading.ac ? 13 : 15, fontWeight: 'bold', lineHeight: 1.15 }}>
        {reading.display}
      </div>
      {reading.ac && (
        <div
          style={{
            fontSize: 9,
            opacity: 0.85,
            display: 'flex',
            gap: 6,
            lineHeight: 1.1,
          }}
        >
          <span>{reading.ac.peakDisplay}</span>
          <span>{reading.ac.dcDisplay}</span>
        </div>
      )}
    </div>
  );
}
