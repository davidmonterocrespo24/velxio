"""Pure-Python tests for the UC8159c (ACeP 7-colour) backend slave.

The slave lives in `backend/app/services/esp32_spi_slaves.py`. Same spec
the TS port matches — keep both in sync when adding new test cases.
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

# Reach into the backend package without spawning a full uvicorn.
_REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(_REPO / "backend"))

from app.services.esp32_spi_slaves import (   # noqa: E402
    Uc8159cEpaperSlave,
    Frame,
    UC_CMD_DTM1,
    UC_CMD_DISPLAY_REFRESH,
    UC_CMD_DEEP_SLEEP,
    UC_CMD_POWER_ON,
    UC_CMD_POWER_OFF,
    UC_CMD_PANEL_SETTING,
)


# ── Helpers ──────────────────────────────────────────────────────────────────

def cmd(c):
    return [(c, False)]


def data(*bs):
    return [(b, True) for b in bs]


def feed_all(d, *streams):
    for stream in streams:
        for byte, dc in stream:
            d.feed(byte, dc)


# ── Tests ────────────────────────────────────────────────────────────────────


class TestPowerLifecycle:
    def test_power_on_off_flag(self):
        d = Uc8159cEpaperSlave(component_id="t", width=8, height=1)
        assert d.powered_on is False
        feed_all(d, cmd(UC_CMD_POWER_ON))
        assert d.powered_on is True
        feed_all(d, cmd(UC_CMD_POWER_OFF))
        assert d.powered_on is False

    def test_deep_sleep_with_a5(self):
        d = Uc8159cEpaperSlave(component_id="t", width=8, height=1)
        feed_all(d, cmd(UC_CMD_DEEP_SLEEP), data(0xA5))
        assert d.in_deep_sleep is True

    def test_deep_sleep_without_a5_does_not_arm(self):
        d = Uc8159cEpaperSlave(component_id="t", width=8, height=1)
        feed_all(d, cmd(UC_CMD_DEEP_SLEEP), data(0x00))
        assert d.in_deep_sleep is False


class TestPixelPacking:
    def test_two_pixels_per_byte_upper_first(self):
        seen = []
        d = Uc8159cEpaperSlave(component_id="t", width=4, height=1,
                               on_flush=lambda f: seen.append(f))
        feed_all(d, cmd(UC_CMD_DTM1), data(0x40, 0x52),
                 cmd(UC_CMD_DISPLAY_REFRESH))
        assert len(seen) == 1
        assert list(seen[0].pixels) == [4, 0, 5, 2]

    def test_only_low_three_bits_form_palette(self):
        # 0xFE → upper=0xF→7 (clean), lower=0xE→6 (orange)
        seen = []
        d = Uc8159cEpaperSlave(component_id="t", width=2, height=1,
                               on_flush=lambda f: seen.append(f))
        feed_all(d, cmd(UC_CMD_DTM1), data(0xFE),
                 cmd(UC_CMD_DISPLAY_REFRESH))
        assert list(seen[0].pixels) == [7, 6]

    def test_overflow_bytes_ignored(self):
        seen = []
        d = Uc8159cEpaperSlave(component_id="t", width=2, height=1,
                               on_flush=lambda f: seen.append(f))
        feed_all(d, cmd(UC_CMD_DTM1), data(0x40, 0x52, 0x66),
                 cmd(UC_CMD_DISPLAY_REFRESH))
        assert list(seen[0].pixels) == [4, 0]

    def test_dtm1_resets_cursor(self):
        seen = []
        d = Uc8159cEpaperSlave(component_id="t", width=2, height=1,
                               on_flush=lambda f: seen.append(f))
        feed_all(d, cmd(UC_CMD_DTM1), data(0x40), cmd(UC_CMD_DISPLAY_REFRESH))
        feed_all(d, cmd(UC_CMD_DTM1), data(0x52), cmd(UC_CMD_DISPLAY_REFRESH))
        assert len(seen) == 2
        assert list(seen[0].pixels) == [4, 0]
        assert list(seen[1].pixels) == [5, 2]


class TestRefreshLatching:
    def test_display_refresh_emits_frame(self):
        seen = []
        d = Uc8159cEpaperSlave(component_id="t", width=600, height=448,
                               on_flush=lambda f: seen.append(f))
        feed_all(d, cmd(UC_CMD_DISPLAY_REFRESH))
        assert d.refreshed_count == 1
        assert len(seen) == 1
        assert seen[0].width == 600 and seen[0].height == 448
        assert len(seen[0].pixels) == 600 * 448

    def test_default_ram_is_white(self):
        seen = []
        d = Uc8159cEpaperSlave(component_id="t", width=100, height=1,
                               on_flush=lambda f: seen.append(f))
        feed_all(d, cmd(UC_CMD_DISPLAY_REFRESH))
        assert all(p == 1 for p in seen[0].pixels)


class TestUnknownCmds:
    def test_init_subcommands_silently_buffered(self):
        d = Uc8159cEpaperSlave(component_id="t", width=8, height=1)
        feed_all(d, cmd(UC_CMD_PANEL_SETTING), data(0xEF, 0x08))
        assert d.unknown_cmds == []

    def test_truly_unknown_opcode_is_logged(self):
        d = Uc8159cEpaperSlave(component_id="t", width=8, height=1)
        feed_all(d, cmd(0xCC), data(0x01))
        assert 0xCC in d.unknown_cmds


class TestFrameType:
    def test_compose_frame_returns_dataclass(self):
        d = Uc8159cEpaperSlave(component_id="t", width=4, height=1)
        feed_all(d, cmd(UC_CMD_DTM1), data(0x12))
        f = d.compose_frame()
        assert isinstance(f, Frame)
        assert f.width == 4
        assert f.height == 1
        # 0x12 → upper=0x1 (white), lower=0x2 (green); rest defaulted to 1
        assert list(f.pixels) == [1, 2, 1, 1]


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
