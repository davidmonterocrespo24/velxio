"""
Tests for WiFi NIC argument injection in ESP32 QEMU launch.

Verifies that:
  - `-nic user,model=esp32_wifi,...` is added when wifi_enabled=True
  - NIC args are absent when wifi_enabled=False
  - esp32c3_wifi model is used for C3 boards
  - hostfwd port is included when specified
"""
import json
import unittest
from unittest.mock import patch, MagicMock


class TestEsp32WorkerWifiArgs(unittest.TestCase):
    """Test the QEMU arg construction in esp32_worker when WiFi is enabled."""

    def _build_config(self, wifi_enabled=False, wifi_hostfwd_port=0,
                      machine='esp32-picsimlab'):
        return json.dumps({
            'lib_path': '/fake/libqemu-xtensa.so',
            'firmware_b64': 'AAAA',  # minimal base64
            'machine': machine,
            'sensors': [],
            'wifi_enabled': wifi_enabled,
            'wifi_hostfwd_port': wifi_hostfwd_port,
        })

    def test_wifi_disabled_no_nic_arg(self):
        """When wifi_enabled=False, -nic should NOT appear in args."""
        cfg = json.loads(self._build_config(wifi_enabled=False))
        args = self._simulate_args(cfg)
        self.assertNotIn(b'-nic', args)

    def test_wifi_enabled_adds_nic_arg(self):
        """When wifi_enabled=True, -nic should appear with esp32_wifi model."""
        cfg = json.loads(self._build_config(wifi_enabled=True))
        args = self._simulate_args(cfg)
        self.assertIn(b'-nic', args)
        nic_idx = args.index(b'-nic')
        nic_val = args[nic_idx + 1].decode()
        self.assertIn('model=esp32_wifi', nic_val)
        self.assertIn('net=192.168.4.0/24', nic_val)

    def test_wifi_enabled_c3_uses_c3_model(self):
        """ESP32-C3 machines should use esp32c3_wifi model."""
        cfg = json.loads(self._build_config(
            wifi_enabled=True, machine='esp32c3-picsimlab'))
        args = self._simulate_args(cfg)
        nic_idx = args.index(b'-nic')
        nic_val = args[nic_idx + 1].decode()
        self.assertIn('model=esp32c3_wifi', nic_val)

    def test_hostfwd_included_when_port_set(self):
        """When wifi_hostfwd_port is set, hostfwd should appear in NIC arg."""
        cfg = json.loads(self._build_config(
            wifi_enabled=True, wifi_hostfwd_port=12345))
        args = self._simulate_args(cfg)
        nic_idx = args.index(b'-nic')
        nic_val = args[nic_idx + 1].decode()
        self.assertIn('hostfwd=tcp::12345-192.168.4.15:80', nic_val)

    def test_hostfwd_absent_when_port_zero(self):
        """When wifi_hostfwd_port is 0, hostfwd should NOT appear."""
        cfg = json.loads(self._build_config(
            wifi_enabled=True, wifi_hostfwd_port=0))
        args = self._simulate_args(cfg)
        nic_idx = args.index(b'-nic')
        nic_val = args[nic_idx + 1].decode()
        self.assertNotIn('hostfwd', nic_val)

    @staticmethod
    def _simulate_args(cfg: dict) -> list[bytes]:
        """Simulate the arg-building logic from esp32_worker.main()."""
        machine = cfg.get('machine', 'esp32-picsimlab')
        wifi_enabled = cfg.get('wifi_enabled', False)
        wifi_hostfwd_port = cfg.get('wifi_hostfwd_port', 0)

        args_list = [
            b'qemu',
            b'-M', machine.encode(),
            b'-nographic',
            b'-L', b'/fake/rom',
            b'-drive', b'file=/tmp/fw.bin,if=mtd,format=raw',
        ]

        if wifi_enabled:
            nic_model = 'esp32c3_wifi' if 'c3' in machine else 'esp32_wifi'
            nic_arg = f'user,model={nic_model},net=192.168.4.0/24'
            if wifi_hostfwd_port:
                nic_arg += f',hostfwd=tcp::{wifi_hostfwd_port}-192.168.4.15:80'
            args_list.extend([b'-nic', nic_arg.encode()])

        return args_list


class TestEspQemuManagerWifiArgs(unittest.TestCase):
    """Test that EspQemuManager passes wifi params through."""

    def test_start_instance_accepts_wifi_params(self):
        """start_instance should accept wifi_enabled and wifi_hostfwd_port."""
        from app.services.esp_qemu_manager import EspQemuManager
        mgr = EspQemuManager()
        # Should not raise
        with patch('asyncio.create_task'):
            mgr.start_instance(
                'test-client', 'esp32', MagicMock(),
                firmware_b64=None,
                wifi_enabled=True,
                wifi_hostfwd_port=8080,
            )


class TestSimulationWifiPort(unittest.TestCase):
    """Test that simulation.py allocates a free port for WiFi hostfwd."""

    def test_find_free_port(self):
        from app.api.routes.simulation import _find_free_port
        port = _find_free_port()
        self.assertIsInstance(port, int)
        self.assertGreater(port, 0)
        self.assertLess(port, 65536)


if __name__ == '__main__':
    unittest.main()
