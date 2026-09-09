"""WASM Chip Runtime — Python port of frontend/src/simulation/customChips/ChipRuntime.ts.

Loads a Velxio Custom Chip (.wasm compiled from C against velxio-chip.h) and
runs it inside the same process as the QEMU worker, so I2C events the firmware
generates are answered SYNCHRONOUSLY by the chip — no WebSocket round-trip,
no race condition.

Architecture rationale: see docs/wiki/esp32-i2c-slave-simulation.md. The
existing Python slaves (MPU6050Slave, BMP280Slave, …) are hardcoded; this
runtime delegates the slave logic to a user-provided WASM, making the system
generic for any chip the user writes.

Scope of this MVP:
- Pin register/read/write (digital)
- Attributes (vx_attr_register / vx_attr_read)
- I2C slave (vx_i2c_attach + 4 callbacks)
- vx_log + printf via WASI fd_write
- vx_sim_now_nanos (returns wall-clock for now)

Out of scope (raise NotImplementedError):
- SPI, UART, Timers (need additional QEMU integration)
- Pin watch (firmware-driven, not yet wired through the QEMU thread)
- Framebuffer
"""
from __future__ import annotations

import heapq
import struct
import threading
import time
from typing import Callable, Optional

import wasmtime

# The UART a chip talks on. UART0 is the serial monitor on every ESP32
# family, so a chip there collides with the console in both directions.
CHIP_UART = 1



# I2C config struct layout (must match velxio-chip.h's vx_i2c_config — 64 bytes)
#   offset 0  : address      (uint8_t  + 3 bytes pad)
#   offset 4  : scl          (int32_t)
#   offset 8  : sda          (int32_t)
#   offset 12 : on_connect   (function index)
#   offset 16 : on_read      (function index)
#   offset 20 : on_write     (function index)
#   offset 24 : on_stop      (function index)
#   offset 28 : user_data    (uint32_t)
#   offset 32 : reserved[8]  (32 bytes — ignored)
_I2C_CONFIG_FMT = "<B3xIIIIIII"   # 32 bytes (we ignore reserved trailer)

# UART config struct layout (must match vx_uart_config — 56 bytes total)
#   offset 0  : rx           (int32_t)
#   offset 4  : tx           (int32_t)
#   offset 8  : baud_rate    (uint32_t)
#   offset 12 : on_rx_byte   (function index)
#   offset 16 : on_tx_done   (function index)
#   offset 20 : user_data    (uint32_t)
#   offset 24 : reserved[8]  (32 bytes — ignored)
_UART_CONFIG_FMT = "<IIIIII"      # 24 bytes (ignore reserved trailer)

# SPI config struct layout (must match vx_spi_config — 60 bytes total)
#   offset 0  : sck          (int32_t)
#   offset 4  : mosi         (int32_t)
#   offset 8  : miso         (int32_t)
#   offset 12 : cs           (int32_t)
#   offset 16 : mode         (uint32_t)
#   offset 20 : on_done      (function index)
#   offset 24 : user_data    (uint32_t)
#   offset 28 : reserved[8]  (32 bytes — ignored)
_SPI_CONFIG_FMT = "<IIIIIII"      # 28 bytes (ignore reserved trailer)


class WasmChipRuntime:
    """Wraps a single chip WASM instance.

    Lifecycle:
        runtime = WasmChipRuntime(wasm_bytes, attrs, emit)
        runtime.run_chip_setup()
        # if the chip called vx_i2c_attach, runtime.i2c_address is set
        # → wrap it in WasmChipI2CSlave and register in _i2c_slaves
    """

    # Pin mode constants (mirror velxio-chip.h)
    MODE_OUTPUT_LOW = 16
    MODE_OUTPUT_HIGH = 17

    def __init__(
        self,
        wasm_bytes: bytes,
        attrs: dict[str, float] | None = None,
        emit: Callable[[dict], None] | None = None,
        pin_map: dict[str, int] | None = None,
        pin_writer: Optional[Callable[[int, int], None]] = None,
        pin_reader: Optional[Callable[[int], int]] = None,
        uart_writer: Optional[Callable[[int, bytes], None]] = None,
        timer_scheduler: Optional[Callable[["WasmChipRuntime"], None]] = None,
    ):
        """
        Args:
            wasm_bytes: the compiled chip WASM
            attrs:      user-editable attribute values from chip.json
            emit:       telemetry callback (receives chip_log / chip_warning dicts)
            pin_map:    {chip_pin_name: real_gpio_number} — resolved by frontend from wires
            pin_writer: (gpio, value) → void — drives a real GPIO pin in QEMU.
                        Called by vx_pin_write when the chip's pin is mapped.
            pin_reader: (gpio) → 0/1 — reads current GPIO state from QEMU. If absent,
                        vx_pin_read returns the runtime's last-known cached value.
            uart_writer: (uart_id, bytes) → void — injects bytes into the firmware's
                         UART RX. Called by vx_uart_write, always with CHIP_UART.
            timer_scheduler: callback invoked when the chip arms a timer; the worker
                             starts the actual scheduling thread.
        """
        self._engine = wasmtime.Engine()
        self._store = wasmtime.Store(self._engine)
        self._module = wasmtime.Module(self._engine, wasm_bytes)

        # Provide the linear memory (the WASM is compiled with --import-memory)
        self._memory = wasmtime.Memory(
            self._store, wasmtime.MemoryType(wasmtime.Limits(2, 16))
        )

        self._attrs = {k: v for k, v in (attrs or {}).items()
                       if isinstance(v, (int, float))}
        # String attribute values (vx_attr_register_string) ride the same
        # attrs payload; split by type.
        self._str_attrs = {k: v for k, v in (attrs or {}).items()
                           if isinstance(v, str)}
        self._emit = emit or (lambda _payload: None)
        self._stdout_buf = ""

        # External plumbing
        self._pin_map = dict(pin_map or {})       # logical name → real GPIO
        self._pin_writer = pin_writer
        self._pin_reader = pin_reader
        self._uart_writer = uart_writer
        self._timer_scheduler = timer_scheduler

        # Per-instance state
        self._pins: list[dict] = []           # [{name, mode, value, gpio}]
        self._attr_handles: list[dict] = []   # [{name, default}]

        # I2C state populated by vx_i2c_attach
        self.i2c_address: int | None = None
        self.i2c_callbacks: dict | None = None    # {on_connect, on_read, on_write, on_stop, user_data}

        # UART state — at most one UART per chip in MVP
        self.uart_config: dict | None = None      # {rx, tx, baud_rate, on_rx_byte, on_tx_done, user_data}

        # SPI state
        self.spi_config: dict | None = None       # {sck, mosi, miso, cs, mode, on_done, user_data}
        self._spi_buffer_ptr: int = 0             # WASM ptr to current MISO buffer
        self._spi_buffer_count: int = 0
        self._spi_buffer_pos: int = 0

        # Timer state — list of active timers
        # each: {cb_idx, user_data, period_ns, repeat, next_fire_ns, active}
        self._timers: list[dict] = []
        self._timer_lock = threading.Lock()

        # Pin watches indexed by REAL gpio number (not chip handle), so the
        # worker can dispatch on _on_pin_change(gpio) without iterating chips.
        # Each entry: {handle, edge (1=R,2=F,3=BOTH), cb_idx, user_data, last_value}
        self._pin_watches: dict[int, list[dict]] = {}

        # Timestamp anchor for sim_now_nanos
        self._t0 = time.monotonic_ns()

        # Build the linker
        linker = wasmtime.Linker(self._engine)
        self._define_wasi(linker)
        self._define_velxio(linker)
        linker.define(self._store, "env", "memory", self._memory)

        self._instance = linker.instantiate(self._store, self._module)
        self._exports = self._instance.exports(self._store)

    # ── Lifecycle ─────────────────────────────────────────────────────────────

    def run_chip_setup(self) -> None:
        """Invoke the chip's chip_setup export. Populates pins, attrs, I2C state."""
        chip_setup = self._exports["chip_setup"]
        if chip_setup is None:
            raise RuntimeError("chip WASM does not export chip_setup")
        chip_setup(self._store)
        self._flush_stdout()

    # ── Memory & helpers ──────────────────────────────────────────────────────

    def _read_bytes(self, ptr: int, length: int) -> bytes:
        return bytes(self._memory.read(self._store, ptr, ptr + length))

    def _write_bytes(self, ptr: int, data: bytes) -> None:
        self._memory.write(self._store, data, ptr)

    def _read_cstring(self, ptr: int) -> str:
        if ptr == 0:
            return ""
        # Read a chunk and find the NUL.
        u8 = self._memory.read(self._store, ptr, ptr + 256)
        try:
            end = u8.index(0)
        except ValueError:
            end = len(u8)
        return bytes(u8[:end]).decode("utf-8", errors="replace")

    def _read_i2c_config(self, ptr: int) -> dict:
        raw = self._read_bytes(ptr, struct.calcsize(_I2C_CONFIG_FMT))
        addr, scl, sda, on_connect, on_read, on_write, on_stop, user_data = struct.unpack(
            _I2C_CONFIG_FMT, raw
        )
        return {
            "address": addr,
            "scl": scl,
            "sda": sda,
            "on_connect": on_connect,
            "on_read": on_read,
            "on_write": on_write,
            "on_stop": on_stop,
            "user_data": user_data,
        }

    def _read_uart_config(self, ptr: int) -> dict:
        raw = self._read_bytes(ptr, struct.calcsize(_UART_CONFIG_FMT))
        rx, tx, baud, on_rx, on_tx_done, user_data = struct.unpack(_UART_CONFIG_FMT, raw)
        return {
            "rx": rx, "tx": tx, "baud_rate": baud,
            "on_rx_byte": on_rx, "on_tx_done": on_tx_done, "user_data": user_data,
        }

    def _read_spi_config(self, ptr: int) -> dict:
        raw = self._read_bytes(ptr, struct.calcsize(_SPI_CONFIG_FMT))
        sck, mosi, miso, cs, mode, on_done, user_data = struct.unpack(_SPI_CONFIG_FMT, raw)
        return {
            "sck": sck, "mosi": mosi, "miso": miso, "cs": cs, "mode": mode,
            "on_done": on_done, "user_data": user_data,
        }

    def _call_indirect(self, idx: int, *args: int) -> int:
        """Invoke a function from __indirect_function_table by index. Returns 0 if idx==0 or no result."""
        if idx == 0:
            return 0
        table = self._exports.get("__indirect_function_table")
        if table is None:
            return 0
        try:
            fn = table.get(self._store, idx)
            if fn is None:
                return 0
            result = fn(self._store, *args)
            if isinstance(result, (list, tuple)):
                result = result[0] if result else 0
            return int(result or 0)
        except Exception as e:
            self._emit({"type": "chip_error", "where": "indirect_call", "idx": idx, "error": str(e)})
            return 0

    # ── WASI shim ─────────────────────────────────────────────────────────────

    def _define_wasi(self, linker: wasmtime.Linker) -> None:
        i32 = wasmtime.ValType.i32()
        i64 = wasmtime.ValType.i64()

        def fd_write(fd, iovs_ptr, iovs_len, nwritten_ptr):
            mem = self._memory
            total = 0
            chunks = []
            for i in range(iovs_len):
                hdr = bytes(mem.read(self._store, iovs_ptr + i * 8, iovs_ptr + i * 8 + 8))
                buf, length = struct.unpack("<II", hdr)
                if length:
                    chunks.append(bytes(mem.read(self._store, buf, buf + length)))
                total += length
            mem.write(self._store, struct.pack("<I", total), nwritten_ptr)
            if fd in (1, 2) and chunks:
                text = b"".join(chunks).decode("utf-8", errors="replace")
                self._stdout_buf += text
                self._flush_stdout()
            return 0

        def proc_exit(_code):
            raise wasmtime.Trap(f"chip called proc_exit({_code})")

        def clock_time_get(_id, _precision, time_ptr):
            ns = self.sim_now_nanos()
            self._memory.write(self._store, struct.pack("<Q", ns), time_ptr)
            return 0

        def environ_sizes_get(c_ptr, s_ptr):
            self._memory.write(self._store, struct.pack("<II", 0, 0), c_ptr)
            return 0

        def environ_get(_argv, _buf):
            return 0

        def args_sizes_get(c_ptr, s_ptr):
            self._memory.write(self._store, struct.pack("<II", 0, 0), c_ptr)
            return 0

        def args_get(_argv, _buf):
            return 0

        def random_get(ptr, length):
            # Deterministic-ish noise; chips shouldn't depend on this anyway.
            self._memory.write(self._store, bytes((i * 1103515245 + 12345) & 0xFF for i in range(length)), ptr)
            return 0

        def fd_close(_fd):
            return 0

        def fd_seek(*_args):
            return 28  # ENOSYS

        def fd_read(*_args):
            return 28

        def fd_fdstat_get(*_args):
            return 0

        def fd_prestat_get(*_args):
            return 8  # EBADF

        def fd_prestat_dir_name(*_args):
            return 28

        # Type signatures
        sig_i_iiii = wasmtime.FuncType([i32, i32, i32, i32], [i32])
        sig_i_i = wasmtime.FuncType([i32], [i32])
        sig_i_ii = wasmtime.FuncType([i32, i32], [i32])
        sig_v_i = wasmtime.FuncType([i32], [])
        sig_clock = wasmtime.FuncType([i32, i64, i32], [i32])
        sig_v = wasmtime.FuncType([], [])

        for ns in ("wasi_snapshot_preview1", "wasi_unstable"):
            linker.define_func(ns, "fd_write",            sig_i_iiii, fd_write)
            linker.define_func(ns, "proc_exit",           sig_v_i,    proc_exit)
            linker.define_func(ns, "clock_time_get",      sig_clock,  clock_time_get)
            linker.define_func(ns, "environ_sizes_get",   sig_i_ii,   environ_sizes_get)
            linker.define_func(ns, "environ_get",         sig_i_ii,   environ_get)
            linker.define_func(ns, "args_sizes_get",      sig_i_ii,   args_sizes_get)
            linker.define_func(ns, "args_get",            sig_i_ii,   args_get)
            linker.define_func(ns, "random_get",          sig_i_ii,   random_get)
            linker.define_func(ns, "fd_close",            sig_i_i,    fd_close)
            linker.define_func(ns, "fd_seek",             wasmtime.FuncType([i32, i64, i32, i32], [i32]), fd_seek)
            linker.define_func(ns, "fd_read",             sig_i_iiii, fd_read)
            linker.define_func(ns, "fd_fdstat_get",       sig_i_ii,   fd_fdstat_get)
            linker.define_func(ns, "fd_prestat_get",      sig_i_ii,   fd_prestat_get)
            linker.define_func(ns, "fd_prestat_dir_name", sig_i_iiii, fd_prestat_dir_name)

    # ── Velxio host imports ──────────────────────────────────────────────────

    def _define_velxio(self, linker: wasmtime.Linker) -> None:
        i32 = wasmtime.ValType.i32()
        i64 = wasmtime.ValType.i64()
        f64 = wasmtime.ValType.f64()

        # ── Pins ──
        # When the chip registers a pin name that exists in the diagram's
        # wiring map, we cache the resolved GPIO so vx_pin_read/write can
        # talk to the real QEMU side.
        def vx_pin_register(name_ptr: int, mode: int) -> int:
            name = self._read_cstring(name_ptr)
            handle = len(self._pins)
            initial = 1 if mode == self.MODE_OUTPUT_HIGH else 0
            gpio = self._pin_map.get(name)
            self._pins.append({"name": name, "mode": mode, "value": initial, "gpio": gpio})
            # Drive the initial level into QEMU if this is an OUTPUT_LOW/HIGH pin
            # AND we have a real GPIO for it.
            if gpio is not None and self._pin_writer and mode in (self.MODE_OUTPUT_LOW, self.MODE_OUTPUT_HIGH):
                try:
                    self._pin_writer(gpio, initial)
                except Exception as e:
                    self._emit({"type": "chip_error", "where": "pin_register_init", "error": str(e)})
            return handle

        def vx_pin_read(handle: int) -> int:
            if not (0 <= handle < len(self._pins)):
                return 0
            p = self._pins[handle]
            # Prefer the live QEMU value when wired & a reader is available.
            if p["gpio"] is not None and self._pin_reader is not None:
                try:
                    return self._pin_reader(p["gpio"]) & 1
                except Exception:
                    pass
            return p["value"] & 1

        def vx_pin_write(handle: int, value: int) -> None:
            if not (0 <= handle < len(self._pins)):
                return
            p = self._pins[handle]
            v = 1 if value else 0
            p["value"] = v
            if p["gpio"] is not None and self._pin_writer is not None:
                try:
                    self._pin_writer(p["gpio"], v)
                except Exception as e:
                    self._emit({"type": "chip_error", "where": "pin_write", "error": str(e)})

        def vx_pin_read_analog(handle: int) -> float:
            if 0 <= handle < len(self._pins):
                return float(self._pins[handle]["value"] * 5.0)
            return 0.0

        def vx_pin_dac_write(_handle: int, _voltage: float) -> None:
            return

        def vx_pin_pwm_write(_handle: int, _duty: float) -> None:
            # The QEMU-hosted boards have no duty-cycle channel to report on,
            # but the import has to exist: a chip that calls it would fail to
            # instantiate here, taking the whole board down with it.
            return

        def vx_pin_set_mode(handle: int, mode: int) -> None:
            if 0 <= handle < len(self._pins):
                self._pins[handle]["mode"] = mode

        def vx_pin_watch(handle: int, edge: int, cb_idx: int, user_data: int) -> None:
            if not (0 <= handle < len(self._pins)):
                return
            p = self._pins[handle]
            if p["gpio"] is None:
                # Chip's logical pin not wired to a real GPIO — no edges to detect.
                return
            entries = self._pin_watches.setdefault(p["gpio"], [])
            entries.append({
                "handle": handle,
                "edge": edge & 3,
                "cb_idx": cb_idx,
                "user_data": user_data,
                "last_value": p["value"] & 1,
            })

        def vx_pin_watch_stop(handle: int) -> None:
            if not (0 <= handle < len(self._pins)):
                return
            gpio = self._pins[handle]["gpio"]
            if gpio is None:
                return
            entries = self._pin_watches.get(gpio)
            if entries:
                self._pin_watches[gpio] = [e for e in entries if e["handle"] != handle]
                if not self._pin_watches[gpio]:
                    del self._pin_watches[gpio]

        # ── Attributes ──
        def vx_attr_register(name_ptr: int, default_val: float) -> int:
            name = self._read_cstring(name_ptr)
            handle = len(self._attr_handles)
            self._attr_handles.append({"name": name, "default": default_val})
            self._attrs.setdefault(name, default_val)
            return handle

        def vx_attr_read(handle: int) -> float:
            if 0 <= handle < len(self._attr_handles):
                a = self._attr_handles[handle]
                return float(self._attrs.get(a["name"], a["default"]))
            return 0.0

        # ── I2C ──
        def vx_i2c_attach(cfg_ptr: int) -> int:
            cfg = self._read_i2c_config(cfg_ptr)
            self.i2c_address = cfg["address"]
            self.i2c_callbacks = cfg
            return 0

        # ── UART ──
        def vx_uart_attach(cfg_ptr: int) -> int:
            self.uart_config = self._read_uart_config(cfg_ptr)
            return 0

        def vx_uart_write(_handle: int, buf_ptr: int, count: int) -> int:
            if count <= 0:
                return 1
            data = self._read_bytes(buf_ptr, count)
            if self._uart_writer is not None:
                try:
                    # CHIP_UART, not UART0: UART0 is the serial monitor on
                    # every ESP32 family, so a chip writing there appears in
                    # the console as garbage and reads the sketch's own
                    # prints back. Chips live on Serial1 — the browser
                    # bridge (simulatorBridges.ts CHIP_UART) agrees.
                    self._uart_writer(CHIP_UART, data)
                except Exception as e:
                    self._emit({"type": "chip_error", "where": "uart_write", "error": str(e)})
                    return 0
            # Notify chip that the TX completed (synchronous in our model).
            if self.uart_config and self.uart_config["on_tx_done"]:
                self._call_indirect(self.uart_config["on_tx_done"], self.uart_config["user_data"])
            return 1

        # ── SPI ──
        def vx_spi_attach(cfg_ptr: int) -> int:
            self.spi_config = self._read_spi_config(cfg_ptr)
            return 0

        def vx_spi_start(_handle: int, buf_ptr: int, count: int) -> None:
            self._spi_buffer_ptr = buf_ptr
            self._spi_buffer_count = count
            self._spi_buffer_pos = 0

        def vx_spi_stop(_handle: int) -> None:
            # Fire on_done with what we have so far.
            if self.spi_config and self.spi_config["on_done"] and self._spi_buffer_count > 0:
                self._call_indirect(
                    self.spi_config["on_done"],
                    self.spi_config["user_data"],
                    self._spi_buffer_ptr,
                    self._spi_buffer_pos,
                )
            self._spi_buffer_ptr = 0
            self._spi_buffer_count = 0
            self._spi_buffer_pos = 0

        # ── Time + timers ──
        def vx_sim_now_nanos() -> int:
            return self.sim_now_nanos()

        def vx_timer_create(cb_idx: int, user_data: int) -> int:
            handle = len(self._timers)
            self._timers.append({
                "cb_idx": cb_idx,
                "user_data": user_data,
                "period_ns": 0,
                "repeat": False,
                "next_fire_ns": 0,
                "active": False,
            })
            return handle

        def vx_timer_start(handle: int, period_ns: int, repeat: int) -> None:
            if not (0 <= handle < len(self._timers)):
                return
            with self._timer_lock:
                t = self._timers[handle]
                t["period_ns"] = int(period_ns)
                t["repeat"] = bool(repeat)
                t["next_fire_ns"] = self.sim_now_nanos() + t["period_ns"]
                t["active"] = True
            if self._timer_scheduler is not None:
                try:
                    self._timer_scheduler(self)
                except Exception as e:
                    self._emit({"type": "chip_error", "where": "timer_start", "error": str(e)})

        def vx_timer_stop(handle: int) -> None:
            if 0 <= handle < len(self._timers):
                with self._timer_lock:
                    self._timers[handle]["active"] = False

        # ── String attributes ──
        def vx_attr_register_string(name_ptr: int, default_ptr: int) -> int:
            name = self._read_cstring(name_ptr)
            default = self._read_cstring(default_ptr)
            handle = len(self._attr_handles)
            self._attr_handles.append({"name": name, "default": 0.0,
                                       "string_default": default})
            return handle

        def _attr_string_value(handle: int) -> bytes:
            if 0 <= handle < len(self._attr_handles):
                a = self._attr_handles[handle]
                if "string_default" in a:
                    v = self._str_attrs.get(a["name"], a["string_default"])
                    return str(v).encode("utf-8")
            return b""

        def vx_attr_string_len(handle: int) -> int:
            return len(_attr_string_value(handle))

        def vx_attr_string_read(handle: int, buf_ptr: int, cap: int) -> int:
            if cap <= 0:
                return 0
            data = _attr_string_value(handle)
            n = min(len(data), cap - 1)
            self._write_bytes(buf_ptr, data[:n] + b"\x00")
            return n

        # ── Framebuffer (stubs — no display in the headless worker) ──
        def vx_framebuffer_init(_w_ptr: int, _h_ptr: int) -> int:
            return -1

        def vx_buffer_write(_handle: int, _offset: int, _data: int, _len: int) -> None:
            return

        def vx_buffer_read(_handle: int, _offset: int, _data: int, _len: int) -> None:
            return

        # ── External ROM (no ROM delivery path on the ESP32 worker yet — a
        #    chip calling these gets an empty ROM instead of failing to
        #    instantiate, which is what happened before they were defined) ──
        def vx_rom_size() -> int:
            return 0

        def vx_rom_read(_offset: int, _dst_ptr: int, _len: int) -> None:
            return

        # ── Logging ──
        def vx_log(msg_ptr: int) -> None:
            text = self._read_cstring(msg_ptr)
            self._emit({"type": "chip_log", "text": text})

        # Register them all
        sigs = {
            "vx_pin_register":     (wasmtime.FuncType([i32, i32], [i32]), vx_pin_register),
            "vx_pin_read":         (wasmtime.FuncType([i32], [i32]),      vx_pin_read),
            "vx_pin_write":        (wasmtime.FuncType([i32, i32], []),    vx_pin_write),
            "vx_pin_read_analog":  (wasmtime.FuncType([i32], [f64]),      vx_pin_read_analog),
            "vx_pin_dac_write":    (wasmtime.FuncType([i32, f64], []),    vx_pin_dac_write),
            "vx_pin_pwm_write":    (wasmtime.FuncType([i32, f64], []),    vx_pin_pwm_write),
            "vx_pin_set_mode":     (wasmtime.FuncType([i32, i32], []),    vx_pin_set_mode),
            "vx_pin_watch":        (wasmtime.FuncType([i32, i32, i32, i32], []), vx_pin_watch),
            "vx_pin_watch_stop":   (wasmtime.FuncType([i32], []),         vx_pin_watch_stop),

            "vx_attr_register":    (wasmtime.FuncType([i32, f64], [i32]), vx_attr_register),
            "vx_attr_read":        (wasmtime.FuncType([i32], [f64]),      vx_attr_read),
            "vx_attr_register_string": (wasmtime.FuncType([i32, i32], [i32]), vx_attr_register_string),
            "vx_attr_string_len":  (wasmtime.FuncType([i32], [i32]),      vx_attr_string_len),
            "vx_attr_string_read": (wasmtime.FuncType([i32, i32, i32], [i32]), vx_attr_string_read),

            "vx_i2c_attach":       (wasmtime.FuncType([i32], [i32]),      vx_i2c_attach),
            "vx_uart_attach":      (wasmtime.FuncType([i32], [i32]),      vx_uart_attach),
            "vx_uart_write":       (wasmtime.FuncType([i32, i32, i32], [i32]), vx_uart_write),
            "vx_spi_attach":       (wasmtime.FuncType([i32], [i32]),      vx_spi_attach),
            "vx_spi_start":        (wasmtime.FuncType([i32, i32, i32], []), vx_spi_start),
            "vx_spi_stop":         (wasmtime.FuncType([i32], []),         vx_spi_stop),

            "vx_sim_now_nanos":    (wasmtime.FuncType([], [i64]),         vx_sim_now_nanos),
            "vx_timer_create":     (wasmtime.FuncType([i32, i32], [i32]), vx_timer_create),
            "vx_timer_start":      (wasmtime.FuncType([i32, i64, i32], []), vx_timer_start),
            "vx_timer_stop":       (wasmtime.FuncType([i32], []),         vx_timer_stop),

            "vx_framebuffer_init": (wasmtime.FuncType([i32, i32], [i32]), vx_framebuffer_init),
            "vx_buffer_write":     (wasmtime.FuncType([i32, i32, i32, i32], []), vx_buffer_write),
            "vx_buffer_read":      (wasmtime.FuncType([i32, i32, i32, i32], []), vx_buffer_read),

            "vx_rom_size":         (wasmtime.FuncType([], [i32]),         vx_rom_size),
            "vx_rom_read":         (wasmtime.FuncType([i32, i32, i32], []), vx_rom_read),

            "vx_log":              (wasmtime.FuncType([i32], []),         vx_log),
        }
        for name, (sig, fn) in sigs.items():
            linker.define_func("env", name, sig, fn)

    # ── Time + telemetry helpers ──────────────────────────────────────────────

    def sim_now_nanos(self) -> int:
        return time.monotonic_ns() - self._t0

    def _flush_stdout(self) -> None:
        if not self._stdout_buf:
            return
        # Emit complete lines so multi-line printf shows up cleanly.
        while True:
            nl = self._stdout_buf.find("\n")
            if nl < 0:
                break
            line = self._stdout_buf[: nl + 1]
            self._stdout_buf = self._stdout_buf[nl + 1 :]
            self._emit({"type": "chip_log", "text": line})

    # ── Exposed for the I2C slave adapter ────────────────────────────────────

    def call_i2c_callback(self, name: str, *args: int) -> int:
        """Invoke one of {on_connect, on_read, on_write, on_stop} via indirect call."""
        if not self.i2c_callbacks:
            return 0
        idx = self.i2c_callbacks.get(name, 0)
        result = self._call_indirect(idx, self.i2c_callbacks["user_data"], *args)
        self._flush_stdout()
        return result

    # ── Live attribute updates (sensor control panel sliders) ───────────────
    def update_attrs(self, attrs: dict[str, float]) -> None:
        """Apply live control values. vx_attr_read reads self._attrs on every
        call, so the running chip sees the new values immediately — no reload.
        Called from the worker's sensor_update command thread; a plain dict
        update is atomic enough under the GIL for float slots."""
        for name, value in attrs.items():
            self._attrs[str(name)] = float(value)

    # ── Pin watch dispatch (worker calls this from _on_pin_change) ──────────
    def has_pin_watches(self) -> bool:
        return bool(self._pin_watches)

    def notify_pin_change(self, gpio: int, value: int) -> None:
        """Called by the worker for every QEMU GPIO transition. Fires any
        chip-side watches whose edge condition matches.

        Must be called while holding the QEMU IO-thread lock — the chip's
        callback can call vx_pin_write which goes back into picsimlab.
        """
        entries = self._pin_watches.get(gpio)
        if not entries:
            return
        new_state = value & 1
        for entry in entries:
            last = entry["last_value"]
            entry["last_value"] = new_state
            if last == new_state:
                continue
            edge = entry["edge"]
            is_rising  = (last == 0 and new_state == 1)
            is_falling = (last == 1 and new_state == 0)
            if (is_rising and (edge & 1)) or (is_falling and (edge & 2)):
                self._call_indirect(
                    entry["cb_idx"],
                    entry["user_data"],
                    entry["handle"],
                    new_state,
                )
        self._flush_stdout()

    # ── UART hook (chip ← firmware) ──────────────────────────────────────────
    def feed_uart_byte(self, byte: int) -> None:
        """Called by the worker when the firmware transmits a UART byte —
        delivers it to the chip's vx_uart_attach `on_rx_byte` callback."""
        if not self.uart_config:
            return
        idx = self.uart_config.get("on_rx_byte", 0)
        if not idx:
            return
        self._call_indirect(idx, self.uart_config["user_data"], byte & 0xFF)
        self._flush_stdout()

    # ── SPI hook (chip ← firmware) ───────────────────────────────────────────
    def spi_transfer_byte(self, mosi: int) -> int:
        """Called by the worker when the firmware clocks one SPI byte.
        Returns the byte the chip put in its MISO buffer at the current position;
        overwrites that buffer slot with `mosi` so the chip's `on_done` callback
        sees what the master sent.
        """
        if not self.spi_config or self._spi_buffer_count == 0:
            return 0xFF
        if self._spi_buffer_pos >= self._spi_buffer_count:
            return 0xFF
        # Read MISO byte (chip's pre-filled response)
        miso_byte = self._read_bytes(self._spi_buffer_ptr + self._spi_buffer_pos, 1)[0]
        # Overwrite with master's MOSI byte
        self._write_bytes(self._spi_buffer_ptr + self._spi_buffer_pos, bytes([mosi & 0xFF]))
        self._spi_buffer_pos += 1
        if self._spi_buffer_pos >= self._spi_buffer_count:
            # Transfer complete — fire on_done with the buffer the chip prepared.
            on_done = self.spi_config.get("on_done", 0)
            if on_done:
                self._call_indirect(
                    on_done,
                    self.spi_config["user_data"],
                    self._spi_buffer_ptr,
                    self._spi_buffer_count,
                )
            self._flush_stdout()
            # Reset; the chip's on_done may have called vx_spi_start again.
            # If it didn't, future bytes return 0xff until it re-arms.
        return miso_byte

    # ── Timers ──────────────────────────────────────────────────────────────
    def next_timer_deadline(self) -> int | None:
        """Return the soonest active timer's fire time (ns). None if no timers."""
        with self._timer_lock:
            deadlines = [t["next_fire_ns"] for t in self._timers if t["active"]]
        return min(deadlines) if deadlines else None

    def fire_due_timers(self) -> None:
        """Fire every timer whose deadline has passed. Called by the scheduler
        thread after acquiring the QEMU iothread lock."""
        now = self.sim_now_nanos()
        with self._timer_lock:
            due = [
                (i, t) for i, t in enumerate(self._timers)
                if t["active"] and now >= t["next_fire_ns"]
            ]
        for _i, t in due:
            self._call_indirect(t["cb_idx"], t["user_data"])
            with self._timer_lock:
                if t["repeat"]:
                    t["next_fire_ns"] += t["period_ns"]
                else:
                    t["active"] = False
        self._flush_stdout()
