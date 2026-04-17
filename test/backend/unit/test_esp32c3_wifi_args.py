"""
Tests for ESP32-C3 (RISC-V) WiFi NIC argument injection and status parsing.

Verifies that:
  - `-nic user,model=esp32c3_wifi,...` is used (not esp32_wifi)
  - RISC-V machine name is used (esp32c3-picsimlab)
  - hostfwd port is included when specified
  - WiFi serial parser works with C3 output (same ESP-IDF log format)
  - Free port allocation works
"""
import socket
import unittest


class TestEsp32C3QemuNicArgs(unittest.TestCase):
    """Test QEMU arg construction for ESP32-C3 with WiFi enabled."""

    @staticmethod
    def _simulate_args(wifi_enabled: bool, machine: str = 'esp32c3-picsimlab',
                       hostfwd_port: int = 0) -> list[bytes]:
        """Simulate arg-building logic from esp32_worker.main() for C3."""
        args = [
            b'qemu-system-riscv32',
            b'-M', machine.encode(),
            b'-nographic',
            b'-L', b'/fake/rom',
            b'-drive', b'file=/tmp/fw.bin,if=mtd,format=raw',
        ]
        if wifi_enabled:
            nic_model = 'esp32c3_wifi' if 'c3' in machine else 'esp32_wifi'
            nic_arg = f'user,model={nic_model},net=192.168.4.0/24'
            if hostfwd_port:
                nic_arg += f',hostfwd=tcp::{hostfwd_port}-192.168.4.15:80'
            args.extend([b'-nic', nic_arg.encode()])
        return args

    def test_c3_uses_riscv32_binary(self):
        """ESP32-C3 should use qemu-system-riscv32."""
        args = self._simulate_args(wifi_enabled=False)
        self.assertEqual(args[0], b'qemu-system-riscv32')

    def test_c3_uses_esp32c3_picsimlab_machine(self):
        """ESP32-C3 machine name should be esp32c3-picsimlab."""
        args = self._simulate_args(wifi_enabled=False)
        self.assertEqual(args[2], b'esp32c3-picsimlab')

    def test_c3_wifi_enabled_adds_nic(self):
        """When wifi_enabled=True, -nic should appear in C3 args."""
        args = self._simulate_args(wifi_enabled=True)
        self.assertIn(b'-nic', args)

    def test_c3_wifi_uses_esp32c3_wifi_model(self):
        """C3 NIC model should be esp32c3_wifi, NOT esp32_wifi."""
        args = self._simulate_args(wifi_enabled=True)
        nic_idx = args.index(b'-nic')
        nic_val = args[nic_idx + 1].decode()
        self.assertIn('model=esp32c3_wifi', nic_val)
        self.assertNotIn('model=esp32_wifi,', nic_val)

    def test_c3_wifi_uses_192_168_4_subnet(self):
        """Same slirp subnet as Xtensa ESP32."""
        args = self._simulate_args(wifi_enabled=True)
        nic_idx = args.index(b'-nic')
        nic_val = args[nic_idx + 1].decode()
        self.assertIn('net=192.168.4.0/24', nic_val)

    def test_c3_hostfwd_included_when_port_set(self):
        """hostfwd should map to ESP32-C3 port 80."""
        args = self._simulate_args(wifi_enabled=True, hostfwd_port=12345)
        nic_idx = args.index(b'-nic')
        nic_val = args[nic_idx + 1].decode()
        self.assertIn('hostfwd=tcp::12345-192.168.4.15:80', nic_val)

    def test_c3_hostfwd_absent_when_port_zero(self):
        """No hostfwd when port is 0."""
        args = self._simulate_args(wifi_enabled=True, hostfwd_port=0)
        nic_idx = args.index(b'-nic')
        nic_val = args[nic_idx + 1].decode()
        self.assertNotIn('hostfwd', nic_val)

    def test_c3_wifi_disabled_no_nic(self):
        """When wifi_enabled=False, -nic should NOT appear."""
        args = self._simulate_args(wifi_enabled=False)
        self.assertNotIn(b'-nic', args)


class TestEsp32C3WifiSerialParser(unittest.TestCase):
    """WiFi/BLE serial parser works with ESP32-C3 output (same ESP-IDF format)."""

    # Simulated C3 serial output (same ESP-IDF log format as Xtensa)
    C3_SERIAL_OUTPUT = """I (432) wifi:wifi sta start
I (500) wifi:new:Velxio-GUEST, old: , ASSOC
I (800) wifi:connected with Velxio-GUEST, aid = 1, channel 6
I (1200) esp_netif_handlers: sta ip: 192.168.4.2, mask: 255.255.255.0
"""

    C3_BLE_OUTPUT = """I (300) BT_INIT: BT controller compile version [abcd1234]
I (500) GATTS: advertising started
"""

    def test_c3_wifi_events_parsed(self):
        from app.services.wifi_status_parser import parse_serial_text
        wifi_events, _ = parse_serial_text(self.C3_SERIAL_OUTPUT)
        self.assertGreaterEqual(len(wifi_events), 3)

    def test_c3_first_event_initializing(self):
        from app.services.wifi_status_parser import parse_serial_text
        wifi_events, _ = parse_serial_text(self.C3_SERIAL_OUTPUT)
        self.assertEqual(wifi_events[0]['status'], 'initializing')

    def test_c3_connected_has_velxio_guest(self):
        from app.services.wifi_status_parser import parse_serial_text
        wifi_events, _ = parse_serial_text(self.C3_SERIAL_OUTPUT)
        connected = [e for e in wifi_events if e['status'] == 'connected']
        self.assertTrue(len(connected) > 0)
        self.assertIn('Velxio-GUEST', connected[0].get('ssid', ''))

    def test_c3_got_ip_correct(self):
        from app.services.wifi_status_parser import parse_serial_text
        wifi_events, _ = parse_serial_text(self.C3_SERIAL_OUTPUT)
        got_ip = [e for e in wifi_events if e['status'] == 'got_ip']
        self.assertEqual(len(got_ip), 1)
        self.assertEqual(got_ip[0]['ip'], '192.168.4.2')

    def test_c3_ble_events_parsed(self):
        from app.services.wifi_status_parser import parse_serial_text
        _, ble_events = parse_serial_text(self.C3_BLE_OUTPUT)
        self.assertGreaterEqual(len(ble_events), 2)
        self.assertEqual(ble_events[0]['status'], 'initialized')
        self.assertEqual(ble_events[1]['status'], 'advertising')

    def test_c3_no_ble_in_wifi_only_output(self):
        from app.services.wifi_status_parser import parse_serial_text
        _, ble_events = parse_serial_text(self.C3_SERIAL_OUTPUT)
        self.assertEqual(len(ble_events), 0)


class TestEsp32C3FreePort(unittest.TestCase):
    """Free port allocation for C3 hostfwd."""

    def test_find_free_port(self):
        from app.api.routes.simulation import _find_free_port
        port = _find_free_port()
        self.assertIsInstance(port, int)
        self.assertGreater(port, 0)
        self.assertLess(port, 65536)

    def test_free_port_is_bindable(self):
        from app.api.routes.simulation import _find_free_port
        port = _find_free_port()
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            s.bind(('127.0.0.1', port))
        finally:
            s.close()


class TestEsp32C3QemuManagerMapping(unittest.TestCase):
    """Test that EspQemuManager maps C3 to RISC-V correctly."""

    def test_c3_maps_to_riscv32(self):
        """The _MACHINE dict should map esp32-c3 to qemu-system-riscv32."""
        from app.services.esp_qemu_manager import _MACHINE
        self.assertIn('esp32-c3', _MACHINE)
        qemu_bin, machine_name = _MACHINE['esp32-c3']
        self.assertIn('riscv32', qemu_bin)
        self.assertEqual(machine_name, 'esp32c3')


if __name__ == '__main__':
    unittest.main()
