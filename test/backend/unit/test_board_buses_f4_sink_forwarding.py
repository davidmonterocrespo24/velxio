"""
test_board_buses_f4_sink_forwarding.py: what the ESP32 QEMU worker relays to
the tab, and what it keeps (project/board-buses-2026-09, F4-SPEC "Worker, por
byte", step 3).

Every byte the guest clocks is answered here, beside the guest. The tab only
needs the bytes a SINK of its own (a display, an e-paper panel, anything that
listens and does not answer) could be selected for. Before this, the worker
relayed all of them, which made a streamed card read cost twice what it did
before F4: the card's 515 bytes a sector went through the batch, base64 and
the socket for nobody (STATUS.md, "F4 veredicto de cierre").

The tab now lists, in the same map, the chip select of every device it keeps
(`{"sinks": {"all": bool, "cs": [...]}}`), and the worker relays a byte only
while one of them could be selected. The property that matters is one-sided:
a sink must NEVER miss a byte it would have decoded. Relaying a byte nobody
decodes costs time; dropping one a display needed is a wrong picture. So every
case where this side cannot follow the tab's view of a select (a level the
guest never wrote, a pad released to an input, a select the tab cannot name)
relays, and those are tested as hard as the saving.

The card's writes used to reach the tab's copy through those relayed bytes.
They travel as `bus_blob` now, the event the Pi relay already sends, and the
last class here holds that.

Wiring is the repro suite's (TFT CS 15 / DC 2, microSD CS 4), on its rig.
"""
from __future__ import annotations

import base64

from .test_board_buses_repro_worker import (  # noqa: F401  (worker fixture)
    SD_CS,
    TFT_CS,
    TFT_DC,
    Worker,
    _clock_tft,
    sd_cmd,
    sd_entry,
    worker,
)

CASET_CMD = [0x2A]
CASET_DATA = [0x00, 0x00, 0x00, 0xEF]
PIXELS = [(i * 37) & 0xFF for i in range(640)]
TFT_BYTES = bytes(CASET_CMD + CASET_DATA + PIXELS)

IMAGE = bytes((i * 7 + (i >> 9)) & 0xFF for i in range(8 * 512))
SPARE_CS = 13   # a sink select the guest never touches unless a test says so
HW_PAD = 5      # the pad VSPI drives as its own CS0 on a DevKit


def sinks(*cs: dict, all_: bool = False) -> dict:
    """The entry the tab appends to its map (registry.remoteSpiPublication)."""
    return {'owner': '', 'sinks': {'all': all_, 'cs': list(cs)}}


def pin(gpio: int, active_low: bool = True) -> dict:
    return {'kind': 'pin', 'gpio': gpio, 'active_low': active_low}


def hw(index: int, gpio: int) -> dict:
    return {'kind': 'hw', 'index': index, 'gpio': gpio, 'active_low': True}


def card_init(w: Worker) -> None:
    w.pin(SD_CS, 1)
    w.pin(SD_CS, 0)
    seq = [0xFF] * 10 + sd_cmd(0) + [0xFF] * 4 + sd_cmd(8, 0x1AA) + [0xFF] * 8
    for _ in range(3):
        seq += sd_cmd(55) + [0xFF] * 4 + sd_cmd(41, 0x40000000) + [0xFF] * 4
    w.spi(seq)
    w.pin(SD_CS, 1)


def read_block(w: Worker, block: int) -> tuple[list[int], list[int]]:
    """CMD17 on a standard-capacity card (byte address). Returns what was
    clocked and the 512 bytes after the data token."""
    w.pin(SD_CS, 0)
    seq = sd_cmd(17, block * 512) + [0xFF] * (8 + 515)
    miso = w.spi(seq)
    w.pin(SD_CS, 1)
    i = miso.index(0xFE, 6) + 1
    return seq, miso[i:i + 512]


def card_traffic(w: Worker) -> list[int]:
    """Everything the card sees in one init and one read, and the block read
    back must be the image's: a card that is quick because it is silent must
    not pass."""
    card_init(w)
    seq, block = read_block(w, 2)
    assert bytes(block) == IMAGE[1024:1536], 'the card answered the guest'
    return seq


def tab_bytes(w: Worker) -> bytes:
    w.flush()
    return w.spi_stream()


class TestAMapThatListsNoSinks:
    """A tab that does not list its sinks (a page cached before this change)
    gets what it always got: every byte."""

    def test_every_card_byte_still_reaches_the_tab(self, worker):
        w = worker(bus_map={'spi': [sd_entry(image=IMAGE)]})
        seq = card_traffic(w)
        assert bytes(seq) in tab_bytes(w)


class TestOnlyWhatASinkCanSeeIsRelayed:
    def test_a_card_read_no_sink_can_see_stays_in_the_worker(self, worker):
        w = worker(bus_map={'spi': [sd_entry(image=IMAGE), sinks(pin(TFT_CS))]})
        w.pin(TFT_CS, 1)
        card_traffic(w)
        assert tab_bytes(w) == b''

    def test_a_board_with_no_sink_at_all_relays_nothing(self, worker):
        w = worker(bus_map={'spi': [sd_entry(image=IMAGE), sinks()]})
        card_traffic(w)
        assert tab_bytes(w) == b''

    def test_a_display_and_a_card_on_one_bus_the_display_gets_exactly_its_bytes(self, worker):
        """The case the saving has to survive: one SCK, two selects, the
        transactions interleaved. The display sees every byte of its own, in
        order, and none of the card's; the card still answers."""
        w = worker(bus_map={'spi': [sd_entry(image=IMAGE), sinks(pin(TFT_CS))]})
        w.pin(TFT_CS, 1)
        card_init(w)
        _clock_tft(w)
        _seq, block = read_block(w, 1)
        assert bytes(block) == IMAGE[512:1024]
        _clock_tft(w)
        _seq, block = read_block(w, 3)
        assert bytes(block) == IMAGE[1536:2048]
        assert tab_bytes(w) == TFT_BYTES + TFT_BYTES

    def test_both_selected_at_once_the_display_still_gets_every_byte(self, worker):
        """Two selects low together is a wiring fault the tab reports, and the
        display on a bench would receive the card's bytes too. It still must."""
        w = worker(bus_map={'spi': [sd_entry(image=IMAGE), sinks(pin(TFT_CS))]})
        w.pin(TFT_CS, 1)
        card_init(w)
        w.pin(TFT_CS, 0)
        seq, _block = read_block(w, 2)
        w.pin(TFT_CS, 1)
        assert tab_bytes(w) == bytes(seq)

    def test_the_bulk_path_is_gated_the_same_way(self, worker):
        w = worker(bus_map={'spi': [sd_entry(image=IMAGE), sinks(pin(TFT_CS))]})
        w.pin(TFT_CS, 1)
        w.batch(PIXELS)          # nobody listening
        w.pin(TFT_CS, 0)
        w.batch(PIXELS[:64])     # the display is
        w.pin(TFT_CS, 1)
        assert tab_bytes(w) == bytes(PIXELS[:64])

    def test_an_active_high_sink_is_read_with_its_own_polarity(self, worker):
        w = worker(bus_map={'spi': [sd_entry(image=IMAGE),
                                    sinks(pin(SPARE_CS, active_low=False))]})
        w.pin(SPARE_CS, 0)
        w.spi([0x11, 0x22])
        w.pin(SPARE_CS, 1)
        w.spi([0x33])
        assert tab_bytes(w) == bytes([0x33])

    def test_a_new_map_takes_effect_on_the_next_byte(self, worker):
        """The list changes when the circuit does; the old one must not linger."""
        w = worker(bus_map={'spi': [sd_entry(image=IMAGE), sinks(pin(TFT_CS))]})
        w.pin(TFT_CS, 1)
        w.spi([0x01])
        w.send({'cmd': 'bus_map', 'spi': [sd_entry(image=IMAGE), sinks(all_=True)]})
        w.sync()
        w.spi([0x02])
        assert tab_bytes(w) == bytes([0x02])


class TestASelectThisSideCannotFollowIsRelayed:
    """Each of these is a byte the tab MIGHT decode; a false yes costs time, a
    false no is a byte gone for good."""

    def test_the_tab_says_it_cannot_tell(self, worker):
        # A sink whose select is tied to a rail, has no line, or is driven by
        # another part: the tab says `all`, and everything goes.
        w = worker(bus_map={'spi': [sd_entry(image=IMAGE), sinks(pin(TFT_CS), all_=True)]})
        w.pin(TFT_CS, 1)
        seq = card_traffic(w)
        assert bytes(seq) in tab_bytes(w)

    def test_a_select_the_guest_never_drove(self, worker):
        # The tab reads that line's pull, or whatever else is on it; this side
        # has no level at all. Once the guest drives it high, the saving starts.
        w = worker(bus_map={'spi': [sd_entry(image=IMAGE), sinks(pin(SPARE_CS))]})
        w.spi([0x5A])
        w.pin(SPARE_CS, 1)
        w.spi([0xA5])
        assert tab_bytes(w) == bytes([0x5A])

    def test_a_select_released_to_an_input(self, worker):
        # pinMode(INPUT) on the display's select: the latch still says high,
        # but the line is the circuit's now.
        w = worker(bus_map={'spi': [sd_entry(image=IMAGE), sinks(pin(SPARE_CS))]})
        w.pin(SPARE_CS, 1)
        w.guest('dir', slot=SPARE_CS + 1, value=1)
        w.spi([0x01])
        w.guest('dir', slot=SPARE_CS + 1, value=0)
        w.spi([0x02])
        w.guest('dir', slot=SPARE_CS + 1, value=1)
        w.spi([0x03])
        assert tab_bytes(w) == bytes([0x02])

    def test_a_peripheral_select_is_heard_through_its_own_event(self, worker):
        # QEMU moves no GPIO for a pad the SPI peripheral drives, so the
        # peripheral's CS event is the only place the level exists.
        w = worker(bus_map={'spi': [sd_entry(image=IMAGE), sinks(hw(0, HW_PAD))]})
        w.pin(HW_PAD, 1)
        w.cs(0, 1)
        w.spi([0x01])
        w.cs(0, 0)
        w.spi([0x02])
        w.cs(0, 1)
        w.spi([0x03])
        assert tab_bytes(w) == bytes([0x02])

    def test_the_same_pad_driven_as_a_gpio_still_counts(self, worker):
        # A library that drives the default SS pad with digitalWrite: the
        # peripheral's own CS never moves, the GPIO does, and the tab believes
        # the GPIO until it hears from the peripheral.
        w = worker(bus_map={'spi': [sd_entry(image=IMAGE), sinks(hw(0, HW_PAD))]})
        w.pin(HW_PAD, 1)
        w.spi([0x01])
        w.pin(HW_PAD, 0)
        w.spi([0x02])
        w.pin(HW_PAD, 1)
        w.spi([0x03])
        assert tab_bytes(w) == bytes([0x02])


class TestTheCardsWritesTravelInstead:
    """The tab's card is what the SD panel lists and what the next map ships
    back here. It learnt the guest's writes by decoding the relayed bytes; with
    those gone, the written span comes back as `bus_blob`."""

    def _write_block(self, w: Worker, block: int, fill: int) -> None:
        w.pin(SD_CS, 0)
        w.spi(sd_cmd(24, block * 512) + [0xFF] * 8 + [0xFE] + [fill] * 512
              + [0xFF, 0xFF] + [0xFF] * 8)
        w.pin(SD_CS, 1)

    def _blobs(self, w: Worker) -> list[dict]:
        return [e for e in w.events('system') if e.get('event') == 'bus_blob']

    def test_a_written_sector_comes_back_as_its_span(self, worker):
        w = worker(bus_map={'spi': [sd_entry(image=IMAGE), sinks(pin(TFT_CS))]})
        w.pin(TFT_CS, 1)
        card_init(w)
        self._write_block(w, 3, 0xC3)
        assert w.wait_for(lambda: bool(self._blobs(w)), 2.0), 'no bus_blob'
        spans = self._blobs(w)
        assert [(e['owner'], e['name'], e['offset']) for e in spans] == [('sd1', 'card', 3 * 512)]
        assert base64.b64decode(spans[0]['data']) == bytes([0xC3] * 512)
        assert tab_bytes(w) == b'', 'and the bytes that wrote it stayed here'

    def test_the_span_goes_out_on_the_deselect_ahead_of_what_the_guest_does_next(self, worker):
        # Not on the next flush tick, 50 ms later: the tab rebuilds the next
        # map from its copy, so every millisecond the span sits here is a
        # millisecond in which a map built without it can be on its way.
        w = worker(bus_map={'spi': [sd_entry(image=IMAGE), sinks(pin(TFT_CS))]})
        w.pin(TFT_CS, 1)
        card_init(w)
        self._write_block(w, 2, 0x5E)
        w.pin(TFT_CS, 0)

        def order() -> tuple[int, int] | None:
            evs = w.events()
            blob = next((i for i, e in enumerate(evs)
                         if e.get('type') == 'system' and e.get('event') == 'bus_blob'), None)
            nxt = next((i for i, e in enumerate(evs) if e.get('type') == 'gpio_change'
                        and e.get('pin') == TFT_CS and e.get('state') == 0), None)
            return None if blob is None or nxt is None else (blob, nxt)

        assert w.wait_for(lambda: order() is not None, 2.0)
        blob, nxt = order()
        assert blob < nxt, 'the written span waited for a flush tick'

    def test_a_read_sends_nothing_back(self, worker):
        w = worker(bus_map={'spi': [sd_entry(image=IMAGE), sinks(pin(TFT_CS))]})
        w.pin(TFT_CS, 1)
        card_traffic(w)
        w.flush()
        assert self._blobs(w) == []

    def test_a_write_before_a_new_map_is_sent_before_the_model_is_rebuilt(self, worker):
        # The next map is built from the tab's copy, so what the old model
        # wrote must not die with it.
        w = worker(bus_map={'spi': [sd_entry(image=IMAGE), sinks(pin(TFT_CS))]})
        w.pin(TFT_CS, 1)
        card_init(w)
        w.pin(SD_CS, 0)
        w.spi(sd_cmd(24, 512) + [0xFF] * 8 + [0xFE] + [0x77] * 512 + [0xFF, 0xFF] + [0xFF] * 8)
        # still selected: no deselect edge has drained it yet
        w.send({'cmd': 'bus_map', 'spi': [sinks(pin(TFT_CS))]})
        w.sync()
        assert w.wait_for(lambda: bool(self._blobs(w)), 2.0)
        assert base64.b64decode(self._blobs(w)[0]['data']) == bytes([0x77] * 512)
