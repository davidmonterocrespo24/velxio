from __future__ import annotations
"""
RPi.GPIO shim — injected into the QEMU Raspberry Pi 3B guest at boot.

This file is encoded as base64 and written by the QEMU boot automator
to /usr/local/lib/python3.x/dist-packages/RPi/GPIO.py inside the guest.
It communicates over /dev/ttyAMA1 using a simple text protocol:

  Pi → backend:  "GPIO <bcm_pin> <0|1>\\n"   (output pin driven)
  backend → Pi:  "SET <bcm_pin> <0|1>\\n"    (external input / Arduino→Pi)

Usage inside Pi Python scripts (transparent drop-in):
  import RPi.GPIO as GPIO
  GPIO.setmode(GPIO.BCM)
  GPIO.setup(17, GPIO.OUT)
  GPIO.output(17, GPIO.HIGH)
  val = GPIO.input(17)
"""

BCM  = 'BCM'
BOARD= 'BOARD'
OUT  = 1
IN   = 0
HIGH = 1
LOW  = 0
PUD_UP   = 22
PUD_DOWN = 21
PUD_OFF  = 20

import threading
import os
from typing import Any

_mode    : str | None = None
_pin_dir : dict[int, int] = {}
_pin_val : dict[int, int] = {}
_callbacks: dict[int, list] = {}
_tty    : Any = None   # serial.Serial or raw file IO
_tty_lock = threading.Lock()

# ── Physical-pin to BCM-pin map (40-pin header) ────────────────────────────
_PHYSICAL_TO_BCM = {
    3:2, 5:3, 7:4, 8:14, 10:15, 11:17, 12:18, 13:27, 15:22, 16:23,
    18:24, 19:10, 21:9, 22:25, 23:11, 24:8, 26:7, 29:5, 31:6, 32:12,
    33:13, 35:19, 36:16, 37:26, 38:20, 40:21,
}

def _open_tty():
    global _tty
    for path in ['/dev/ttyAMA1', '/dev/ttyS1', '/dev/serial1']:
        if os.path.exists(path):
            try:
                import serial
                _tty = serial.Serial(path, baudrate=115200, timeout=0.01)
                return
            except Exception:
                pass
            try:
                _tty = open(path, 'r+b', buffering=0)
                return
            except Exception:
                pass

def _to_bcm(pin: int) -> int:
    if _mode == BCM:
        return pin
    return _PHYSICAL_TO_BCM.get(pin, pin)

def _send(line: str) -> None:
    global _tty
    if _tty is None:
        _open_tty()
    if _tty is None:
        return
    with _tty_lock:
        try:
            data = (line.strip() + '\n').encode()
            if hasattr(_tty, 'write'):
                _tty.write(data)
        except Exception:
            _tty = None

def _recv_loop():
    """Background thread: read "SET <pin> <0|1>" from ttyAMA1."""
    while True:
        if _tty is None:
            import time; time.sleep(0.5); continue
        try:
            with _tty_lock:
                line = b''
                while True:
                    ch = _tty.read(1) if hasattr(_tty, 'read') else b''
                    if not ch:
                        break
                    line += ch
                    if ch == b'\n':
                        break
            if line:
                text = line.decode('ascii', 'ignore').strip()
                parts = text.split()
                if len(parts) == 3 and parts[0] == 'SET':
                    bcm = int(parts[1])
                    val = int(parts[2])
                    _pin_val[bcm] = val
                    for cb in _callbacks.get(bcm, []):
                        try:
                            cb(bcm)
                        except Exception:
                            pass
        except Exception:
            import time; time.sleep(0.1)

_recv_thread = threading.Thread(target=_recv_loop, daemon=True)
_recv_thread.start()

# ── Public API ─────────────────────────────────────────────────────────────

def setmode(mode: str) -> None:
    global _mode
    _mode = mode

def getmode() -> str | None:
    return _mode

def setup(pin, direction, pull_up_down=PUD_OFF, initial=-1):
    bcm = _to_bcm(pin)
    _pin_dir[bcm] = direction
    if direction == OUT:
        val = initial if initial in (0, 1) else 0
        _pin_val[bcm] = val

def output(pin, value):
    bcm = _to_bcm(pin)
    val = 1 if value else 0
    _pin_val[bcm] = val
    _send(f'GPIO {bcm} {val}')

def input(pin) -> int:
    bcm = _to_bcm(pin)
    return _pin_val.get(bcm, 0)

def cleanup(pins=None):
    pass

def setwarnings(flag: bool) -> None:
    pass

# ── Event detection stubs ──────────────────────────────────────────────────

RISING  = 31
FALLING = 32
BOTH    = 33

def add_event_detect(pin, edge, callback=None, bouncetime=0):
    bcm = _to_bcm(pin)
    if callback:
        _callbacks.setdefault(bcm, []).append(callback)

def add_event_callback(pin, callback):
    bcm = _to_bcm(pin)
    _callbacks.setdefault(bcm, []).append(callback)

def remove_event_detect(pin):
    bcm = _to_bcm(pin)
    _callbacks.pop(bcm, None)

def event_detected(pin) -> bool:
    return False

def wait_for_edge(pin, edge, bouncetime=0, timeout=-1):
    pass

# ── PWM stub ───────────────────────────────────────────────────────────────

class PWM:
    def __init__(self, pin, frequency):
        self._pin = _to_bcm(pin)
        self._freq = frequency
        self._dc = 0

    def start(self, dc):
        self._dc = dc
        _send(f'GPIO {self._pin} {1 if dc > 50 else 0}')

    def ChangeDutyCycle(self, dc):
        self._dc = dc
        _send(f'GPIO {self._pin} {1 if dc > 50 else 0}')

    def ChangeFrequency(self, freq):
        self._freq = freq

    def stop(self):
        _send(f'GPIO {self._pin} 0')

# ── Version info ───────────────────────────────────────────────────────────
VERSION       = '0.7.1a'
RPI_INFO      = {'P1_REVISION': 3, 'RAM': '1024M', 'MANUFACTURER': 'embest',
                 'PROCESSOR': 'BCM2837', 'TYPE': 'Pi 3 Model B', 'REVISION': 'a22082'}
RPI_REVISION  = '0010'
BOARD_INFO    = RPI_INFO
