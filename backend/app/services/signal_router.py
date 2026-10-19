"""GPIO Matrix-aware signal router for emulated ESP32 boards.

The ESP32 SoC's IO_MUX + GPIO Matrix decouples *signal sources*
(LEDC channels, RMT channels, UART TX, SPI MOSI, ...) from physical
*GPIO pins* via a 40-entry routing table (`gpio_out_sel[40]`). Each
entry records which signal id drives the pin; any number of pins
can be routed from the same signal (rare, but legal).

This module is the velxio-side mirror of that routing table. The
worker (`esp32_worker.py`) feeds it every time the firmware writes
to a `GPIO_FUNCx_OUT_SEL_CFG_REG` register; the worker then emits
peripheral-event payloads (LEDC duty changes, RMT pulses, …) that
identify the signal SOURCE rather than the pin, and the routing
table fans them out to all the pins that signal currently drives.

This replaces the previous per-peripheral ad hoc maps (e.g.
`_ledc_gpio_map`) and the lossy `broadcastPwm` fallback in the
frontend, both of which violated the hardware abstraction and
caused the multi-servo blink bug documented in commit 77bf897.
"""

from __future__ import annotations

from collections import defaultdict
from typing import Iterator


def diff_routes(
    snapshot: dict[int, int], emitted: dict[int, int],
) -> tuple[list[tuple[int, int]], list[int]]:
    """What the frontend still has to hear about: the routes in `snapshot`
    that differ from what was last announced to it (`emitted`), and the pins
    that were announced and are no longer routed.

    The diff is taken against the announced table, never against the router
    itself: the libqemu GPIO Matrix callback updates the router the moment
    the firmware routes a pin, so by the time the poll compares the chip's
    table with the router the two already agree and a diff against the
    router reports nothing. That left the frontend's mirror empty for every
    LEDC consumer (servo, dimmed LED, buzzer) on the QEMU engine (#385).
    """
    changed = [(gpio, sid) for gpio, sid in snapshot.items()
               if emitted.get(gpio) != sid]
    cleared = [gpio for gpio in emitted if gpio not in snapshot]
    return changed, cleared


class SignalRouter:
    """Mirror of the ESP32 GPIO Matrix.

    Maintains both a forward index (gpio_pin → signal_id) and a
    reverse index (signal_id → set of gpio_pins) so each direction
    of lookup is O(1). All mutations are atomic across the two
    indexes — concurrent reads from another thread see a consistent
    pair before/after, never an intermediate state with the gpio
    in BOTH the old and new signal's set.

    The class is intentionally simple: no locking, no async, no
    persistence. Threading is the caller's concern; the worker runs
    everything on the QEMU emulation thread which serialises
    register writes.
    """

    def __init__(self) -> None:
        self._matrix: dict[int, int] = {}
        # defaultdict(set) keeps lookups symmetric — a signal id
        # with zero current routees returns an empty set rather than
        # raising KeyError, matching real-hardware semantics.
        self._sources: dict[int, set[int]] = defaultdict(set)

    # ── Mutators ────────────────────────────────────────────────────────

    def update_routing(self, gpio_pin: int, signal_id: int) -> None:
        """Record that `gpio_pin` is now driven by `signal_id`.

        If the pin previously routed from a different signal, it is
        removed from that signal's set first — keeping the reverse
        index a true partition of the matrix.
        """
        old = self._matrix.get(gpio_pin)
        if old == signal_id:
            return  # idempotent — common case during polling fallback
        if old is not None:
            self._sources[old].discard(gpio_pin)
            if not self._sources[old]:
                del self._sources[old]
        self._matrix[gpio_pin] = signal_id
        self._sources[signal_id].add(gpio_pin)

    def clear_routing(self, gpio_pin: int) -> None:
        """Remove `gpio_pin` from the matrix entirely.

        Equivalent to the firmware setting `gpio_out_sel[gpio_pin]`
        back to the default 'GPIO direct out' sentinel.  Idempotent
        if the pin isn't currently routed.
        """
        old = self._matrix.pop(gpio_pin, None)
        if old is None:
            return
        self._sources[old].discard(gpio_pin)
        if not self._sources[old]:
            del self._sources[old]

    def replace_snapshot(
        self, matrix: dict[int, int],
    ) -> tuple[list[tuple[int, int]], list[int]]:
        """Adopt a wholesale snapshot of the matrix and return the
        diff vs the previous state.

        Used by the polling-fallback path (no synchronous C callback
        available): the worker periodically scans `gpio_out_sel[40]`
        and hands us the whole table; we diff against our state and
        return:

          - ``changed_routes``: list of ``(gpio_pin, new_signal_id)``
            for pins whose signal id moved or that became newly
            routed;
          - ``cleared_pins``: list of gpio_pins that USED to be
            routed and no longer are.

        Callers use these lists to emit `gpio_routing` /
        `gpio_routing_clear` WebSocket events to the frontend so its
        mirror stays in sync without re-broadcasting the whole table.
        """
        changed: list[tuple[int, int]] = []
        for gpio_pin, signal_id in matrix.items():
            if self._matrix.get(gpio_pin) != signal_id:
                changed.append((gpio_pin, signal_id))
        cleared = [g for g in self._matrix if g not in matrix]
        for gpio_pin, signal_id in changed:
            self.update_routing(gpio_pin, signal_id)
        for gpio_pin in cleared:
            self.clear_routing(gpio_pin)
        return changed, cleared

    # ── Readers ─────────────────────────────────────────────────────────

    def pins_for_signal(self, signal_id: int) -> tuple[int, ...]:
        """Return every gpio_pin currently driven by ``signal_id``.

        Returns a tuple (immutable) so callers can iterate without
        worrying about concurrent mutations invalidating the result.
        """
        return tuple(sorted(self._sources.get(signal_id, ())))

    def signal_for_gpio(self, gpio_pin: int) -> int | None:
        """Return the signal id currently routed to ``gpio_pin``, or
        None when the pin is unmapped (GPIO direct-out)."""
        return self._matrix.get(gpio_pin)

    def routes(self) -> Iterator[tuple[int, int]]:
        """Iterate the full matrix as ``(gpio_pin, signal_id)`` pairs.

        Useful for snapshot-style replication to a new connection
        (e.g. the frontend re-attaching after a WebSocket reconnect).
        """
        return iter(self._matrix.items())

    def __len__(self) -> int:
        return len(self._matrix)


__all__ = ["SignalRouter"]
