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
- vx_sim_now_nanos and the timers, on the clock the host hands over (the
  QEMU workers pass the guest's virtual clock; without one, host time)
- SPI, one armed buffer per vx_spi_attach handle, behind the chip's own select
- UART, pin watch, framebuffer

The contract every call follows is the header's (backend/sdk/velxio-chip.h),
and the browser runtime (frontend/src/simulation/customChips/ChipRuntime.ts)
answers the same for the same call: one chip model runs beside the CPU here
and in the tab, and the cross-host table
(frontend/src/__tests__/board-buses/fixtures/chips-abi-parity/) is what holds
the two to one answer.
"""
from __future__ import annotations

import hashlib
import heapq
import json
import struct
import functools
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


class _RawCallApi:
    """wasmtime's unchecked call, bound as a bare C function of addresses.

    `wasmtime_func_call_unchecked` takes the arguments and the results in one
    array of raw values and checks no type, so a caller that has checked the
    type once can fill that array in place and call with plain integers. Bound
    here with void* arguments, ctypes converts nothing per call: about 2 us an
    i2c callback against 10 us through _fast_call and 14 us through the
    generic path, measured on buses/models/ds1307.c (project
    i2c-model-fidelity-2026-09, P5 step 2). Probed once; a wasmtime without it
    keeps the other paths (WasmChipRuntime.export_caller).
    """

    def __init__(self, bindings, trap_cls, error_cls, raise_last) -> None:
        addr = ctypes.cast(bindings.dll.wasmtime_func_call_unchecked, ctypes.c_void_p).value
        self.call = ctypes.CFUNCTYPE(
            ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p,
            ctypes.c_size_t, ctypes.c_void_p)(addr)
        vp = ctypes.c_void_p
        self.memory_size = ctypes.CFUNCTYPE(ctypes.c_size_t, vp, vp)(
            ctypes.cast(bindings.dll.wasmtime_memory_data_size, vp).value)
        self.memory_data = ctypes.CFUNCTYPE(vp, vp, vp)(
            ctypes.cast(bindings.dll.wasmtime_memory_data, vp).value)
        self.val_raw_t = bindings.wasmtime_val_raw_t
        self.trap_t = bindings.wasm_trap_t
        self.error_t = bindings.wasmtime_error_t
        self.trap_cls = trap_cls
        self.error_cls = error_cls
        self.raise_last = raise_last


def _probe_raw_call():
    try:
        from wasmtime import _bindings as _wt_bindings
        from wasmtime._func import maybe_raise_last_exn as _raise_last
        api = _RawCallApi(_wt_bindings, wasmtime.Trap, wasmtime.WasmtimeError, _raise_last)
        _ = ctypes.sizeof(api.val_raw_t), api.trap_t, api.error_t
        return api
    except Exception:  # noqa: BLE001 - any shape change falls back
        return None


_RAW_CALL = _probe_raw_call()


class _PeekGuard:
    """Whether the chip is running ahead of the bus, and what it did then.

    A model that serves reads ahead of the master (chip_i2c_peek in
    buses/models/i2c_host.h) runs its on_read for bytes not asked for yet and
    then puts its memory back, so it is only a read-ahead while nothing
    outside that memory saw it: a host function called in it (a pin driven,
    the guest clock read, a log line) would be seen, or would make the byte
    depend on when it is read. The model says in its own memory that it is
    peeking (`flag_at`, i2c_host_state[0]); while it is, every host function
    answers a neutral value and does nothing, and marks the peek
    (i2c_host_state[1]), which the model then throws away. The host asks for
    those bytes one at a time.
    """

    __slots__ = ("runtime", "flag_at")

    def __init__(self, runtime: "WasmChipRuntime") -> None:
        self.runtime = runtime
        self.flag_at: int | None = None

    def peeking(self) -> bool:
        at = self.flag_at
        if at is None:
            return False
        runtime = self.runtime
        base = runtime.mem_address()
        # The flag and the mark are two bytes of the chip's memory, read and
        # written through its address: one the memory does not hold is no
        # flag (watch_peeks refuses it; this keeps a host that sets flag_at
        # by hand inside the memory as well).
        if at < 0 or at + 2 > runtime._mem_size:
            return False
        if not ctypes.c_uint8.from_address(base + at).value:
            return False
        ctypes.c_uint8.from_address(base + at + 1).value = 1
        return True


def _guarded(func, ty, guard: _PeekGuard):
    results = list(ty.results)
    if not results:
        neutral = None
    elif str(results[0]) in ("f32", "f64"):
        neutral = 0.0
    else:
        neutral = 0

    def call(*args):
        if guard.peeking():
            return neutral
        return func(*args)

    return call




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
#   offset 28 : on_exchange  (function index, 0 = none; was reserved[0])
#   offset 32 : reserved[7]  (28 bytes, ignored)
_SPI_CONFIG_FMT = "<IIIIIIII"     # 32 bytes (ignore reserved trailer)


class _SpiHandle:
    """One vx_spi_attach: its config and the buffer the chip has armed on it.

    A chip with two handles is two devices on the bus, each behind its own
    select and each with its own buffer, exactly as ChipRuntime.ts keeps one
    SPIDevice per handle. The runtime used to keep one config and one buffer
    for the whole chip, so the second attach silently replaced the first and
    every on_done saw the last vx_spi_start's pointer (finding
    spi-done-bufptr-shared, on the worker side).
    """

    __slots__ = ('cfg', 'ptr', 'count', 'pos', 'cache', 'cache_lo', 'gen')

    def __init__(self, cfg: dict) -> None:
        self.cfg = cfg
        self.ptr = 0        # WASM ptr of the armed buffer
        self.count = 0      # bytes armed; 0 = nothing armed
        self.pos = 0        # bytes exchanged so far
        # A Python copy of a long armed buffer (see spi_transfer_byte) and
        # the first position whose MOSI it holds and wasm memory does not yet.
        self.cache: bytearray | None = None
        self.cache_lo = 0
        # Bumped by every vx_spi_start, so a completion can tell whether the
        # chip re-armed from inside on_done.
        self.gen = 0

    def arm(self, ptr: int, count: int) -> None:
        self.cache = None
        self.ptr = ptr
        self.count = count
        self.pos = 0
        self.gen += 1

    def clear(self) -> None:
        self.cache = None
        self.ptr = 0
        self.count = 0
        self.pos = 0


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
            to_host = getattr(rt, "host_ns_of", None)
            if override is not None and to_host is not None:
                return int(to_host(int(override)))
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


def hosted_model_identity(model: dict, cs=None, bus_id=None) -> str:
    """What makes a hosted bus model the SAME device across two bus maps.

    Every host (the ESP32 and STM32 workers, the Pi's responder set) rebuilds
    its models from the map the tab publishes on each membership change, and
    the map carries each model's blobs as the TAB last knew them. The card a
    guest has been writing to is newer than that copy until the written spans
    (`bus_blob`) reach the tab, so rebuilding a card from a republished map
    undoes whatever the guest wrote in between. A host keeps the running
    instance when this value has not changed.

    In: the wasm bytes, the select (`cs`, `bus_id`, the Pi's `cs_pin`) and the
    pin map, because a different artifact or a different wiring is a
    different device. Out: live attributes, which have their own channel
    (`bus_attrs`) and are applied to a kept model, and the blob CONTENTS,
    which are exactly what the race makes stale.

    What a blob stands for is in: `blob_ids` is the tab naming the image it
    loaded, and it changes when the user loads another card and never when a
    guest write lands on the same one. That is the only way a host can tell
    "the tab is behind" from "the tab swapped the card"; both look like
    different bytes. A map that names no id (a page older than the ids) falls
    back to the contents, which can never serve a card the user replaced, at
    the price of the old race for that page only.
    """
    digest = hashlib.sha256()

    def part(value) -> None:
        digest.update(json.dumps(value, sort_keys=True, default=str).encode('utf-8'))
        digest.update(b'\x00')

    part(str(model.get('wasm_b64') or ''))
    part(cs)
    part(bus_id)
    part(str(model.get('cs_pin') or ''))
    pins = model.get('pin_map')
    part({str(k): v for k, v in pins.items()} if isinstance(pins, dict) else {})
    blobs = model.get('blobs') if isinstance(model.get('blobs'), dict) else {}
    ids = model.get('blob_ids') if isinstance(model.get('blob_ids'), dict) else {}
    lineage = {}
    for name in sorted({str(n) for n in blobs} | {str(n) for n in ids}):
        if ids.get(name):
            lineage[name] = 'id:' + str(ids[name])
        else:
            raw = blobs.get(name)
            data = raw.encode('ascii', 'ignore') if isinstance(raw, str) else bytes(raw or b'')
            lineage[name] = 'sha256:' + hashlib.sha256(data).hexdigest()
    part(lineage)
    return digest.hexdigest()


class _CompiledModule:
    """A module compiled once, the engine it belongs to, and the imports it
    names. A Store must be made from the module's engine, so the two travel
    together."""

    __slots__ = ("engine", "module", "imports")

    def __init__(self, wasm_bytes: bytes) -> None:
        self.engine = wasmtime.Engine()
        self.module = wasmtime.Module(self.engine, wasm_bytes)
        self.imports = frozenset((i.module, i.name) for i in self.module.imports)


# Modules compiled for `share_module` runtimes, by the sha256 of their bytes,
# least recently used first. The compile is most of what building a runtime
# costs (8 to 20 ms for a 7 KB model on this host), and a part that attaches
# again on every Run brings the same bytes every time.
_MODULE_CACHE: "dict[str, _CompiledModule]" = {}
_MODULE_CACHE_MAX = 16
_MODULE_CACHE_LOCK = threading.Lock()


def _compiled_module(wasm_bytes: bytes) -> _CompiledModule:
    key = hashlib.sha256(wasm_bytes).hexdigest()
    with _MODULE_CACHE_LOCK:
        hit = _MODULE_CACHE.pop(key, None)
        if hit is not None:
            _MODULE_CACHE[key] = hit
            return hit
    compiled = _CompiledModule(wasm_bytes)
    with _MODULE_CACHE_LOCK:
        _MODULE_CACHE[key] = compiled
        while len(_MODULE_CACHE) > _MODULE_CACHE_MAX:
            _MODULE_CACHE.pop(next(iter(_MODULE_CACHE)))
    return compiled


class _ImportedOnly:
    """A linker that defines only the host functions the module imports.
    Defining the whole ABI costs a few milliseconds per runtime (a FuncType
    and a trampoline each), and a register model imports a handful of it."""

    def __init__(self, linker: wasmtime.Linker, imports: frozenset,
                 guard: "_PeekGuard | None" = None) -> None:
        self._linker = linker
        self._imports = imports
        self._guard = guard

    def define_func(self, module: str, name: str, ty, func) -> None:
        if (module, name) in self._imports:
            if self._guard is not None:
                func = _guarded(func, ty, self._guard)
            self._linker.define_func(module, name, ty, func)


def _under_entry_lock(method):
    """Serialise a public entry into the chip.

    The runtime is not safe between threads by itself: a wasmtime Store is
    entered by whichever thread calls, and the workers have two that do (the
    QEMU thread delivering pin edges, bus bytes and UART bytes, and the chip
    timer thread firing deadlines). The ESP32 worker serialises them under
    QEMU's iothread lock; the STM32 worker has no such symbol, so there a chip
    with a timer and a pin watch entered the same Store from two threads at
    once (seen as a guest hang on the F7 rig without the BQL). One reentrant
    lock per runtime around every entry closes it, in every host: a callback
    that re-enters the runtime from inside the chip (a pin watch answering with
    vx_pin_write, a timer arming another) is on the same thread and passes.
    """
    @functools.wraps(method)
    def wrapper(self, *args, **kwargs):
        with self._entry_lock:
            return method(self, *args, **kwargs)
    return wrapper


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
        uart_writer: Optional[Callable[[bytes], None]] = None,
        timer_scheduler: Optional[Callable[["WasmChipRuntime"], None]] = None,
        net_map: dict[str, str] | None = None,
        net_bus: Optional[ChipNetBus] = None,
        display: dict | None = None,
        component_id: str | None = None,
        blobs: dict[str, bytes] | None = None,
        clock: Optional[Callable[[], int]] = None,
        pad_volts: dict[str, float | None] | None = None,
        pin_releaser: Optional[Callable[[int], None]] = None,
        live_attrs: Optional[Callable[[str], "float | str | None"]] = None,
        share_module: bool = False,
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
            uart_writer: (bytes) -> void: what the chip transmits (vx_uart_write).
                         Which guest UART the bytes land in is not the chip's
                         to say: the worker's bus table answers per write from
                         the tab's wiring map (uart_bus_table.py), and a chip
                         the map puts on no controller writes into the air.
            timer_scheduler: callback invoked when the chip arms a timer; the worker
                             starts the actual scheduling thread.
            net_map:    {chip_pin_name: net_id} - chip pins that share a diagram net
                        with another chip's pin. Resolved by the frontend with the
                        same union-find over wires that chipNets.ts uses. Omitted
                        by older frontends, which is why it defaults to empty.
            net_bus:    the shared ChipNetBus every chip in this worker registers
                        its net pins on.
            display:    chip.json's `display: {width, height}` - the framebuffer
                        vx_framebuffer_init hands the chip. Same default as the
                        browser runtime (128x64) when the chip declares none.
            component_id: the canvas component this chip is, so a framebuffer
                        frame can be routed to its element (like ePaper frames).
            blobs:      named byte storage for vx_blob_* (the microSD card
                        image arrives as "card"). Raw bytes; decode_blobs()
                        turns the base64 that travels on the wire into them.
            clock:      () -> ns, the guest's clock: what vx_sim_now_nanos
                        answers and what the timer deadlines are on. The QEMU
                        workers pass QEMU_CLOCK_VIRTUAL, the clock the guest's
                        own micros() counts, so a chip that measures a pulse
                        or paces a timer agrees with the sketch whatever the
                        host's load (memory: parts run on the guest clock,
                        never the wall clock). None keeps host time, which
                        is all a host without a guest clock has.
            pad_volts:  {chip_pin_name: volts} - the voltage the tab's circuit
                        solve publishes for the net each pad is on, for every
                        pad a wire reaches (the tab lists the pads in the air
                        as None). What vx_pin_read_analog answers, and what
                        vx_pin_wired reads; see update_pad_volts. The tab's
                        padVolts.ts computes the same numbers the browser
                        runtime reads, so both hosts answer alike.
            pin_releaser: (gpio) -> void - the chip stopped driving a mapped
                        GPIO (vx_pin_set_mode to an input mode). The worker's
                        pad model (pad_model.py) then decides the pad: the
                        guest's output, another driver, or a module's pull.
                        Absent, a release changes nothing, as before.
            live_attrs: (name) -> value - attributes the host answers at the
                        moment the chip reads them, ahead of `attrs`: a float
                        for vx_attr_read, a str for vx_attr_string_read, None
                        to fall through. The browser runtime's `liveAttrs`:
                        the wall clock a real-time clock counts and the build
                        times it compares with (buses/models/rtc.h).
            share_module: compile the bytes once per process and reuse the
                        module for every runtime built from the same bytes,
                        and define only the host functions the module imports
                        (_compiled_module). For a model a part attaches on
                        every Run (buses/models/ds1307.c, ds3231.c, bmp280.c);
                        off, each runtime compiles its own, as before. Such a
                        runtime can also run the model ahead of the bus
                        (watch_peeks, _PeekGuard).
        """
        compiled = _compiled_module(wasm_bytes) if share_module else None
        self._engine = compiled.engine if compiled else wasmtime.Engine()
        self._store = wasmtime.Store(self._engine)
        # Every public entry takes this (see _under_entry_lock). Created before
        # anything else so update_pad_volts and friends can run from __init__.
        self._entry_lock = threading.RLock()
        self._module = compiled.module if compiled else wasmtime.Module(self._engine, wasm_bytes)

        # Provide the linear memory (the WASM is compiled with --import-memory)
        self._memory = wasmtime.Memory(
            self._store, wasmtime.MemoryType(wasmtime.Limits(2, 16))
        )

        # See _mem_view / _call_indirect: both caches are dropped whenever wasm
        # runs, which is the only thing that can invalidate them. A handle's
        # buffer copy (_SpiHandle.cache) is written back by the same hook.
        self._mem_view_cache = None
        self._fn_cache: dict[int, object] = {}
        self._fast_cache: dict[int, object] = {}

        self._attrs = {k: v for k, v in (attrs or {}).items()
                       if isinstance(v, (int, float))}
        # String attribute values (vx_attr_register_string) ride the same
        # attrs payload; split by type.
        self._str_attrs = {k: v for k, v in (attrs or {}).items()
                           if isinstance(v, str)}
        self._live_attrs = live_attrs
        self._emit = emit or (lambda _payload: None)
        self._stdout_buf = ""

        # External plumbing
        self._pin_map = dict(pin_map or {})       # logical name → real GPIO
        self._pin_writer = pin_writer
        self._pin_reader = pin_reader
        self._pin_releaser = pin_releaser
        self._uart_writer = uart_writer
        self._timer_scheduler = timer_scheduler
        self._net_map = {str(k): str(v) for k, v in (net_map or {}).items()}
        self._net_bus = net_bus

        # Per-instance state
        self._pins: list[dict] = []           # [{name, mode, value, gpio, net}]
        self._attr_handles: list[dict] = []   # [{name, default}]
        # Solved voltage per chip pin name, for the pads a wire reaches.
        self._pad_volts: dict[str, float] = {}
        self.update_pad_volts(pad_volts or {})

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

        # I2C state populated by vx_i2c_attach: one entry per call, in call
        # order. A chip that attaches two addresses on one SDA/SCL is one chip
        # with two targets (the browser runtime keeps them the same way); each
        # START selects the entry whose address it names, and the STOP goes
        # to every entry addressed since the last one.
        self._i2c_devices: list[dict] = []        # [{address, on_connect, on_read, on_write, on_stop, user_data}]
        self._i2c_current: dict | None = None     # the entry the last START addressed
        self._i2c_touched: list[dict] = []        # entries addressed since the last STOP

        # UART state — at most one UART per chip in MVP
        self.uart_config: dict | None = None      # {rx, tx, baud_rate, on_rx_byte, on_tx_done, user_data}
        # Which of the board's UARTs the chip is on is not kept here: the
        # worker's bus table decides per byte from the tab's wiring map
        # (uart_bus_table.py), and a chip on no controller is silent.

        # SPI state: one entry per vx_spi_attach (see _SpiHandle).
        self._spi_handles: list[_SpiHandle] = []
        # Set once a buffer outside the chip's memory was refused, so the
        # chip is told the first time and not on every arm.
        self._spi_refused = False

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

        # The chip's clock. With `clock`, vx_sim_now_nanos is what it answers;
        # without one, host time since this instance was made (_t0).
        self._clock = clock
        self._t0 = time.monotonic_ns()
        # Set while a remote net edge is delivered (notify_net_change with a
        # stamp), and while a timer callback runs (fire_due_timers): the
        # instant the chip's callbacks read as "now". PER THREAD: the timer
        # thread fires a callback at its deadline while QEMU's thread delivers
        # a pin edge, and the edge's callback must read the clock, not the
        # other thread's deadline. The ESP32 worker serialises the two under
        # the iothread lock; the STM32 worker has no such lock to take, and
        # a 1 ms chip timer there stamped every edge with its own deadline.
        self._override = threading.local()

        # Build the linker
        linker = wasmtime.Linker(self._engine)
        # A shared module is a bus model (buses/models/), which a host may
        # run ahead of the bus: its host functions stand still while it does.
        self._peek_guard = _PeekGuard(self) if compiled else None
        self._mem_size = -1
        self._mem_base = 0
        self._mem_handles: tuple[int, int] | None = None
        defs = _ImportedOnly(linker, compiled.imports, self._peek_guard) if compiled else linker
        self._define_wasi(defs)  # type: ignore[arg-type]
        self._define_velxio(defs)  # type: ignore[arg-type]
        linker.define(self._store, "env", "memory", self._memory)

        self._instance = linker.instantiate(self._store, self._module)
        self._exports = self._instance.exports(self._store)

    @property
    def _now_override_ns(self) -> int | None:
        return getattr(self._override, "ns", None)

    @_now_override_ns.setter
    def _now_override_ns(self, value: int | None) -> None:
        self._override.ns = value

    # ── Lifecycle ─────────────────────────────────────────────────────────────

    @_under_entry_lock
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

    # ── What the chip declared ───────────────────────────────────────────────

    @property
    def spi_config(self) -> dict | None:
        """The first vx_spi_attach's config (the dict the handle answers
        from, so a host that edits it edits the live one), None when the
        chip declared no SPI. The workers ask this to know whether to put the
        chip on their bus table."""
        return self._spi_handles[0].cfg if self._spi_handles else None

    def spi_handle_count(self) -> int:
        """How many SPI handles the chip attached: each is a device of its
        own on the bus, behind its own select."""
        return len(self._spi_handles)

    @property
    def _spi_cache(self) -> bytearray | None:
        """Handle 0's buffer copy; kept so a host can see the copy is in use."""
        return self._spi_handles[0].cache if self._spi_handles else None

    @property
    def i2c_address(self) -> int | None:
        """The first address the chip attached, None when it declared no I2C.
        The Linux-board adapter and the workers' logs read this one."""
        return self._i2c_devices[0]["address"] if self._i2c_devices else None

    @property
    def i2c_addresses(self) -> list[int]:
        """Every address the chip attached, in call order, each once: what a
        worker registers on its bus table so all of them answer."""
        out: list[int] = []
        for d in self._i2c_devices:
            if d["address"] not in out:
                out.append(d["address"])
        return out

    @property
    def i2c_callbacks(self) -> dict | None:
        """The entry a START last addressed, else the last attach: the config
        call_i2c_callback answers from when no address is given."""
        if self._i2c_current is not None:
            return self._i2c_current
        return self._i2c_devices[-1] if self._i2c_devices else None

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
        # Wasm is about to run: the chip must find in its buffer every MOSI
        # byte the master has clocked so far, and may rewrite what is left.
        for st in self._spi_handles:
            if st.cache is not None:
                self._spi_sync(st)
        self._mem_view_cache = None

    # A buffer at least this long is served from a Python copy. Every byte
    # through the ctypes view costs a read and a write across it, which for
    # a streamed card sector (one 514-byte buffer) was most of the model's
    # price in the worker; a copy costs one memmove each way. A short buffer
    # (a command byte, a register) is cheaper to serve in place.
    _SPI_CACHE_MIN = 16

    def _spi_frame_done(self, st: _SpiHandle) -> None:
        """The last byte of an armed buffer went out: on_done, once, with the
        buffer the chip armed on THIS handle. For a buffer served from the
        copy, on_done runs wasm, which writes the copy back first
        (_drop_mem_view), so the chip sees the whole frame exactly as it does
        for a buffer served in place.

        Afterwards the transfer is over. The chip may have re-armed from
        inside on_done (the 74HC595 idiom), and then the new buffer stands;
        if it did not, nothing is armed: the next byte reads the idle level
        and a vx_spi_stop reports nothing, as SPIDevice does in the browser.
        The old code left the finished buffer armed, so the vx_spi_stop every
        CS-gated chip issues on the rising edge fired on_done a second time
        with the same frame (PHASES.md F7, the worker's first divergence).
        """
        gen = st.gen
        on_done = st.cfg.get("on_done", 0)
        if on_done:
            self._call_indirect(on_done, st.cfg["user_data"], st.ptr, st.count)
        elif st.cache is not None:
            self._spi_sync(st)
        self._flush_stdout()
        if st.gen == gen:
            st.clear()

    def _spi_sync(self, st: _SpiHandle) -> None:
        """Put the MOSI bytes the cached buffer took back into wasm memory and
        forget the copy: after wasm runs, the chip may have re-armed or
        rewritten the rest of it."""
        cache = st.cache
        st.cache = None
        if cache is None:
            return
        lo, hi = st.cache_lo, min(st.pos, len(cache))
        if hi > lo:
            view = self._mem_view()
            # Only a buffer inside the chip's memory is ever armed
            # (vx_spi_start); this keeps the write there whatever armed it.
            if st.ptr + lo < 0 or st.ptr + hi > len(view):
                return
            ctypes.memmove(ctypes.addressof(view) + st.ptr + lo,
                           bytes(cache[lo:hi]), hi - lo)

    def _holds(self, ptr: int, length: int) -> bool:
        """Whether the `length` bytes at `ptr` all lie in the chip's linear
        memory. Asked of the engine, so it is right from inside a host call
        too, where the cached view may be stale."""
        return 0 <= ptr and 0 <= length and ptr + length <= self._memory.data_len(self._store)

    def _refuse_spi_buffer(self, st: _SpiHandle | None = None) -> int:
        """A buffer the chip's memory does not hold is not served: nothing is
        armed (the line idles high, no on_done follows) and the chip's console
        gets one line saying so, the first time. Returns the idle MISO byte.
        The bytes of an SPI buffer are read and written through the memory's
        address, so this is what keeps them inside it. (The tab's runtime
        reads such bytes as 0xFF and drops the writes; velxio-chip.h has the
        buffer in the chip's own memory, which every chip in the tree keeps.)"""
        if st is not None:
            st.clear()
        if not self._spi_refused:
            self._spi_refused = True
            self._emit({"type": "chip_error", "where": "spi_start",
                        "error": "vx_spi_start: the buffer is not inside the chip's "
                                 "memory; nothing was armed"})
        return 0xFF

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
        sck, mosi, miso, cs, mode, on_done, user_data, on_exchange = \
            struct.unpack(_SPI_CONFIG_FMT, raw)
        return {
            "sck": sck, "mosi": mosi, "miso": miso, "cs": cs, "mode": mode,
            "on_done": on_done, "user_data": user_data, "on_exchange": on_exchange,
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

        def fd_fdstat_get(fd, stat_ptr):
            # wasi-libc's isatty asks this, and stdout's buffering hangs on
            # the answer: a character device without seek/tell rights is a
            # terminal, so printf flushes at every newline; anything else
            # switches stdout to full buffering after its first write. It
            # used to answer success without writing the struct, so a chip's
            # first printf line came out and the rest sat in libc's 1 KB
            # buffer (finding chip-printf-fully-buffered). Same answer as
            # the browser runtime's WasiShim.
            if fd < 0 or fd > 2:
                return 8  # EBADF
            # __wasi_fdstat_t: u8 filetype (2 = CHARACTER_DEVICE), u16 flags,
            # u64 rights_base (FD_READ for stdin, FD_WRITE otherwise; never
            # FD_SEEK or FD_TELL), u64 rights_inheriting. 24 bytes.
            rights = 1 << 1 if fd == 0 else 1 << 6
            self._memory.write(self._store, struct.pack("<BBHIQQ", 2, 0, 0, 0, rights, 0), stat_ptr)
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
            # `seen`: the host has reported a level on this pad at least
            # once (notify_pin_change), so `value` is a level and not the
            # registration default. Until then an input reads its pull.
            self._pins.append({"name": name, "mode": mode, "value": initial,
                               "gpio": gpio, "net": net, "seen": False})
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
            # The voltage the tab's solve published for the pad's net (pad_volts),
            # the same number the browser runtime reads off the electrical
            # store; 0 for a pad in the air or on a net without a number. It
            # used to answer the pin's DIGITAL level times five (finding
            # vx-pin-read-analog-answers-neither-host-the-solve).
            if 0 <= handle < len(self._pins):
                return float(self._pad_volts.get(self._pins[handle]["name"], 0.0))
            return 0.0

        def vx_pin_wired(handle: int) -> int:
            # A wire reaches the pad: the tab published a voltage for it, or
            # mapped it to a guest GPIO or a chip net.
            if not (0 <= handle < len(self._pins)):
                return 0
            p = self._pins[handle]
            wired = (p["name"] in self._pad_volts
                     or p.get("gpio") is not None
                     or p.get("net") is not None)
            return 1 if wired else 0

        def vx_pin_dac_write(_handle: int, _voltage: float) -> None:
            return

        def vx_pin_pwm_write(_handle: int, _duty: float) -> None:
            # The QEMU-hosted boards have no duty-cycle channel to report on,
            # but the import has to exist: a chip that calls it would fail to
            # instantiate here, taking the whole board down with it.
            return

        def vx_pin_set_mode(handle: int, mode: int) -> None:
            if not (0 <= handle < len(self._pins)):
                return
            p = self._pins[handle]
            p["mode"] = mode
            # VX_OUTPUT_LOW / VX_OUTPUT_HIGH carry a level, at set_mode as at
            # registration: the open-drain idiom pulls a line with
            # set_mode(VX_OUTPUT_LOW) and never writes it (the browser runtime
            # drives it the same way). Plain VX_OUTPUT drives nothing until
            # the first vx_pin_write (velxio-chip.h).
            if mode in (self.MODE_OUTPUT_LOW, self.MODE_OUTPUT_HIGH):
                vx_pin_write(handle, 1 if mode == self.MODE_OUTPUT_HIGH else 0)
            # VX_INPUT (and the input pulls, and VX_ANALOG) is the documented
            # tri-state idiom: the chip lets go of the pad. QEMU's pin
            # injection carries a level and no float state, so what the pad
            # reads now is the worker's to say: its pad model (pad_model.py)
            # hands it back to the guest's output, another driver, or a
            # module's pull resistor, and a pad none of those decides keeps
            # the chip's last level, as before.
            elif (mode != 1 and p["gpio"] is not None
                    and self._pin_releaser is not None):
                try:
                    self._pin_releaser(p["gpio"])
                except Exception as e:
                    self._emit({"type": "chip_error", "where": "pin_release", "error": str(e)})

        def vx_pin_watch(handle: int, edge: int, cb_idx: int, user_data: int) -> None:
            if not (0 <= handle < len(self._pins)):
                return
            p = self._pins[handle]
            if p["gpio"] is None and p["net"] is None:
                # Chip's logical pin is on neither a real GPIO nor a chip net -
                # no edges to detect.
                return

            # The watch starts from the level the pin reads NOW (pin_level:
            # the guest's level when reported, the pull when never driven),
            # the way the browser's watch starts from the PinManager's level.
            # It used to start from the registration default (0), so a
            # pulled-up select the guest first drives high fired a rising
            # edge no silicon would see.
            start = self.pin_level(handle) & 1

            def _entry() -> dict:
                return {
                    "handle": handle,
                    "edge": edge & 3,
                    "cb_idx": cb_idx,
                    "user_data": user_data,
                    "last_value": start,
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
                if self._live_attrs is not None:
                    live = self._live_attrs(a["name"])
                    if isinstance(live, (int, float)) and not isinstance(live, bool):
                        return float(live)
                return float(self._attrs.get(a["name"], a["default"]))
            return 0.0

        # ── I2C ──
        def vx_i2c_attach(cfg_ptr: int) -> int:
            # Every attach is kept: a chip on two addresses is two targets on
            # one pair of pins. Returns 0 like the browser runtime, so a chip
            # reads the same handle in every host.
            cfg = self._read_i2c_config(cfg_ptr)
            cfg["address"] = cfg["address"] & 0x7F
            self._i2c_devices.append(cfg)
            return 0

        # ── UART ──
        def vx_uart_attach(cfg_ptr: int) -> int:
            self.uart_config = self._read_uart_config(cfg_ptr)
            return 0

        def vx_uart_write(_handle: int, buf_ptr: int, count: int) -> int:
            # An empty write puts nothing on the wire and still completes,
            # as it does in the browser runtime: on_tx_done is the chip's
            # pacing signal, and a host that skips it for zero bytes leaves a
            # state machine waiting.
            data = self._read_bytes(buf_ptr, count) if count > 0 else b""
            if data and self._uart_writer is not None:
                try:
                    # The bytes only: the worker's bus table puts them in the
                    # guest UART whose RX the chip's TX pad is wired to, as the
                    # tab mapped it, or nowhere. Until board-buses F6 the chip
                    # resolved a UART itself from a static table the tab sent,
                    # and landed on Serial1 when nothing matched.
                    self._uart_writer(data)
                except Exception as e:
                    self._emit({"type": "chip_error", "where": "uart_write", "error": str(e)})
                    return 0
            # Notify chip that the TX completed (synchronous in our model).
            if self.uart_config and self.uart_config["on_tx_done"]:
                self._call_indirect(self.uart_config["on_tx_done"], self.uart_config["user_data"])
            return 1

        # ── SPI ──
        def vx_spi_attach(cfg_ptr: int) -> int:
            # The handle is the index: a chip with two handles is two
            # devices, each behind its own select, as in the browser runtime.
            self._spi_handles.append(_SpiHandle(self._read_spi_config(cfg_ptr)))
            return len(self._spi_handles) - 1

        def vx_spi_start(handle: int, buf_ptr: int, count: int) -> None:
            if not (0 <= handle < len(self._spi_handles)):
                return
            st = self._spi_handles[handle]
            count = max(0, int(count))
            # The host serves the armed bytes straight from the chip's memory,
            # so a buffer that memory does not hold is never armed. The
            # memory only grows, so a buffer inside it now stays inside.
            if count and not self._holds(buf_ptr, count):
                st.arm(0, 0)
                self._refuse_spi_buffer()
                return
            # Called from inside wasm, so any copy was already written back.
            # An empty exchange arms nothing: no byte to shift, no completion.
            st.arm(buf_ptr, count)

        def vx_spi_stop(handle: int) -> None:
            if not (0 <= handle < len(self._spi_handles)):
                return
            st = self._spi_handles[handle]
            st.cache = None
            if st.count <= 0:
                # Nothing armed (or the transfer already completed and
                # reported): nothing to report. This is the case the CS idiom
                # hits on every rising edge after a full frame.
                return
            # End the exchange where it stands: on_done with the bytes
            # exchanged so far, as CS rising does.
            ptr, pos = st.ptr, st.pos
            st.clear()
            on_done = st.cfg.get("on_done", 0)
            if on_done:
                self._call_indirect(on_done, st.cfg["user_data"], ptr, pos)

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
                    live = self._live_attrs(a["name"]) if self._live_attrs else None
                    v = live if isinstance(live, str) else self._str_attrs.get(
                        a["name"], a["string_default"])
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
            "vx_pin_wired":        (wasmtime.FuncType([i32], [i32]),      vx_pin_wired),
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
        """The chip's "now": the clock the host handed over (the guest's), or
        host time since this instance was made."""
        if self._clock is not None:
            return int(self._clock())
        return time.monotonic_ns() - self._t0

    # The cross-worker net bridge stamps every edge on CLOCK_MONOTONIC, the
    # one timeline two workers on a host share, and a chip's instants are on
    # its own clock. These two map between them: on host time the map is the
    # fixed origin _t0; on a guest clock it is the offset between the two
    # clocks right now, which keeps the spacing between edges (what a
    # self-clocked protocol measures) as long as guest and host time run at
    # the same rate, as they do without -icount.

    def host_ns_of(self, chip_ns: int) -> int:
        """CLOCK_MONOTONIC at the chip instant `chip_ns`."""
        if self._clock is None:
            return int(self._t0) + int(chip_ns)
        return time.monotonic_ns() - (int(self._clock()) - int(chip_ns))

    def chip_ns_of(self, host_ns: int) -> int:
        """The chip's instant at CLOCK_MONOTONIC `host_ns`."""
        if self._clock is None:
            return int(host_ns) - int(self._t0)
        return int(self._clock()) - (time.monotonic_ns() - int(host_ns))

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

    @_under_entry_lock
    def call_i2c_callback(self, name: str, *args: int, address: int | None = None) -> int:
        """Invoke one of {on_connect, on_read, on_write, on_stop} via indirect
        call, on the target the transaction is for.

        `on_connect` names the address the master put on the wire: the entry
        attached at that address takes the transaction (a chip with two
        addresses is two targets), and an address the chip never attached
        falls back to the entry a host without the address would have used,
        the last attach, so a single-address chip answers as before. A read
        or write goes to the entry the last START selected. The STOP is the
        bus's: every entry addressed since the last STOP sees it, in the
        order they were addressed, which is what the browser runtime does
        and what the silicon of a two-address chip does.
        """
        if not self._i2c_devices:
            return 0
        if name == "on_stop":
            touched = self._i2c_touched or ([self._i2c_current] if self._i2c_current else [])
            self._i2c_touched = []
            self._i2c_current = None
            result = 0
            for dev in touched:
                result = self._call_indirect(dev.get("on_stop", 0), dev["user_data"])
            self._flush_stdout()
            return result
        if name == "on_connect":
            addr = address if address is not None else (int(args[0]) if args else None)
            dev = None
            if addr is not None:
                for d in self._i2c_devices:
                    if d["address"] == (int(addr) & 0x7F):
                        dev = d
                        break
            if dev is None:
                dev = self._i2c_devices[-1]
            self._i2c_current = dev
            if dev not in self._i2c_touched:
                self._i2c_touched.append(dev)
        else:
            dev = self._i2c_current or self._i2c_devices[-1]
        result = self._call_indirect(dev.get(name, 0), dev["user_data"], *args)
        self._flush_stdout()
        return result

    @_under_entry_lock
    def call_export(self, name: str) -> int:
        """Call a function the chip exports by name, with no arguments, and
        return its i32 result (0 for none). For a host that asks a model for
        more than the bus callbacks, such as the register file the Pi relay
        mirrors (chip_dump_registers in buses/models/ds3231.c)."""
        fn = self._exports.get(name)
        if fn is None:
            raise KeyError(f"chip WASM does not export {name}")
        self._drop_mem_view()
        result = fn(self._store)
        self._drop_mem_view()
        self._flush_stdout()
        return int(result or 0)

    def read_memory(self, ptr: int, length: int) -> bytes:
        """`length` bytes of the chip's linear memory from `ptr`."""
        if _RAW_CALL is None:
            return self._read_bytes(ptr, length)
        with self._entry_lock:
            base = self.mem_address()
            if ptr < 0 or length < 0 or ptr + length > self._mem_size:
                raise IndexError("read outside the chip's memory")
            return ctypes.string_at(base + ptr, length)

    def export_caller(self, name: str) -> Callable[..., int]:
        """A function that calls the export `name` with i32 arguments and
        returns its i32 result (0 for none), under the entry lock, on the
        cheapest path this wasmtime offers.

        For a host that calls the same export for every bus event (the
        whole-event entry of buses/models/i2c_host.h): the function's type is
        checked here once, the value array and the trap slot are made once,
        and a call is one foreign call of plain integers (_RawCallApi). An
        export of another shape, or a wasmtime without the unchecked call,
        gets the generic call behind the same signature.
        """
        fn = self._exports.get(name)
        if fn is None:
            raise KeyError(f"chip WASM does not export {name}")
        ty = fn.type(self._store)
        params = [str(p) for p in ty.params]
        results = [str(r) for r in ty.results]
        api = _RAW_CALL
        lock = self._entry_lock
        runtime = self

        if api is None or any(p != "i32" for p in params) or results not in ([], ["i32"]):
            def generic(*args: int) -> int:
                with lock:
                    runtime._drop_mem_view()
                    result = fn(runtime._store, *args)
                    if runtime._stdout_buf:
                        runtime._flush_stdout()
                    return int(result or 0)
            return generic

        nargs, nres = len(params), len(results)
        n = max(nargs, nres, 1)
        buf = (api.val_raw_t * n)()
        base = ctypes.addressof(buf)
        stride = ctypes.sizeof(api.val_raw_t)
        slots = [ctypes.c_int32.from_address(base + i * stride) for i in range(n)]
        out = slots[0]
        trap = ctypes.POINTER(api.trap_t)()
        trap_at = ctypes.addressof(trap)
        ctx = ctypes.cast(self._store._context(), ctypes.c_void_p).value
        func_at = ctypes.addressof(fn._func)
        raw = api.call
        # The array, the trap slot and the Func are what the addresses point
        # into: the closure keeps them alive.
        keep = (buf, trap, fn)

        def failed(err) -> None:
            _ = keep
            if trap:
                owned = ctypes.cast(trap, ctypes.POINTER(api.trap_t))
                ctypes.memset(trap_at, 0, ctypes.sizeof(ctypes.c_void_p))
                exc = api.trap_cls._from_ptr(owned)
                api.raise_last()
                raise exc
            raise api.error_cls._from_ptr(ctypes.cast(err, ctypes.POINTER(api.error_t)))

        def call(*args: int) -> int:
            with lock:
                # Wasm is about to run, and may grow the memory under the view.
                runtime._drop_mem_view()
                for i in range(nargs):
                    slots[i].value = args[i]
                err = raw(ctx, func_at, base, n, trap_at)
                if err or trap:
                    failed(err)
                if runtime._stdout_buf:
                    runtime._flush_stdout()
                return out.value if nres else 0

        return call

    def mem_address(self) -> int:
        """Where the chip's linear memory starts in this process. Asked of the
        engine only when the memory's size has changed (a grow can move it),
        which is one foreign call where the view costs several."""
        api = _RAW_CALL
        where = self._mem_handles
        if where is None:
            where = self._mem_handles = (
                ctypes.cast(self._store._context(), ctypes.c_void_p).value,
                ctypes.addressof(self._memory._memory))
        size = api.memory_size(*where)
        if size != self._mem_size:
            self._mem_base = api.memory_data(*where) or 0
            self._mem_size = size
        return self._mem_base

    def watch_peeks(self, flag_at: int) -> bool:
        """Guard this chip's host functions while the byte at `flag_at` of
        its memory says it is peeking (_PeekGuard). False for a runtime whose
        host functions are not wrapped (one that does not share its module),
        or a wasmtime without the calls mem_address needs: then the chip may
        not be run ahead."""
        if self._peek_guard is None or _RAW_CALL is None:
            return False
        flag_at = int(flag_at)
        # The flag and its mark are two bytes the guard reads and writes
        # through the memory's address: outside the memory there is no flag,
        # and the chip is not run ahead. The memory only grows, so an
        # address inside it now stays inside.
        self.mem_address()
        if flag_at < 0 or flag_at + 2 > self._mem_size:
            return False
        self._peek_guard.flag_at = flag_at
        return True

    @_under_entry_lock
    def write_memory(self, ptr: int, data: bytes) -> None:
        """Store `data` in the chip's linear memory at `ptr`: a host that
        pushes an input into a struct the chip exports (rtc.h, rtc_inputs)
        instead of the chip calling out for it. Through the cached view, so a
        store between two calls is one memmove; under the entry lock, since
        the panel's thread pushes while the bus thread may be in the chip."""
        if _RAW_CALL is None:
            view = self._mem_view()
            if ptr < 0 or ptr + len(data) > len(view):
                raise IndexError("write outside the chip's memory")
            ctypes.memmove(ctypes.addressof(view) + ptr, data, len(data))
            return
        base = self.mem_address()
        if ptr < 0 or ptr + len(data) > self._mem_size:
            raise IndexError("write outside the chip's memory")
        ctypes.memmove(base + ptr, data, len(data))

    # ── Live attribute updates (sensor control panel sliders) ───────────────
    @_under_entry_lock
    def update_attrs(self, attrs: dict[str, float]) -> None:
        """Apply live control values. vx_attr_read reads self._attrs on every
        call, so the running chip sees the new values immediately — no reload.
        Called from the worker's sensor_update command thread; a plain dict
        update is atomic enough under the GIL for float slots."""
        for name, value in attrs.items():
            self._attrs[str(name)] = float(value)

    @_under_entry_lock
    def update_pad_volts(self, volts: dict) -> None:
        """Apply what the tab's solve says about the chip's pads: a number is
        the voltage on that pad's net, None (a pad in the air, or a wire
        removed since the last publication) takes the pad off the table. Keys
        are the chip's own pin names, as vx_pin_register named them."""
        for name, value in (volts or {}).items():
            if isinstance(value, bool):
                continue
            if isinstance(value, (int, float)):
                self._pad_volts[str(name)] = float(value)
            else:
                self._pad_volts.pop(str(name), None)

    # ── Named blob readback (the host ships the writes onwards) ─────────────
    @_under_entry_lock
    def blob_bytes(self, name: str) -> bytes | None:
        """Current bytes of a named blob, None when the chip has no such blob."""
        blob = self._blobs.get(name)
        if blob is None:
            return None
        with self._blob_lock:
            return bytes(blob)

    @_under_entry_lock
    def blob_span(self, name: str, lo: int, hi: int) -> bytes | None:
        """Bytes [lo, hi) of a named blob. What a host sends back after a
        write is the span the chip touched; copying the whole card image to
        slice a sector out of it would cost megabytes per write."""
        blob = self._blobs.get(name)
        if blob is None:
            return None
        with self._blob_lock:
            return bytes(blob[max(0, lo):max(0, hi)])

    @_under_entry_lock
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

    @_under_entry_lock
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

    @_under_entry_lock
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
            self._now_override_ns = max(0, self.chip_ns_of(at_ns))
        try:
            self._fire_watches(entries, value)
        finally:
            self._now_override_ns = None
        self._flush_stdout()

    @_under_entry_lock
    def notify_pin_change(self, gpio: int, value: int) -> None:
        """Called by the worker for every QEMU GPIO transition. Fires any
        chip-side watches whose edge condition matches.

        Must be called while holding the QEMU IO-thread lock — the chip's
        callback can call vx_pin_write which goes back into picsimlab.
        """
        # The level is the chip's to read back (vx_pin_read) whether or not
        # it watches the pad: a hardware chip select has no GPIO the reader
        # could answer for, and the edge reported here is the only place its
        # level exists.
        v = value & 1
        for p in self._pins:
            if p["gpio"] == gpio:
                p["value"] = v
                p["seen"] = True
        entries = self._pin_watches.get(gpio)
        if not entries:
            return
        self._fire_watches(entries, v)
        self._flush_stdout()

    # ── UART hook (chip ← firmware) ──────────────────────────────────────────
    @_under_entry_lock
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
    @_under_entry_lock
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
        mode = p["mode"]
        # An output reads back what the chip drives: the pad is its own, and
        # the PinManager in the tab answers the chip's last write the same
        # way. The guest's view of that pad (a contention) is not the chip's.
        if mode in (1, self.MODE_OUTPUT_LOW, self.MODE_OUTPUT_HIGH):
            return p["value"] & 1
        # An input on a board pad reads the live QEMU level when the guest
        # has reported one. A pad the guest never drove is what the reader
        # answers None for (the workers' _pin_state has no entry): the pin
        # then reads the last level the host handed the chip on it (a
        # hardware chip select exists only as the edge the peripheral
        # reports, notify_pin_change), and before any, low. The chip's own
        # pull is not modelled on a board pin, in this host or the browser's
        # (its PinManager folds a never-driven pin into LOW too): the parts on
        # that pin inject levels with no strength, and a pull that counted
        # would beat every one of them.
        if p["gpio"] is not None and self._pin_reader is not None:
            try:
                level = self._pin_reader(p["gpio"])
            except Exception:
                level = None
            if level is not None:
                return int(level) & 1
            return p["value"] & 1
        # No board GPIO: the net level is the pin level, so a chip reads
        # what another chip on the same net last drove.
        if p["net"] is not None and self._net_bus is not None:
            level = self._net_bus.level(p["net"])
            if level is not None:
                return level & 1
        return p["value"] & 1

    # ── SPI hook (chip ← firmware) ───────────────────────────────────────────
    @_under_entry_lock
    def spi_cs_active(self, handle: int = 0) -> bool:
        """Whether the select line of SPI handle `handle` is asserted now.

        velxio-chip.h states the contract: the bus HONOURS `cfg.cs`, so the
        chip is clocked only while that pin is low, and a chip that set cs to
        -1 has no select line and is always on the bus (a 74HC595). The level
        comes from pin_level, so a select wired to a board GPIO follows the
        guest and one on a chip net follows whatever drives that net; a
        select the guest never drove reads its pull.
        """
        if not (0 <= handle < len(self._spi_handles)):
            return False
        pin = int(self._spi_handles[handle].cfg.get("cs", -1))
        if pin < 0:
            return True
        if self._pad_floats(pin):
            # A select nobody has driven is floating, and a floating select
            # is deselected: what the tab's fabric does (csWhenFloating) and
            # what the pull-up on every breakout does on the bench. It used
            # to read 0 here (the reader's default) and select the chip
            # before the sketch had touched the pad.
            return False
        return self.pin_level(pin) == 0

    def _pad_floats(self, handle: int) -> bool:
        """True when the chip pin `handle` sits on a board pad no one has
        reported a level on: neither the guest (the reader has no entry) nor
        the host (no notify_pin_change yet)."""
        p = self._pins[handle]
        if p["gpio"] is None or p.get("seen"):
            return False
        if self._pin_reader is None:
            return False
        try:
            return self._pin_reader(p["gpio"]) is None
        except Exception:
            return False

    @_under_entry_lock
    def spi_transfer_byte(self, mosi: int, handle: int = 0) -> int:
        """Called by the worker when the firmware clocks one SPI byte to the
        device that SPI handle `handle` is. Returns the byte the chip put in
        that handle's MISO buffer at the current position; overwrites that
        buffer slot with `mosi` so the chip's `on_done` callback sees what
        the master sent.
        """
        # The per-byte path of every responder a worker hosts: a streamed card
        # read comes through here 515 times a sector, so the handle is fetched
        # once and its state is read into locals and written back once.
        #
        # A copy exists only while a long buffer is armed and part-way through
        # (it is made below and dropped by vx_spi_start, vx_spi_stop and
        # whenever wasm runs), so the middle of a sector needs no other check.
        if not (0 <= handle < len(self._spi_handles)):
            return 0xFF
        st = self._spi_handles[handle]
        cache = st.cache
        if cache is not None:
            pos = st.pos
            miso_byte = cache[pos]
            cache[pos] = mosi & 0xFF
            pos += 1
            st.pos = pos
            if pos < st.count:
                return miso_byte
            self._spi_frame_done(st)
            return miso_byte
        cfg = st.cfg
        # A chip that answers each byte as it arrives (velxio-chip.h,
        # `on_exchange`) is asked here and nothing else runs: the worker and the
        # Pi host always hand over a whole byte, so the buffer below is only
        # the look-ahead a bit-banged master in the tab reads, and consuming it
        # as well would run the chip's frame twice.
        on_exchange = cfg.get("on_exchange", 0)
        if on_exchange:
            miso_byte = self._call_indirect(on_exchange, cfg["user_data"], mosi & 0xFF) & 0xFF
            self._flush_stdout()
            return miso_byte
        pos = st.pos
        count = st.count
        if pos >= count:
            # Nothing armed: the chip neither answers nor consumes, and the
            # line reads its idle level.
            return 0xFF
        if count - pos >= self._SPI_CACHE_MIN:
            view = self._mem_view()
            # vx_spi_start arms only a buffer inside the chip's memory; the
            # copy is read through the memory's address, so it is checked
            # again here rather than trusted.
            if st.ptr < 0 or st.ptr + count > len(view):
                return self._refuse_spi_buffer(st)
            cache = st.cache = bytearray(
                ctypes.string_at(ctypes.addressof(view) + st.ptr, count))
            st.cache_lo = pos
            miso_byte = cache[pos]
            cache[pos] = mosi & 0xFF
            st.pos = pos + 1
            return miso_byte
        # One byte in and one byte out of the chip's armed buffer, straight
        # through the cached view (see _mem_view).
        view = self._mem_view_cache
        if view is None:
            view = self._mem_view()
        off = st.ptr + pos
        if off < 0 or off >= len(view):
            return self._refuse_spi_buffer(st)
        miso_byte = view[off]          # the chip's pre-filled response
        view[off] = mosi & 0xFF        # what the master sent, for on_done
        pos += 1
        st.pos = pos
        if pos >= count:
            self._spi_frame_done(st)
        return miso_byte

    # ── Timers ──────────────────────────────────────────────────────────────
    @_under_entry_lock
    def next_timer_deadline(self) -> int | None:
        """Return the soonest active timer's fire time (ns). None if no timers."""
        with self._timer_lock:
            deadlines = [t["next_fire_ns"] for t in self._timers if t["active"]]
        return min(deadlines) if deadlines else None

    @_under_entry_lock
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
