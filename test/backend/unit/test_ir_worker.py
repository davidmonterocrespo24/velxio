"""
test_ir_worker.py — the IR envelope the QEMU ESP32 worker drives
(`app.services.esp32_ir`).

The guest that reads this frame is an IR library, and the two families sample
it very differently:

  * IRremote's ESP32 backend samples the pin from a 50 us timer ISR and
    reconstructs mark and space lengths by counting samples.
  * a pin-change-interrupt decoder never reads the pin at all and is woken by
    the edges themselves.

The first is why the frame is paced by REAL guest microseconds rather than by
the DHT22 player's 2 us-per-read credit — at 2 us per 50 us sample a 9 ms
header would take 225 ms of guest time and nothing would decode it. The second
is why the worker also advances the frame from a host ticker.

The decoder here is the same one the browser runs
(`simulation/ir/necCodec.ts`), reimplemented over the levels this player
actually put on the pad — which is the only way to test that the envelope means
what it is supposed to mean rather than that it has the shape we wrote down.
"""

from __future__ import annotations

import unittest

from app.services.esp32_ir import (
    LEAD_US,
    STUCK_TIMEOUT_US,
    IrReply,
    envelope_phases,
    nec_pulses,
)
from app.services.esp32_worker import LINE_SENSOR_TYPES


class FakePad:
    """A pad plus a clock the test advances by hand, recording every edge."""

    def __init__(self) -> None:
        self.now = 1_000_000.0          # a guest that has been up a while
        self.level = 1                  # a demodulator idles HIGH
        self.edges: list[tuple[float, int]] = []

    def set_level(self, level: int) -> None:
        if level != self.level:
            self.level = level
            self.edges.append((self.now, level))

    def now_us(self) -> float:
        return self.now

    def run(self, reply: IrReply, step_us: float, limit_us: float = 500_000.0) -> int:
        """Sample the pad every `step_us` of guest time, the way an ISR does."""
        samples = 0
        start = self.now
        while not reply.done and self.now - start < limit_us:
            self.now += step_us
            samples += 1
            if reply.advance():
                break
        return samples


def decode_nec(edges: list[tuple[float, int]]) -> tuple[str, int, int, bool]:
    """The NEC frame the recorded edges carry. Mirror of necCodec.ts."""
    if len(edges) < 4:
        return ('raw', 0, 0, False)
    # A mark is an interval the pad spent LOW; an edge to LOW starts one.
    pulses: list[tuple[int, float]] = []
    for i in range(len(edges) - 1):
        level, nxt = edges[i][1], edges[i + 1][0]
        pulses.append((1 if level == 0 else 0, nxt - edges[i][0]))

    def near(actual: float, expected: float, tol: float = 0.25) -> bool:
        return abs(actual - expected) <= expected * tol

    i = 0
    while i < len(pulses) and pulses[i][0] == 0:
        i += 1
    if len(pulses) - i < 3:
        return ('raw', 0, 0, False)
    if not near(pulses[i][1], 9000):
        return ('raw', 0, 0, False)
    if not near(pulses[i + 1][1], 4500):
        if near(pulses[i + 1][1], 2250):
            return ('NEC-repeat', 0, 0, True)
        return ('raw', 0, 0, False)
    i += 2

    bits: list[int] = []
    while len(bits) < 32:
        if i + 1 >= len(pulses):
            return ('raw', 0, 0, False)
        if not near(pulses[i][1], 560):
            return ('raw', 0, 0, False)
        space = pulses[i + 1][1]
        if near(space, 1690):
            bits.append(1)
        elif near(space, 560):
            bits.append(0)
        else:
            return ('raw', 0, 0, False)
        i += 2

    def byte_at(n: int) -> int:
        v = 0
        for b in range(8):                     # least significant bit first
            v |= bits[n * 8 + b] << b
        return v

    addr_lo, addr_hi, cmd, cmd_inv = (byte_at(n) for n in range(4))
    classic = ((addr_lo ^ addr_hi) & 0xFF) == 0xFF
    address = addr_lo if classic else addr_lo | (addr_hi << 8)
    return ('NEC', address, cmd, ((cmd ^ cmd_inv) & 0xFF) == 0xFF)


class TestEnvelopePhases(unittest.TestCase):
    def test_a_mark_pulls_the_output_low(self):
        phases = envelope_phases([(1, 9000), (0, 4500)])
        self.assertEqual(phases[0], (1, LEAD_US))   # the settling lead
        self.assertEqual(phases[1], (0, 9000.0))    # the mark
        self.assertEqual(phases[2], (1, 4500.0))    # the space

    def test_it_ends_idle_high_even_though_nec_ends_on_a_mark(self):
        phases = envelope_phases(nec_pulses(0x00, 0x45))
        self.assertEqual(phases[-1][0], 1)

    def test_adjacent_marks_merge_rather_than_growing_a_zero_width_edge(self):
        phases = envelope_phases([(1, 500), (1, 500), (0, 600)])
        self.assertEqual(phases[1], (0, 1000.0))

    def test_zero_length_pulses_are_dropped(self):
        self.assertEqual(envelope_phases([(1, 0), (0, 0)]), [])

    def test_an_empty_train_is_not_a_frame(self):
        self.assertEqual(envelope_phases([]), [])


class TestNecPulses(unittest.TestCase):
    def test_header_then_thirty_two_bits_then_a_stop_mark(self):
        p = nec_pulses(0x00, 0x45)
        self.assertEqual(len(p), 2 + 64 + 1)
        self.assertEqual(p[0], (1, 9000.0))
        self.assertEqual(p[1], (0, 4500.0))
        self.assertEqual(p[-1], (1, 560.0))

    def test_a_bit_is_in_the_space_least_significant_first(self):
        p = nec_pulses(0x01, 0x00)
        self.assertEqual(p[3][1], 1690.0)
        self.assertEqual(p[5][1], 560.0)


class TestIrReply(unittest.TestCase):
    def _play(self, address: int, command: int, step_us: float):
        pad = FakePad()
        reply = IrReply(envelope_phases(nec_pulses(address, command)),
                        pad.set_level, pad.now_us)
        pad.run(reply, step_us)
        return pad, reply

    def test_a_fifty_microsecond_sampler_decodes_the_frame(self):
        # IRremote's ESP32 backend. This is the case the DHT22 player's 2 us
        # per-read credit would have stretched to 225 ms and destroyed.
        pad, reply = self._play(0x04, 0x1C, 50.0)
        self.assertTrue(reply.done)
        self.assertEqual(decode_nec(pad.edges), ('NEC', 0x04, 0x1C, True))

    def test_it_decodes_across_every_sampling_rate_a_guest_might_use(self):
        for step_us in (1.0, 10.0, 50.0, 100.0):
            with self.subTest(step_us=step_us):
                pad, _ = self._play(0x00, 0x45, step_us)
                self.assertEqual(decode_nec(pad.edges), ('NEC', 0x00, 0x45, True))

    def test_the_header_lasts_nine_milliseconds_of_guest_time(self):
        pad, _ = self._play(0x00, 0x45, 10.0)
        header_us = pad.edges[1][0] - pad.edges[0][0]
        self.assertAlmostEqual(header_us, 9000.0, delta=20.0)

    def test_a_coarse_advance_crosses_every_boundary_it_covers(self):
        # One advance spanning several 560 us phases must not stretch the frame
        # by the number of phases it fell behind.
        pad, _ = self._play(0x04, 0x1C, 300.0)
        span = pad.edges[-1][0] - pad.edges[0][0]
        self.assertLess(span, 75_000.0)   # a NEC frame is ~67.5 ms

    def test_extended_addresses_survive_the_round_trip(self):
        pad, _ = self._play(0x1234, 0x56, 20.0)
        protocol, address, command, _ = decode_nec(pad.edges)
        self.assertEqual((protocol, address, command), ('NEC', 0x1234, 0x56))

    def test_the_pad_is_left_idle_high_when_the_frame_is_over(self):
        pad, reply = self._play(0x00, 0x45, 50.0)
        self.assertTrue(reply.done)
        self.assertEqual(pad.level, 1)

    def test_settle_gives_the_line_back_mid_frame(self):
        pad = FakePad()
        reply = IrReply(envelope_phases(nec_pulses(0, 0x45)), pad.set_level, pad.now_us)
        for _ in range(5):
            pad.now += 50.0
            reply.advance()
        self.assertFalse(reply.done)
        self.assertTrue(reply.settle())
        self.assertEqual(pad.level, 1)
        self.assertFalse(reply.settle())    # only acts once

    def test_a_frame_nobody_advances_does_not_hold_the_pad_forever(self):
        pad = FakePad()
        reply = IrReply(envelope_phases(nec_pulses(0, 0x45)), pad.set_level, pad.now_us)
        reply.advance()
        pad.now += STUCK_TIMEOUT_US + 1000
        self.assertTrue(reply.advance())
        self.assertEqual(pad.level, 1)

    def test_a_guest_reboot_ends_the_frame_rather_than_replaying_it(self):
        pad = FakePad()
        reply = IrReply(envelope_phases(nec_pulses(0, 0x45)), pad.set_level, pad.now_us)
        reply.advance()
        pad.now = 0.0                       # esp_restart: the clock went back
        self.assertTrue(reply.advance())
        self.assertEqual(pad.level, 1)

    def test_a_frame_needs_at_least_one_phase(self):
        with self.assertRaises(ValueError):
            IrReply([], lambda _: None, lambda: 0.0)


class TestWorkerPolicy(unittest.TestCase):
    def test_ir_counts_as_a_line_sensor_for_the_run_policy(self):
        # It places timed edges on a pad in guest time, which is the whole of
        # what that list means.
        self.assertIn('ir-nec', LINE_SENSOR_TYPES)


if __name__ == '__main__':
    unittest.main()
