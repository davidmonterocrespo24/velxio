/**
 * A board's own clock, as the circuit layer reads it.
 *
 * The pad edges carry it (connectMcuEdgesToService), so the service can place
 * a burst of edges by guest time, and the ADC bridge reads it at each
 * conversion, so a one-shot capture is sampled at the guest time since the
 * edge that began it (connectAnalogInputsToMcu).
 */

/**
 * The board's own clock in milliseconds, or null when the engine keeps
 * none the service can read. Same two doors as parts/partUtils'
 * `guestMillis` (not imported: that module pulls an engine in). Read on
 * every edge, so it stays two property lookups and a division.
 */
export function guestMsOf(sim: unknown): number | null {
  const s = sim as {
    getGuestMicros?: () => number;
    getCurrentCycles?: () => number;
    getClockHz?: () => number;
  } | undefined;
  if (!s) return null;
  if (typeof s.getGuestMicros === 'function') {
    const us = s.getGuestMicros();
    return Number.isFinite(us) && us >= 0 ? us / 1000 : null;
  }
  if (typeof s.getCurrentCycles === 'function' && typeof s.getClockHz === 'function') {
    const cycles = s.getCurrentCycles();
    const hz = s.getClockHz();
    return Number.isFinite(cycles) && cycles >= 0 && Number.isFinite(hz) && hz > 0
      ? (cycles / hz) * 1000
      : null;
  }
  return null;
}
