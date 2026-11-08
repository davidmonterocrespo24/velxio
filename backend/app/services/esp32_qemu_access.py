"""
Who may start an ESP32 on the server's QEMU lane, and how many at once.

``start_esp32`` carries firmware that then runs on THIS server: one libqemu
worker process per board, with a user-mode network stack of its own. So the
simulation route admits every start here first:

1. An optional gate that an overlay registers (:func:`register_esp32_qemu_gate`).
   The velxio.dev overlay requires a signed-in session and caps the workers
   each user may hold. With no overlay installed there is no gate.
2. A global cap on concurrent QEMU ESP32 workers,
   ``VELXIO_ESP32_QEMU_MAX_INSTANCES`` (``0`` = no cap). The default is twice
   the CPU count, and at least 4: each worker is a real process that can keep
   a core busy. It is a safety valve for the machine, not a product limit; a
   self-hosted server for a whole classroom raises it.

An admitted start holds a reservation until the manager has registered its
worker (:func:`release`). The lib manager only registers a worker after an
await, so without the reservation starts that arrive together all counted the
same table and all passed.

A gate that raises refuses the start. It decides who may run code on the
server, and a broken check must not open the lane.
"""
from __future__ import annotations

import logging
import os
from typing import Awaitable, Callable, Optional

from app.services.board_access import BoardAccessDenial

logger = logging.getLogger(__name__)

MAX_INSTANCES_ENV = 'VELXIO_ESP32_QEMU_MAX_INSTANCES'

BUSY_MESSAGE = (
    'All the ESP32 simulators on this server are busy right now. '
    'Try again in a minute: they free up as people stop their simulations.'
)
CHECK_FAILED_MESSAGE = (
    'Could not check whether this ESP32 may run on the server right now. '
    'Please try again.'
)

# gate(websocket, client_id, board) -> None to admit, or a BoardAccessDenial
# whose words the client shows.
Esp32QemuGate = Callable[[object, str, object], Awaitable[Optional[BoardAccessDenial]]]

_gate: Optional[Esp32QemuGate] = None

# Admitted starts whose worker the manager has not registered yet.
_reserved: set[str] = set()


def register_esp32_qemu_gate(fn: Optional[Esp32QemuGate]) -> None:
    """Install the overlay's gate, or clear it (None)."""
    global _gate
    _gate = fn


def default_max_instances() -> int:
    return max(4, 2 * (os.cpu_count() or 1))


def max_instances() -> int:
    """The global cap on concurrent QEMU ESP32 workers; 0 means none."""
    raw = os.environ.get(MAX_INSTANCES_ENV, '').strip()
    if not raw:
        return default_max_instances()
    try:
        value = int(raw)
    except ValueError:
        logger.warning('%s=%r is not a number; using the default (%d)',
                       MAX_INSTANCES_ENV, raw, default_max_instances())
        return default_max_instances()
    return max(0, value)


def running_clients() -> set[str]:
    """Clients that hold a QEMU ESP32 worker, in either manager.

    Resolved through the modules at call time, so a test that reloads a
    manager module is counted against the new singleton."""
    from app.services import esp32_lib_manager as lib_mod
    from app.services import esp_qemu_manager as sub_mod

    return set(lib_mod.esp_lib_manager.client_ids()) | set(sub_mod.esp_qemu_manager.client_ids())


def active_clients() -> set[str]:
    """Running clients plus the admitted ones whose worker is still starting."""
    return running_clients() | _reserved


async def admit(websocket: object, client_id: str, board: object) -> Optional[BoardAccessDenial]:
    """None when this client may start a QEMU ESP32 now, with a slot reserved
    for it until :func:`release`; otherwise why not."""
    if _gate is not None:
        try:
            verdict = await _gate(websocket, client_id, board)
        except Exception:
            logger.exception('[%s] esp32 qemu gate raised; refusing the start', client_id)
            return BoardAccessDenial(CHECK_FAILED_MESSAGE, code='esp32_qemu_check_failed')
        if verdict is not None:
            if isinstance(verdict, BoardAccessDenial):
                return verdict
            logger.error('[%s] esp32 qemu gate answered %r; refusing the start', client_id, verdict)
            return BoardAccessDenial(CHECK_FAILED_MESSAGE, code='esp32_qemu_check_failed')

    # No await from here to the reservation: two starts cannot both pass the
    # count before either of them is in it. A restart of the same client is
    # not counted against itself.
    cap = max_instances()
    others = active_clients() - {client_id}
    if cap and len(others) >= cap:
        logger.warning(
            '[%s] start_esp32 refused: %d QEMU ESP32 workers active, the cap is %d (%s)',
            client_id, len(others), cap, MAX_INSTANCES_ENV,
        )
        return BoardAccessDenial(BUSY_MESSAGE, code='esp32_qemu_busy')
    _reserved.add(client_id)
    return None


def release(client_id: str) -> None:
    """Drop the reservation once the manager holds the worker (or failed)."""
    _reserved.discard(client_id)
