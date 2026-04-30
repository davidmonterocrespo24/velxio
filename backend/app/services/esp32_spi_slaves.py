"""ESP32 SPI slave state machines — runs inside the worker subprocess
synchronously, alongside the existing I2C slaves in
``esp32_i2c_slaves.py``.

Currently houses two ePaper decoders:

* :class:`Ssd168xEpaperSlave` — Solomon Systech SSD168x family
  (mono + B/W/Red panels, 1.54"–7.5"). Latches on opcode 0x20.
* :class:`Uc8159cEpaperSlave` — UltraChip UC8159c (ACeP 7-colour 5.65"
  GoodDisplay GDEP0565D90 / Waveshare). Latches on opcode 0x12.

Both classes have the same surface (``feed(byte, dc_high)``, ``reset()``,
``on_flush`` callback) so the worker dispatch in
``esp32_worker.py::_on_spi_event`` can route bytes by ``cs_low`` without
caring which controller is mounted.
"""
from __future__ import annotations

import base64
from dataclasses import dataclass, field
from typing import Callable, List, Optional


# ── Command opcodes (SSD1681; SSD1675/1680/1683 share these) ─────────────────

CMD_DRIVER_OUTPUT_CTRL = 0x01
CMD_GATE_DRIVING_VOLTAGE = 0x03
CMD_SOURCE_DRIVING_VOLT = 0x04
CMD_DEEP_SLEEP = 0x10
CMD_DATA_ENTRY_MODE = 0x11
CMD_SW_RESET = 0x12
CMD_TEMP_SENSOR = 0x18
CMD_MASTER_ACTIVATION = 0x20
CMD_DISP_UPDATE_CTRL_1 = 0x21
CMD_DISP_UPDATE_CTRL_2 = 0x22
CMD_WRITE_BLACK_VRAM = 0x24
CMD_WRITE_RED_VRAM = 0x26
CMD_WRITE_VCOM_REG = 0x2C
CMD_WRITE_LUT = 0x32
CMD_BORDER_WAVEFORM = 0x3C
CMD_END_OPTION = 0x3F
CMD_SET_RAMX_RANGE = 0x44
CMD_SET_RAMY_RANGE = 0x45
CMD_SET_RAMX_COUNTER = 0x4E
CMD_SET_RAMY_COUNTER = 0x4F


@dataclass
class Frame:
    """Composed B/W (and optionally red) frame ready to ship to the frontend."""
    width: int
    height: int
    pixels: bytes  # length == width * height; values 0=black, 1=white, 2=red


@dataclass
class Ssd168xEpaperSlave:
    """Stateful SSD168x SPI peripheral. Algorithm verbatim with the Python
    reference in ``test/test_epaper/ssd168x_decoder.py``."""

    component_id: str
    width: int
    height: int
    on_flush: Optional[Callable[[Frame], None]] = None

    bw_ram: bytearray = field(init=False)
    red_ram: bytearray = field(init=False)
    _current_cmd: int = -1
    _params: List[int] = field(default_factory=list)
    _ram_target: str = "bw"
    _x_byte: int = 0
    _y: int = 0
    _xrange: tuple = (0, 0)
    _yrange: tuple = (0, 0)
    _entry_mode: int = 0x03
    refreshed_count: int = 0
    unknown_cmds: List[int] = field(default_factory=list)
    in_deep_sleep: bool = False

    def __post_init__(self) -> None:
        bytes_per_row = (self.width + 7) // 8
        self.bw_ram = bytearray([0xFF] * (bytes_per_row * self.height))
        self.red_ram = bytearray([0x00] * (bytes_per_row * self.height))
        self._xrange = (0, bytes_per_row - 1)
        self._yrange = (0, self.height - 1)

    # ── Public API ─────────────────────────────────────────────────────

    def feed(self, byte: int, dc_high: bool) -> None:
        """Process one SPI byte. ``dc_high`` mirrors the DC pin (False = command)."""
        if not dc_high:
            self._begin_command(byte & 0xFF)
        else:
            self._handle_data(byte & 0xFF)

    def reset(self) -> None:
        bytes_per_row = (self.width + 7) // 8
        self.bw_ram = bytearray([0xFF] * (bytes_per_row * self.height))
        self.red_ram = bytearray([0x00] * (bytes_per_row * self.height))
        self._current_cmd = -1
        self._params = []
        self._ram_target = "bw"
        self._x_byte = 0
        self._y = 0
        self.in_deep_sleep = False

    def compose_frame(self) -> Frame:
        bytes_per_row = (self.width + 7) // 8
        pixels = bytearray(self.width * self.height)
        for y in range(self.height):
            for xb in range(bytes_per_row):
                b_byte = self.bw_ram[y * bytes_per_row + xb]
                r_byte = self.red_ram[y * bytes_per_row + xb]
                for bit in range(8):
                    x = xb * 8 + bit
                    if x >= self.width:
                        break
                    mask = 0x80 >> bit
                    is_red = bool(r_byte & mask)
                    is_white = bool(b_byte & mask)
                    pixels[y * self.width + x] = 2 if is_red else (1 if is_white else 0)
        return Frame(self.width, self.height, bytes(pixels))

    def compose_frame_b64(self) -> str:
        """Convenience for the worker — same as compose_frame() but base64-encoded."""
        return base64.b64encode(self.compose_frame().pixels).decode("ascii")

    # ── Internal: command / data dispatch ──────────────────────────────

    def _begin_command(self, cmd: int) -> None:
        self._current_cmd = cmd
        self._params = []

        if cmd == CMD_SW_RESET:
            self.reset()
            return
        if cmd == CMD_MASTER_ACTIVATION:
            self.refreshed_count += 1
            frame = self.compose_frame()
            if self.on_flush:
                try:
                    self.on_flush(frame)
                except Exception:
                    # Never let the frontend hook raise back into QEMU thread.
                    pass
            return
        if cmd == CMD_WRITE_BLACK_VRAM:
            self._ram_target = "bw"
            return
        if cmd == CMD_WRITE_RED_VRAM:
            self._ram_target = "red"
            return
        if cmd in (
            CMD_DRIVER_OUTPUT_CTRL, CMD_GATE_DRIVING_VOLTAGE,
            CMD_SOURCE_DRIVING_VOLT, CMD_DEEP_SLEEP, CMD_DATA_ENTRY_MODE,
            CMD_TEMP_SENSOR, CMD_DISP_UPDATE_CTRL_1, CMD_DISP_UPDATE_CTRL_2,
            CMD_WRITE_VCOM_REG, CMD_WRITE_LUT, CMD_BORDER_WAVEFORM,
            CMD_END_OPTION, CMD_SET_RAMX_RANGE, CMD_SET_RAMY_RANGE,
            CMD_SET_RAMX_COUNTER, CMD_SET_RAMY_COUNTER,
        ):
            return
        self.unknown_cmds.append(cmd)

    def _handle_data(self, byte: int) -> None:
        cmd = self._current_cmd
        params = self._params
        params.append(byte)

        if cmd == CMD_DEEP_SLEEP and len(params) == 1:
            self.in_deep_sleep = byte != 0
        elif cmd == CMD_DATA_ENTRY_MODE and len(params) == 1:
            self._entry_mode = byte
        elif cmd == CMD_SET_RAMX_RANGE and len(params) == 2:
            self._xrange = (params[0], params[1])
            self._x_byte = params[0]
        elif cmd == CMD_SET_RAMY_RANGE and len(params) == 4:
            self._yrange = (params[0] | (params[1] << 8),
                            params[2] | (params[3] << 8))
            self._y = self._yrange[0]
        elif cmd == CMD_SET_RAMX_COUNTER and len(params) == 1:
            self._x_byte = byte
        elif cmd == CMD_SET_RAMY_COUNTER and len(params) == 2:
            self._y = params[0] | (params[1] << 8)
        elif cmd == CMD_WRITE_BLACK_VRAM:
            self._write_ram_byte(self.bw_ram, byte)
        elif cmd == CMD_WRITE_RED_VRAM:
            self._write_ram_byte(self.red_ram, byte)

    def _write_ram_byte(self, plane: bytearray, byte: int) -> None:
        bytes_per_row = (self.width + 7) // 8
        if 0 <= self._x_byte < bytes_per_row and 0 <= self._y < self.height:
            plane[self._y * bytes_per_row + self._x_byte] = byte
        x_inc = (self._entry_mode & 0x01) == 0x01
        if x_inc:
            if self._x_byte < self._xrange[1]:
                self._x_byte += 1
            else:
                self._x_byte = self._xrange[0]
                self._y += 1
        else:
            if self._x_byte > self._xrange[0]:
                self._x_byte -= 1
            else:
                self._x_byte = self._xrange[1]
                self._y += 1


# ── UC8159c (ACeP 7-colour 5.65" GoodDisplay GDEP0565D90) ───────────────────
#
# Different command set from SSD168x. Pixel packing: 2 px per byte, upper
# nibble = first pixel, each nibble's lower 3 bits = palette index 0..6.

UC_CMD_PANEL_SETTING = 0x00
UC_CMD_POWER_SETTING = 0x01
UC_CMD_POWER_OFF = 0x02
UC_CMD_POWER_OFF_SEQ = 0x03
UC_CMD_POWER_ON = 0x04
UC_CMD_BOOSTER_SOFT_START = 0x06
UC_CMD_DEEP_SLEEP = 0x07
UC_CMD_DTM1 = 0x10
UC_CMD_DISPLAY_REFRESH = 0x12
UC_CMD_PLL_CONTROL = 0x30
UC_CMD_TSE = 0x41
UC_CMD_VCOM_DATA_INTERVAL = 0x50
UC_CMD_TCON_SETTING = 0x60
UC_CMD_RESOLUTION_SETTING = 0x61
UC_CMD_PWS = 0xE3


@dataclass
class Uc8159cEpaperSlave:
    """ACeP 7-colour decoder. Latches on 0x12 DRF and emits a Frame whose
    `pixels` are 1 byte/pixel palette indices (0=black .. 6=orange). The
    worker maps those indices to RGB on the frontend side."""

    component_id: str
    width: int
    height: int
    on_flush: Optional[Callable[[Frame], None]] = None

    ram: bytearray = field(init=False)
    _write_idx: int = 0
    _current_cmd: int = -1
    _params: List[int] = field(default_factory=list)
    refreshed_count: int = 0
    unknown_cmds: List[int] = field(default_factory=list)
    in_deep_sleep: bool = False
    powered_on: bool = False

    def __post_init__(self) -> None:
        # Default to all-white (index 1) so a freshly-mounted panel doesn't
        # render as transparent.
        self.ram = bytearray([1] * (self.width * self.height))

    # ── Public API ─────────────────────────────────────────────────────

    def feed(self, byte: int, dc_high: bool) -> None:
        if not dc_high:
            self._begin_command(byte & 0xFF)
        else:
            self._handle_data(byte & 0xFF)

    def reset(self) -> None:
        self.ram = bytearray([1] * (self.width * self.height))
        self._write_idx = 0
        self._current_cmd = -1
        self._params = []
        self.refreshed_count = 0
        self.powered_on = False
        self.in_deep_sleep = False

    def compose_frame(self) -> Frame:
        return Frame(self.width, self.height, bytes(self.ram))

    def compose_frame_b64(self) -> str:
        return base64.b64encode(bytes(self.ram)).decode("ascii")

    # ── Internal: command / data dispatch ──────────────────────────────

    def _begin_command(self, cmd: int) -> None:
        self._current_cmd = cmd
        self._params = []

        if cmd == UC_CMD_POWER_ON:
            self.powered_on = True
            return
        if cmd == UC_CMD_POWER_OFF:
            self.powered_on = False
            return
        if cmd == UC_CMD_DTM1:
            self._write_idx = 0
            return
        if cmd == UC_CMD_DISPLAY_REFRESH:
            self.refreshed_count += 1
            frame = self.compose_frame()
            if self.on_flush:
                try:
                    self.on_flush(frame)
                except Exception:
                    pass
            return
        if cmd == UC_CMD_DEEP_SLEEP:
            return
        if cmd in (
            UC_CMD_PANEL_SETTING, UC_CMD_POWER_SETTING, UC_CMD_POWER_OFF_SEQ,
            UC_CMD_BOOSTER_SOFT_START, UC_CMD_PLL_CONTROL, UC_CMD_TSE,
            UC_CMD_VCOM_DATA_INTERVAL, UC_CMD_TCON_SETTING,
            UC_CMD_RESOLUTION_SETTING, UC_CMD_PWS,
        ):
            return
        self.unknown_cmds.append(cmd)

    def _handle_data(self, byte: int) -> None:
        cmd = self._current_cmd
        self._params.append(byte)

        if cmd == UC_CMD_DEEP_SLEEP:
            if byte == 0xA5:
                self.in_deep_sleep = True
            return

        if cmd == UC_CMD_DTM1:
            total = self.width * self.height
            if self._write_idx < total:
                self.ram[self._write_idx] = (byte >> 4) & 0x07
                self._write_idx += 1
            if self._write_idx < total:
                self.ram[self._write_idx] = byte & 0x07
                self._write_idx += 1
