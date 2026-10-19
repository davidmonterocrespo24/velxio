"""The poll announces GPIO Matrix routes from a diff against what it already
announced, not against the router the libqemu callback keeps up to date.

Regression for #385: with the callback updating the router first, a diff
against the router was always empty and no `gpio_routing` ever reached the
frontend, so LEDC PWM (servo, dimmed LED, buzzer) never found its pin on the
QEMU engine.
"""
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

_here = Path(__file__).resolve().parent.parent / "app" / "services" / "signal_router.py"
_spec = importlib.util.spec_from_file_location("signal_router", _here)
_mod = importlib.util.module_from_spec(_spec)
sys.modules["signal_router"] = _mod
_spec.loader.exec_module(_mod)
SignalRouter = _mod.SignalRouter
diff_routes = _mod.diff_routes

SIG_LEDC_HS_CH0 = 71


def test_a_route_the_callback_already_applied_is_still_announced_once():
    router = SignalRouter()
    emitted: dict[int, int] = {}
    # The synchronous callback lands first and brings the router up to date.
    router.update_routing(13, SIG_LEDC_HS_CH0)
    # The poll then scans the chip: the table equals the router already.
    snapshot = {13: SIG_LEDC_HS_CH0}
    assert router.replace_snapshot(snapshot) == ([], [])  # what #385 diffed against
    changed, cleared = diff_routes(snapshot, emitted)
    assert changed == [(13, SIG_LEDC_HS_CH0)]
    assert cleared == []
    emitted.update(snapshot)
    # The next poll with nothing new stays quiet.
    assert diff_routes(snapshot, emitted) == ([], [])


def test_a_pin_that_moves_to_another_channel_is_announced_again():
    emitted = {13: SIG_LEDC_HS_CH0}
    changed, cleared = diff_routes({13: SIG_LEDC_HS_CH0 + 1}, emitted)
    assert changed == [(13, SIG_LEDC_HS_CH0 + 1)]
    assert cleared == []


def test_a_pin_routed_back_to_gpio_is_cleared_once():
    emitted = {13: SIG_LEDC_HS_CH0, 14: SIG_LEDC_HS_CH0 + 1}
    changed, cleared = diff_routes({14: SIG_LEDC_HS_CH0 + 1}, emitted)
    assert changed == []
    assert cleared == [13]
    emitted = {14: SIG_LEDC_HS_CH0 + 1}
    assert diff_routes({14: SIG_LEDC_HS_CH0 + 1}, emitted) == ([], [])
