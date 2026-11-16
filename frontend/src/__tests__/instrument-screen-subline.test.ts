// @vitest-environment jsdom
/**
 * A meter's AC readout keeps its peak and DC legends apart for the longest
 * values the meters print (velxio/velxio-prod#129 follow-up).
 *
 * The sub-line puts "pk ..." at the left edge and "DC ..." at the right, at a
 * size worked out from their combined length but never under 6 px. With the
 * microvolt band, an-diode-clipper's "DC -485.57 µV" is 13 characters where
 * "DC -50.19 mV" was 12, and at the 6 px floor the V of "pk 414.29 mV" was
 * drawn over the D of "DC". The same happens to any negative DC from -100 to
 * -999.99 of a unit beside a three-digit peak, in volts or amperes: 25
 * characters do not fit in the 88 px between the two anchors at 6 px.
 *
 * Text is measured with a monospace advance of 0.6 em, which is what the
 * fonts the screen asks for draw (SF Mono, Menlo, DejaVu Sans Mono and
 * Liberation Mono are all 0.60 em wide per glyph).
 */
import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { InstrumentScreen } from '../components/components-instruments/InstrumentScreen';
import { INSTRUMENT_WIDTH } from '../components/components-instruments/InstrumentFace';
import { readAmmeter, readVoltmeter, type ProbeReading } from '../simulation/spice/probes';
import type { ElectricalSolveResult, TimeWaveforms } from '../simulation/spice/types';

const ADVANCE_EM = 0.6;
/** The AC body is 78 px tall and its screen runs from y 19 to 78 - 7. */
const SCREEN = { left: 7, right: INSTRUMENT_WIDTH - 7, top: 19, bottom: 78 - 7 };

/**
 * A waveform whose time-weighted peak is `pk` and mean `dc` (|dc| < pk):
 * a straight line from -pk to 2dc + pk over the span the meter reads.
 */
function waveform(net: string, pk: number, dc: number, branch = false): TimeWaveforms {
  const samples = [0, -pk, 2 * dc + pk];
  return {
    time: [0, 0.5, 1],
    nodes: new Map(branch ? [] : [[net, samples]]),
    branches: new Map(branch ? [[net, samples]] : []),
  };
}

const solve = (nodeVoltages: Record<string, number>, branchCurrents: Record<string, number> = {}) =>
  ({ nodeVoltages, branchCurrents, converged: true, error: null, analysisMode: 'tran' }) as unknown as ElectricalSolveResult;

function voltmeter(pk: number, dc: number): ProbeReading {
  return readVoltmeter(
    { id: 'vm', metadataId: 'instr-voltmeter', properties: {} },
    (_c, pin) => (pin === 'V+' ? 'n1' : '0'),
    solve({ n1: dc }),
    waveform('n1', pk, dc),
  );
}

function ammeter(pk: number, dc: number): ProbeReading {
  return readAmmeter(
    { id: 'am', metadataId: 'instr-ammeter', properties: {} },
    solve({}, { v_am_sense: dc }),
    waveform('v_am_sense', pk, dc, true),
  );
}

interface Box {
  text: string;
  size: number;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

function layout(reading: ProbeReading): Box[] {
  const host = document.createElement('div');
  host.innerHTML = `<svg>${renderToStaticMarkup(createElement(InstrumentScreen, { reading, accent: '#ffa726' }))}</svg>`;
  return [...host.querySelectorAll('text')].map((el) => {
    const text = el.textContent ?? '';
    const size = Number(el.getAttribute('font-size'));
    const x = Number(el.getAttribute('x'));
    const y = Number(el.getAttribute('y'));
    const width = [...text].length * ADVANCE_EM * size;
    const anchor = el.getAttribute('text-anchor') ?? 'start';
    const x0 = anchor === 'middle' ? x - width / 2 : anchor === 'end' ? x - width : x;
    return { text, size, x0, x1: x0 + width, y0: y - 0.8 * size, y1: y + 0.2 * size };
  });
}

/** No legend overlaps another or leaves the screen, and none is under 6 px. */
function expectLegible(reading: ProbeReading) {
  const boxes = layout(reading);
  const names = boxes.map((b) => b.text).join(' | ');
  expect(boxes.map((b) => b.text).sort(), names).toEqual(
    [reading.ac!.rmsDisplay, reading.ac!.peakDisplay, reading.ac!.dcDisplay].sort(),
  );
  for (const b of boxes) {
    expect(b.size, `${b.text} font size`).toBeGreaterThanOrEqual(6);
    expect(b.x0, `${b.text} left edge`).toBeGreaterThanOrEqual(SCREEN.left + 1);
    expect(b.x1, `${b.text} right edge`).toBeLessThanOrEqual(SCREEN.right - 1);
    expect(b.y0, `${b.text} top`).toBeGreaterThanOrEqual(SCREEN.top + 1);
    expect(b.y1, `${b.text} bottom`).toBeLessThanOrEqual(SCREEN.bottom - 1);
  }
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const [a, b] = [boxes[i]!, boxes[j]!];
      const apart = a.x1 + 1 <= b.x0 || b.x1 + 1 <= a.x0 || a.y1 <= b.y0 || b.y1 <= a.y0;
      expect(apart, `"${a.text}" and "${b.text}" overlap`).toBe(true);
    }
  }
}

describe('the AC readout of a meter', () => {
  it("an-diode-clipper's voltmeter: pk 414.29 mV and DC -485.57 µV no longer overlap", () => {
    const reading = voltmeter(0.41429, -485.57e-6);
    expect(reading.ac!.peakDisplay).toBe('pk 414.29 mV');
    expect(reading.ac!.dcDisplay).toBe('DC -485.57 µV');
    expectLegible(reading);
  });

  // The longest legend of every band the formatters print: a three-digit
  // peak beside a three-digit negative DC, in each pair of bands
  // ("pk 999.99 mV" and "DC -899.98 mV" are 12 + 13 characters). A meter
  // shows the AC readout only for a swing above 0.1 mV or 0.1 mA (probes.ts
  // AC_EPSILON), so a nanoampere peak never gets one.
  const VOLTS = { peaks: [999.999, 0.99999, 999.99e-6], dcs: [899.998, 0.89998, 899.98e-6] };
  const AMPS = { peaks: [999.999, 0.99999, 999.99e-6], dcs: [899.998, 0.89998, 899.98e-6] };
  for (const [name, read, bands] of [
    ['voltmeter', voltmeter, VOLTS],
    ['ammeter', ammeter, AMPS],
  ] as const) {
    it(`the ${name}: every band of peak beside every band of negative DC`, () => {
      let longest = 0;
      for (const pk of bands.peaks) {
        for (const dc of bands.dcs) {
          if (dc >= pk) continue;
          const reading = read(pk, -dc);
          longest = Math.max(longest, [...reading.ac!.peakDisplay, ...reading.ac!.dcDisplay].length);
          expectLegible(reading);
        }
      }
      expect(longest).toBe(25);
    });
  }

  it('a kilovolt reading, past anything a gallery circuit makes, still fits', () => {
    expectLegible(voltmeter(1234.567, -1234.566));
  });

  it('a sub-line that already fitted keeps its single-line layout', () => {
    // The default 1 kHz, 1 V generator on 1 kΩ: 24 characters.
    const reading = voltmeter(0.99613, -20.42e-6);
    expect(`${reading.ac!.peakDisplay}${reading.ac!.dcDisplay}`).toHaveLength(24);
    const boxes = layout(reading);
    const pk = boxes.find((b) => b.text === reading.ac!.peakDisplay)!;
    const dc = boxes.find((b) => b.text === reading.ac!.dcDisplay)!;
    expect(pk.y1).toBe(dc.y1);
    expectLegible(reading);
  });
});
