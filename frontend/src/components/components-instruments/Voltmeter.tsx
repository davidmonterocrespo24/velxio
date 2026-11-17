/**
 * Voltmeter — probe component that displays the voltage between V+ and V-.
 *
 * For DC nets the display is a single scalar (e.g. "3.300 V"). For nets
 * with AC content (reflected in `.tran` `timeWaveforms`) the display shows
 * the RMS of the whole signal prominently, AC and DC together as a true-RMS
 * meter reads in its AC+DC mode, with the peak-to-peak swing and the DC
 * underneath (meterLegend, velxio/velxio-prod#125).
 */
import { useMemo } from 'react';
import { InstrumentFace, INSTRUMENT_WIDTH } from './InstrumentFace';
import { InstrumentScreen } from './InstrumentScreen';
import { useElectricalStore, type SolveWindowState } from '../../store/useElectricalStore';
import { useSimulatorStore } from '../../store/useSimulatorStore';
import { buildPinNetLookup, readVoltmeter, averageOverWindow, meterLegend } from '../../simulation/spice/probes';
import { boardPinGroupFor } from '../../simulation/spice/boardPinGroups';

/** Instrument tint. Amber for volts, cyan for amps: the same pairing the
 *  canvas legend and the picker thumbnails use. */
const ACCENT = '#ffa726';

interface VoltmeterProps {
  id: string;
}

export function Voltmeter({ id }: VoltmeterProps) {
  const nodeVoltages = useElectricalStore((s) => s.nodeVoltages);
  const window = useElectricalStore((s) => s.window);
  const converged = useElectricalStore((s) => s.converged);
  const error = useElectricalStore((s) => s.error);
  const timeWaveforms = useElectricalStore((s) => s.timeWaveforms);
  const pinNetMap = useElectricalStore((s) => s.pinNetMap);
  const wires = useSimulatorStore((s) => s.wires);
  const boards = useSimulatorStore((s) => s.boards);

  const reading = useMemo(() => {
    const groundPins = boards.flatMap((b) =>
      boardPinGroupFor(b.boardKind).gnd.map((pin) => ({
        componentId: b.id,
        pinName: pin,
      })),
    );
    const vccPins = boards.flatMap((b) =>
      boardPinGroupFor(b.boardKind).vcc_pins.map((pin) => ({
        componentId: b.id,
        pinName: pin,
      })),
    );
    // Aux-rail pins (VIN / 5V / off-voltage 3V3) so probing them reads the
    // rail's own voltage — and so the n0/n1 numbering matches the solver's.
    const auxPins = boards.flatMap((b) => {
      const aux = boardPinGroupFor(b.boardKind).aux;
      if (!aux) return [];
      return aux.pins.map((pin) => ({ componentId: b.id, pinName: pin, volts: aux.volts }));
    });
    // The solver publishes the very map it netlisted with. Prefer it: any
    // drift between it and a locally rebuilt Union-Find shows up as the meter
    // reading two unrelated nodes. The rebuild stays as the fallback for the
    // window before the first solve lands (pinNetMap still empty).
    const netLookup =
      pinNetMap.size > 0
        ? (componentId: string, pinName: string) =>
            pinNetMap.get(`${componentId}:${pinName}`) ?? null
        : buildPinNetLookup(wires, groundPins, vccPins, auxPins);
    return readVoltmeter(
      { id, metadataId: 'instr-voltmeter', properties: {} },
      netLookup,
      {
        nodeVoltages: averageOverWindow(window, (st) => (st as SolveWindowState).nodeVoltages, nodeVoltages),
        branchCurrents: {},
        converged,
        error,
        solveMs: 0,
        submittedNetlist: '',
        pinNetMap,
        analysisMode: timeWaveforms ? 'tran' : 'op',
        timeWaveforms,
      },
      timeWaveforms,
    );
  }, [nodeVoltages, window, pinNetMap, wires, boards, id, converged, error, timeWaveforms]);

  const height = reading.ac ? 78 : 60;

  return (
    <div
      data-component-id={id}
      data-metadata-id="instr-voltmeter"
      style={{ width: INSTRUMENT_WIDTH, height, lineHeight: 0 }}
    >
      <InstrumentFace
        height={height}
        accent={ACCENT}
        legend={meterLegend(reading)}
        stale={reading.stale}
        terminals={[
          { label: '+', y: 18, side: 'left', polarity: 'plus' },
          { label: '-', y: 42, side: 'left', polarity: 'minus' },
        ]}
      >
        <InstrumentScreen reading={reading} accent={ACCENT} />
      </InstrumentFace>
    </div>
  );
}
