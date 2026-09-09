"""Infrared for the QEMU ESP32 worker: the envelope a demodulator puts on its
pin, paced in guest time.

Why this is its own module, and why it does NOT reuse the DHT22 player. The
two look alike — both are a list of (level, duration) phases on one pad — and
the difference is the pacing rule, which is the whole of the problem:

  * `esp32_dht22.Dht22Reply` credits at most `STALL_CAP_US` (2 us) of guest
    time per GPIO_IN read, because the drivers it serves sit in a tight
    busy-wait and a phase is really a number of READS. That is exactly right
    there and catastrophic here. An IR library does not busy-wait: IRremote's
    ESP32 backend samples the pin from a 50 us timer ISR. At 2 us credited per
    50 us sample, the 9 ms NEC header would take 225 ms of guest time to play
    out and every decoder would reject the frame.

  * So an IR frame is paced by REAL guest time. `micros()` is what the guest
    measures the envelope with, and the phases are microseconds of exactly
    that clock.

TWO THINGS ADVANCE THE FRAME, and it needs both:

  * a GPIO_IN read, the way the DHT22 does. This covers every polling decoder
    and gives the finest resolution available, because a read is the only
    instant the guest can observe the pad anyway.
  * a host-side ticker, under the BQL. This covers the decoder that uses a
    pin-change interrupt and never reads the pin at all — which reads nothing
    and would otherwise leave the frame frozen on its first phase forever.
    Attaching an interrupt is a normal thing for an IR library to do, so a
    model that only advanced on reads would be dead for a real share of
    sketches with no way for the user to tell why.

Both callers hold the BQL when they drive the pad, so `step()` needs no lock
of its own; it is `advance()` that is called from either side.

POLARITY. A demodulator's output is ACTIVE LOW and idles HIGH: it pulls the
line down for the length of each carrier burst. The frame therefore always
ends HIGH, whatever the last pulse was — a decoder waiting for the end of a
transmission has to see the line come back to idle, and NEC's last pulse is a
mark, so a train played out literally would strand it low forever.
"""

from __future__ import annotations

from typing import Callable, Sequence

Level = int
Phase = tuple[Level, float]  # (level, duration in guest us)

# Settling gap before the first edge, so a frame never starts on the very
# instant it was armed.
LEAD_US = 100.0
# A frame nobody advances for this long of guest time is abandoned rather than
# left holding the pad. Longer than any NEC frame (67.5 ms) by a wide margin.
STUCK_TIMEOUT_US = 400_000.0


def envelope_phases(pulses: Sequence[tuple[int, float]]) -> list[Phase]:
    """Mark/space pairs to pad phases, active low, ending idle HIGH.

    `pulses` are `(level, us)` with level 1 meaning the carrier is ON. Adjacent
    pulses of the same kind are merged: two marks in a row are one longer mark
    on the pin, and emitting them as two phases would put a zero-width edge
    between them that a decoder could see as a bit.
    """
    phases: list[Phase] = [(1, LEAD_US)]
    for level, us in pulses:
        if us <= 0:
            continue
        want = 0 if level == 1 else 1     # a mark pulls the output LOW
        if phases and phases[-1][0] == want:
            phases[-1] = (want, phases[-1][1] + float(us))
        else:
            phases.append((want, float(us)))
    if len(phases) <= 1:
        return []
    if phases[-1][0] == 0:
        # The train ended on a mark. Idle is HIGH, so add the return to it.
        phases.append((1, LEAD_US))
    return phases


def nec_pulses(address: int, command: int) -> list[tuple[int, float]]:
    """The NEC train for an address and a command, as (level, us) pairs.

    Mirror of `simulation/ir/necCodec.ts::necEncode`, the way this whole file
    mirrors `simulation/line/models/ir-nec.ts` — one protocol, written once per
    runtime, never twice per runtime. An address above 0xff is extended NEC:
    16 bits, low byte first, no complement.
    """
    address &= 0xFFFF
    command &= 0xFF
    if address > 0xFF:
        payload = [address & 0xFF, (address >> 8) & 0xFF, command, (~command) & 0xFF]
    else:
        payload = [address & 0xFF, (~address) & 0xFF, command, (~command) & 0xFF]
    out: list[tuple[int, float]] = [(1, 9000.0), (0, 4500.0)]
    for byte in payload:
        for bit in range(8):                       # least significant first
            out.append((1, 560.0))
            out.append((0, 1690.0 if (byte >> bit) & 1 else 560.0))
    out.append((1, 560.0))                         # stop mark
    return out


class IrReply:
    """One envelope on one pad, advanced by real guest microseconds.

    `set_level(level)` drives the pad (QEMU's GPIO_IN bit); `now_us()` is the
    guest clock. `advance()` is called from a GPIO_IN read or from the host
    ticker, both holding the BQL, and returns True once the frame is out and
    the line is back at idle.
    """

    def __init__(
        self,
        phases: list[Phase],
        set_level: Callable[[int], None],
        now_us: Callable[[], float],
    ) -> None:
        if not phases:
            raise ValueError('an IR frame has at least one phase')
        self._phases = phases
        self._set = set_level
        self._now = now_us
        self._idx = -1                 # -1: nothing driven yet
        self._phase_started_us = 0.0
        self.done = False
        # Diagnostics.
        self.advances = 0
        self.started_at_us: float | None = None
        self.finished_at_us: float | None = None

    @property
    def phase(self) -> int:
        """Index of the phase on the wire, -1 before the first advance."""
        return self._idx

    def advance(self) -> bool:
        if self.done:
            return True
        t = self._now()
        self.advances += 1
        if self._idx < 0:
            self._idx = 0
            self._phase_started_us = t
            self.started_at_us = t
            self._set(self._phases[0][0])
            return False

        if t < self._phase_started_us:
            # The guest clock went backwards: it rebooted underneath us and
            # everything measured against the old base is meaningless.
            self._finish(t)
            return True

        # Cross as many boundaries as the elapsed time actually covers. A
        # coarse advance (a 50 us ISR sample, a host tick) can span several
        # 560 us phases if the guest ran ahead between two of them, and
        # stepping one phase per call would stretch the frame by the number of
        # phases it fell behind.
        while True:
            duration = self._phases[self._idx][1]
            if t - self._phase_started_us < duration:
                break
            self._phase_started_us += duration
            self._idx += 1
            if self._idx >= len(self._phases):
                self._finish(t)
                return True
            self._set(self._phases[self._idx][0])
        # A frame nothing advances would hold the pad for the rest of the run.
        if t - (self.started_at_us or t) > STUCK_TIMEOUT_US:
            self._finish(t)
            return True
        return False

    def settle(self) -> bool:
        """Give the line back even though the frame has not run out — the
        guest stopped looking, or the run is ending. True when it acted."""
        if self.done:
            return False
        self._finish(self._now())
        return True

    def _finish(self, t: float) -> None:
        self._set(1)                   # a demodulator idles HIGH
        self.done = True
        self.finished_at_us = t

    def diag(self) -> dict:
        span = (
            None
            if self.started_at_us is None or self.finished_at_us is None
            else round(self.finished_at_us - self.started_at_us, 1)
        )
        return {
            'phases': len(self._phases),
            'advances': self.advances,
            'span_us': span,
        }
