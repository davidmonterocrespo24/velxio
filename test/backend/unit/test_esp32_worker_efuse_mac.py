"""
test_esp32_worker_efuse_mac.py: the classic ESP32 has the same factory MAC on
the QEMU engine as on the in-browser one (velxio/velxio-prod#187).

The in-browser engine (esp32js, src/memory-map.ts) seeds EFUSE_BLK0_RDATA1 =
0xc4000110 and RDATA2 = 0x00b9240a: 24:0a:c4:00:01:10, an Espressif OUI, with
its CRC 0xb9. The QEMU fork, given no eFuse drive, fills BLK0 words 1 and 2
with 0x00c40a24 / 0x00fe1001 (hw/nvram/esp32_efuse.c), which ESP-IDF reads as
10:01:00:c4:0a:24 (MAC[0..5] at BLK0 bits 72, 64, 56, 48, 40, 32, the CRC at
bit 80: components/efuse/esp32/esp_efuse_table.csv), the same bytes in the
other order. So one sketch printed a different MAC, and built different
MAC-derived topics and client IDs, on each engine.

The worker now hands the classic machine an eFuse image (the fork's
`nvram.esp32.efuse` device takes a `drive`) that carries the in-browser
engine's MAC. QEMU itself is unchanged.
"""
from __future__ import annotations

import struct
from pathlib import Path

import pytest

from app.services.esp32_worker import (
    ESP32_FACTORY_MAC,
    efuse_drive_args,
    esp32_efuse_image,
    esp32_mac_crc8,
)

FORK_DEFAULT_MAC = bytes([0x10, 0x01, 0x00, 0xC4, 0x0A, 0x24])


def mac_of(image: bytes) -> tuple[bytes, int]:
    """MAC[0..5] and its CRC, read from BLK0 the way ESP-IDF's table reads them."""
    blk0 = int.from_bytes(image[:28], 'little')
    mac = bytes((blk0 >> bit) & 0xFF for bit in (72, 64, 56, 48, 40, 32))
    return mac, (blk0 >> 80) & 0xFF


def test_the_crc_is_the_roms() -> None:
    # esp_rom_efuse_mac_address_crc8: CRC-8, polynomial 0x8C reflected, init 0.
    # The fork's default pair is one ESP-IDF accepts (QEMU boots with it), and
    # the in-browser engine's RDATA2 carries 0xb9 for its MAC.
    assert esp32_mac_crc8(FORK_DEFAULT_MAC) == 0xFE
    assert esp32_mac_crc8(bytes([0x24, 0x0A, 0xC4, 0x00, 0x01, 0x10])) == 0xB9


def test_the_image_carries_the_in_browser_engines_mac() -> None:
    image = esp32_efuse_image()
    # Esp32EfuseRegs: BLK0 (7 words) and BLK1-3 (8 words each), what the
    # fork's eFuse device reads from its drive.
    assert len(image) == (7 + 8 * 3) * 4
    words = struct.unpack('<31I', image)
    assert words[1] == 0xC4000110
    assert words[2] == 0x00B9240A
    assert all(w == 0 for i, w in enumerate(words) if i not in (1, 2))
    mac, crc = mac_of(image)
    assert mac == ESP32_FACTORY_MAC == bytes([0x24, 0x0A, 0xC4, 0x00, 0x01, 0x10])
    assert crc == esp32_mac_crc8(mac)


def test_only_the_classic_machine_gets_the_drive(tmp_path: Path) -> None:
    f = tmp_path / 'efuse.bin'
    args = efuse_drive_args('esp32-picsimlab', str(f))
    assert args == [
        b'-drive', f'file={f},if=none,format=raw,id=efuse'.encode(),
        b'-global', b'driver=nvram.esp32.efuse,property=drive,value=efuse',
    ]
    # The S3 and C3 machines have eFuse devices of their own, with their own
    # layouts; they are not the classic ESP32's.
    assert efuse_drive_args('esp32s3-picsimlab', str(f)) == []
    assert efuse_drive_args('esp32c3-picsimlab', str(f)) == []


def test_the_worker_starts_qemu_with_that_image(tmp_path: Path) -> None:
    pytest.importorskip('wasmtime', reason='the worker rig needs wasmtime')
    from .test_board_buses_repro_worker import Worker

    w = Worker(tmp_path)
    try:
        w.boot()
        argv = w.guest('argv')['argv']
        drive = next(a for a in argv if a.endswith(',if=none,format=raw,id=efuse'))
        path = Path(drive[len('file='):].split(',')[0])
        assert argv[argv.index(drive) - 1] == '-drive'
        assert 'driver=nvram.esp32.efuse,property=drive,value=efuse' in argv
        assert path.read_bytes() == esp32_efuse_image()
    finally:
        w.close()
