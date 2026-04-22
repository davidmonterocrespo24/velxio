/**
 * Ammeter — probe component that reads the current through its body.
 *
 * Connected in SERIES with the circuit under test. `componentToSpice`
 * emits a `V_<id>_sense 0` voltage source plus a tiny shunt; ngspice
 * reports the branch current for that source, and we read it back here.
 *
 * Like a real bench DMM, the display switches to RMS/peak/DC when the
 * current has AC content (detected via `.tran` `timeWaveforms`).
 */
import { useMemo } from 'react';
import { useElectricalStore } from '../../store/useElectricalStore';
import { readAmmeter } from '../../simulation/spice/probes';

interface AmmeterProps {
  id: string;
}

export function Ammeter({ id }: AmmeterProps) {
  const branchCurrents = useElectricalStore((s) => s.branchCurrents);
  const converged = useElectricalStore((s) => s.converged);
  const error = useElectricalStore((s) => s.error);
  const timeWaveforms = useElectricalStore((s) => s.timeWaveforms);

  const reading = useMemo(() => {
    return readAmmeter(
      { id, metadataId: 'instr-ammeter', properties: {} },
      {
        nodeVoltages: {},
        branchCurrents,
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
  }, [branchCurrents, converged, error, id, timeWaveforms]);

  const color = reading.stale ? '#666' : '#4dd0e1';
  const height = reading.ac ? 78 : 60;

  return (
    <div
      data-component-id={id}
      data-metadata-id="instr-ammeter"
      style={{
        width: 110,
        height,
        background: '#1f1f1f',
        border: '2px solid #4dd0e1',
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
        A METER {reading.ac ? '~AC' : 'DC'}
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
