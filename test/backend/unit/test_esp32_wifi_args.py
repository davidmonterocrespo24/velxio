"""
Tests for the WiFi NIC argument the ESP32 QEMU launch builds.

These call the SHIPPED `wifi_nic_arg`. The previous version of this file
re-implemented the logic inline, so it only ever proved that copy
self-consistent — it would have passed unchanged through issue #260, whose
whole content is that this decision was wrong.
"""
import unittest
from unittest.mock import patch, MagicMock

from app.services.esp32_worker import wifi_nic_arg


class TestWifiNicArg(unittest.TestCase):
    """What the machine gets, and why."""

    def test_radio_attached_even_when_the_sketch_looks_wifi_less(self):
        """The regression #260 is about.

        A real ESP32 has a radio whether or not the sketch uses it. When the
        NIC was conditional, a sketch misread as WiFi-less ran on a machine
        with nothing mapped at the MAC, and the firmware's first register
        touch panicked with LoadStorePIFAddrError instead of failing to
        connect.
        """
        arg = wifi_nic_arg('esp32-picsimlab', wifi_enabled=False)
        self.assertIsNotNone(arg)
        self.assertIn('model=esp32_wifi', arg)
        self.assertIn('net=192.168.4.0/24', arg)

    def test_classic_esp32_model(self):
        arg = wifi_nic_arg('esp32-picsimlab', wifi_enabled=True)
        self.assertIn('model=esp32_wifi', arg)

    def test_c3_uses_its_own_model(self):
        arg = wifi_nic_arg('esp32c3-picsimlab', wifi_enabled=True)
        self.assertIn('model=esp32c3_wifi', arg)

    def test_c3_gets_no_nic_unless_the_sketch_uses_wifi(self):
        """The C3 machine does not survive a radio it was handed.

        With an esp32c3_wifi NIC present the fork resets the eFuse device
        before it realizes it, and the worker aborts at boot with
        `esp_efuse_reload_from_blk: Assertion 's->mirror' failed`. The radio
        was unconditional, so every C3 run on QEMU died that way.
        """
        self.assertIsNone(wifi_nic_arg('esp32c3-picsimlab', wifi_enabled=False))
        self.assertIsNone(
            wifi_nic_arg('esp32c3-picsimlab', wifi_enabled=False, hostfwd_port=12345))

    def test_s3_gets_no_nic_because_it_models_no_radio(self):
        """hw/xtensa/esp32s3.c never looks for the NIC, so handing it one
        would leave an unconsumed netdev."""
        self.assertIsNone(wifi_nic_arg('esp32s3-picsimlab', wifi_enabled=True))
        self.assertIsNone(wifi_nic_arg('esp32s3-picsimlab', wifi_enabled=False))

    def test_hostfwd_included_when_port_set(self):
        arg = wifi_nic_arg('esp32-picsimlab', wifi_enabled=True, hostfwd_port=12345)
        self.assertIn('hostfwd=tcp:127.0.0.1:12345-192.168.4.15:80', arg)

    def test_hostfwd_listens_on_loopback_only(self):
        """A forward with no host address listens on every interface of the
        server (the fork's slirp_hostfwd defaults to INADDR_ANY). Its only
        consumer is the backend's own gateway proxy, which dials 127.0.0.1,
        so the forward must not be reachable from anywhere else (#182)."""
        arg = wifi_nic_arg('esp32-picsimlab', wifi_enabled=True, hostfwd_port=12345)
        rule = next(p for p in arg.split(',') if p.startswith('hostfwd='))
        proto, host_addr, rest = rule[len('hostfwd='):].split(':', 2)
        self.assertEqual(proto, 'tcp')
        self.assertEqual(host_addr, '127.0.0.1')
        self.assertEqual(rest, '12345-192.168.4.15:80')

    def test_hostfwd_absent_when_port_zero(self):
        arg = wifi_nic_arg('esp32-picsimlab', wifi_enabled=True, hostfwd_port=0)
        self.assertNotIn('hostfwd', arg)

    def test_hostfwd_needs_a_sketch_that_serves(self):
        """The forward exposes the guest's server to the host. The radio is
        unconditional; opening a port is not."""
        arg = wifi_nic_arg('esp32-picsimlab', wifi_enabled=False, hostfwd_port=12345)
        self.assertNotIn('hostfwd', arg)


class TestEspQemuManagerWifiArgs(unittest.TestCase):
    """Test that EspQemuManager passes wifi params through."""

    def test_start_instance_accepts_wifi_params(self):
        """start_instance should accept wifi_enabled and wifi_hostfwd_port."""
        from app.services.esp_qemu_manager import EspQemuManager
        mgr = EspQemuManager()

        # start_instance calls `asyncio.create_task(self._boot(...))`. The
        # `_boot(...)` call creates a coroutine BEFORE create_task sees it,
        # so simply mocking create_task with no side-effect lets the
        # coroutine leak and trigger a "coroutine never awaited"
        # RuntimeWarning in the test log.  Close the coroutine inside the
        # mock to consume it cleanly.
        def consume_coroutine(coro):
            coro.close()
            return MagicMock()

        with patch('asyncio.create_task', side_effect=consume_coroutine):
            mgr.start_instance(
                'test-client', 'esp32', MagicMock(),
                firmware_b64=None,
                wifi_enabled=True,
                wifi_hostfwd_port=8080,
            )


class TestEspQemuManagerHostfwd(unittest.IsolatedAsyncioTestCase):
    """The subprocess fallback builds its own -nic: same rule as the worker."""

    async def test_hostfwd_listens_on_loopback_only(self):
        from unittest.mock import AsyncMock
        from app.services.esp_qemu_manager import EspInstance, EspQemuManager

        mgr = EspQemuManager()
        inst = EspInstance('c1', 'esp32', AsyncMock())
        mgr._instances['c1'] = inst
        captured: dict = {}

        async def fake_exec(*cmd, **kwargs):
            captured['cmd'] = list(cmd)
            raise FileNotFoundError(cmd[0])

        with patch('asyncio.create_subprocess_exec', side_effect=fake_exec):
            await mgr._boot(inst, None, wifi_enabled=True, wifi_hostfwd_port=4321)

        cmd = captured['cmd']
        nic = cmd[cmd.index('-nic') + 1]
        self.assertIn('hostfwd=tcp:127.0.0.1:4321-192.168.4.15:80', nic)


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


class TestExplainPifFault(unittest.TestCase):
    """The panic dump says "memory"; the user needs to hear "peripheral"."""

    def test_names_the_wifi_mac_at_the_apb_alias(self):
        from app.services.esp32_worker import _explain_pif_fault
        note = _explain_pif_fault(b'EXCVADDR: 0x60033c00\n')
        self.assertIsNotNone(note)
        self.assertIn('WiFi MAC', note)
        self.assertIn('0x60033c00', note)

    def test_names_the_wifi_mac_at_the_dport_address(self):
        from app.services.esp32_worker import _explain_pif_fault
        note = _explain_pif_fault(b'EXCVADDR: 0x3ff73c00\n')
        self.assertIn('WiFi MAC', note)

    def test_other_addresses_are_still_explained_generically(self):
        from app.services.esp32_worker import _explain_pif_fault
        note = _explain_pif_fault(b'EXCVADDR: 0x3ff40000\n')
        self.assertIn('a peripheral', note)
        self.assertNotIn('WiFi MAC', note)

    def test_waits_for_the_address(self):
        """The cause and EXCVADDR arrive in different chunks."""
        from app.services.esp32_worker import _explain_pif_fault
        self.assertIsNone(_explain_pif_fault(b'Core  0 register dump:\n'))
