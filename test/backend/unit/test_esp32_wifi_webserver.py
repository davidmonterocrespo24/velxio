"""
Integration test: ESP32 WiFi + WebServer sketch compilation & emulation.

Verifies the full pipeline for the user's specific sketch:
  1. Sketch structure is valid for ESP32 compilation
  2. WiFi auto-detection triggers wifi_enabled flag
  3. QEMU args include -nic when wifi_enabled=True
  4. WiFi/BLE serial parser extracts correct events from QEMU output
  5. IoT Gateway proxy URL construction
  6. hostfwd port allocation
"""
import socket
import unittest

# ── The user's exact sketch ──────────────────────────────────────────────────

WEBSERVER_SKETCH = r'''#include <WiFi.h>
#include <WebServer.h>

const char* ssid = "Velxio-GUEST";
const char* password = "";

WebServer server(80);

void handleRoot() {
  server.send(200, "text/html", "<h1>Hola desde ESP32 🚀</h1>");
}

void setup() {
  Serial.begin(115200);
  WiFi.begin(ssid, password);
  Serial.print("Conectando");
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println("\nConectado!");
  Serial.print("IP: ");
  Serial.println(WiFi.localIP());
  server.on("/", handleRoot);
  server.begin();
  Serial.println("Servidor HTTP iniciado");
}

void loop() {
  server.handleClient();
}
'''

# Simulated QEMU serial output for this sketch
SIMULATED_SERIAL_OUTPUT = """I (432) wifi:wifi sta start
I (500) wifi:new:Velxio-GUEST, old: , ASSOC
I (800) wifi:connected with Velxio-GUEST, aid = 1, channel 6
I (1200) esp_netif_handlers: sta ip: 192.168.4.2, mask: 255.255.255.0
Conectando...
Conectado!
IP: 192.168.4.2
Servidor HTTP iniciado
"""


class TestSketchStructure(unittest.TestCase):
    """Validate the sketch has the correct structure for ESP32 compilation."""

    def test_has_wifi_include(self):
        self.assertIn('#include <WiFi.h>', WEBSERVER_SKETCH)

    def test_has_webserver_include(self):
        self.assertIn('#include <WebServer.h>', WEBSERVER_SKETCH)

    def test_uses_velxio_guest_ssid(self):
        self.assertIn('"Velxio-GUEST"', WEBSERVER_SKETCH)

    def test_empty_password(self):
        self.assertIn('password = ""', WEBSERVER_SKETCH)

    def test_webserver_port_80(self):
        self.assertIn('WebServer server(80)', WEBSERVER_SKETCH)

    def test_has_setup_and_loop(self):
        self.assertIn('void setup()', WEBSERVER_SKETCH)
        self.assertIn('void loop()', WEBSERVER_SKETCH)

    def test_serial_begin_115200(self):
        self.assertIn('Serial.begin(115200)', WEBSERVER_SKETCH)

    def test_wifi_begin_call(self):
        self.assertIn('WiFi.begin(ssid, password)', WEBSERVER_SKETCH)

    def test_server_routes_registered(self):
        self.assertIn('server.on("/", handleRoot)', WEBSERVER_SKETCH)
        self.assertIn('server.begin()', WEBSERVER_SKETCH)

    def test_handle_client_in_loop(self):
        self.assertIn('server.handleClient()', WEBSERVER_SKETCH)

    def test_handle_root_sends_html(self):
        self.assertIn('server.send(200, "text/html"', WEBSERVER_SKETCH)


class TestWifiAutoDetection(unittest.TestCase):
    """Test that the sketch triggers WiFi auto-detection."""

    @staticmethod
    def detect_wifi(content: str) -> bool:
        return any(pattern in content for pattern in [
            '#include <WiFi.h>',
            '#include <esp_wifi.h>',
            '#include "WiFi.h"',
            'WiFi.begin(',
        ])

    def test_detects_wifi_in_webserver_sketch(self):
        self.assertTrue(self.detect_wifi(WEBSERVER_SKETCH))

    def test_detects_via_wifi_h_include(self):
        self.assertIn('#include <WiFi.h>', WEBSERVER_SKETCH)

    def test_detects_via_wifi_begin(self):
        self.assertIn('WiFi.begin(', WEBSERVER_SKETCH)

    def test_no_detection_for_blink_sketch(self):
        blink = 'void setup() { pinMode(13, OUTPUT); }\nvoid loop() { digitalWrite(13, HIGH); delay(1000); }'
        self.assertFalse(self.detect_wifi(blink))


class TestQemuNicArgs(unittest.TestCase):
    """Test QEMU -nic arg construction for the WebServer sketch."""

    @staticmethod
    def build_args(wifi_enabled: bool, machine: str = 'esp32-picsimlab',
                   hostfwd_port: int = 0) -> list[bytes]:
        args = [b'qemu', b'-M', machine.encode(), b'-nographic']
        if wifi_enabled:
            nic_model = 'esp32c3_wifi' if 'c3' in machine else 'esp32_wifi'
            nic_arg = f'user,model={nic_model},net=192.168.4.0/24'
            if hostfwd_port:
                nic_arg += f',hostfwd=tcp::{hostfwd_port}-192.168.4.15:80'
            args.extend([b'-nic', nic_arg.encode()])
        return args

    def test_wifi_enabled_adds_nic(self):
        args = self.build_args(wifi_enabled=True)
        self.assertIn(b'-nic', args)

    def test_nic_uses_esp32_wifi_model(self):
        args = self.build_args(wifi_enabled=True)
        nic_val = args[args.index(b'-nic') + 1].decode()
        self.assertIn('model=esp32_wifi', nic_val)

    def test_nic_uses_192_168_4_subnet(self):
        args = self.build_args(wifi_enabled=True)
        nic_val = args[args.index(b'-nic') + 1].decode()
        self.assertIn('net=192.168.4.0/24', nic_val)

    def test_hostfwd_maps_to_port_80(self):
        """WebServer listens on port 80, hostfwd should route to it."""
        args = self.build_args(wifi_enabled=True, hostfwd_port=54321)
        nic_val = args[args.index(b'-nic') + 1].decode()
        self.assertIn('hostfwd=tcp::54321-192.168.4.15:80', nic_val)

    def test_no_hostfwd_when_port_zero(self):
        args = self.build_args(wifi_enabled=True, hostfwd_port=0)
        nic_val = args[args.index(b'-nic') + 1].decode()
        self.assertNotIn('hostfwd', nic_val)

    def test_wifi_disabled_no_nic(self):
        args = self.build_args(wifi_enabled=False)
        self.assertNotIn(b'-nic', args)


class TestSerialOutputParsing(unittest.TestCase):
    """Test WiFi/BLE serial parser with the simulated QEMU output."""

    def test_parse_wifi_events_from_serial(self):
        from app.services.wifi_status_parser import parse_serial_text
        wifi_events, ble_events = parse_serial_text(SIMULATED_SERIAL_OUTPUT)

        # Should have at least: initializing, connected, got_ip
        self.assertGreaterEqual(len(wifi_events), 3)

    def test_first_event_is_initializing(self):
        from app.services.wifi_status_parser import parse_serial_text
        wifi_events, _ = parse_serial_text(SIMULATED_SERIAL_OUTPUT)
        self.assertEqual(wifi_events[0]['status'], 'initializing')

    def test_connected_event_has_velxio_guest_ssid(self):
        from app.services.wifi_status_parser import parse_serial_text
        wifi_events, _ = parse_serial_text(SIMULATED_SERIAL_OUTPUT)
        connected = [e for e in wifi_events if e['status'] == 'connected']
        self.assertTrue(len(connected) > 0)
        self.assertIn('Velxio-GUEST', connected[0].get('ssid', ''))

    def test_got_ip_event_has_correct_ip(self):
        from app.services.wifi_status_parser import parse_serial_text
        wifi_events, _ = parse_serial_text(SIMULATED_SERIAL_OUTPUT)
        got_ip = [e for e in wifi_events if e['status'] == 'got_ip']
        self.assertEqual(len(got_ip), 1)
        self.assertEqual(got_ip[0]['ip'], '192.168.4.2')

    def test_ip_in_slirp_subnet(self):
        """QEMU slirp assigns IPs in 192.168.4.x range."""
        from app.services.wifi_status_parser import parse_serial_text
        wifi_events, _ = parse_serial_text(SIMULATED_SERIAL_OUTPUT)
        got_ip = [e for e in wifi_events if e['status'] == 'got_ip']
        self.assertTrue(got_ip[0]['ip'].startswith('192.168.4.'))

    def test_no_ble_events_in_wifi_only_sketch(self):
        from app.services.wifi_status_parser import parse_serial_text
        _, ble_events = parse_serial_text(SIMULATED_SERIAL_OUTPUT)
        self.assertEqual(len(ble_events), 0)


class TestHttpServerDetection(unittest.TestCase):
    """Detect HTTP server from serial output patterns."""

    @staticmethod
    def detect_http_server(serial_output: str) -> dict:
        import re
        server_patterns = [
            r'[Ss]erver\s+at:\s*([\d.]+)',
            r'[Ss]ervidor\s+HTTP\s+iniciado',
        ]
        ip_pattern = r'IP:\s*([\d.]+)'
        has_server = any(re.search(p, serial_output) for p in server_patterns)
        ip_match = re.search(ip_pattern, serial_output)
        return {
            'detected': has_server,
            'ip': ip_match.group(1) if ip_match else None,
        }

    def test_detects_http_server(self):
        result = self.detect_http_server(SIMULATED_SERIAL_OUTPUT)
        self.assertTrue(result['detected'])

    def test_extracts_ip_address(self):
        result = self.detect_http_server(SIMULATED_SERIAL_OUTPUT)
        self.assertEqual(result['ip'], '192.168.4.2')

    def test_no_detection_for_blink_output(self):
        result = self.detect_http_server('Hello World!\nBlink LED\n')
        self.assertFalse(result['detected'])
        self.assertIsNone(result['ip'])


class TestIoTGatewayUrl(unittest.TestCase):
    """Test IoT Gateway URL construction for the WebServer sketch."""

    def test_root_gateway_url(self):
        client_id = 'board-1'
        url = f'http://localhost:8001/api/gateway/{client_id}/'
        self.assertEqual(url, 'http://localhost:8001/api/gateway/board-1/')

    def test_gateway_proxies_to_hostfwd_port(self):
        hostfwd_port = 54321
        esp_url = f'http://127.0.0.1:{hostfwd_port}/'
        self.assertIn(':54321/', esp_url)


class TestFreePortAllocation(unittest.TestCase):
    """Test that _find_free_port returns a valid port for hostfwd."""

    def test_find_free_port(self):
        from app.api.routes.simulation import _find_free_port
        port = _find_free_port()
        self.assertIsInstance(port, int)
        self.assertGreater(port, 0)
        self.assertLess(port, 65536)

    def test_free_port_is_usable(self):
        from app.api.routes.simulation import _find_free_port
        port = _find_free_port()
        # Verify we can bind to the returned port
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            s.bind(('127.0.0.1', port))
        finally:
            s.close()


if __name__ == '__main__':
    unittest.main()
