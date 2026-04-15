/**
 * Ammeter — probe component that reads the current through its body.
 *
 * Connected in SERIES with the circuit under test. `componentToSpice`
 * emits a `V_<id>_sense 0` voltage source plus a tiny shunt; ngspice
 * reports the branch current for that source, and we read it back here.
 */
import { useMemo } from 'react';
import { useElectricalStore } from '../../store/useElectricalStore';
import { readAmmeter } from '../../simulation/spice/probes';

interface AmmeterProps {
  id: string;
}

export function Ammeter({ id }: AmmeterProps) {
  const mode = useElectricalStore((s) => s.mode);
  const branchCurrents = useElectricalStore((s) => s.branchCurrents);
  const converged = useElectricalStore((s) => s.converged);
  const error = useElectricalStore((s) => s.error);

  const reading = useMemo(() => {
    if (mode === 'off') {
      return { kind: 'ammeter' as const, value: 0, unit: '—' as const, display: '— off', stale: true };
    }
    return readAmmeter(
      { id, metadataId: 'instr-ammeter', properties: {} },
      {
        nodeVoltages: {},
        branchCurrents,
        converged,
        error,
        solveMs: 0,
        submittedNetlist: '',
      },
    );
  }, [mode, branchCurrents, converged, error, id]);

  return (
    <div
      data-component-id={id}
      data-metadata-id="instr-ammeter"
      style={{
        width: 100,
        height: 60,
        background: '#1f1f1f',
        border: '2px solid #4dd0e1',
        borderRadius: 6,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        color: reading.stale ? '#666' : '#4dd0e1',
        fontFamily: 'monospace',
        fontSize: 13,
      }}
    >
      <div style={{ fontSize: 9, letterSpacing: 1 }}>A METER</div>
      <div style={{ fontSize: 15, fontWeight: 'bold' }}>{reading.display}</div>
    </div>
  );
}
