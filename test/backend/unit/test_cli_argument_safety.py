"""
test_cli_argument_safety.py: request text never reaches arduino-cli as an option
or as recipe syntax (issue velxio/velxio-prod#236).

* `lib search`, `lib install` and `lib uninstall` take the user's text as a
  positional argument. Placed before any "--", a query that starts with "-" was
  read as one of arduino-cli's own options (--log-file wrote a file the query
  named). The text now always follows "--".
* POST /api/flash/upload hands the request's port and FQBN to `arduino-cli
  upload`, which expands {property} references inside the port string when it
  builds the uploader's command line and splits it on quotes. A port is now a
  plain device name (/dev/... or COM<n>) and an FQBN its words and menu
  options; anything else answers 400 before arduino-cli runs.
"""

from __future__ import annotations

import asyncio
import io
import subprocess
import unittest
from unittest import mock

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.routes import flash
from app.services.arduino_cli import ArduinoCLIService


class _Done:
    returncode = 0
    stdout = '{"libraries": []}'
    stderr = ""


class LibCommandsEndOptionsFirst(unittest.TestCase):
    def setUp(self):
        self.calls: list[list[str]] = []

        def fake_run(argv, *a, **kw):
            self.calls.append(list(argv))
            return _Done()

        patcher = mock.patch.object(subprocess, "run", side_effect=fake_run)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.svc = ArduinoCLIService.__new__(ArduinoCLIService)
        self.svc.cli_path = "arduino-cli"

    def _assert_after_dashdash(self, argv: list[str], text: str):
        self.assertIn("--", argv, argv)
        self.assertEqual(argv[argv.index("--") + 1:], [text], argv)

    def test_a_search_that_looks_like_an_option_is_searched_for(self):
        for q in ("-v", "--log-file=/srv/example/x", "Servo"):
            self.calls.clear()
            asyncio.run(self.svc.search_libraries(q))
            self.assertEqual(len(self.calls), 1)
            self._assert_after_dashdash(self.calls[0], q)
            self.assertEqual(self.calls[0][:3], ["arduino-cli", "lib", "search"])

    def test_an_install_or_uninstall_name_is_never_an_option(self):
        asyncio.run(self.svc.install_library("--log-file=/srv/example/x"))
        self.assertTrue(self.calls)
        for argv in self.calls:
            if argv[1:3] == ["lib", "install"]:
                self.assertIn("--", argv, argv)
                self.assertLess(argv.index("--"), len(argv) - 1, argv)
        self.calls.clear()
        if hasattr(self.svc, "uninstall_library"):
            asyncio.run(self.svc.uninstall_library("-v"))
            uninstall = [a for a in self.calls if a[1:3] == ["lib", "uninstall"]]
            self.assertTrue(uninstall)
            self._assert_after_dashdash(uninstall[0], "-v")


class FlashTakesPlainPortsAndFqbns(unittest.TestCase):
    def setUp(self):
        app = FastAPI()
        app.include_router(flash.router, prefix="/api/flash")
        self.client = TestClient(app)
        # No arduino-cli: a request that passes validation answers 503, so
        # nothing ever runs here.
        patcher = mock.patch.object(flash, "_arduino_cli_bin", return_value=None)
        patcher.start()
        self.addCleanup(patcher.stop)

    def _post(self, port: str, fqbn: str = "arduino:avr:uno"):
        return self.client.post(
            "/api/flash/upload",
            data={"board_id": "b1", "port": port, "fqbn": fqbn, "program_format": "hex"},
            files={"program": ("p.hex", io.BytesIO(b":00000001FF\n"), "application/octet-stream")},
        )

    def test_a_port_with_recipe_syntax_is_refused(self):
        for port in ("p{build.mcu}q", '/dev/ttyUSB0" -C /srv/example/x', "COM3 -v", "{serial.port}", "/dev/tty$HOME"):
            r = self._post(port)
            self.assertEqual(r.status_code, 400, (port, r.text))

    def test_an_fqbn_with_recipe_syntax_is_refused(self):
        for fqbn in ("arduino:avr:uno:{includes}", 'arduino:avr:uno" x', "arduino:avr:uno:cpu=a b"):
            r = self._post("/dev/ttyUSB0", fqbn)
            self.assertEqual(r.status_code, 400, (fqbn, r.text))

    def test_everyday_ports_and_fqbns_pass_validation(self):
        for port in ("/dev/ttyUSB0", "/dev/ttyACM1", "/dev/cu.usbmodem1101", "/dev/tty.usbserial-1420",
                     "/dev/serial/by-id/usb-Arduino__www.arduino.cc__0043_7563-if00", "COM3", "COM12"):
            r = self._post(port)
            self.assertEqual(r.status_code, 503, (port, r.text))
        r = self._post("/dev/ttyUSB0", "esp32:esp32:esp32s3:CDCOnBoot=cdc,PartitionScheme=default")
        self.assertNotEqual(r.status_code, 400, r.text)


if __name__ == "__main__":
    unittest.main()
