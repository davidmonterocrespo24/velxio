#!/usr/bin/env python3
"""Write sd-script.json, the cross-host conformance table for the portable
microSD model (board-buses F4).

The table is written from the SD Physical Layer spec in SPI mode and from the
decisions recorded in microsd.c, NEVER by running the model: a table copied off
a runtime cannot fail when that runtime is wrong, and the whole point of this
one is that the browser, the QEMU worker and the Linux-board host all have to
answer it the same way. Every register byte, CRC and offset below is computed
here from its definition.

The one modelled timing it pins down is N_CR: the card answers R1 at offset 7 of
the exchange that starts with the command byte, because the spec allows 1 to 8
fill byte times and this project pays for exactly one of them (SdFat discards
the byte at offset 6, and ESP-IDF's fixed sdspi_hw_cmd_t reads r1 at offset 7).

    ./make-sd-script.py        # rewrites sd-script.json next to this file
"""
import json
import pathlib

SECTOR = 512
CARD_SECTORS = 2048          # 1 MiB: SDSC territory, and small enough to build
CARD_BYTES = CARD_SECTORS * SECTOR
WRITE_SECTOR = 5
READ_SECTOR = 3


def card_byte(sector: int, offset: int) -> int:
    """The test card's contents. Both replayers build the image from this rule
    and the read assertions below carry the bytes it produces, so a replayer
    that builds a different card fails instead of comparing nothing."""
    return (sector * 37 + offset) & 0xFF


def sector_hex(sector: int, start: int = 0, count: int = SECTOR) -> str:
    return bytes(card_byte(sector, start + i) for i in range(count)).hex()


def payload_byte(offset: int) -> int:
    """What the script writes into WRITE_SECTOR. Deliberately unlike the card
    pattern, so a write that lands in the wrong sector is visible."""
    return (0xA5 ^ offset) & 0xFF


PAYLOAD = bytes(payload_byte(i) for i in range(SECTOR))


def crc7(data: bytes) -> int:
    """CRC-7, polynomial x^7 + x^3 + 1 (0x09), as the SD command and register
    CRC. Written from the polynomial, not lifted from the model."""
    crc = 0
    for b in data:
        crc ^= b
        for _ in range(8):
            crc = ((crc << 1) ^ 0x12) & 0xFF if crc & 0x80 else (crc << 1) & 0xFF
    return crc >> 1


def crc16(data: bytes) -> int:
    """CRC-16-CCITT, polynomial 0x1021 with a zero seed: the CRC that trails
    every SD data block once CMD59 has turned checking on."""
    crc = 0
    for b in data:
        crc ^= b << 8
        for _ in range(8):
            crc = ((crc << 1) ^ 0x1021) & 0xFFFF if crc & 0x8000 else (crc << 1) & 0xFFFF
    return crc


def scr() -> str:
    """SCR: structure 0, SD_SPEC 2 (SD 2.00), security 3, bus widths 1 and 4
    bit. The ESP-IDF stack reads this for every SD card and bails on any other
    structure; Arduino SD.h never asks for it."""
    return "0235" + "00" * 6


def cmd(index: int, arg: int = 0) -> str:
    """A six-byte command frame: 0b01 + index, the 32-bit argument, CRC7 + stop."""
    frame = bytes([0x40 | index,
                   (arg >> 24) & 0xFF, (arg >> 16) & 0xFF, (arg >> 8) & 0xFF, arg & 0xFF])
    return (frame + bytes([(crc7(frame) << 1) | 1])).hex()


def csd_v1(byte_capacity: int) -> str:
    """CSD structure 1.0. capacity = (C_SIZE + 1) << (C_SIZE_MULT + 2) << READ_BL_LEN;
    with READ_BL_LEN 9 and C_SIZE_MULT 7 that is (C_SIZE + 1) * 256 KiB."""
    csize = max(byte_capacity // (256 * 1024) - 1, 0)
    c = bytearray(16)
    c[0] = 0x00                       # CSD_STRUCTURE = 0
    c[1] = 0x26                       # TAAC 1.5 ms
    c[3] = 0x32                       # TRAN_SPEED 25 MHz
    c[4] = 0x5B                       # CCC 0x5B5 ...
    c[5] = 0x59                       # ... READ_BL_LEN = 9
    c[6] = (csize >> 10) & 0x03
    c[7] = (csize >> 2) & 0xFF
    c[8] = ((csize & 0x03) << 6) | 0x3F   # + VDD_R_CURR_MIN/MAX
    c[9] = 0xFF                       # VDD_W_CURR + C_SIZE_MULT[2:1]
    c[10] = 0xFF                      # C_SIZE_MULT[0] = 7, ERASE_BLK_EN, SECTOR_SIZE
    c[11] = 0x80
    c[12] = 0x0A                      # R2W_FACTOR 2, WRITE_BL_LEN[3:2]
    c[13] = 0x40                      # WRITE_BL_LEN = 9
    c[15] = (crc7(bytes(c[:15])) << 1) | 1
    return bytes(c).hex()


def csd_v2(byte_capacity: int) -> str:
    """CSD structure 2.0. capacity = (C_SIZE + 1) * 512 KiB."""
    csize = max(byte_capacity // (512 * 1024) - 1, 0)
    c = bytearray(16)
    c[0] = 0x40                       # CSD_STRUCTURE = 1
    c[1] = 0x26
    c[3] = 0x32
    c[4] = 0x5B
    c[5] = 0x59
    c[7] = (csize >> 16) & 0x3F
    c[8] = (csize >> 8) & 0xFF
    c[9] = csize & 0xFF
    c[10] = 0x7F
    c[11] = 0x80
    c[12] = 0x0A
    c[13] = 0x40
    c[15] = (crc7(bytes(c[:15])) << 1) | 1
    return bytes(c).hex()


def cid() -> str:
    c = bytearray(b"\x01\x56\x58\x56\x45\x4c\x58\x53\x10\x00\x00\x00\x01\x01\x60")
    c.append((crc7(bytes(c)) << 1) | 1)
    return bytes(c).hex()


def rep(byte: str, times: int) -> dict:
    return {"byte": byte, "times": times}


def sdsc_steps() -> list:
    """The init handshake, the registers, a read, a write, a streamed read and
    the stop, all on a standard-capacity card (byte addressing)."""
    steps = [
        {"why": "chip select asserted: the transaction begins", "cs": "low"},

        {"why": "CMD0 leaves the card idle, and R1 arrives at offset 7 with the "
                "N_CR fill byte in front of it, never on offset 6",
         "mosi": [cmd(0)], "clock": 8,
         "expect": [{"at": 6, "is": "ff"}, {"at": 7, "is": "01"}]},

        {"why": "CMD13 before init: R2's first byte carries the idle bit",
         "mosi": [cmd(13)], "clock": 6,
         "expect": [{"at": 7, "is": "01"}, {"at": 8, "is": "00"}]},

        {"why": "CMD8 answers R7: R1 then the voltage and check pattern echoed back",
         "mosi": [cmd(8, 0x1AA)], "clock": 8,
         "expect": [{"at": 7, "is": "01"}, {"at": 8, "is": "000001aa"}]},

        {"why": "CMD55 announces an application command and stays idle",
         "mosi": [cmd(55)], "clock": 4, "expect": [{"at": 7, "is": "01"}]},

        {"why": "ACMD41 completes initialisation: R1 is 0x00, the card is out of idle",
         "mosi": [cmd(41, 0x40000000)], "clock": 4, "expect": [{"at": 7, "is": "00"}]},

        {"why": "CMD13 after init: the same status, now with the idle bit clear",
         "mosi": [cmd(13)], "clock": 6,
         "expect": [{"at": 7, "is": "00"}, {"at": 8, "is": "00"}]},

        {"why": "CMD58 reports a powered card with CCS clear: arguments are byte offsets",
         "mosi": [cmd(58)], "clock": 6,
         "expect": [{"at": 7, "is": "00"}, {"at": 8, "is": "80"}]},

        {"why": "CMD9 returns the CSD as a data block; structure 1.0 encodes "
                f"the {CARD_BYTES // 1024} KiB the card image holds",
         "mosi": [cmd(9)], "clock": 24,
         "expect": [{"at": 7, "is": "00"}, {"at": 8, "is": "fe"},
                    {"at": 9, "is": csd_v1(CARD_BYTES)}]},

        {"why": "CMD10 returns the CID the same way",
         "mosi": [cmd(10)], "clock": 24,
         "expect": [{"at": 7, "is": "00"}, {"at": 8, "is": "fe"},
                    {"at": 9, "is": cid()}]},

        {"why": "ACMD51 returns the SCR. The ESP-IDF stack reads it for every "
                "card and clocks 0xFF forever when it never comes, which is "
                "why two of the three twins could not mount an IDF app",
         "mosi": [cmd(55)], "clock": 4, "expect": [{"at": 7, "is": "00"}]},
        {"why": "and the SCR block itself",
         "mosi": [cmd(51)], "clock": 16,
         "expect": [{"at": 7, "is": "00"}, {"at": 8, "is": "fe"},
                    {"at": 9, "is": scr()}]},

        {"why": f"CMD17 with a BYTE address reads sector {READ_SECTOR}: start "
                "token, 512 bytes, then the CRC placeholder with CRC off",
         "mosi": [cmd(17, READ_SECTOR * SECTOR)], "clock": 520,
         "expect": [{"at": 7, "is": "00"}, {"at": 8, "is": "fe"},
                    {"at": 9, "is": sector_hex(READ_SECTOR, 0, 16)},
                    {"at": 9 + 496, "is": sector_hex(READ_SECTOR, 496, 16)},
                    {"at": 521, "is": "ffff"}]},

        {"why": f"CMD24 accepts a write to sector {WRITE_SECTOR}", "mosi":
            [cmd(24, WRITE_SECTOR * SECTOR)], "clock": 4,
         "expect": [{"at": 7, "is": "00"}]},

        {"why": "the block that follows is taken and acknowledged with the "
                "data-response token 0x05, and the card is not busy after it",
         "mosi": ["fffe", PAYLOAD.hex(), "ffff"], "clock": 4,
         "expect": [{"at": 516, "is": "05"}, {"at": 517, "is": "ff"}]},

        {"why": "reading that sector back gives what was written, so the write "
                "reached the card's storage and not a queue",
         "mosi": [cmd(17, WRITE_SECTOR * SECTOR)], "clock": 520,
         "expect": [{"at": 7, "is": "00"}, {"at": 8, "is": "fe"},
                    {"at": 9, "is": PAYLOAD[:16].hex()},
                    {"at": 9 + 496, "is": PAYLOAD[496:].hex()}]},

        {"why": "CMD59 turns data-block CRC checking on. The ESP-IDF host "
                "validates it; Arduino SD.h leaves it off, which is why the "
                "placeholder above is two 0xFF bytes",
         "mosi": [cmd(59, 1)], "clock": 4, "expect": [{"at": 7, "is": "00"}]},
        {"why": f"the same sector {READ_SECTOR} now trails a real CRC-16",
         "mosi": [cmd(17, READ_SECTOR * SECTOR)], "clock": 520,
         "expect": [{"at": 8, "is": "fe"},
                    {"at": 9, "is": sector_hex(READ_SECTOR, 0, 8)},
                    {"at": 521, "is": "%04x" % crc16(
                        bytes.fromhex(sector_hex(READ_SECTOR)))}]},
        {"why": "and CMD59 turns it off again, so the rest of the script reads "
                "the placeholder",
         "mosi": [cmd(59, 0)], "clock": 4, "expect": [{"at": 7, "is": "00"}]},

        {"why": "a sector past the end of the image reads as zeros: the card is "
                "exactly as big as the image it was given, and the sectors "
                "beyond it were never written",
         "mosi": [cmd(17, CARD_SECTORS * SECTOR)], "clock": 24,
         "expect": [{"at": 7, "is": "00"}, {"at": 8, "is": "fe"},
                    {"at": 9, "is": "00" * 8}]},

        {"why": "and writing there is refused with the write-error token 0x0d "
                "rather than swallowed: a full card says so, and the blob it "
                "was given cannot grow",
         "mosi": [cmd(24, CARD_SECTORS * SECTOR)], "clock": 4,
         "expect": [{"at": 7, "is": "00"}]},
        {"why": "the block the host sends anyway is not stored",
         "mosi": ["fffe", PAYLOAD.hex(), "ffff"], "clock": 4,
         "expect": [{"at": 516, "is": "0d"}]},

        {"why": "a write data phase SURVIVES chip select. SdFat releases the "
                "select between writeStart, writeData and writeStop and comes "
                "back expecting the card to still be waiting for the block; a "
                "card that forgot would read 512 bytes of user data as commands",
         "mosi": [cmd(24, (WRITE_SECTOR + 1) * SECTOR)], "clock": 4,
         "expect": [{"at": 7, "is": "00"}]},
        {"why": "the host lets go of the bus between the command and the data",
         "cs": "high"},
        {"why": "and comes back", "cs": "low"},
        {"why": "the block is still taken, and acknowledged",
         "mosi": ["fffe", PAYLOAD.hex(), "ffff"], "clock": 4,
         "expect": [{"at": 516, "is": "05"}]},

        {"why": "and so does the APP_CMD flag of a CMD55: it belongs to the "
                "next command, which SdFat clocks after deselecting",
         "mosi": [cmd(55)], "clock": 4, "expect": [{"at": 7, "is": "00"}]},
        {"why": "the host lets go of the bus between CMD55 and its ACMD",
         "cs": "high"},
        {"why": "and comes back", "cs": "low"},
        {"why": "ACMD41 is still read as an application command, not as CMD41",
         "mosi": [cmd(41, 0x40000000)], "clock": 4,
         "expect": [{"at": 7, "is": "00"}]},

        # Where the stop lands. Until 2026-09-24 this step clocked 1040 bytes,
        # which stops 8 bytes INTO the third block, and the next one asked the
        # card to honour CMD12 there. The spec allows that host (SD Physical
        # Layer Simplified 6.00, 4.3.3: "The data transfer stops after the end
        # bit of the stop command", which 7.2.3 applies to SPI mode), but no
        # driver the product runs is one: each reads a block to its last CRC
        # byte and sends CMD12 on the next byte.
        #   ESP-IDF 5.5 sdspi_host.c start_command_read_blocks: the last block
        #     is received with receive_extra_bytes = 2, the CRC only (l. 821),
        #     then STOP_TRANSMISSION (l. 865).
        #   SdFat 2.3.0 SdSpiCard.cpp readData clocks both CRC bytes even with
        #     CRC off (l. 385-393); readStop sends CMD12 between readData calls.
        #   arduino-esp32 3.3.10 sd_diskio.cpp sdReadBytes ends on transfer16
        #     of the CRC (l. 222), then sdReadSectors stops (l. 289).
        #   MicroPython sdcard.py readinto clocks the CRC, then readblocks
        #     sends cmd(12).
        # The mid-block contract is what forced the card to hand a stream out
        # one byte per call (150x the Python card it replaced,
        # project/board-buses-2026-09/evidence/sd-host-cost-*.json), so the
        # table now pins the boundary the drivers use, and the rows after
        # this one prove the stop is still heard there.
        {"why": "CMD18 streams: sector 0 arrives, and the card refills with the "
                "next sector as soon as the first block's CRC has gone out, so "
                "the second start token follows it with no command in between. "
                "The host reads that second block to its CRC and stops there, "
                "as every driver does",
         "mosi": [cmd(18, 0)], "clock": 1032,
         "expect": [{"at": 8, "is": "fe"}, {"at": 9, "is": sector_hex(0, 0, 8)},
                    {"at": 521, "is": "ffff"},
                    {"at": 523, "is": "fe"}, {"at": 524, "is": sector_hex(1, 0, 8)},
                    {"at": 524 + 504, "is": sector_hex(1, 504, 8)},
                    {"at": 1036, "is": "ffff"}]},

        {"why": "CMD12 on the byte after a CRC stops the stream: the block the "
                "card had already queued is flushed, so R1b lands at offset 7 "
                "and no block data trails it",
         "mosi": [cmd(12)], "clock": 8,
         "expect": [{"at": 6, "is": "ff"}, {"at": 7, "is": "00"},
                    {"at": 8, "is": "00"}, {"at": 9, "is": "ff"},
                    {"at": 10, "is": "ff"}]},

        {"why": "the stop holds: after R1b the card is idle, and the 0xFF the "
                "host keeps clocking does not start another block",
         "clock": 520,
         "expect": [{"at": 0, "is": "ff" * 16}, {"at": 504, "is": "ff" * 16}]},

        {"why": f"a stream that is released between blocks resumes at the "
                "next block, not the one after it. MicroPython's sdcard.py "
                "lets go of the card after EVERY block of a CMD18 "
                f"(readinto ends in cs(1)); here sector {READ_SECTOR} is read "
                "to its CRC",
         "mosi": [cmd(18, READ_SECTOR * SECTOR)], "clock": 517,
         "expect": [{"at": 7, "is": "00"}, {"at": 8, "is": "fe"},
                    {"at": 9, "is": sector_hex(READ_SECTOR, 0, 8)},
                    {"at": 521, "is": "ffff"}]},
        {"why": "the host lets go of the bus at the block boundary", "cs": "high"},
        {"why": "and comes back", "cs": "low"},
        {"why": f"the next block is sector {READ_SECTOR + 1}: the one the card "
                "had queued but never clocked out is served, not skipped",
         "clock": 515,
         "expect": [{"at": 0, "is": "fe"},
                    {"at": 1, "is": sector_hex(READ_SECTOR + 1, 0, 16)},
                    {"at": 1 + 496, "is": sector_hex(READ_SECTOR + 1, 496, 16)},
                    {"at": 513, "is": "ffff"}]},
        {"why": "released again, the way readinto ends", "cs": "high"},
        {"why": "and the stop comes on a fresh selection", "cs": "low"},
        {"why": "CMD12 at that boundary is still heard: R1b at offset 7",
         "mosi": [cmd(12)], "clock": 8,
         "expect": [{"at": 6, "is": "ff"}, {"at": 7, "is": "00"},
                    {"at": 8, "is": "00"}, {"at": 9, "is": "ff"}]},

        {"why": "chip select released", "cs": "high"},

        {"why": "a command frame cut in half by chip select is forgotten, so the "
                "bytes of the next transaction are not read as its tail",
         "cs": "low"},
        {"why": "three bytes of a CMD0 and then the host walks away",
         "mosi": [cmd(0)[:6]]},
        {"why": "chip select released mid-command", "cs": "high"},
        {"why": "and again", "cs": "low"},
        {"why": "a whole CMD0 is understood on its own terms: had the card kept "
                "the three orphan bytes, this frame would end three bytes early",
         "mosi": [cmd(0)], "clock": 8,
         "expect": [{"at": 6, "is": "ff"}, {"at": 7, "is": "01"}]},
        {"why": "chip select released", "cs": "high"},
    ]
    return steps


def sdhc_steps() -> list:
    return [
        {"why": "chip select asserted", "cs": "low"},
        {"why": "CMD0 answers as it always does", "mosi": [cmd(0)], "clock": 8,
         "expect": [{"at": 7, "is": "01"}]},
        {"why": "CMD58 sets CCS on a high-capacity card: arguments are block indices",
         "mosi": [cmd(58)], "clock": 6,
         "expect": [{"at": 7, "is": "01"}, {"at": 8, "is": "c0"}]},
        {"why": "CMD9 returns a structure 2.0 CSD, which is the only one that can "
                "describe a high-capacity card",
         "mosi": [cmd(9)], "clock": 24,
         "expect": [{"at": 8, "is": "fe"}, {"at": 9, "is": csd_v2(CARD_BYTES)}]},
        {"why": f"CMD17 with the BLOCK INDEX {READ_SECTOR} reads that sector; the "
                "same argument on a standard card would read sector 0",
         "mosi": [cmd(17, READ_SECTOR)], "clock": 520,
         "expect": [{"at": 8, "is": "fe"}, {"at": 9, "is": sector_hex(READ_SECTOR, 0, 16)}]},
        {"why": "chip select released", "cs": "high"},
    ]


def empty_steps() -> list:
    return [
        {"why": "chip select asserted on a slot the host gave no card image",
         "cs": "low"},
        {"why": "an empty slot drives nothing: the master reads the line's idle "
                "level for the command and for every byte after it",
         "mosi": [cmd(0)], "clock": 8,
         "expect": [{"at": 6, "is": "ff"}, {"at": 7, "is": "ff"},
                    {"at": 8, "is": "ff"}]},
        {"why": "chip select released", "cs": "high"},
    ]


def main() -> None:
    doc = {
        "why": "One table, every host that runs the portable microSD model: the "
               "browser runtime, the QEMU worker runtime and the Linux-board "
               "host. Offsets are counted from the first byte of each step's "
               "own exchange. Bytes not named are not checked.",
        "card": {
            "blob": "card",
            "sectors": CARD_SECTORS,
            "rule": "byte(sector, offset) = (sector * 37 + offset) & 255",
        },
        "scripts": {
            "sdsc": {
                "why": "A standard-capacity card: byte addressing, CSD v1.",
                "attrs": {},
                "steps": sdsc_steps(),
                "after": {
                    "writes": [{"offset": WRITE_SECTOR * SECTOR, "hex": PAYLOAD.hex()},
                               {"offset": (WRITE_SECTOR + 1) * SECTOR, "hex": PAYLOAD.hex()}],
                    "dirty": {"card": [WRITE_SECTOR * SECTOR,
                                       (WRITE_SECTOR + 2) * SECTOR]},
                },
            },
            "sdhc": {
                "why": "The same card forced high capacity: block addressing, "
                       "CCS set, CSD v2. The attribute exists so this half of "
                       "the model can be exercised without a 2 GB image.",
                "attrs": {"sdhc": 1},
                "steps": sdhc_steps(),
                "after": {"writes": [], "dirty": {}},
            },
            "empty": {
                "why": "No blob at all: an empty slot, which drives nothing.",
                "attrs": {},
                "noCard": True,
                "steps": empty_steps(),
                "after": {"writes": [], "dirty": {}},
            },
        },
    }
    out = pathlib.Path(__file__).with_name("sd-script.json")
    out.write_text(json.dumps(doc, indent=2) + "\n")
    print(f"wrote {out} ({out.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
