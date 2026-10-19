"""The bit a WS281x pixel reads from one RMT item (QEMU worker).

FastLED gives WS2811 (the default chip of its DemoReel100 example) and WS2813
a '1' of 640 ns high and 640 ns low: exactly half the bit. The decoder asked
for "high longer than low", read every one of those as 0 and the strip stayed
black while the sketch ran (measured on velxio.dev, 2026-10-05). A real pixel
samples about 0.48 us after the rising edge, so that symbol is a 1.
"""

import pytest

from app.services.esp32_worker import _RmtDecoder, _ws281x_bit

# name, '0' (high, low), '1' (high, low). ns or ticks: only the ratio counts.
DRIVERS = [
    ("FastLED WS2812B (250/625/375)", (250, 1000), (875, 375)),
    ("FastLED WS2811 800 kHz and WS2813 (320/320/640)", (320, 960), (640, 640)),
    ("FastLED WS2815 (250/1090/550)", (250, 1640), (1340, 550)),
    ("FastLED SK6812 (300/600/300)", (300, 900), (900, 300)),
    ("FastLED WS2811 400 kHz (800/800/900)", (800, 1700), (1600, 900)),
    ("FastLED TM1829 (340/340/550)", (340, 890), (680, 550)),
    ("Adafruit_NeoPixel / MicroPython bitstream", (400, 850), (800, 450)),
    ("arduino-esp32 rgbLedWrite (ticks at 10 MHz)", (4, 8), (8, 4)),
    ("ESP-IDF led_strip", (300, 900), (900, 300)),
]


@pytest.mark.parametrize("name,zero,one", DRIVERS, ids=[d[0] for d in DRIVERS])
def test_a_zero_reads_zero_and_a_one_reads_one(name, zero, one):
    assert _ws281x_bit(*zero) == 0
    assert _ws281x_bit(*one) == 1


def test_a_one_at_exactly_half_the_bit_is_a_one():
    assert _ws281x_bit(640, 640) == 1
    assert _ws281x_bit(26, 26) == 1  # the same symbol in 25 ns ticks
    assert not (640 > 640)  # what the old rule asked


def _item(high: int, low: int) -> int:
    """duration0[14:0], level0[15]=1, duration1[30:16], level1[31]=0."""
    return (high & 0x7FFF) | (1 << 15) | ((low & 0x7FFF) << 16)


def _frame(decoder: _RmtDecoder, grb: tuple[int, int, int], one: int, zero: int):
    out = None
    for byte in grb:
        for bit in range(7, -1, -1):
            out = decoder.feed(one if (byte >> bit) & 1 else zero) or out
    return decoder.feed(0) or out  # the {0, 0} end marker flushes the frame


def test_a_frame_in_fastled_ws2813_timing_decodes_to_its_colour():
    # 320/320/640 ns at 25 ns a tick: a 1 is 26 + 26, a 0 is 13 + 38.
    pixels = _frame(_RmtDecoder(0), (0x0F, 0xF0, 0xAA), _item(26, 26), _item(13, 38))
    assert pixels == [{"r": 0xF0, "g": 0x0F, "b": 0xAA}]


def test_a_frame_in_the_arduino_core_timing_still_decodes():
    # rgbLedWrite: 8 ticks high + 4 low for a 1, 4 + 8 for a 0.
    pixels = _frame(_RmtDecoder(0), (0x12, 0x34, 0x56), _item(8, 4), _item(4, 8))
    assert pixels == [{"r": 0x34, "g": 0x12, "b": 0x56}]
