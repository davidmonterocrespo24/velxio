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
import { InstrumentFace, INSTRUMENT_WIDTH } from './InstrumentFace';
import { InstrumentScreen } from './InstrumentScreen';
import { useElectricalStore, type SolveWindowState } from '../../store/useElectricalStore';
import { readAmmeter, averageOverWindow } from '../../simulation/spice/probes';

/** Instrument tint. Amber for volts, cyan for amps: the same pairing the
 *  canvas legend and the picker thumbnails use. */
const ACCENT = '#4dd0e1';

interface AmmeterProps {
  id: string;
}

export function Ammeter({ id }: AmmeterProps) {
  const branchCurrents = useElectricalStore((s) => s.branchCurrents);
  const window = useElectricalStore((s) => s.window);
  const converged = useElectricalStore((s) => s.converged);
  const error = useElectricalStore((s) => s.error);
  const timeWaveforms = useElectricalStore((s) => s.timeWaveforms);

  const reading = useMemo(() => {
    return readAmmeter(
      { id, metadataId: 'instr-ammeter', properties: {} },
      {
        nodeVoltages: {},
        branchCurrents: averageOverWindow(window, (st) => (st as SolveWindowState).branchCurrents, branchCurrents),
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
  }, [branchCurrents, window, converged, error, id, timeWaveforms]);

  const height = reading.ac ? 78 : 60;

  return (
    <div
      data-component-id={id}
      data-metadata-id="instr-ammeter"
      style={{ width: INSTRUMENT_WIDTH, height, lineHeight: 0 }}
    >
      <InstrumentFace
        height={height}
        accent={ACCENT}
        legend={reading.ac ? 'AC A' : 'DC A'}
        stale={reading.stale}
        terminals={[
          { label: '+', y: 30, side: 'left', polarity: 'plus' },
          { label: '-', y: 30, side: 'right', polarity: 'minus' },
        ]}
      >
        <InstrumentScreen reading={reading} accent={ACCENT} />
      </InstrumentFace>
    </div>
  );
}
