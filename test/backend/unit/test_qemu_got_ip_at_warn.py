"""On the QEMU lane a WiFi sketch reaches got_ip although the firmware logs
from WARN up (velxio/velxio-prod#178, fixed by #229).

The WiFi status the lib manager reports for a QEMU board comes from UART0
text. The only line the parser read got_ip from is the IDF's
"esp_netif_handlers: sta ip: ...", an INFO line, and the firmware Velxio
builds logs from WARN up (sdkconfig.defaults.in, since b373c973), so that line
never prints: the status stopped short of got_ip, the badge never turned
green and the serial monitor never linked the address to the IoT gateway.

These feed what the gallery's WiFi sketches really print at that level
(no IDF INFO line at all) through the lib manager's own read loop, as the
worker's uart_tx events, and read the wifi_status events it dispatches.
"""
from __future__ import annotations

import io
import json
import re
import threading
import unittest
from pathlib import Path

from app.services import esp32_lib_manager as m

REPO = Path(__file__).resolve().parents[3]

# esp32-wifi-connect (frontend/src/data/examples.ts), as it prints on the
# QEMU lane: Serial.printf("Connecting to %s", ssid), the progress dots,
# " Connected!", then WiFi.localIP() and loop()'s line.
WIFI_CONNECT = (b'ESP32 WiFi Connection Demo\r\n==========================\r\n'
                b'Connecting to Velxio-GUEST' + b'.' * 6 + b' Connected!\r\n'
                b'IP Address: 192.168.4.15\n'
                b'MAC Address: 24:0A:C4:00:01:10\n'
                b'Signal Strength (RSSI): -45 dBm\n'
                b'WiFi still connected - IP: 192.168.4.15\r\n')

# esp32-http-server, the sketch whose page the IoT gateway opens.
HTTP_SERVER = (b'ESP32 HTTP Server\r\n' + b'Connecting to WiFi' + b'.' * 3
               + b' Connected!\r\n' + b'Server started at: http://192.168.4.15/\n'
               + b'Open the IoT Gateway link to access it from your browser.\r\n')


class _FakeProcess:
    def __init__(self, stdout: bytes) -> None:
        self.stdout = io.BytesIO(stdout)
        self.returncode = 0

    def poll(self) -> int:
        return self.returncode


def wifi_status_events(uart0: bytes, hostfwd_port: int = 18080) -> list[dict]:
    """The wifi_status events the lib manager dispatches for a board that
    prints `uart0`, one uart_tx event per byte as the worker sends them."""
    stdout = b''.join(json.dumps({'type': 'uart_tx', 'uart': 0, 'byte': b}).encode() + b'\n'
                      for b in uart0)
    inst = m._WorkerInstance(
        process=_FakeProcess(stdout),  # type: ignore[arg-type]
        stdin_lock=threading.Lock(),
        callback=None,  # type: ignore[arg-type]
        board_type='esp32',
        uart_bufs={0: m._UartBuffer(0), 1: m._UartBuffer(1), 2: m._UartBuffer(2)},
        threads=[],
        loop=None,  # type: ignore[arg-type]
        running=False,
        wifi_enabled=True,
        wifi_hostfwd_port=hostfwd_port,
    )
    mgr = m.EspLibManager()
    got: list[tuple[str, dict]] = []
    mgr._dispatch = lambda _inst, etype, data: got.append((etype, data))  # type: ignore[method-assign]
    mgr._thread_read_stdout(inst, 'c1')
    return [data for etype, data in got if etype == 'wifi_status']


class TheFirmwareLogsFromWarnUp(unittest.TestCase):

    def test_the_idf_got_ip_line_is_below_the_builds_level(self):
        """The premise: the template builds at WARN, and the IDF prints its
        got-IP line at INFO, so a QEMU board never prints it."""
        defaults = (REPO / 'backend/app/services/esp-idf-template/sdkconfig.defaults.in').read_text()
        self.assertRegex(defaults, r'(?m)^CONFIG_LOG_DEFAULT_LEVEL_WARN=y$')
        self.assertNotRegex(defaults, r'(?m)^CONFIG_LOG_DEFAULT_LEVEL_INFO=y$')
        for uart0 in (WIFI_CONNECT, HTTP_SERVER):
            self.assertNotIn(b'sta ip:', uart0)


class TheGallerySketchesReachGotIp(unittest.TestCase):

    def _last(self, events: list[dict]) -> dict:
        self.assertTrue(events, 'no wifi_status event at all')
        return events[-1]

    def test_wifi_connect(self):
        self.assertEqual(self._last(wifi_status_events(WIFI_CONNECT)),
                         {'status': 'got_ip', 'ip': '192.168.4.15'})

    def test_http_server(self):
        self.assertEqual(self._last(wifi_status_events(HTTP_SERVER)),
                         {'status': 'got_ip', 'ip': '192.168.4.15'})


if __name__ == '__main__':
    unittest.main()
