"""ESP32 GPIO Matrix output signal source IDs.

Lifted from the ESP32 Technical Reference Manual (Espressif ESP32 TRM
section 4.11, "IO_MUX and GPIO Matrix"). Each output GPIO has a
configuration register `GPIO_FUNCx_OUT_SEL_CFG_REG[x]` whose low 9
bits (`FUNCx_OUT_SEL`) select one of 256 internal peripheral signals
to drive the pin. The constants below name the signals that velxio
actually emulates today; add more here when a new peripheral wants
to participate in the SignalRouter.

The signal ID range mirrors the QEMU plugin's interpretation of
`gpio_out_sel`; the existing worker code at
`esp32_worker.py:_refresh_ledc_gpio_map` already reads these values
out of the matrix via `qemu_picsimlab_get_internals(2)`.
"""

from __future__ import annotations


# ── LEDC (PWM peripheral) ─────────────────────────────────────────────────
# Per ESP32 Technical Reference Manual section 4.11, Table 4-3 (GPIO
# Matrix output signals):
#   71-78 → LEDC_HS_SIG_OUT[0..7]  (high-speed channels 0-7)
#   79-86 → LEDC_LS_SIG_OUT[0..7]  (low-speed  channels 0-7)
#
# The legacy worker code at esp32_worker.py:426 used the off-by-one
# range 72-87; that masked itself because the channel index encoded in
# the 0x5000 duty callback (0..15) was internally consistent with the
# bogus signal-id math, so single-servo demos still appeared to work.
# Multi-servo projects (e.g. solar-tracker, project 5218f9e3) exposed
# the bug — `ledcAttachPin(13, 0)` actually writes signal 71 to
# gpio_out_sel[13], which the off-by-one scan REJECTED, so channel 0
# resolved to GPIO 12 (the next servo's pin, whose signal 72 WAS in
# range and was misinterpreted as channel 0).
SIG_LEDC_HS_CH0_OUT_IDX = 71  # add N for HS channel N (0..7)
SIG_LEDC_HS_CH_LAST     = 78
SIG_LEDC_LS_CH0_OUT_IDX = 79  # add N for LS channel N (0..7)
SIG_LEDC_LS_CH_LAST     = 86


# RMT_SIG_OUT0_IDX per chip, read from the IDF headers shipped in this image
# (components/soc/<chip>/include/soc/gpio_sig_map.h). Add the RMT TX channel
# number to get the signal a GPIO must carry for that channel to reach the pad.
#
# Needed because the WS2812 frames the RMT decoder produces are useless to the
# frontend without the GPIO they went out on: a NeoPixel PART on the canvas is
# keyed by its DIN pin, and an RMT channel number cannot reach one.
RMT_SIG_OUT0_IDX_BY_CHIP = {
    'esp32': 87,
    'esp32-s3': 81,
    'esp32-c3': 51,
}


def rmt_signal_base(machine: str) -> int | None:
    """The chip's RMT_SIG_OUT0_IDX, from a machine string like 'esp32-s3'."""
    if not machine:
        return None
    if 'c3' in machine:
        return RMT_SIG_OUT0_IDX_BY_CHIP['esp32-c3']
    if 's3' in machine:
        return RMT_SIG_OUT0_IDX_BY_CHIP['esp32-s3']
    return RMT_SIG_OUT0_IDX_BY_CHIP['esp32']


# I2CEXTn_SDA_OUT_IDX per chip, by controller (ESP-IDF
# components/soc/<chip>/include/soc/gpio_sig_map.h). The worker reads which
# controller a pad carries off the matrix, because on these chips any GPIO can
# be SDA: `Wire1.begin(25, 26)` is the whole of Wire1's pin assignment, and the
# tab has no table that could say it (project board-buses-2026-09, F5).
I2C_SDA_OUT_IDX_BY_CHIP = {
    'esp32': {30: 0, 96: 1},
    'esp32-s3': {90: 0, 92: 1},
    'esp32-c3': {54: 0},
}


def i2c_sda_signals(machine: str) -> dict[int, int]:
    """Matrix signal id -> I2C controller, for the chip a machine string names."""
    if not machine:
        return {}
    if 'c3' in machine:
        return I2C_SDA_OUT_IDX_BY_CHIP['esp32-c3']
    if 's3' in machine:
        return I2C_SDA_OUT_IDX_BY_CHIP['esp32-s3']
    return I2C_SDA_OUT_IDX_BY_CHIP['esp32']


def ledc_signal_for_channel(channel: int) -> int:
    """Map a velxio-style unified LEDC channel index (0..15) to its
    GPIO Matrix signal source id.

    The ESP32 LEDC hardware has two channel groups: 8 high-speed (HS)
    and 8 low-speed (LS). velxio unifies them into a single 0..15
    space where ch 0-7 = HS, ch 8-15 = LS (matches the encoding the
    QEMU plugin emits on the 0x5000 duty callback).
    """
    if not 0 <= channel < 16:
        raise ValueError(f"ledc channel out of range: {channel}")
    if channel < 8:
        return SIG_LEDC_HS_CH0_OUT_IDX + channel
    return SIG_LEDC_LS_CH0_OUT_IDX + (channel - 8)


def channel_for_ledc_signal(signal_id: int) -> int | None:
    """Inverse of :func:`ledc_signal_for_channel`.  Returns None when
    the signal id is not an LEDC channel."""
    if SIG_LEDC_HS_CH0_OUT_IDX <= signal_id <= SIG_LEDC_HS_CH_LAST:
        return signal_id - SIG_LEDC_HS_CH0_OUT_IDX
    if SIG_LEDC_LS_CH0_OUT_IDX <= signal_id <= SIG_LEDC_LS_CH_LAST:
        return 8 + (signal_id - SIG_LEDC_LS_CH0_OUT_IDX)
    return None


# ── Sentinel for "GPIO not routed to any peripheral" ──────────────────────
# When `gpio_out_sel[N]` carries this value the pin is driven by
# normal GPIO output (the value in the GPIO_OUT_REG bit N), not a
# peripheral signal.
SIG_GPIO_DIRECT_OUT_IDX = 256


__all__ = [
    "SIG_LEDC_HS_CH0_OUT_IDX",
    "SIG_LEDC_HS_CH_LAST",
    "SIG_LEDC_LS_CH0_OUT_IDX",
    "SIG_LEDC_LS_CH_LAST",
    "SIG_GPIO_DIRECT_OUT_IDX",
    "RMT_SIG_OUT0_IDX_BY_CHIP",
    "rmt_signal_base",
    "ledc_signal_for_channel",
    "channel_for_ledc_signal",
]
