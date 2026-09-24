"""
i2c_bus_table.py: the I2C targets a QEMU worker hosts, by (bus, address)
(project board-buses-2026-09, F5).

QEMU asks for the answer to every I2C event synchronously
(picsimlab_i2c_event(bus_id, addr, op | data << 8)), so the models that answer
(the MPU6050, DS3231, BMP280 twins, the write sinks behind the tab's displays,
custom chips, the cross-board proxy) live in the worker beside the guest. They
used to live in one dict keyed by address alone: two identical sensors on Wire
and Wire1 were one device, a sensor wired to Wire1 answered Wire's probes, and
removing one of two same-address devices removed whichever sat in the slot
(the worker-i2c-slaves-ignore-bus-id finding).

This table keeps the rules the tab's fabric keeps (simulation/buses/i2cBus.ts),
on the worker's side of the wire:

  - a registration is an IDENTITY (the key its caller chose: the sensor record's
    pin, the proxy's address), never an address, and it leaves by that key;
  - a target answers on the controller its SDA is wired to, and only there;
  - every target that has the address sees the START and the controller reads
    an ACK if any of them ACKs; a read with several answering is the
    wired-AND of their bytes, plus an `i2c-address-conflict` diagnostic;
  - an address nobody has on that controller is not this table's to answer.

Which controller a target is on comes from, in this order:

  1. the tab's bus map (`bus_map.i2c`, F5-SPEC "Motores"): the fabric walked
     the nets and names the controller whose SDA the target's SDA is on, or,
     when it cannot (an ESP32's Wire1 has no default pins; the GPIO matrix
     picks them at run time), the board pin, which the worker resolves
     against the live routing through `resolve_bus`. An owner the map lists
     as unplaced is wired to no board's bus and answers nothing;
  2. the record's own `bus` field, for a caller that names it directly;
  3. otherwise every controller, which is what a record from a part that is
     not on the fabric yet has always had. Kept on purpose, so an unmigrated
     part keeps working; it is the only place an address still answers on a
     bus it may not be wired to, and it goes when the last part migrates.

Owners link a map entry to a registration: a record's `owner` field, else its
`component_id`, the same identity the tab's registry keys the target by.

The table is plain Python with no QEMU in it, so the ESP32 worker and the
STM32 worker (pro/backend/app/pro_boards/stm32_worker.py) share it and it is
tested on its own.
"""
from __future__ import annotations

import threading
from typing import Any, Callable, Iterable, Optional

# picsimlab I2C ops (hw/i2c/picsimlab_i2c.c): low byte of the event.
I2C_START_RECV = 0x00
I2C_START_SEND = 0x01
I2C_START_ASYNC = 0x02
I2C_FINISH = 0x03
I2C_NACK = 0x04
I2C_WRITE = 0x05
I2C_READ = 0x06

_STARTS = (I2C_START_RECV, I2C_START_SEND)

# What `resolve_bus` answers for a pin no controller is routed to right now.
NOT_ROUTED = -1

EmitFn = Callable[[dict], None]
ResolveFn = Callable[[int], Optional[int]]


class _Registration:
    __slots__ = ('key', 'slave', 'addresses', 'owner', 'record_bus', 'name')

    def __init__(self, key: Any, slave: Any, addresses: list[int],
                 owner: Optional[str], record_bus: Optional[int]) -> None:
        self.key = key
        self.slave = slave
        self.addresses = addresses
        self.owner = owner
        self.record_bus = record_bus
        # Diagnostics and a stable call order both need a name that does not
        # depend on the order registrations arrived in.
        self.name = owner if owner else f'{type(slave).__name__}@{key!r}'


def _as_bus(v: Any) -> Optional[int]:
    if isinstance(v, bool) or v is None:
        return None
    try:
        n = int(v)
    except (TypeError, ValueError):
        return None
    return n if n >= 0 else None


def owner_of(record: dict) -> Optional[str]:
    """The identity a sensor record carries for the bus map: `owner` when the
    part names its fabric owner, else the canvas component id."""
    for k in ('owner', 'component_id'):
        v = record.get(k)
        if isinstance(v, str) and v:
            return v
    return None


class I2cBusTable:
    """Every I2C target of one worker, indexed by (controller, address)."""

    def __init__(self, emit: Optional[EmitFn] = None,
                 resolve_bus: Optional[ResolveFn] = None) -> None:
        self._emit = emit
        self._resolve = resolve_bus
        # A worker's command thread registers while the QEMU thread asks; the
        # index is swapped whole under this lock and read without it.
        self._lock = threading.Lock()
        self._regs: dict[Any, _Registration] = {}
        # owner -> ('bus', unit) | ('pin', sda) | ('none', None); None until a
        # map has said anything about I2C.
        self._placement: Optional[dict[str, tuple[str, Optional[int]]]] = None
        # (unit, addr) and (None, addr) -> registrations; ('pin', sda, addr) for
        # entries whose controller is resolved per event.
        self._fixed: dict[tuple[Optional[int], int], list[_Registration]] = {}
        self._by_pin: dict[int, list[tuple[int, _Registration]]] = {}
        # (unit, addr) -> the registrations that ACKed the current address phase.
        self._active: dict[tuple[int, int], list[_Registration]] = {}
        self._diag_seen: set[str] = set()

    # ── registrations ──────────────────────────────────────────────────────

    def add(self, key: Any, slave: Any, addresses: Iterable[int], *,
            owner: Optional[str] = None, bus: Any = None) -> None:
        """Register `slave` under `key`. The same key again replaces it: a
        record re-sent for the same device can never leave a twin answering."""
        addrs: list[int] = []
        for a in addresses:
            try:
                n = int(a) & 0x7F
            except (TypeError, ValueError):
                continue
            if n not in addrs:
                addrs.append(n)
        reg = _Registration(key, slave, addrs, owner or None, _as_bus(bus))
        with self._lock:
            self._regs[key] = reg
            self._reindex()

    def remove(self, key: Any) -> Any:
        """Take the registration under `key` off the bus, by identity, and
        return its slave (None when there was none). Another device at the
        same address stays exactly where it was."""
        with self._lock:
            reg = self._regs.pop(key, None)
            if reg is None:
                return None
            self._reindex()
            return reg.slave

    def get(self, key: Any) -> Any:
        reg = self._regs.get(key)
        return reg.slave if reg is not None else None

    def slave_at(self, addr: int, bus_id: Optional[int] = None) -> Any:
        """The first slave that would answer `addr` (on `bus_id`, or anywhere
        when None). For callers that update a model in place (a sensor slider
        on a record that only knows its address), not for dispatch."""
        a = int(addr) & 0x7F
        if bus_id is not None:
            found = self.targets(int(bus_id), a)
            return found[0].slave if found else None
        for reg in sorted(self._regs.values(), key=lambda r: r.name):
            if a in reg.addresses:
                return reg.slave
        return None

    def addresses(self) -> list[int]:
        """Every address some registration answers, for the worker's logs."""
        out: set[int] = set()
        for reg in self._regs.values():
            out.update(reg.addresses)
        return sorted(out)

    def __len__(self) -> int:
        return len(self._regs)

    # ── the tab's map ──────────────────────────────────────────────────────

    def apply_map(self, entries: Optional[list]) -> None:
        """Replace the tab's view of which controller each owner is on.

        `entries` is the `i2c` list of a `bus_map`: `{owner, bus_id, sda}` for
        a target the fabric placed on this board (bus_id null when the tab
        cannot name the controller, and then `sda` is resolved here), and
        `{unplaced: [owner, ...]}` for targets wired to no board's bus. The
        whole list travels every time, so an owner that left is gone by being
        absent. None (a map with no `i2c` key, from a tab that predates F5)
        leaves the placement as it was.
        """
        if entries is None:
            return
        placement: dict[str, tuple[str, Optional[int]]] = {}
        for e in entries if isinstance(entries, list) else []:
            if not isinstance(e, dict):
                continue
            unplaced = e.get('unplaced')
            if isinstance(unplaced, list):
                for o in unplaced:
                    if isinstance(o, str) and o and o not in placement:
                        placement[o] = ('none', None)
                continue
            owner = e.get('owner')
            if not isinstance(owner, str) or not owner:
                continue
            unit = _as_bus(e.get('bus_id'))
            sda = _as_bus(e.get('sda'))
            if unit is not None:
                placement[owner] = ('bus', unit)
            elif sda is not None:
                placement[owner] = ('pin', sda)
            else:
                placement[owner] = ('none', None)
        with self._lock:
            self._placement = placement
            self._reindex()

    # ── dispatch ───────────────────────────────────────────────────────────

    def targets(self, bus_id: int, addr: int) -> list[_Registration]:
        """Who is on controller `bus_id` at `addr`, in a stable order."""
        a = int(addr) & 0x7F
        found = list(self._fixed.get((int(bus_id), a), ()))
        found.extend(self._fixed.get((None, a), ()))
        if self._by_pin:
            for sda, entries in self._by_pin.items():
                unit = self._resolve(sda) if self._resolve is not None else None
                if unit == NOT_ROUTED:
                    continue
                for ea, reg in entries:
                    # Unknown routing (a library that cannot read the matrix)
                    # answers anywhere, as before F5; a known one only there.
                    if ea == a and (unit is None or unit == int(bus_id)):
                        found.append(reg)
        if len(found) > 1:
            found.sort(key=lambda r: r.name)
        return found

    def event(self, bus_id: int, addr: int, event: int,
              found: Optional[list] = None) -> Optional[int]:
        """Dispatch one QEMU I2C event. None when nobody on that controller
        has the address, so the caller keeps its no-slave path (the NACK, the
        test overrides) exactly as it was. `found` is a `targets()` answer the
        caller already holds for this event, to skip a second lookup."""
        if found is None:
            found = self.targets(bus_id, addr)
        if not found:
            return None
        if len(found) == 1:
            return found[0].slave.handle_event(event)
        return self._arbitrate(int(bus_id), int(addr) & 0x7F, found, event)

    def _arbitrate(self, bus_id: int, addr: int, found: list[_Registration],
                   event: int) -> int:
        """Several targets on one controller at one address: the open-drain
        wire decides. Rare, so clarity over speed."""
        op = event & 0xFF
        key = (bus_id, addr)
        if op in _STARTS:
            acked: list[_Registration] = []
            first_nack = 1
            for reg in found:
                r = reg.slave.handle_event(event)
                if r == 0:
                    acked.append(reg)
                elif first_nack == 1:
                    first_nack = r
            self._active[key] = acked
            if len(acked) > 1:
                self._conflict(bus_id, addr, acked)
            return 0 if acked else first_nack
        # A target that NACKed its own address is out of this transaction.
        active = [r for r in self._active.get(key, found) if r in found]
        if op == I2C_READ:
            v = 0xFF
            for reg in active:
                v &= int(reg.slave.handle_event(event)) & 0xFF
            return v
        if op == I2C_WRITE:
            ack = False
            for reg in active:
                if reg.slave.handle_event(event) == 0:
                    ack = True
            return 0 if ack else 1
        # FINISH, NACK and anything else end the phase for everyone addressed.
        result = 0
        for i, reg in enumerate(found):
            r = reg.slave.handle_event(event)
            if i == 0:
                result = r
        if op in (I2C_FINISH, I2C_NACK):
            self._active.pop(key, None)
        return result

    def _conflict(self, bus_id: int, addr: int, regs: list[_Registration]) -> None:
        owners = sorted(r.name for r in regs)
        key = f'{bus_id}|{addr}|{",".join(owners)}'
        if key in self._diag_seen or self._emit is None:
            return
        self._diag_seen.add(key)
        try:
            self._emit({
                'type': 'bus_diag', 'code': 'i2c-address-conflict', 'bus': 'i2c',
                'controller': bus_id, 'owners': owners,
                'message': (f'{" and ".join(owners)} all answer at address 0x{addr:02x} on '
                            f'I2C{bus_id}: every one of them ACKs, and a read returns the '
                            f'wired-AND of their bytes.'),
            })
        except Exception:
            pass

    def reset_diagnostics(self) -> None:
        self._diag_seen.clear()

    # ── index ──────────────────────────────────────────────────────────────

    def _where(self, reg: _Registration) -> tuple[str, Optional[int]]:
        placement = self._placement
        if placement is not None and reg.owner is not None and reg.owner in placement:
            return placement[reg.owner]
        if reg.record_bus is not None:
            return ('bus', reg.record_bus)
        return ('any', None)

    def _reindex(self) -> None:
        fixed: dict[tuple[Optional[int], int], list[_Registration]] = {}
        by_pin: dict[int, list[tuple[int, _Registration]]] = {}
        for reg in self._regs.values():
            kind, where = self._where(reg)
            if kind == 'none':
                continue
            for a in reg.addresses:
                if kind == 'pin' and where is not None:
                    by_pin.setdefault(where, []).append((a, reg))
                else:
                    fixed.setdefault((where if kind == 'bus' else None, a), []).append(reg)
        self._fixed = fixed
        self._by_pin = by_pin
        # Whatever is mid-transaction keeps only registrations still indexed.
        live = set(id(r) for lst in fixed.values() for r in lst)
        live.update(id(r) for lst in by_pin.values() for _, r in lst)
        self._active = {k: [r for r in v if id(r) in live] for k, v in self._active.items()}
