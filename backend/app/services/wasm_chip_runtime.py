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
- Named blobs (vx_blob_size / vx_blob_read / vx_blob_write)
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
import base64
import zlib

import ctypes
import wasmtime


class _FastCallApi:
    """The pieces of wasmtime's ctypes layer the per-byte call path needs.

    Probed once, here, so the rest of the file can ask a single question
    ("is it there?") and a wasmtime whose internals moved just keeps the
    generic call instead of failing. See WasmChipRuntime._fast_call.
    """

    def __init__(self, ffi, enter_wasm):
        self.val_t = ffi.wasmtime_val_t
        self.call = ffi.wasmtime_func_call
        self.enter_wasm = enter_wasm
        # wasmtime spells the i32 kind as a c_ubyte constant.
        kind = ffi.WASMTIME_I32
        self.i32_kind = getattr(kind, "value", kind)


def _probe_fast_call():
    try:
        from wasmtime import _ffi as _wt_ffi
        from wasmtime._func import enter_wasm as _enter_wasm

        api = _FastCallApi(_wt_ffi, _enter_wasm)
        # Touch every field once: a missing one raises here and nowhere else.
        _ = (api.val_t * 1)(), api.call, api.i32_kind
        return api
    except Exception:  # noqa: BLE001 - any shape change falls back
        return None


_FAST_CALL = _probe_fast_call()


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


class ChipNetBus:
    """Level fan-out across the chip pins that share one diagram net.

    A chip pin wired only to other chip pins has no board GPIO, so nothing in
    the QEMU pin plumbing ever sees it: vx_pin_watch used to drop the watch and
    the net carried nothing. This bus is the missing conductor. It mirrors what
    chipNets.ts plus syntheticNetPin already do for the browser chip runtime,
    where every endpoint of a pure chip-to-chip net resolves to one shared
    PinManager key.

    Net ids are opaque strings minted by the frontend (chipNets.ts canonical
    endpoint key), so both ends of a net agree on the name without the worker
    having to see the diagram.

    A net whose members live in different QEMU workers is bridged by the
    frontend: `publisher` is called on every local level change for such a net,
    and `apply_remote` replays the peer's changes here.
    """

    def __init__(
        self,
        publisher: Optional[Callable[[str, int, int], None]] = None,
        clock: Callable[[], int] = time.monotonic_ns,
    ) -> None:
        """
        Args:
            publisher: (net_id, level, ts_ns) -> void, called for a net marked
                       remote when a local member drives it. None keeps the bus
                       local to this worker.
            clock:     the timeline a published edge is stamped with. Every
                       worker on one host reads CLOCK_MONOTONIC, so the stamp
                       is meaningful to the receiving worker; tests pass their
                       virtual clock.
        """
        self._publisher = publisher
        self._clock = clock
        self._levels: dict[str, int] = {}
        self._members: dict[str, list[tuple["WasmChipRuntime", int]]] = {}
        self._remote: set[str] = set()
        # Re-entrancy guard: a watch callback may drive the same net straight
        # back. The nested write still sets the level, it just does not fan out
        # a second time, so a chip cannot recurse the worker to death.
        self._driving: set[str] = set()

    def register(self, net_id: str, runtime: "WasmChipRuntime", handle: int) -> None:
        self._members.setdefault(net_id, []).append((runtime, handle))
        self._levels.setdefault(net_id, 0)

    def unregister(self, runtime: "WasmChipRuntime") -> None:
        """Drop every membership of `runtime` (a chip detached at runtime).
        Nets it leaves empty keep their last level: the wire is still there,
        only the driver left."""
        for net_id, members in list(self._members.items()):
            kept = [(rt, h) for rt, h in members if rt is not runtime]
            if kept:
                self._members[net_id] = kept
            else:
                del self._members[net_id]

    def mark_remote(self, net_ids) -> None:
        """Flag nets that have a member in another worker, so local writes are
        published to the frontend bridge."""
        self._remote.update(str(n) for n in net_ids)

    def is_remote(self, net_id: str) -> bool:
        return net_id in self._remote

    def level(self, net_id: str) -> int | None:
        return self._levels.get(net_id)

    def drive(
        self,
        net_id: str,
        value: int,
        source: Optional[tuple["WasmChipRuntime", int]] = None,
        publish: bool = True,
        ts_ns: int | None = None,
        at_ns: int | None = None,
    ) -> None:
        """Set the net level and fire every other member's pin watches.
        `at_ns` (absolute, the bus clock) makes the members see the edge at
        that instant instead of now; see apply_remote."""
        v = 1 if value else 0
        self._levels[net_id] = v
        if publish and self._publisher is not None and net_id in self._remote:
            try:
                self._publisher(net_id, v, self._stamp(ts_ns, source))
            except Exception:
                pass
        if net_id in self._driving:
            return
        self._driving.add(net_id)
        try:
            for runtime, handle in self._members.get(net_id, ()):
                if source is not None and runtime is source[0] and handle == source[1]:
                    continue
                if at_ns is None:
                    runtime.notify_net_change(handle, v)
                else:
                    runtime.notify_net_change(handle, v, at_ns=at_ns)
        finally:
            self._driving.discard(net_id)

    def _stamp(self, ts_ns: int | None, source) -> int:
        """The instant a published edge carries. An explicit stamp wins; a
        write from a chip's timer callback (or from a watch delivering a
        stamped remote edge) carries the chip's own current instant, which is
        the timer's deadline rather than the scheduler's wake-up time; anything
        else is stamped with the bus clock."""
        if ts_ns is not None:
            return int(ts_ns)
        if source is not None:
            rt = source[0]
            override = getattr(rt, "_now_override_ns", None)
            t0 = getattr(rt, "_t0", None)
            if override is not None and t0 is not None:
                return int(t0) + int(override)
        return int(self._clock())

    def apply_remote(self, net_id: str, value: int, ts_ns: int = 0) -> None:
        """Replay a level change a peer worker drove. Never republished, so two
        bridged workers cannot ping-pong one edge forever.

        The edge is applied AT THE SENDER'S TIME: the members' watch callbacks
        see `ts_ns` from vx_sim_now_nanos, not the arrival time. The bridge
        (worker, backend, browser, backend, worker) adds milliseconds of jitter
        with a tail past 100 ms, and a self-clocked protocol measures the
        spacing between edges; stamped this way it measures what the sender
        drove, and the hop only delays the frame. Both workers on one host read
        CLOCK_MONOTONIC, which is what makes the stamp portable. A stamp of 0
        (an older worker) falls back to the arrival time."""
        self.drive(net_id, value, source=None, publish=False,
                   at_ns=ts_ns if ts_ns > 0 else None)


def decode_blobs(raw: dict | None) -> dict[str, bytes]:
    """Turn a chip config's `blobs` field into the bytes the runtime wants.

    The wire carries them base64, like wasm_b64 does, because they ride the
    same JSON. One decoder for every host that builds a runtime (the ESP32 and
    STM32 workers, the Linux-board adapter) so a card image cannot arrive as
    bytes in one place and as text in another.
    """
    out: dict[str, bytes] = {}
    for name, value in (raw or {}).items():
        if isinstance(value, (bytes, bytearray, memoryview)):
            out[str(name)] = bytes(value)
        elif isinstance(value, str):
            try:
                out[str(name)] = base64.b64decode(value)
            except Exception:
                continue
    return out


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
        net_map: dict[str, str] | None = None,
        net_bus: Optional[ChipNetBus] = None,
        uart_map: dict[int, int] | None = None,
        display: dict | None = None,
        component_id: str | None = None,
        blobs: dict[str, bytes] | None = None,
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
                         UART RX. Called by vx_uart_write with the UART this chip
                         resolved to (see uart_map), CHIP_UART when none does.
            timer_scheduler: callback invoked when the chip arms a timer; the worker
                             starts the actual scheduling thread.
            net_map:    {chip_pin_name: net_id} - chip pins that share a diagram net
                        with another chip's pin. Resolved by the frontend with the
                        same union-find over wires that chipNets.ts uses. Omitted
                        by older frontends, which is why it defaults to empty.
            net_bus:    the shared ChipNetBus every chip in this worker registers
                        its net pins on.
            uart_map:   {gpio: uart_id} for the UART pins this chip is wired to,
                        from the board's UART pin table in the frontend. Decides
                        which UART vx_uart_attach binds to; empty keeps CHIP_UART.
            display:    chip.json's `display: {width, height}` - the framebuffer
                        vx_framebuffer_init hands the chip. Same default as the
                        browser runtime (128x64) when the chip declares none.
            component_id: the canvas component this chip is, so a framebuffer
                        frame can be routed to its element (like ePaper frames).
            blobs:      named byte storage for vx_blob_* (the microSD card
                        image arrives as "card"). Raw bytes; decode_blobs()
                        turns the base64 that travels on the wire into them.
        """
        self._engine = wasmtime.Engine()
        self._store = wasmtime.Store(self._engine)
        self._module = wasmtime.Module(self._engine, wasm_bytes)

        # Provide the linear memory (the WASM is compiled with --import-memory)
        self._memory = wasmtime.Memory(
            self._store, wasmtime.MemoryType(wasmtime.Limits(2, 16))
        )

        # See _mem_view / _call_indirect: both caches are dropped whenever wasm
        # runs, which is the only thing that can invalidate them.
        self._mem_view_cache = None
        self._fn_cache: dict[int, object] = {}
        self._fast_cache: dict[int, object] = {}

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
        self._net_map = {str(k): str(v) for k, v in (net_map or {}).items()}
        self._net_bus = net_bus
        self._uart_map = {int(k): int(v) for k, v in (uart_map or {}).items()}

        # Per-instance state
        self._pins: list[dict] = []           # [{name, mode, value, gpio, net}]
        self._attr_handles: list[dict] = []   # [{name, default}]

        # Named byte storage (vx_blob_*), per chip instance. Copied in, like the
        # browser runtime does, so the chip's writes stay inside the chip until
        # the host asks for them with blob_bytes()/take_blob_dirty().
        self._blobs: dict[str, bytearray] = {
            str(k): bytearray(v) for k, v in (blobs or {}).items()
        }
        # {name: [lo, hi)} the chip has written since the last take_blob_dirty().
        self._blob_dirty: dict[str, list[int]] = {}
        # The chip writes from whichever thread runs its WASM (QEMU's IO thread
        # inside a bus callback, the chip-timer thread inside a timer) and the
        # host drains the spans from its own thread, exactly like the
        # framebuffer, so the same lock discipline applies: without it a drain
        # racing a write loses the part of the span the write had just added.
        self._blob_lock = threading.Lock()

        # I2C state populated by vx_i2c_attach
        self.i2c_address: int | None = None
        self.i2c_callbacks: dict | None = None    # {on_connect, on_read, on_write, on_stop, user_data}

        # UART state — at most one UART per chip in MVP
        self.uart_config: dict | None = None      # {rx, tx, baud_rate, on_rx_byte, on_tx_done, user_data}
        # Which of the board's UARTs this chip is on. Resolved from the wired
        # pins at vx_uart_attach; CHIP_UART until then and when nothing resolves.
        self.uart_id: int = CHIP_UART

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

        # Pin watches on chip-to-chip net pins, indexed by pin handle. A pin can
        # sit in both maps (a net that also carries a board GPIO); the two
        # entries keep separate last_value so neither source double-fires.
        self._net_watches: dict[int, list[dict]] = {}

        # Framebuffer (vx_framebuffer_init). RGBA8888, the size chip.json declares.
        # Written by the chip from whichever thread runs its WASM (QEMU's IO thread
        # for a bus callback, the chip-timer thread for a timer) and read by the
        # worker's flush thread, hence the lock. The dirty range is a byte span,
        # turned into whole rows at flush time: a display driver paints windows,
        # and shipping the rows they touched instead of the whole buffer is what
        # keeps a 480x320 panel from pushing 600 kB per frame down the WS.
        self.component_id = component_id
        dw = dh = 0
        if isinstance(display, dict):
            try:
                dw, dh = int(display.get('width', 0)), int(display.get('height', 0))
            except (TypeError, ValueError):
                dw = dh = 0
        self._display = (dw, dh) if dw > 0 and dh > 0 else None
        self._fb: bytearray | None = None
        self._fb_w = 0
        self._fb_h = 0
        self._fb_dirty_lo: int | None = None
        self._fb_dirty_hi = 0
        self._fb_lock = threading.Lock()

        # Timestamp anchor for sim_now_nanos
        self._t0 = time.monotonic_ns()
        # Set while a remote net edge is delivered (notify_net_change with a
        # stamp): the instant the chip's callbacks read as "now".
        self._now_override_ns: int | None = None

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
        # chip_setup allocates, so the memory can grow under the view.
        self._drop_mem_view()
        chip_setup(self._store)
        self._drop_mem_view()
        self._flush_stdout()

    # ── Memory & helpers ──────────────────────────────────────────────────────

    def _read_bytes(self, ptr: int, length: int) -> bytes:
        return bytes(self._memory.read(self._store, ptr, ptr + length))

    def _write_bytes(self, ptr: int, data: bytes) -> None:
        self._memory.write(self._store, data, ptr)

    # ── The hot path ────────────────────────────────────────────────────────
    #
    # An SPI responder is asked for one byte at a time, and a 512-byte SD
    # sector is therefore 512 round trips through this file. The generic
    # wasmtime-py helpers are far too expensive for that: `Memory.read` of ONE
    # byte asks the engine for the buffer size, builds a ctypes array type and
    # allocates a bytearray, and `Func.__call__` re-reads the function's TYPE
    # on every call and rebuilds its parameter list. Measured on the microSD
    # model, that was ~85 % of the cost of a byte (project
    # board-buses-2026-09, harness/sd-host-cost.py).
    #
    # Both are cached here instead. The invariant that makes it safe is small:
    # the memory's base address only moves when the memory GROWS, and it only
    # grows while wasm code runs, so the view is dropped around the two places
    # that enter the module (`run_chip_setup` and `_call_indirect`) and
    # nowhere else has to know.

    def _fast_call(self, fn, args: tuple) -> int | None:
        """Call a wasm function without wasmtime-py's per-call type work.

        `Func.__call__` asks the engine for the function's TYPE on every call
        and rebuilds its parameter list from it, then converts each argument
        through the generic Val path. For a responder that is per SPI BYTE. The
        type never changes, so it is read once and the value array is filled in
        place after that: measured at about a fifth of the generic call on the
        microSD model (harness/sd-host-cost.py).

        This reaches into wasmtime's ctypes bindings, which are not a published
        API, so everything it needs is probed once at import and a host without
        it simply keeps the generic path. Returns None when it cannot run, and
        the caller falls back.
        """
        if _FAST_CALL is None:
            return None
        cached = self._fast_cache.get(id(fn))
        if cached is None:
            try:
                ty = fn.type(self._store)
                params = list(ty.params)
                results = list(ty.results)
                nres = len(results)
                # Only the all-i32 shape the chip ABI uses; anything else goes
                # the generic way rather than being guessed at.
                if (any(str(p) != "i32" for p in params)
                        or any(str(r) != "i32" for r in results)
                        or nres > 1):
                    self._fast_cache[id(fn)] = False
                    return None
                argv = (_FAST_CALL.val_t * len(params))()
                for v in argv:
                    v.kind = _FAST_CALL.i32_kind
                resv = (_FAST_CALL.val_t * nres)()
                cached = (fn, argv, len(params), resv, nres)
                self._fast_cache[id(fn)] = cached
            except Exception:
                self._fast_cache[id(fn)] = False
                return None
        if cached is False:
            return None
        _fn, argv, nargs, resv, nres = cached
        if len(args) != nargs:
            return None
        for i, a in enumerate(args):
            argv[i].of.i32 = int(a)
        with _FAST_CALL.enter_wasm(self._store) as trap:
            err = _FAST_CALL.call(
                self._store._context(), ctypes.byref(_fn._func),
                argv, nargs, resv, nres, trap,
            )
            if err:
                raise wasmtime.WasmtimeError._from_ptr(err)
        return int(resv[0].of.i32) if nres else 0

    def _mem_view(self):
        """A ctypes view of the guest's linear memory, valid until wasm runs."""
        view = self._mem_view_cache
        if view is None:
            view = self._memory.get_buffer_ptr(self._store)
            self._mem_view_cache = view
        return view

    def _drop_mem_view(self) -> None:
        self._mem_view_cache = None

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

    def _resolve_uart_id(self, cfg: dict) -> int:
        """Which board UART this chip's vx_uart_attach binds to.

        `cfg["rx"]` and `cfg["tx"]` are pin handles from vx_pin_register, so
        they resolve through this chip's own pin list to the GPIOs the diagram
        wired. `uart_map` says which UART each of those GPIOs belongs to. A
        chip's RX is wired to the board's TX and its TX to the board's RX, so
        either end names the same UART and the first one that resolves wins.

        With no map and no wire (a chip whose UART pins go nowhere) the answer
        is CHIP_UART, which is where every chip used to land unconditionally.
        """
        if not self._uart_map:
            return CHIP_UART
        for key in ("rx", "tx"):
            handle = int(cfg.get(key, -1))
            if not (0 <= handle < len(self._pins)):
                continue
            gpio = self._pins[handle]["gpio"]
            if gpio is None:
                continue
            uart = self._uart_map.get(int(gpio))
            if uart is not None:
                return int(uart)
        return CHIP_UART

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
            # The table lookup is stable for the life of the module, and it is
            # not free: it builds a Func object and its type. A responder calls
            # the same on_done for every byte of a transfer.
            fn = self._fn_cache.get(idx)
            if fn is None:
                fn = table.get(self._store, idx)
                if fn is None:
                    return 0
                self._fn_cache[idx] = fn
            # Anything below runs wasm, which can grow the memory.
            self._drop_mem_view()
            fast = self._fast_call(fn, args)
            if fast is not None:
                return fast
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
            net = self._net_map.get(name)
            self._pins.append({"name": name, "mode": mode, "value": initial,
                               "gpio": gpio, "net": net})
            if net is not None and self._net_bus is not None:
                self._net_bus.register(net, self, handle)
            # Drive the initial level into QEMU if this is an OUTPUT_LOW/HIGH pin
            # AND we have a real GPIO for it.
            if gpio is not None and self._pin_writer and mode in (self.MODE_OUTPUT_LOW, self.MODE_OUTPUT_HIGH):
                try:
                    self._pin_writer(gpio, initial)
                except Exception as e:
                    self._emit({"type": "chip_error", "where": "pin_register_init", "error": str(e)})
            return handle

        def vx_pin_read(handle: int) -> int:
            return self.pin_level(handle)

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
            # A net with a board GPIO on it keeps the GPIO behaviour above AND
            # fans out to the chip members, so a chip wired to both a board pin
            # and another chip drives both.
            if p["net"] is not None and self._net_bus is not None:
                try:
                    self._net_bus.drive(p["net"], v, source=(self, handle))
                except Exception as e:
                    self._emit({"type": "chip_error", "where": "net_write", "error": str(e)})

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
            if p["gpio"] is None and p["net"] is None:
                # Chip's logical pin is on neither a real GPIO nor a chip net -
                # no edges to detect.
                return

            def _entry() -> dict:
                return {
                    "handle": handle,
                    "edge": edge & 3,
                    "cb_idx": cb_idx,
                    "user_data": user_data,
                    "last_value": p["value"] & 1,
                }

            if p["gpio"] is not None:
                self._pin_watches.setdefault(p["gpio"], []).append(_entry())
            if p["net"] is not None:
                self._net_watches.setdefault(handle, []).append(_entry())

        def vx_pin_watch_stop(handle: int) -> None:
            if not (0 <= handle < len(self._pins)):
                return
            self._net_watches.pop(handle, None)
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
            self.uart_id = self._resolve_uart_id(self.uart_config)
            return 0

        def vx_uart_write(_handle: int, buf_ptr: int, count: int) -> int:
            if count <= 0:
                return 1
            data = self._read_bytes(buf_ptr, count)
            if self._uart_writer is not None:
                try:
                    # The UART whose TX/RX the diagram wires to this chip, so a
                    # module on Serial2 is read by Serial2 and not by the
                    # console. When no wire resolves this stays CHIP_UART, not
                    # UART0: UART0 is the serial monitor on every ESP32 family,
                    # so a chip writing there appears in the console as garbage
                    # and reads the sketch's own prints back. Chips default to
                    # Serial1, which the browser bridge
                    # (simulatorBridges.ts CHIP_UART) agrees with.
                    self._uart_writer(self.uart_id, data)
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
            return self._now_nanos_for_chip()

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

        # ── Framebuffer ──
        # The worker has no canvas, but the chip's pixels still have somewhere to
        # go: the frontend element that placed the chip. The buffer lives here,
        # the worker ships the rows the chip touched (see flush_framebuffer), and
        # CustomChipPart paints them. Before this the three calls were stubs, so a
        # custom display chip on the QEMU path decoded its SPI perfectly and
        # showed nothing (issue #338).
        def vx_framebuffer_init(w_ptr: int, h_ptr: int) -> int:
            w, h = self._display or (128, 64)
            with self._fb_lock:
                if self._fb is None:
                    self._fb = bytearray(w * h * 4)
                    self._fb_w, self._fb_h = w, h
                    # The first frame is the whole buffer, so a chip that never
                    # writes still gets its (black) glass painted once.
                    self._fb_dirty_lo, self._fb_dirty_hi = 0, len(self._fb)
            self._write_bytes(w_ptr, struct.pack('<I', self._fb_w))
            self._write_bytes(h_ptr, struct.pack('<I', self._fb_h))
            return 0

        def vx_buffer_write(_handle: int, offset: int, data: int, length: int) -> None:
            if self._fb is None or length <= 0 or offset < 0:
                return
            end = min(offset + length, len(self._fb))
            n = end - offset
            if n <= 0:
                return
            chunk = self._read_bytes(data, n)
            with self._fb_lock:
                self._fb[offset:end] = chunk
                lo = self._fb_dirty_lo
                self._fb_dirty_lo = offset if lo is None else min(lo, offset)
                self._fb_dirty_hi = max(self._fb_dirty_hi, end)

        def vx_buffer_read(_handle: int, offset: int, data: int, length: int) -> None:
            if self._fb is None or length <= 0 or offset < 0:
                return
            end = min(offset + length, len(self._fb))
            if end <= offset:
                return
            with self._fb_lock:
                chunk = bytes(self._fb[offset:end])
            self._write_bytes(data, chunk)

        # ── External ROM (no ROM delivery path on the ESP32 worker yet — a
        #    chip calling these gets an empty ROM instead of failing to
        #    instantiate, which is what happened before they were defined) ──
        def vx_rom_size() -> int:
            return 0

        def vx_rom_read(_offset: int, _dst_ptr: int, _len: int) -> None:
            return

        # ── Named blobs ──
        # velxio-chip.h writes out the contract; ChipRuntime.ts answers the same
        # for the same call. Storage is per instance, an unknown name has
        # nothing, a blob never grows, and both directions truncate at the end
        # and return what they moved.
        def vx_blob_size(name_ptr: int) -> int:
            blob = self._blobs.get(self._read_cstring(name_ptr))
            return len(blob) if blob is not None else 0

        def vx_blob_read(name_ptr: int, offset: int, dst_ptr: int, length: int) -> int:
            blob = self._blobs.get(self._read_cstring(name_ptr))
            if blob is None or length <= 0 or offset < 0 or offset >= len(blob):
                return 0
            n = min(length, len(blob) - offset)
            with self._blob_lock:
                chunk = bytes(blob[offset:offset + n])
            self._write_bytes(dst_ptr, chunk)
            return n

        def vx_blob_write(name_ptr: int, offset: int, src_ptr: int, length: int) -> int:
            name = self._read_cstring(name_ptr)
            blob = self._blobs.get(name)
            if blob is None or length <= 0 or offset < 0 or offset >= len(blob):
                return 0
            n = min(length, len(blob) - offset)
            chunk = self._read_bytes(src_ptr, n)
            with self._blob_lock:
                blob[offset:offset + n] = chunk
                span = self._blob_dirty.get(name)
                if span is None:
                    self._blob_dirty[name] = [offset, offset + n]
                else:
                    span[0] = min(span[0], offset)
                    span[1] = max(span[1], offset + n)
            return n

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

            "vx_blob_size":        (wasmtime.FuncType([i32], [i32]),        vx_blob_size),
            "vx_blob_read":        (wasmtime.FuncType([i32, i32, i32, i32], [i32]), vx_blob_read),
            "vx_blob_write":       (wasmtime.FuncType([i32, i32, i32, i32], [i32]), vx_blob_write),

            "vx_log":              (wasmtime.FuncType([i32], []),         vx_log),
        }
        for name, (sig, fn) in sigs.items():
            linker.define_func("env", name, sig, fn)

    # ── Time + telemetry helpers ──────────────────────────────────────────────

    def sim_now_nanos(self) -> int:
        return time.monotonic_ns() - self._t0

    def _now_nanos_for_chip(self) -> int:
        """What vx_sim_now_nanos answers: the stamped instant while a remote
        net edge is being delivered (see ChipNetBus.apply_remote), the live
        clock otherwise."""
        if self._now_override_ns is not None:
            return self._now_override_ns
        return self.sim_now_nanos()

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

    # ── Named blob readback (the host ships the writes onwards) ─────────────
    def blob_bytes(self, name: str) -> bytes | None:
        """Current bytes of a named blob, None when the chip has no such blob."""
        blob = self._blobs.get(name)
        if blob is None:
            return None
        with self._blob_lock:
            return bytes(blob)

    def take_blob_dirty(self) -> dict[str, tuple[int, int]]:
        """The byte spans [lo, hi) the chip wrote since the last call, and
        clears them. A card image is megabytes, so what goes back to the panel
        is the span the guest touched, never the whole blob."""
        with self._blob_lock:
            out = {name: (span[0], span[1]) for name, span in self._blob_dirty.items()}
            self._blob_dirty = {}
        return out

    # ── Pin watch dispatch (worker calls this from _on_pin_change) ──────────
    # ── Framebuffer delivery ──────────────────────────────────────────────────

    def has_framebuffer(self) -> bool:
        """True once chip_setup called vx_framebuffer_init."""
        return self._fb is not None

    def flush_framebuffer(self) -> bool:
        """Ship the rows the chip touched since the last flush as ONE
        `chip_framebuffer` event: RGBA rows y0..y1 (inclusive), zlib-deflated,
        base64. Called by the worker's flush thread on a fixed cadence, never
        per vx_buffer_write — a driver that paints a 480x320 window pixel by
        pixel makes hundreds of thousands of writes per screen. Returns True
        when a frame went out."""
        if self._fb is None:
            return False
        with self._fb_lock:
            lo = self._fb_dirty_lo
            if lo is None:
                return False
            hi = self._fb_dirty_hi
            self._fb_dirty_lo, self._fb_dirty_hi = None, 0
            stride = self._fb_w * 4
            y0 = lo // stride
            y1 = min(self._fb_h - 1, max(y0, (hi - 1) // stride))
            rows = bytes(self._fb[y0 * stride:(y1 + 1) * stride])
        # Compress OUTSIDE the lock: the chip keeps painting meanwhile. Level 1
        # is plenty — flat colour and text compress by two orders of magnitude,
        # and the flush cadence matters more than the last few percent.
        packed = zlib.compress(rows, 1)
        self._emit({
            'type': 'chip_framebuffer',
            'component_id': self.component_id,
            'width': self._fb_w,
            'height': self._fb_h,
            'y0': y0,
            'y1': y1,
            'rows_zlib_b64': base64.b64encode(packed).decode('ascii'),
        })
        return True

    def has_pin_watches(self) -> bool:
        return bool(self._pin_watches)

    def has_net_watches(self) -> bool:
        return bool(self._net_watches)

    def _fire_watches(self, entries: list[dict], value: int) -> None:
        """Edge-detect per watch entry and call the ones whose edge matches."""
        new_state = value & 1
        for entry in entries:
            last = entry["last_value"]
            entry["last_value"] = new_state
            if last == new_state:
                continue
            edge = entry["edge"]
            is_rising = (last == 0 and new_state == 1)
            is_falling = (last == 1 and new_state == 0)
            if (is_rising and (edge & 1)) or (is_falling and (edge & 2)):
                self._call_indirect(
                    entry["cb_idx"],
                    entry["user_data"],
                    entry["handle"],
                    new_state,
                )

    def notify_net_change(self, handle: int, value: int, at_ns: int | None = None) -> None:
        """Called by ChipNetBus when another chip drives a net this chip's pin
        `handle` sits on. Edge detection is per watch entry, so a member that
        already reads the new level fires nothing. With `at_ns` (an absolute
        instant on the bus clock) the watch callbacks read that instant from
        vx_sim_now_nanos, so a remote edge keeps the spacing its sender gave
        it whatever the bridge latency was."""
        if 0 <= handle < len(self._pins):
            self._pins[handle]["value"] = value & 1
        entries = self._net_watches.get(handle)
        if not entries:
            return
        if at_ns is not None:
            self._now_override_ns = max(0, at_ns - self._t0)
        try:
            self._fire_watches(entries, value)
        finally:
            self._now_override_ns = None
        self._flush_stdout()

    def notify_pin_change(self, gpio: int, value: int) -> None:
        """Called by the worker for every QEMU GPIO transition. Fires any
        chip-side watches whose edge condition matches.

        Must be called while holding the QEMU IO-thread lock — the chip's
        callback can call vx_pin_write which goes back into picsimlab.
        """
        entries = self._pin_watches.get(gpio)
        if not entries:
            return
        self._fire_watches(entries, value)
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

    # ── Pins ────────────────────────────────────────────────────────────────
    def pin_level(self, handle: int) -> int:
        """The level on one of the chip's own pins, as vx_pin_read sees it.

        A method rather than a closure because the SPI bus needs the same
        answer for the chip's select line (spi_cs_active below), and two
        readings of one pin that can disagree is the whole disease this
        project exists to cure.
        """
        if not (0 <= handle < len(self._pins)):
            return 0
        p = self._pins[handle]
        # Prefer the live QEMU value when wired & a reader is available.
        if p["gpio"] is not None and self._pin_reader is not None:
            try:
                return self._pin_reader(p["gpio"]) & 1
            except Exception:
                pass
        # No board GPIO: the net level is the pin level, so a chip reads
        # what another chip on the same net last drove.
        if p["net"] is not None and self._net_bus is not None:
            level = self._net_bus.level(p["net"])
            if level is not None:
                return level & 1
        return p["value"] & 1

    # ── SPI hook (chip ← firmware) ───────────────────────────────────────────
    def spi_cs_active(self) -> bool:
        """Whether this chip's select line is asserted right now.

        velxio-chip.h states the contract: the bus HONOURS `cfg.cs`, so the
        chip is clocked only while that pin is low, and a chip that set cs to
        -1 has no select line and is always on the bus (a 74HC595). The level
        comes from pin_level, so a select wired to a board GPIO follows the
        guest and one on a chip net follows whatever drives that net.
        """
        if not self.spi_config:
            return False
        handle = int(self.spi_config.get("cs", -1))
        if handle < 0:
            return True
        return self.pin_level(handle) == 0

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
        # One byte in and one byte out of the chip's armed buffer, straight
        # through the cached view: this is the per-byte path (see _mem_view).
        view = self._mem_view()
        off = self._spi_buffer_ptr + self._spi_buffer_pos
        miso_byte = view[off]          # the chip's pre-filled response
        view[off] = mosi & 0xFF        # what the master sent, for on_done
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
            # The callback runs "at" its deadline: vx_sim_now_nanos answers the
            # scheduled instant, not the moment the scheduler thread woke up.
            # A periodic timer's deadlines are exact multiples of its period,
            # so the edges a chip places from its callback are spaced exactly
            # in that timeline whatever the host's wake-up lag was, and a net
            # edge published from here is stamped with that instant (see
            # ChipNetBus.drive) rather than with the lag.
            prev_override = self._now_override_ns
            self._now_override_ns = int(t["next_fire_ns"])
            try:
                self._call_indirect(t["cb_idx"], t["user_data"])
            finally:
                self._now_override_ns = prev_override
            with self._timer_lock:
                if t["repeat"]:
                    t["next_fire_ns"] += t["period_ns"]
                else:
                    t["active"] = False
        self._flush_stdout()
