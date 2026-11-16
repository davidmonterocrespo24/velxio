"""
test_wifi_status_lines.py: the WiFi/BLE status parser reads whole UART0 lines
(issue velxio/velxio-prod#229).

On the QEMU lane the lib manager hands UART0 to the status parser. It used to
hand it the serial monitor's chunks, and _UartBuffer ends a chunk at every
period as well as at a line end, so that a progress line ("Connecting....")
reaches the monitor at once. An address is full of periods: "sta ip:
192.168.4.15" reached the parser as "sta ip: 192.", "168.", "4." and "15", no
chunk held the whole address, and the tab's WiFi status stopped at
'connected'. The serial monitor links an address only once the status is
'got_ip', so a WebServer sketch never got its IoT gateway link.

The bytes go through the real read loop (EspLibManager._thread_read_stdout) as
the worker's uart_tx events, one byte each, so the chunks the parser used to
see are the ones _UartBuffer really makes. The monitor keeps those chunks: the
progress dots must still appear one by one.
"""
from __future__ import annotations

import asyncio
import io
import json
import threading
import unittest

from app.services import esp32_lib_manager as m
from app.services import wifi_status_parser as wsp
from app.services.esp_qemu_manager import EspInstance, EspQemuManager

# What the firmware prints. The IDF console ends a line with CRLF, and so does
# Serial.println; Serial.printf("...\n") ends it with the LF alone.
IDF_GOT_IP = (b'I (2345) esp_netif_handlers: sta ip: 192.168.4.15, '
              b'mask: 255.255.255.0, gw: 192.168.4.2\r\n')

# An Arduino sketch that prints what WiFi.localIP() gives after the label the
# parser knows, as the sketch of the issue did:
#   Serial.print("Connecting to WiFi");
#   while (WiFi.status() != WL_CONNECTED) { delay(500); Serial.print("."); }
#   Serial.println(" Connected!");
#   Serial.print("sta ip: ");
#   Serial.println(WiFi.localIP());
ARDUINO_STA_IP = (b'Connecting to WiFi' + b'.' * 4 + b' Connected!\r\n'
                  + b'sta ip: ' + b'192.168.4.15' + b'\r\n')

# The lines the parser already knew, each with the event it reads from it.
KNOWN_LINES: list[tuple[bytes, list[dict], list[dict]]] = [
    (b'I (432) wifi:wifi sta start', [{'status': 'initializing'}], []),
    (b'I (433) wifi:mode : sta (24:0a:c4:00:01:10)', [{'status': 'initializing'}], []),
    (b'I (500) wifi:new:Velxio-GUEST, old: , ASSOC',
     [{'status': 'connected', 'ssid': 'Velxio-GUEST'}], []),
    (b'I (800) wifi:connected with Velxio-GUEST, aid = 1, channel 6, BW20, rssi: -45',
     [{'status': 'connected', 'ssid': 'Velxio-GUEST'}], []),
    (b'Connecting to WiFi', [{'status': 'connected', 'ssid': 'Velxio-GUEST'}], []),
    (b'I (9999) wifi:state: run -> init (0)', [{'status': 'disconnected'}], []),
    (b'I (2345) esp_netif_handlers: sta ip: 192.168.4.2, mask: 255.255.255.0',
     [{'status': 'got_ip', 'ip': '192.168.4.2'}], []),
    (b'I (300) BT_INIT: BT controller compile version [abc]', [], [{'status': 'initialized'}]),
    (b'I (500) GATTS: advertising started', [], [{'status': 'advertising'}]),
    (b'I (600) GAP_BLE: advertisement config done', [], [{'status': 'advertising'}]),
    (b'Hello from the sketch. Uptime 12.5 s', [], []),
]


def monitor_chunks(data: bytes) -> list[bytes]:
    """The chunks the serial monitor gets for these bytes, one byte at a time."""
    buf = m._UartBuffer(0)
    return [out for b in data if (out := buf.feed_raw(b)) is not None]


class _FakeProcess:
    def __init__(self, stdout: bytes) -> None:
        self.stdout = io.BytesIO(stdout)
        self.returncode = 0

    def poll(self) -> int:
        return self.returncode


def uart_tx_lines(uart: int, data: bytes) -> bytes:
    """The worker's stdout for these bytes: one uart_tx event per byte."""
    return b''.join(json.dumps({'type': 'uart_tx', 'uart': uart, 'byte': b}).encode() + b'\n'
                    for b in data)


def read_loop(stdout: bytes, *, wifi_enabled: bool = True,
              hostfwd_port: int = 18080) -> list[tuple[str, dict]]:
    """Every event the read loop dispatches for this worker output."""
    inst = m._WorkerInstance(
        process=_FakeProcess(stdout),  # type: ignore[arg-type]
        stdin_lock=threading.Lock(),
        callback=None,  # type: ignore[arg-type]
        board_type='esp32',
        uart_bufs={0: m._UartBuffer(0), 1: m._UartBuffer(1), 2: m._UartBuffer(2)},
        threads=[],
        loop=None,  # type: ignore[arg-type]
        running=False,
        wifi_enabled=wifi_enabled,
        wifi_hostfwd_port=hostfwd_port if wifi_enabled else 0,
    )
    mgr = m.EspLibManager()
    got: list[tuple[str, dict]] = []
    mgr._dispatch = lambda _inst, etype, data: got.append((etype, data))  # type: ignore[method-assign]
    mgr._thread_read_stdout(inst, 'c1')
    return got


def wifi_events(got: list[tuple[str, dict]]) -> list[dict]:
    return [data for etype, data in got if etype == 'wifi_status']


def feed_all(lines: 'wsp.SerialStatusLines', chunks, **kw) -> tuple[list[dict], list[dict]]:
    wifi: list[dict] = []
    ble: list[dict] = []
    for chunk in chunks:
        text = chunk.decode('utf-8', errors='replace') if isinstance(chunk, bytes) else chunk
        w, b = lines.feed(text, **kw)
        wifi += w
        ble += b
    return wifi, ble


class TestTheMonitorKeepsItsChunks(unittest.TestCase):
    """The cause, and what has to stay: the monitor's chunks end at a period."""

    def test_an_address_reaches_the_monitor_in_pieces(self):
        self.assertEqual(monitor_chunks(b'sta ip: 192.168.4.15\r\n'),
                         [b'sta ip: 192.', b'168.', b'4.', b'15\r', b'\n'])

    def test_progress_dots_still_reach_the_monitor_one_by_one(self):
        self.assertEqual(monitor_chunks(b'Connecting to WiFi...'),
                         [b'Connecting to WiFi.', b'.', b'.'])

    def test_the_read_loop_still_sends_the_monitor_those_chunks(self):
        got = read_loop(uart_tx_lines(0, ARDUINO_STA_IP))
        sent = [data['data'].encode() for etype, data in got if etype == 'serial_output']
        self.assertEqual(sent, monitor_chunks(ARDUINO_STA_IP))


class TestTheQemuLaneReachesGotIp(unittest.TestCase):
    """The read loop, fed the worker's uart_tx events byte by byte."""

    def test_the_idf_line_reports_got_ip_with_its_address(self):
        got = read_loop(uart_tx_lines(0, IDF_GOT_IP))
        self.assertEqual(wifi_events(got), [{'status': 'got_ip', 'ip': '192.168.4.15'}])

    def test_a_sketch_printing_its_address_reports_got_ip(self):
        got = read_loop(uart_tx_lines(0, ARDUINO_STA_IP))
        self.assertEqual(wifi_events(got), [
            {'status': 'connected', 'ssid': 'Velxio-GUEST'},
            {'status': 'got_ip', 'ip': '192.168.4.15'},
        ])

    def test_the_status_follows_the_text_that_completed_it(self):
        got = read_loop(uart_tx_lines(0, ARDUINO_STA_IP))
        kinds = [(etype, data.get('data', data.get('status'))) for etype, data in got]
        self.assertLess(kinds.index(('serial_output', '15\r')),
                        kinds.index(('wifi_status', 'got_ip')))

    def test_a_board_without_wifi_reports_no_status(self):
        got = read_loop(uart_tx_lines(0, IDF_GOT_IP + ARDUINO_STA_IP), wifi_enabled=False)
        self.assertEqual(wifi_events(got), [])

    def test_only_uart0_reaches_the_parser(self):
        got = read_loop(uart_tx_lines(1, IDF_GOT_IP) + uart_tx_lines(2, ARDUINO_STA_IP))
        self.assertEqual(wifi_events(got), [])


class TestSerialStatusLines(unittest.TestCase):
    """The accumulator: whole lines, whatever the chunks."""

    def test_the_address_survives_any_split(self):
        line = IDF_GOT_IP
        expected = [{'status': 'got_ip', 'ip': '192.168.4.15'}]
        for chunks in (monitor_chunks(line), [bytes([b]) for b in line], [line]):
            wifi, _ = feed_all(wsp.SerialStatusLines(), chunks)
            self.assertEqual(wifi, expected, chunks)

    def test_each_known_line_reads_as_before(self):
        for line, wifi_expected, ble_expected in KNOWN_LINES:
            with self.subTest(line=line):
                before = wsp.parse_serial_text(line.decode())
                self.assertEqual((list(before[0]), list(before[1])), (wifi_expected, ble_expected))
                after = feed_all(wsp.SerialStatusLines(), monitor_chunks(line + b'\r\n'))
                self.assertEqual(after, (wifi_expected, ble_expected))

    def test_a_line_ends_at_lf_cr_or_crlf(self):
        for end in (b'\n', b'\r', b'\r\n'):
            with self.subTest(end=end):
                wifi, _ = feed_all(wsp.SerialStatusLines(), monitor_chunks(b'sta ip: 192.168.4.15' + end))
                self.assertEqual(wifi, [{'status': 'got_ip', 'ip': '192.168.4.15'}])

    def test_text_without_its_line_end_waits_for_it(self):
        lines = wsp.SerialStatusLines()
        self.assertEqual(feed_all(lines, [b'sta ip: 192.', b'168.', b'4.', b'15']), ([], []))
        self.assertEqual(feed_all(lines, [b'\r\n']),
                         ([{'status': 'got_ip', 'ip': '192.168.4.15'}], []))

    def test_a_chunk_can_end_one_line_and_start_the_next(self):
        lines = wsp.SerialStatusLines()
        wifi, _ = feed_all(lines, [b'I (432) wifi:wifi sta start\r\nsta ip: 192.168.4.'])
        self.assertEqual(wifi, [{'status': 'initializing'}])
        wifi, _ = feed_all(lines, [b'15\r\n'])
        self.assertEqual(wifi, [{'status': 'got_ip', 'ip': '192.168.4.15'}])

    def test_a_line_that_never_ends_stays_bounded(self):
        lines = wsp.SerialStatusLines(max_line=256)
        wifi, _ = feed_all(lines, [b'Connecting to WiFi'] + [b'.'] * 5000)
        self.assertLessEqual(len(lines._pending), 256)
        # What the bound cut off is still read, once.
        self.assertEqual(wifi, [{'status': 'connected', 'ssid': 'Velxio-GUEST'}])
        wifi, _ = feed_all(lines, [b' Connected!\r\n'] + monitor_chunks(b'sta ip: 192.168.4.15\r\n'))
        self.assertEqual(wifi, [{'status': 'got_ip', 'ip': '192.168.4.15'}])


class TestTheSubprocessLaneReadsWholeLinesToo(unittest.TestCase):
    """EspQemuManager (no libqemu) reads UART0 off a socket, 256 bytes at a
    time, so a line breaks wherever a read ends."""

    def _read_serial(self, data: bytes) -> list[tuple[str, dict]]:
        async def run() -> list[tuple[str, dict]]:
            got: list[tuple[str, dict]] = []

            async def callback(etype: str, payload: dict) -> None:
                got.append((etype, payload))

            reader = asyncio.StreamReader()
            reader.feed_data(data)
            reader.feed_eof()
            inst = EspInstance('c1', 'esp32', callback)
            inst.running = True
            await EspQemuManager()._read_serial(inst, reader)
            for _ in range(5):
                await asyncio.sleep(0)
            return got

        return asyncio.run(run())

    def test_an_address_split_by_the_read_size_reports_got_ip(self):
        head = b'I (2345) esp_netif_handlers: sta ip: 192.168.'
        filler = b'#' * (256 - len(head) - 2) + b'\r\n'
        data = filler + IDF_GOT_IP
        self.assertEqual(data[:256][-len(head):], head)  # the first read ends mid-address
        got = self._read_serial(data)
        self.assertEqual(wifi_events(got), [{'status': 'got_ip', 'ip': '192.168.4.15'}])
        self.assertEqual(b''.join(d['data'].encode() for e, d in got if e == 'serial_output'), data)

    def test_its_own_address_is_no_sign_here(self):
        """The gateway reaches only the lib manager's boards (iot_gateway.py),
        so a link on this lane would open "No board to reach"."""
        self.assertEqual(wifi_events(self._read_serial(GALLERY_HTTP_SERVER)),
                         [{'status': 'connected', 'ssid': 'Velxio-GUEST'}])


# The gallery's esp32-http-server sketch, as it prints on the QEMU lane:
#   Serial.println("ESP32 HTTP Server");
#   WiFi.begin(ssid, "", 6);
#   Serial.print("Connecting to WiFi");
#   while (WiFi.status() != WL_CONNECTED) { delay(500); Serial.print("."); }
#   Serial.println(" Connected!");
#   ...
#   Serial.printf("Server started at: http://%s/\n", WiFi.localIP().toString().c_str());
#   Serial.println("Open the IoT Gateway link to access it from your browser.");
# The IDF's "sta ip:" line is INFO level, and the firmware Velxio builds logs
# from WARN up (CONFIG_LOG_DEFAULT_LEVEL=2), so nothing else in it says the
# station got its lease.
GALLERY_HTTP_SERVER = (b'ESP32 HTTP Server\r\n' + b'Connecting to WiFi' + b'.' * 3
                       + b' Connected!\r\n' + b'Server started at: http://192.168.4.15/\n'
                       + b'Open the IoT Gateway link to access it from your browser.\r\n')

# Lines that name the QEMU station's own address, and the sketch each is from.
STATION_LINES = [
    b'Server started at: http://192.168.4.15/',            # esp32-http-server
    b'IP Address: 192.168.4.15',                           # esp32-wifi-connect
    b'WiFi still connected - IP: 192.168.4.15',            # esp32-wifi-connect, loop()
    b'WiFi connected, IP 192.168.4.15',                    # the MQTT examples
    b'Connected! IP: 192.168.4.15',                        # the WiFi part examples
    b'Open: 192.168.4.15',                                 # MicroPython, wlan.ifconfig()[0]
    b"('192.168.4.15', '255.255.255.0', '192.168.4.2', '192.168.4.3')",  # wlan.ifconfig()
    b'Connecting to WiFi.... IP: 192.168.4.15',            # the dots and the address on one line
]

# Lines with an address that is not the station's.
NOT_STATION_LINES = [
    b'AP IP address: 192.168.4.1',       # WiFi.softAP(): the board is the access point
    b'Gateway: 192.168.4.2',
    b'Lease 192.168.4.150',
    b'Route 10.192.168.4.15',
    b'Host 192.168.4.15.99',
    b'192.168.4.1',
]


class TestTheStationsOwnAddress(unittest.TestCase):
    """On the QEMU lane the station's lease is known before it is given: the
    radio's network is slirp's 192.168.4.0/24, whose DHCP server hands its
    first lease out at .15, and the host forward the IoT gateway goes through
    targets that address. A sketch printing WiFi.localIP() prints it."""

    def test_the_gallery_web_server_reaches_got_ip(self):
        got = read_loop(uart_tx_lines(0, GALLERY_HTTP_SERVER))
        self.assertEqual(wifi_events(got), [
            {'status': 'connected', 'ssid': 'Velxio-GUEST'},
            {'status': 'got_ip', 'ip': '192.168.4.15'},
        ])

    def test_a_line_naming_the_station_reports_got_ip(self):
        for line in STATION_LINES:
            with self.subTest(line=line):
                wifi, _ = feed_all(wsp.SerialStatusLines(), monitor_chunks(line + b'\r\n'),
                                   station_ip=wsp.QEMU_STATION_IP)
                self.assertEqual(wifi, [{'status': 'got_ip', 'ip': '192.168.4.15'}])

    def test_another_address_is_not_the_station(self):
        for line in NOT_STATION_LINES:
            with self.subTest(line=line):
                wifi, _ = feed_all(wsp.SerialStatusLines(), monitor_chunks(line + b'\r\n'),
                                   station_ip=wsp.QEMU_STATION_IP)
                self.assertEqual(wifi, [])

    def test_the_known_lines_read_as_before_beside_it(self):
        for line, wifi_expected, ble_expected in KNOWN_LINES:
            with self.subTest(line=line):
                got = feed_all(wsp.SerialStatusLines(), monitor_chunks(line + b'\r\n'),
                               station_ip=wsp.QEMU_STATION_IP)
                self.assertEqual(got, (wifi_expected, ble_expected))

    def test_without_a_station_the_parser_reads_as_before(self):
        for line in STATION_LINES[:-1]:
            with self.subTest(line=line):
                self.assertEqual(wsp.parse_serial_text(line.decode()), ([], []))
                self.assertEqual(feed_all(wsp.SerialStatusLines(), [line + b'\r\n']), ([], []))

    def test_only_a_board_with_a_host_forward_reads_its_address(self):
        got = read_loop(uart_tx_lines(0, GALLERY_HTTP_SERVER), hostfwd_port=0)
        self.assertEqual(wifi_events(got), [{'status': 'connected', 'ssid': 'Velxio-GUEST'}])

    def test_the_forward_targets_that_address(self):
        from app.services.esp32_worker import wifi_nic_arg
        nic = wifi_nic_arg('esp32-picsimlab', True, 18080)
        self.assertIn('net=192.168.4.0/24', nic)
        self.assertTrue(nic.endswith(f'-{wsp.QEMU_STATION_IP}:80'), nic)


if __name__ == '__main__':
    unittest.main()
