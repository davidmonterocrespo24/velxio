/**
 * The tab's clock in the record of a clock chip a QEMU worker hosts (project
 * i2c-model-fidelity-2026-09).
 */

/**
 * The tab's clock for a worker's copy of a part that keeps the time: the
 * epoch as the browser counts it, and how far its time zone is from UTC, in
 * minutes east. The worker's own clock is the server's, in the server's zone;
 * with these in its record the copy shows the hour the tab's model shows.
 *
 * A record is filed when the part attaches and sent when the board runs,
 * which can be much later, so the bridge stamps it again when it starts the
 * worker (withHostClock). What is left between the stamp and the worker
 * reading it is the delivery, and the worker allows for that.
 */
export function hostClockRecord(): { epochMs: number; utcOffsetMin: number } {
  const now = new Date();
  // `|| 0` turns UTC's -0 into 0: the record crosses JSON to the worker, which
  // writes -0 as 0, and a record that compares unequal to its own wire form is
  // a trap for every check that holds one against the other.
  return { epochMs: now.getTime(), utcOffsetMin: -now.getTimezoneOffset() || 0 };
}

/** The worker models that keep the time, and so carry the tab's clock. */
const HOST_CLOCK_TYPES: ReadonlySet<string> = new Set(['ds1307', 'ds3231']);

/**
 * The records a QEMU worker is started with, the clock chips among them
 * stamped with the tab's clock as of now. Chosen by the worker model the
 * record names and not by the canvas part that filed it: a part that is
 * another part under a new name (the Grove DS1307 is the DS1307) files the
 * same record, and nothing else knows it keeps the time.
 */
export function withHostClock(
  records: ReadonlyArray<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  return records.map((r) =>
    HOST_CLOCK_TYPES.has(String(r['sensor_type'] ?? '')) ? { ...r, ...hostClockRecord() } : r,
  );
}
