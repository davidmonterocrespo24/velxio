"""
Tests for WiFi/BLE serial output parser.

Feeds sample ESP-IDF log patterns and verifies correct status events.
"""
import unittest
from app.services.wifi_status_parser import (
    parse_wifi_line,
    parse_ble_line,
    parse_serial_text,
)


class TestWifiLineParser(unittest.TestCase):

    def test_wifi_sta_start(self):
        line = 'I (432) wifi:wifi sta start'
        result = parse_wifi_line(line)
        self.assertIsNotNone(result)
        self.assertEqual(result['status'], 'initializing')

    def test_wifi_connected(self):
        line = 'I (1234) wifi:connected with Velxio-GUEST, aid = 1, channel 6'
        result = parse_wifi_line(line)
        self.assertIsNotNone(result)
        self.assertEqual(result['status'], 'connected')
        self.assertEqual(result['ssid'], 'Velxio-GUEST')

    def test_wifi_got_ip(self):
        line = 'I (2345) esp_netif_handlers: sta ip: 192.168.4.2, mask: 255.255.255.0'
        result = parse_wifi_line(line)
        self.assertIsNotNone(result)
        self.assertEqual(result['status'], 'got_ip')
        self.assertEqual(result['ip'], '192.168.4.2')

    def test_wifi_disconnect(self):
        line = 'I (9999) wifi:state: run -> init (0)'
        result = parse_wifi_line(line)
        self.assertIsNotNone(result)
        self.assertEqual(result['status'], 'disconnected')

    def test_wifi_new_ssid(self):
        line = 'I (500) wifi:new:Velxio-GUEST, old: , ASSOC'
        result = parse_wifi_line(line)
        self.assertIsNotNone(result)
        self.assertEqual(result['status'], 'connected')
        self.assertIn('Velxio-GUEST', result.get('ssid', ''))

    def test_no_match(self):
        line = 'I (100) main: Hello World!'
        result = parse_wifi_line(line)
        self.assertIsNone(result)

    def test_empty_line(self):
        result = parse_wifi_line('')
        self.assertIsNone(result)


class TestBleLineParser(unittest.TestCase):

    def test_ble_init(self):
        line = 'I (300) BT_INIT: BT controller compile version [abcd1234]'
        result = parse_ble_line(line)
        self.assertIsNotNone(result)
        self.assertEqual(result['status'], 'initialized')

    def test_ble_advertising_gatts(self):
        line = 'I (500) GATTS: advertising started'
        result = parse_ble_line(line)
        self.assertIsNotNone(result)
        self.assertEqual(result['status'], 'advertising')

    def test_ble_advertising_gap(self):
        line = 'I (600) GAP_BLE: advertisement config done'
        result = parse_ble_line(line)
        self.assertIsNotNone(result)
        self.assertEqual(result['status'], 'advertising')

    def test_no_match(self):
        result = parse_ble_line('I (100) main: just a message')
        self.assertIsNone(result)


class TestParseSerialText(unittest.TestCase):

    def test_mixed_output(self):
        text = """I (432) wifi:wifi sta start
I (500) wifi:new:Velxio-GUEST, old:
I (800) wifi:connected with Velxio-GUEST, aid = 1
I (1200) esp_netif_handlers: sta ip: 192.168.4.2, mask: 255.255.255.0
I (300) BT_INIT: BT controller compile version [abc]
I (500) GATTS: advertising started
"""
        wifi_events, ble_events = parse_serial_text(text)
        self.assertGreaterEqual(len(wifi_events), 3)
        self.assertEqual(wifi_events[0]['status'], 'initializing')
        self.assertEqual(wifi_events[-1]['status'], 'got_ip')
        self.assertEqual(wifi_events[-1]['ip'], '192.168.4.2')
        self.assertGreaterEqual(len(ble_events), 2)
        self.assertEqual(ble_events[0]['status'], 'initialized')
        self.assertEqual(ble_events[1]['status'], 'advertising')

    def test_empty_text(self):
        wifi_events, ble_events = parse_serial_text('')
        self.assertEqual(len(wifi_events), 0)
        self.assertEqual(len(ble_events), 0)

    def test_no_matches(self):
        text = 'Hello World!\nJust some output\n'
        wifi_events, ble_events = parse_serial_text(text)
        self.assertEqual(len(wifi_events), 0)
        self.assertEqual(len(ble_events), 0)


if __name__ == '__main__':
    unittest.main()
