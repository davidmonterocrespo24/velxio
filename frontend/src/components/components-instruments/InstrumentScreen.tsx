/**
 * The readout inside an InstrumentFace: one big line for DC, or RMS over a
 * peak/DC sub-line when the probed signal has AC content (bench-DMM layout).
 */
import type { ProbeReading } from '../../simulation/spice/probes';
import { INSTRUMENT_WIDTH } from './InstrumentFace';

const CENTER = INSTRUMENT_WIDTH / 2;
/** Usable width inside the screen bezel, minus a little breathing room. */
const SCREEN_TEXT_WIDTH = INSTRUMENT_WIDTH - 20;
/** Advance width of one monospace glyph as a fraction of the font size. */
const GLYPH_RATIO = 0.62;
/**
 * What the monospace faces MONO asks for really advance per glyph (SF Mono,
 * Menlo, DejaVu Sans Mono and Liberation Mono: 0.60 em). GLYPH_RATIO is the
 * cautious figure the sizes are worked out with; this one says whether two
 * legends on one line would touch.
 */
const MONO_ADVANCE = 0.6;
/** Where the peak legend starts and the DC legend ends. */
const SUB_LEFT = 11;
const SUB_RIGHT = INSTRUMENT_WIDTH - 11;
/** The smallest sub-line text, and the gap the two legends keep between them. */
const SUB_MIN_FONT = 6;
const SUB_MIN_GAP = 1;

/**
 * Shrink the digits so a long string still fits the screen. Readings are
 * normally short ("3.437 V"), but the not-connected and RMS strings are two
 * to three times that, and at a fixed size they ran off the instrument.
 */
function fitFontSize(text: string, preferred: number): number {
  const max = SCREEN_TEXT_WIDTH / (GLYPH_RATIO * Math.max(text.length, 1));
  return Math.max(6.5, Math.min(preferred, max));
}

const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';

export function InstrumentScreen({ reading, accent }: { reading: ProbeReading; accent: string }) {
  const digits = reading.stale ? '#5c646c' : accent;
  if (!reading.ac) {
    return (
      <text
        x={CENTER}
        y={42}
        textAnchor="middle"
        fontFamily={MONO}
        fontSize={fitFontSize(reading.display, 15)}
        fontWeight={700}
        fill={digits}
      >
        {reading.display}
      </text>
    );
  }
  // The peak and DC legends share one line from opposite edges, so they are
  // sized against their COMBINED length plus a gap, not individually.
  const { peakDisplay, dcDisplay } = reading.ac;
  const subLen = [...peakDisplay].length + [...dcDisplay].length;
  let sub = Math.max(SUB_MIN_FONT, Math.min(7.5, (SCREEN_TEXT_WIDTH - 10) / (GLYPH_RATIO * subLen)));
  // At the size floor one line holds 24 glyphs. A three-digit negative DC
  // beside a three-digit peak is 25 ("pk 414.29 mV", "DC -485.57 µV" on
  // an-diode-clipper), and the two legends were drawn over each other
  // (velxio/velxio-prod#129). Those go on two lines, each still at its own
  // edge: the peak under the RMS on the left, the DC below it on the right.
  const oneLine = subLen * MONO_ADVANCE * sub + SUB_MIN_GAP <= SUB_RIGHT - SUB_LEFT;
  if (!oneLine) {
    const longest = Math.max([...peakDisplay].length, [...dcDisplay].length);
    sub = Math.max(SUB_MIN_FONT, Math.min(7.5, (SUB_RIGHT - SUB_LEFT - 2) / (GLYPH_RATIO * longest)));
  }
  return (
    <>
      <text
        x={CENTER}
        y={40}
        textAnchor="middle"
        fontFamily={MONO}
        fontSize={fitFontSize(reading.ac.rmsDisplay, 14)}
        fontWeight={700}
        fill={digits}
      >
        {reading.ac.rmsDisplay}
      </text>
      <text x={SUB_LEFT} y={oneLine ? 58 : 55} fontFamily={MONO} fontSize={sub} fill={digits} opacity={0.75}>
        {peakDisplay}
      </text>
      <text
        x={SUB_RIGHT}
        y={oneLine ? 58 : 65}
        textAnchor="end"
        fontFamily={MONO}
        fontSize={sub}
        fill={digits}
        opacity={0.75}
      >
        {dcDisplay}
      </text>
    </>
  );
}
