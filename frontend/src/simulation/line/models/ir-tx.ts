/**
 * An infrared LED the sketch drives — the transmit half of the link.
 *
 * WHAT IT LISTENS FOR. There is no IR protocol in the hardware: a remote is a
 * plain LED and everything a remote does is TIMING the firmware produces on
 * one pin. So this model owns no pad and answers nothing. It only listens, on
 * the guest's own cycle counter, and turns what the pin did into the mark and
 * space train that crosses the air.
 *
 * DEMODULATION, BOTH SHAPES. Sketches produce two different waveforms and both
 * have to work:
 *
 *   modulated    the classic. The pin is toggled at 38 kHz for the length of
 *                each mark and held low through each space. Edges inside a
 *                mark are ~13 us apart.
 *   unmodulated  the pin is simply held high for the mark and low for the
 *                space. Common in sketches written against a simulator, and
 *                the shape a hardware carrier produces when the engine reports
 *                the peripheral's gate rather than its individual pulses.
 *
 * One rule covers both. An interval the pin spent HIGH is always carrier
 * energy. An interval it spent LOW is carrier energy too when it is shorter
 * than {@link CARRIER_GAP_US} — that is the off half of a carrier cycle, not a
 * space — and a space when it is longer. Nothing here has to know which shape
 * it is looking at, or what the carrier frequency was.
 *
 * WHEN A FRAME IS OVER. Nothing announces it: the pin simply stops moving, and
 * a model with no clock of its own cannot notice silence. So the frame is
 * closed the way the S3 bridge's IR capture already closes one — when the NEXT
 * burst begins, or when it grows past any plausible length — plus a wall-clock
 * debounce for the last frame of a run, which no later burst will ever flush.
 * The debounce is deliberately long: the guest may run slower than real time,
 * and a short one would cut a frame in half.
 */

import type { PadEvent } from '../padEvent';
import { emitIr } from '../../ir/irAir';
import type { IrPulse } from '../../ir/necCodec';
import { registerLineModel, type LineClock, type LineModel } from '../lineModels';

/** A LOW interval shorter than this is the off half of a carrier cycle, not a
 *  space. A 38 kHz half period is 13 us and a 30 kHz one 17; the shortest
 *  space any remote protocol sends is NEC's 560 us, so there is a wide gap to
 *  sit in and this value never has to be tuned per protocol. */
export const CARRIER_GAP_US = 60;
/** A space longer than this ends the transmission. NEC's longest space inside
 *  a frame is the 4.5 ms header; the gap between frames is 40 ms and up. */
export const FRAME_GAP_US = 20_000;
/** Nothing shorter is a transmission — it is a stray edge or a boot glitch. */
export const MIN_SEGMENTS = 4;
/** A guard against a pin toggling forever (a PWM output, a blink loop): flush
 *  and start over rather than growing an unbounded array. */
export const MAX_SEGMENTS = 600;
/** Wall-clock fallback for the last frame of a run. Long, because the guest
 *  may be running well behind real time. */
export const FLUSH_DEBOUNCE_MS = 250;

const stringField = (v: unknown, dflt: string): string => (typeof v === 'string' ? v : dflt);

registerLineModel('ir-tx', (rec) => {
  const pin = rec.pin;
  const sourceId = stringField(rec.source_id, `ir-tx@${pin}`);
  let channel = stringField(rec.channel, '');

  let segments: IrPulse[] = [];
  /** The open segment: what kind it is and how long it has run. */
  let segMark = false;
  let segUs = 0;
  let open = false;
  /** Carrier estimate: completed carrier cycles inside marks, over the marks'
   *  total length. A cycle has two transitions but only ONE of them ends a low
   *  notch, so counting those counts cycles directly — halving them again put
   *  a bit-banged 38 kHz carrier at 19 kHz. */
  let carrierCycles = 0;
  let markUs = 0;

  let lastCycle = -1;
  let lastLevel = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function clearTimer(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function closeSegment(): void {
    if (open && segUs > 0) segments.push({ level: segMark ? 1 : 0, us: segUs });
    open = false;
    segUs = 0;
  }

  function discard(): void {
    segments = [];
    open = false;
    segUs = 0;
    carrierCycles = 0;
    markUs = 0;
  }

  function flush(): void {
    clearTimer();
    closeSegment();
    // A capture starts and ends in silence more often than not; a leading or
    // trailing space is the room, not the message.
    while (segments.length && segments[0].level === 0) segments.shift();
    while (segments.length && segments[segments.length - 1].level === 0) segments.pop();
    const pulses = segments;
    const cycles = carrierCycles;
    const marks = markUs;
    discard();
    if (pulses.length < MIN_SEGMENTS) return;
    emitIr({
      pulses,
      sourceId,
      channel,
      // No notches inside the marks means the sketch sent the envelope with no
      // carrier at all, which is reported as 0 rather than guessed at.
      carrierHz: cycles >= 2 && marks > 0 ? Math.round((cycles / marks) * 1e6) : 0,
    });
  }

  function accumulate(mark: boolean, us: number): void {
    if (open && mark === segMark) {
      segUs += us;
      return;
    }
    closeSegment();
    segMark = mark;
    segUs = us;
    open = true;
  }

  const model: LineModel = {
    listens: [pin],
    drives: [],
    rest: () => [],
    onPad(e: PadEvent, clock: LineClock) {
      const level = e.level;
      if (lastCycle < 0 || e.cycle < lastCycle) {
        // First edge, or the guest rebooted inside the engine and its counter
        // went backwards: everything measured against the old base is gone.
        discard();
        lastCycle = e.cycle;
        lastLevel = level;
        return null;
      }
      if (level === lastLevel) return null; // a pull or direction event, no edge

      const perUs = clock.us(1000) / 1000;
      const dtUs = perUs > 0 ? (e.cycle - lastCycle) / perUs : 0;
      lastCycle = e.cycle;
      lastLevel = level;
      if (dtUs <= 0) return null;

      // The interval that just ENDED was spent at the previous level.
      const wasMark = !level ? true : dtUs <= CARRIER_GAP_US;
      if (wasMark) {
        markUs += dtUs;
        if (level) carrierCycles++; // a low notch inside a mark ends one carrier cycle
      }

      if (!wasMark && dtUs > FRAME_GAP_US) {
        // The transmission ended somewhere back there. The gap itself is the
        // room between frames and belongs to neither.
        flush();
      } else {
        accumulate(wasMark, dtUs);
        if (segments.length >= MAX_SEGMENTS) flush();
      }

      clearTimer();
      timer = setTimeout(flush, FLUSH_DEBOUNCE_MS);
      return null; // this model never puts anything on a wire
    },
    update(props) {
      if ('channel' in props) channel = stringField(props.channel, channel);
    },
    reset() {
      clearTimer();
      discard();
      lastCycle = -1;
      lastLevel = false;
    },
  };
  return model;
});
