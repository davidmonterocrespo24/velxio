"""
test_board_buses_f4_map_keeps_card.py: a republished bus map must not undo
what the guest wrote to a hosted card (project/board-buses-2026-09, F4,
STATUS.md "Carrera en los workers ESP32 y STM32").

The tab publishes the WHOLE map on every membership change (a wire moved, a
part added, a panel attached), and the map carries each model's blobs as the
tab last knew them. The guest's writes reach the tab later, as `bus_blob`
spans. A map that goes out in between carries the card from BEFORE the write,
and the worker used to rebuild every model from its map: the write was gone,
silently, on the user's card.

The rule now, shared with the Pi host (`hosted_model_identity` in
wasm_chip_runtime.py): a model whose artifact, select, pins and image ids did
not change is KEPT, running instance and all. Blob contents are not identity
(they are what the race makes stale); `blob_ids` are, because they are the
tab naming which card it loaded, and a card the user swapped has to replace
the one running here.

Rig: the repro suite's (microSD CS 4, the real microsd.wasm).
"""
from __future__ import annotations

import base64

from .test_board_buses_f4_sink_forwarding import card_init, read_block, sinks, pin
from .test_board_buses_f4_worker import pin_cs, probe_entry, select
from .test_board_buses_repro_worker import (  # noqa: F401  (worker fixture)
    CHIP_A_CS,
    CHIP_B_CS,
    SD_CS,
    TFT_CS,
    Worker,
    sd_cmd,
    sd_entry,
    worker,
)

IMAGE = bytes((i * 7 + (i >> 9)) & 0xFF for i in range(8 * 512))
OTHER_IMAGE = bytes((i * 13 + 5) & 0xFF for i in range(8 * 512))
WRITTEN = bytes([0x77] * 512)


def card(image: bytes = IMAGE, blob_id: str | None = 'img-1') -> dict:
    entry = sd_entry(image=image)
    if blob_id is not None:
        entry['model']['blob_ids'] = {'card': blob_id}
    return entry


def write_block_held(w: Worker, block: int, data: bytes) -> None:
    """CMD24 with the select still LOW afterwards: no deselect edge, so
    nothing has drained the span to the tab yet. The race's window."""
    w.pin(SD_CS, 0)
    w.spi(sd_cmd(24, block * 512) + [0xFF] * 8 + [0xFE] + list(data)
          + [0xFF, 0xFF] + [0xFF] * 8)


def republish(w: Worker, *entries: dict) -> None:
    w.send({'cmd': 'bus_map', 'spi': list(entries)})
    w.sync()


def blobs(w: Worker) -> list[dict]:
    return [e for e in w.events('system') if e.get('event') == 'bus_blob']


class TestARepublishedMapKeepsTheCard:

    def test_setup_a_written_sector_reads_back_without_a_new_map(self, worker):
        """The rig: the write lands and reads back when nothing republishes, so
        a failure below is the map and not the card."""
        w = worker(bus_map={'spi': [card(), sinks(pin(TFT_CS))]})
        w.pin(TFT_CS, 1)
        card_init(w)
        write_block_held(w, 1, WRITTEN)
        w.pin(SD_CS, 1)
        _seq, block = read_block(w, 1)
        assert bytes(block) == WRITTEN

    def test_an_unchanged_map_before_the_span_is_drained_keeps_the_write(self, worker):
        """The defect. The tab moved a wire elsewhere while the guest's sector
        was still in the worker: the map carries the card as it was BEFORE the
        write. The sinks entry changes too, as it would for a panel attached,
        so this is a real membership change and not a byte-identical resend."""
        w = worker(bus_map={'spi': [card(), sinks(pin(TFT_CS))]})
        w.pin(TFT_CS, 1)
        card_init(w)
        write_block_held(w, 1, WRITTEN)
        republish(w, card(), sinks(all_=True))
        w.pin(SD_CS, 1)
        _seq, block = read_block(w, 1)
        assert bytes(block) == WRITTEN, 'the republished map undid the guest write'
        # and the rest of the card is still the image, not a blank one
        _seq, block = read_block(w, 2)
        assert bytes(block) == IMAGE[1024:1536]

    def test_the_kept_card_still_sends_its_span_once(self, worker):
        """Keeping the model must not swallow the span the tab is waiting for,
        nor send it twice (once from the drain before the map, once again from
        the kept model's next deselect)."""
        w = worker(bus_map={'spi': [card(), sinks(pin(TFT_CS))]})
        w.pin(TFT_CS, 1)
        card_init(w)
        write_block_held(w, 1, WRITTEN)
        republish(w, card(), sinks(pin(TFT_CS)))
        w.pin(SD_CS, 1)
        w.flush()
        assert w.wait_for(lambda: bool(blobs(w)), 2.0), 'no bus_blob'
        spans = [(e['offset'], base64.b64decode(e['data'])) for e in blobs(w)]
        assert spans == [(512, WRITTEN)]

    def test_the_span_names_the_image_it_was_written_to(self, worker):
        """The tab drops a span for a card it has since replaced; it can only
        tell by the id the worker echoes."""
        w = worker(bus_map={'spi': [card(blob_id='img-7'), sinks(pin(TFT_CS))]})
        w.pin(TFT_CS, 1)
        card_init(w)
        write_block_held(w, 1, WRITTEN)
        w.pin(SD_CS, 1)
        assert w.wait_for(lambda: bool(blobs(w)), 2.0), 'no bus_blob'
        assert [e.get('blob_id') for e in blobs(w)] == ['img-7']

    def test_a_page_that_names_no_image_keeps_a_card_whose_bytes_did_not_change(self, worker):
        """Without ids the contents stand in for identity: the same image is
        the same card."""
        w = worker(bus_map={'spi': [card(blob_id=None), sinks(pin(TFT_CS))]})
        w.pin(TFT_CS, 1)
        card_init(w)
        write_block_held(w, 1, WRITTEN)
        republish(w, card(blob_id=None), sinks(all_=True))
        w.pin(SD_CS, 1)
        _seq, block = read_block(w, 1)
        assert bytes(block) == WRITTEN


class TestADifferentCardReplacesIt:
    """The opposite bug: keeping a card the user has replaced."""

    def test_a_new_image_id_replaces_the_card(self, worker):
        """The user loaded another card. The worker must serve THAT image, not
        the old one with the guest's write on it. The new card starts
        uninitialised, as a card pushed into a slot does."""
        w = worker(bus_map={'spi': [card(), sinks(pin(TFT_CS))]})
        w.pin(TFT_CS, 1)
        card_init(w)
        write_block_held(w, 1, WRITTEN)
        republish(w, card(OTHER_IMAGE, blob_id='img-2'), sinks(pin(TFT_CS)))
        w.pin(SD_CS, 1)
        card_init(w)
        _seq, block = read_block(w, 1)
        assert bytes(block) == OTHER_IMAGE[512:1024]

    def test_a_new_image_id_replaces_it_even_when_the_bytes_are_the_same(self, worker):
        """Reloading the same files is still a new card: identity is the id,
        not a comparison of bytes that the race makes unreliable."""
        w = worker(bus_map={'spi': [card(), sinks(pin(TFT_CS))]})
        w.pin(TFT_CS, 1)
        card_init(w)
        write_block_held(w, 1, WRITTEN)
        republish(w, card(IMAGE, blob_id='img-2'), sinks(pin(TFT_CS)))
        w.pin(SD_CS, 1)
        card_init(w)
        _seq, block = read_block(w, 1)
        assert bytes(block) == IMAGE[512:1024]

    def test_without_ids_different_bytes_replace_the_card(self, worker):
        w = worker(bus_map={'spi': [card(blob_id=None), sinks(pin(TFT_CS))]})
        w.pin(TFT_CS, 1)
        card_init(w)
        write_block_held(w, 1, WRITTEN)
        republish(w, card(OTHER_IMAGE, blob_id=None), sinks(pin(TFT_CS)))
        w.pin(SD_CS, 1)
        card_init(w)
        _seq, block = read_block(w, 1)
        assert bytes(block) == OTHER_IMAGE[512:1024]

    def test_a_card_moved_to_another_select_is_a_new_device(self, worker):
        """A select that moved is a rewire of the card itself; the tab builds a
        new card for it anyway. What must not happen is the old instance
        answering on the new line with the old select's state."""
        w = worker(bus_map={'spi': [card(), sinks(pin(TFT_CS))]})
        w.pin(TFT_CS, 1)
        card_init(w)
        write_block_held(w, 1, WRITTEN)
        w.pin(SD_CS, 1)
        moved = sd_entry(cs_gpio=5, image=IMAGE)
        moved['model']['blob_ids'] = {'card': 'img-1'}
        republish(w, moved, sinks(pin(TFT_CS)))
        # the old select no longer reaches any card
        w.pin(SD_CS, 0)
        assert set(w.spi(sd_cmd(0) + [0xFF] * 4)) == {0xFF}
        w.pin(SD_CS, 1)
        # and the new one reaches a card built from the map
        w.pin(5, 1)
        w.pin(5, 0)
        seq = [0xFF] * 10 + sd_cmd(0) + [0xFF] * 4 + sd_cmd(8, 0x1AA) + [0xFF] * 8
        for _ in range(3):
            seq += sd_cmd(55) + [0xFF] * 4 + sd_cmd(41, 0x40000000) + [0xFF] * 4
        w.spi(seq)
        w.pin(5, 1)
        w.pin(5, 0)
        miso = w.spi(sd_cmd(17, 512) + [0xFF] * (8 + 515))
        w.pin(5, 1)
        i = miso.index(0xFE, 6) + 1
        assert bytes(miso[i:i + 512]) == IMAGE[512:1024]

    def test_a_card_that_left_the_map_is_gone(self, worker):
        w = worker(bus_map={'spi': [card(), sinks(pin(TFT_CS))]})
        w.pin(TFT_CS, 1)
        card_init(w)
        republish(w, sinks(pin(TFT_CS)))
        w.pin(SD_CS, 0)
        assert set(w.spi(sd_cmd(0) + [0xFF] * 4)) == {0xFF}
        w.pin(SD_CS, 1)


class TestEachPartOfTheIdentityCounts:
    """One changed field each, everything else left as it was, on the probe
    of the F4 worker suite (it answers `sig` on its first byte and logs when
    its select rises). A model kept across any of these would be the old
    device answering for a new one."""

    def _first(self, w: Worker, gpio: int, bus: int = 0) -> int:
        select(w, gpio)
        out = w.spi([0x00, 0x00], bus=bus)
        w.pin(gpio, 1)
        return out[0]

    def test_setup_an_identical_probe_is_kept(self, worker):
        w = worker(bus_map={'spi': [probe_entry('a', pin_cs(CHIP_A_CS), 0xA0)]})
        ready = w.chip_log().count('spi probe ready')
        republish(w, probe_entry('a', pin_cs(CHIP_A_CS), 0xA0))
        assert self._first(w, CHIP_A_CS) == 0xA0
        # the log is a stream: give a rebuilt instance's setup line time to
        # arrive before calling its absence a keep
        assert not w.wait_for(lambda: w.chip_log().count('spi probe ready') > ready, 0.5)

    def test_another_artifact(self, worker):
        w = worker(bus_map={'spi': [probe_entry('a', pin_cs(CHIP_A_CS), 0xA0)]})
        swapped = probe_entry('a', pin_cs(CHIP_A_CS), 0xA0)
        swapped['model']['wasm_b64'] = sd_entry()['model']['wasm_b64']
        republish(w, swapped)
        # a card that has seen no command answers the idle line, not 0xA0
        assert self._first(w, CHIP_A_CS) == 0xFF

    def test_another_select(self, worker):
        w = worker(bus_map={'spi': [probe_entry('a', pin_cs(CHIP_A_CS), 0xA0)]})
        moved = probe_entry('a', pin_cs(CHIP_A_CS), 0xA0)
        moved['cs'] = pin_cs(CHIP_B_CS)
        republish(w, moved)
        # the old line selects nothing now (the new instance is selected by
        # the new line, and reads its own select leg through the pin map)
        assert self._first(w, CHIP_A_CS) == 0xFF

    def test_another_controller(self, worker):
        w = worker(bus_map={'spi': [probe_entry('a', pin_cs(CHIP_A_CS), 0xA0)]})
        republish(w, probe_entry('a', pin_cs(CHIP_A_CS), 0xA0, bus_id=2))
        assert self._first(w, CHIP_A_CS, bus=0) == 0xFF
        assert self._first(w, CHIP_A_CS, bus=2) == 0xA0

    def test_another_pin_map(self, worker):
        # The select leg of the model moved while the bus entry did not: the
        # new model watches the new pad, so a rise on the old one ends no
        # frame of its.
        w = worker(bus_map={'spi': [probe_entry('a', pin_cs(CHIP_A_CS), 0xA0)]})
        rewired = probe_entry('a', pin_cs(CHIP_A_CS), 0xA0)
        rewired['model']['pin_map']['CS'] = CHIP_B_CS
        ready = w.chip_log().count('spi probe ready')
        republish(w, rewired)
        # the log is a stream: wait for the new instance's setup line, or it
        # lands after the mark below and reads as a frame
        assert w.wait_for(lambda: w.chip_log().count('spi probe ready') > ready, 2.0), \
            'the rewired probe was kept, not rebuilt'
        before = len(w.chip_log())
        self._first(w, CHIP_A_CS)
        w.sync()
        assert w.chip_log()[before:] == []
