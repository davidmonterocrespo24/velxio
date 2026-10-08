/**
 * Which remote boards (the Pi family and the QEMU ESP32s) the canvas should
 * start or stop when the simulation state changes.
 *
 * Each board is started AT MOST ONCE per simulation session. The rule used
 * to be "the simulation is running and this board is not, so start it",
 * which re-ran a Raspberry Pi whose script had simply finished: in a project
 * with a second board keeping the simulation running, a short script was
 * restarted about five times a second until Stop (production, 2026-09:
 * sessions of 5,964 and 8,664 runs, each spending the free trial and, on the
 * Linux engine, a guest). A script that ends on a real Pi stays ended.
 *
 * `started` is the caller's memory of the boards already started in this
 * session; it is updated in place and cleared when the simulation stops. A
 * board that is running is recorded too, so one the toolbar started is not
 * restarted when its own run ends. A board added while the simulation runs
 * still starts, once.
 */
export interface RemoteBoardState {
  id: string;
  running?: boolean;
}

export function remoteBoardActions(
  running: boolean,
  boards: readonly RemoteBoardState[],
  started: Set<string>,
): { start: string[]; stop: string[] } {
  const start: string[] = [];
  const stop: string[] = [];
  if (!running) {
    started.clear();
    for (const b of boards) if (b.running) stop.push(b.id);
    return { start, stop };
  }
  for (const b of boards) {
    if (b.running) {
      started.add(b.id);
    } else if (!started.has(b.id)) {
      started.add(b.id);
      start.push(b.id);
    }
  }
  return { start, stop };
}
