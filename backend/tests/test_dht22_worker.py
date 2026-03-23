"""
test_dht22_worker.py — Diagnostic tests for the ESP32 DHT22 response mechanism.

Tests the core algorithm extracted from esp32_worker.py:
  1. Payload encoding (_dht22_build_payload)
  2. Callback state machine (pin_change → saw_low, dir_change → response trigger)
  3. Response pin-drive sequence (preamble + 40 data bits)
  4. Timing analysis
"""

import threading
import time
import unittest


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  Extracted logic from esp32_worker.py (closures inside main())
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

def dht22_build_payload(temperature: float, humidity: float) -> list[int]:
    """Build 5-byte DHT22 data payload: [hum_H, hum_L, temp_H, temp_L, checksum]."""
    hum = round(humidity * 10)
    tmp = round(temperature * 10)
    h_H = (hum >> 8) & 0xFF
    h_L = hum & 0xFF
    raw_t = ((-tmp) & 0x7FFF) | 0x8000 if tmp < 0 else tmp & 0x7FFF
    t_H = (raw_t >> 8) & 0xFF
    t_L = raw_t & 0xFF
    chk = (h_H + h_L + t_H + t_L) & 0xFF
    return [h_H, h_L, t_H, t_L, chk]


def busy_wait_us(us: int) -> None:
    """Busy-wait for the given number of microseconds using perf_counter_ns."""
    end = time.perf_counter_ns() + us * 1000
    while time.perf_counter_ns() < end:
        pass


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  Mock QEMU environment
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

class MockLib:
    """Mock for the ctypes QEMU library.  Records every set_pin call."""

    def __init__(self):
        self.pin_events: list[tuple[float, int, int]] = []  # (timestamp_ns, slot, value)
        self._lock = threading.Lock()

    def qemu_picsimlab_set_pin(self, slot: int, value: int) -> None:
        ts = time.perf_counter_ns()
        with self._lock:
            self.pin_events.append((ts, slot, value))


class DHT22SimulatorHarness:
    """
    Minimal simulation of the esp32_worker callback environment for DHT22.

    Mirrors the exact logic from esp32_worker.py's _on_pin_change and
    _on_dir_change closures, plus the _dht22_respond thread function.
    """

    def __init__(self, gpio_count: int = 40):
        self.gpio_count = gpio_count
        # Identity pinmap: slot i → GPIO (i-1)
        self.pinmap = list(range(-1, gpio_count))  # pinmap[0]=count placeholder
        self.pinmap[0] = gpio_count                 # pinmap[0] = count

        self.sensors: dict[int, dict] = {}
        self.sensors_lock = threading.Lock()
        self.stopped = threading.Event()
        self.lib = MockLib()

        # Collect emitted events
        self.emitted_events: list[dict] = []

    def register_sensor(self, gpio: int, sensor_type: str, **kwargs):
        with self.sensors_lock:
            self.sensors[gpio] = {
                'type': sensor_type,
                'saw_low': False,
                'responding': False,
                **kwargs,
            }

    def _emit(self, obj: dict):
        self.emitted_events.append(obj)

    # ── Callback replicas (mirroring esp32_worker.py) ──

    def on_pin_change(self, slot: int, value: int) -> None:
        """Replica of _on_pin_change from esp32_worker.py."""
        if self.stopped.is_set():
            return
        gpio = self.pinmap[slot] if 1 <= slot <= self.gpio_count else slot
        self._emit({'type': 'gpio_change', 'pin': gpio, 'state': value})

        with self.sensors_lock:
            sensor = self.sensors.get(gpio)
        if sensor is None:
            return

        stype = sensor.get('type', '')

        if stype == 'dht22':
            if value == 0 and not sensor.get('responding', False):
                sensor['saw_low'] = True

    def on_dir_change(self, slot: int, direction: int) -> None:
        """Replica of _on_dir_change from esp32_worker.py (DHT22 portion)."""
        if self.stopped.is_set():
            return

        if slot >= 1:
            gpio = self.pinmap[slot] if slot <= self.gpio_count else slot
            with self.sensors_lock:
                sensor = self.sensors.get(gpio)
            if sensor is not None and sensor.get('type') == 'dht22':
                if direction == 1:
                    sensor['dir_out_ns'] = time.perf_counter_ns()
                elif direction == 0:
                    if sensor.get('saw_low', False) and not sensor.get('responding', False):
                        sensor['saw_low'] = False
                        sensor['responding'] = True

                        now_ns = time.perf_counter_ns()
                        dir_out_ns = sensor.get('dir_out_ns', now_ns)
                        wall_us = max(1.0, (now_ns - dir_out_ns) / 1000)
                        qemu_us_signal = 1200.0
                        ratio = wall_us / qemu_us_signal

                        # Drive pin LOW synchronously
                        self.lib.qemu_picsimlab_set_pin(slot, 0)

                        threading.Thread(
                            target=self._dht22_respond,
                            args=(gpio, sensor.get('temperature', 25.0),
                                  sensor.get('humidity', 50.0), ratio),
                            daemon=True,
                            name=f'dht22-gpio{gpio}',
                        ).start()

        # Emit gpio_dir event (like the real worker does after DHT22 handling)
        if slot >= 1:
            gpio = self.pinmap[slot] if 1 <= slot <= self.gpio_count else slot
            self._emit({'type': 'gpio_dir', 'pin': gpio, 'dir': direction})

    def _dht22_respond(self, gpio_pin: int, temperature: float, humidity: float,
                       ratio: float) -> None:
        """Replica of _dht22_respond from esp32_worker.py."""
        slot = gpio_pin + 1
        payload = dht22_build_payload(temperature, humidity)

        def qemu_wait(qemu_us: float) -> None:
            wall_us = max(1, int(qemu_us * ratio))
            busy_wait_us(wall_us)

        t0 = time.perf_counter_ns()
        error_msg: str | None = None
        try:
            # Preamble: hold LOW 80 µs → drive HIGH 80 µs
            qemu_wait(80)
            self.lib.qemu_picsimlab_set_pin(slot, 1)
            qemu_wait(80)

            # 40 data bits
            for byte_val in payload:
                for b in range(7, -1, -1):
                    bit = (byte_val >> b) & 1
                    self.lib.qemu_picsimlab_set_pin(slot, 0)
                    qemu_wait(50)
                    self.lib.qemu_picsimlab_set_pin(slot, 1)
                    qemu_wait(70 if bit else 26)

            # Final release
            self.lib.qemu_picsimlab_set_pin(slot, 0)
            qemu_wait(50)
            self.lib.qemu_picsimlab_set_pin(slot, 1)
        except Exception as exc:
            error_msg = str(exc)
        finally:
            elapsed_us = (time.perf_counter_ns() - t0) / 1000
            with self.sensors_lock:
                sensor = self.sensors.get(gpio_pin)
                if sensor:
                    sensor['responding'] = False
            if error_msg:
                print(f'  DHT22 respond ERROR gpio={gpio_pin}: {error_msg}')
            else:
                print(f'  DHT22 respond done gpio={gpio_pin} ratio={ratio:.4f} '
                      f'elapsed={elapsed_us:.0f}µs')


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  Test cases
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

class TestDHT22Payload(unittest.TestCase):
    """Test the 5-byte payload encoding."""

    def test_positive_temperature(self):
        payload = dht22_build_payload(28.0, 65.0)
        self.assertEqual(len(payload), 5)
        # Humidity: 65.0 → 650 → 0x028A → [0x02, 0x8A]
        self.assertEqual(payload[0], 0x02)
        self.assertEqual(payload[1], 0x8A)
        # Temperature: 28.0 → 280 → 0x0118 → [0x01, 0x18]
        self.assertEqual(payload[2], 0x01)
        self.assertEqual(payload[3], 0x18)
        # Checksum
        expected_chk = (0x02 + 0x8A + 0x01 + 0x18) & 0xFF
        self.assertEqual(payload[4], expected_chk)

    def test_negative_temperature(self):
        payload = dht22_build_payload(-5.0, 80.0)
        # Temperature: -5.0 → -50 → (50 & 0x7FFF) | 0x8000 = 0x8032 → [0x80, 0x32]
        self.assertEqual(payload[2], 0x80)
        self.assertEqual(payload[3], 0x32)

    def test_zero_values(self):
        payload = dht22_build_payload(0.0, 0.0)
        self.assertEqual(payload, [0, 0, 0, 0, 0])

    def test_checksum_wraps(self):
        payload = dht22_build_payload(25.5, 99.9)
        chk = sum(payload[:4]) & 0xFF
        self.assertEqual(payload[4], chk)


class TestDHT22PinMapping(unittest.TestCase):
    """Verify identity pinmap: slot i → GPIO (i-1)."""

    def test_esp32_gpio4_slot5(self):
        harness = DHT22SimulatorHarness(gpio_count=40)
        # GPIO 4 → slot 5
        self.assertEqual(harness.pinmap[5], 4)

    def test_esp32_gpio_range(self):
        harness = DHT22SimulatorHarness(gpio_count=40)
        for gpio in range(40):
            slot = gpio + 1
            self.assertEqual(harness.pinmap[slot], gpio,
                             f'pinmap[{slot}] should be {gpio}')

    def test_esp32c3_gpio_range(self):
        harness = DHT22SimulatorHarness(gpio_count=22)
        for gpio in range(22):
            slot = gpio + 1
            self.assertEqual(harness.pinmap[slot], gpio,
                             f'ESP32-C3: pinmap[{slot}] should be {gpio}')


class TestDHT22StateMachine(unittest.TestCase):
    """Test the saw_low / responding state machine."""

    def setUp(self):
        self.harness = DHT22SimulatorHarness()
        self.harness.register_sensor(4, 'dht22', temperature=28.0, humidity=65.0)

    def test_initial_state(self):
        sensor = self.harness.sensors[4]
        self.assertFalse(sensor['saw_low'])
        self.assertFalse(sensor['responding'])

    def test_pin_change_low_sets_saw_low(self):
        self.harness.on_pin_change(5, 0)  # slot=5 → GPIO 4, value=0 (LOW)
        sensor = self.harness.sensors[4]
        self.assertTrue(sensor['saw_low'], 'saw_low should be True after LOW pin_change')

    def test_pin_change_high_does_not_set_saw_low(self):
        self.harness.on_pin_change(5, 1)  # HIGH
        sensor = self.harness.sensors[4]
        self.assertFalse(sensor['saw_low'])

    def test_pin_change_low_blocked_when_responding(self):
        sensor = self.harness.sensors[4]
        sensor['responding'] = True
        self.harness.on_pin_change(5, 0)  # LOW
        self.assertFalse(sensor['saw_low'],
                         'saw_low should remain False when responding=True')

    def test_dir_change_output_records_timestamp(self):
        self.harness.on_dir_change(5, 1)  # direction=1 → OUTPUT
        sensor = self.harness.sensors[4]
        self.assertIn('dir_out_ns', sensor)
        self.assertIsInstance(sensor['dir_out_ns'], (int, float))

    def test_dir_change_input_without_saw_low_does_not_trigger(self):
        """If saw_low is False, dir_change(INPUT) should NOT trigger response."""
        self.harness.on_dir_change(5, 1)  # OUTPUT
        # Do NOT call pin_change(LOW) → saw_low stays False
        self.harness.on_dir_change(5, 0)  # INPUT
        sensor = self.harness.sensors[4]
        self.assertFalse(sensor['responding'],
                         'Should not trigger response without saw_low')
        self.assertEqual(len(self.harness.lib.pin_events), 0,
                         'No pin drives should happen without saw_low')

    def test_full_sequence_triggers_response(self):
        """Simulate the full firmware DHT22 start signal sequence."""
        # 1. pinMode(OUTPUT) → dir_change(1)
        self.harness.on_dir_change(5, 1)
        # 2. digitalWrite(LOW) → pin_change(0)
        self.harness.on_pin_change(5, 0)
        sensor = self.harness.sensors[4]
        self.assertTrue(sensor['saw_low'])

        # 3. delayMicroseconds(1100) — simulate with small sleep
        time.sleep(0.001)

        # 4. digitalWrite(HIGH) → pin_change(1)
        self.harness.on_pin_change(5, 1)

        # 5. delayMicroseconds(55) — simulate
        time.sleep(0.00005)

        # 6. pinMode(INPUT_PULLUP) → dir_change(0) → TRIGGERS RESPONSE
        self.harness.on_dir_change(5, 0)

        # Wait for response thread to complete
        time.sleep(1.0)

        self.assertFalse(sensor['responding'],
                         'responding should be False after response thread completes')

        # Check pin events were recorded
        events = self.harness.lib.pin_events
        self.assertGreater(len(events), 0,
                           'Response thread should have driven pins')

        print(f'\n  Total pin events: {len(events)}')
        # Expected: 1 (sync LOW) + 1 (HIGH preamble) + 40*2 (data bits) + 2 (final) = 84 drives
        expected_drives = 1 + 1 + 40 * 2 + 2
        self.assertEqual(len(events), expected_drives,
                         f'Expected {expected_drives} pin drives, got {len(events)}')


class TestDHT22ResponseWaveform(unittest.TestCase):
    """Verify the exact pin-drive sequence of the DHT22 response."""

    def test_response_sequence(self):
        harness = DHT22SimulatorHarness()
        harness.register_sensor(4, 'dht22', temperature=28.0, humidity=65.0)

        # Trigger full sequence
        harness.on_dir_change(5, 1)     # OUTPUT
        harness.on_pin_change(5, 0)     # LOW (saw_low=True)
        time.sleep(0.001)               # simulate delayMicroseconds(1100)
        harness.on_pin_change(5, 1)     # HIGH
        time.sleep(0.00005)
        harness.on_dir_change(5, 0)     # INPUT → triggers response

        time.sleep(1.0)  # wait for response thread

        events = harness.lib.pin_events
        if not events:
            self.fail('No pin events recorded — response thread did not run!')

        # Extract slot/value pairs (ignore timestamps)
        drives = [(slot, value) for _, slot, value in events]
        print(f'\n  Pin drives ({len(drives)} total):')

        # 1. Synchronous LOW from on_dir_change
        self.assertEqual(drives[0], (5, 0), 'First drive should be sync LOW on slot 5')

        # 2. HIGH preamble
        self.assertEqual(drives[1], (5, 1), 'Second drive should be HIGH preamble')

        # 3. Data bits: alternating LOW/HIGH for 40 bits = 80 drives
        payload = dht22_build_payload(28.0, 65.0)
        data_drives = drives[2:82]  # 80 drives for 40 bits
        self.assertEqual(len(data_drives), 80, f'Expected 80 data drives, got {len(data_drives)}')

        # Verify data drives alternate LOW/HIGH
        for i, (slot, value) in enumerate(data_drives):
            self.assertEqual(slot, 5, f'Data drive {i}: wrong slot')
            expected_value = 0 if i % 2 == 0 else 1
            self.assertEqual(value, expected_value,
                             f'Data drive {i}: expected {"LOW" if expected_value == 0 else "HIGH"}, '
                             f'got {"LOW" if value == 0 else "HIGH"}')

        # 4. Final: LOW then HIGH
        self.assertEqual(drives[82], (5, 0), 'Final LOW')
        self.assertEqual(drives[83], (5, 1), 'Final HIGH (release)')

        print('  Waveform sequence: CORRECT ✓')

    def test_response_data_matches_payload(self):
        """Verify that the HIGH pulse durations encode the correct bits."""
        harness = DHT22SimulatorHarness()
        harness.register_sensor(4, 'dht22', temperature=28.0, humidity=65.0)

        # Trigger
        harness.on_dir_change(5, 1)
        harness.on_pin_change(5, 0)
        time.sleep(0.001)
        harness.on_pin_change(5, 1)
        time.sleep(0.00005)
        harness.on_dir_change(5, 0)
        time.sleep(1.0)

        events = harness.lib.pin_events
        if len(events) < 84:
            self.fail(f'Expected 84 pin events, got {len(events)}')

        # Extract HIGH pulse durations (between set_pin(1) and set_pin(0))
        # Data starts at event index 2
        payload = dht22_build_payload(28.0, 65.0)
        expected_bits = []
        for byte_val in payload:
            for b in range(7, -1, -1):
                expected_bits.append((byte_val >> b) & 1)

        # For each data bit, check HIGH duration relative to LOW duration
        # bit=0: HIGH ≈ 26µs, bit=1: HIGH ≈ 70µs
        # LOW phase always ≈ 50µs
        decoded_bits = []
        for i in range(40):
            # Event index: 2 + i*2 = LOW drive, 2 + i*2 + 1 = HIGH drive
            low_ts = events[2 + i * 2][0]    # timestamp of LOW
            high_ts = events[2 + i * 2 + 1][0]  # timestamp of HIGH
            # Next LOW (or final LOW) timestamp
            next_low_ts = events[2 + (i + 1) * 2][0] if i < 39 else events[82][0]

            low_dur_us = (high_ts - low_ts) / 1000
            high_dur_us = (next_low_ts - high_ts) / 1000

            # Decode: HIGH > LOW → bit 1, else bit 0
            decoded_bit = 1 if high_dur_us > low_dur_us else 0
            decoded_bits.append(decoded_bit)

        self.assertEqual(decoded_bits, expected_bits,
                         'Decoded bits from waveform do not match expected payload')

        # Reconstruct bytes from decoded bits
        decoded_bytes = []
        for byte_idx in range(5):
            val = 0
            for bit_idx in range(8):
                val = (val << 1) | decoded_bits[byte_idx * 8 + bit_idx]
            decoded_bytes.append(val)

        print(f'\n  Expected payload: {[hex(b) for b in payload]}')
        print(f'  Decoded payload:  {[hex(b) for b in decoded_bytes]}')
        self.assertEqual(decoded_bytes, payload, 'Decoded bytes do not match payload')
        print('  Data encoding: CORRECT ✓')


class TestDHT22ResponseTiming(unittest.TestCase):
    """Analyze the timing of the response to check for issues."""

    def test_response_timing_analysis(self):
        """Measure actual timing of the response with ratio=1.0 (real-time)."""
        harness = DHT22SimulatorHarness()
        harness.register_sensor(4, 'dht22', temperature=28.0, humidity=65.0)

        # Use a fixed ratio of 1.0 for predictable timing
        sensor = harness.sensors[4]
        sensor['dir_out_ns'] = time.perf_counter_ns() - 1200000  # 1200µs ago

        harness.on_dir_change(5, 1)     # OUTPUT (record dir_out_ns)
        harness.on_pin_change(5, 0)     # LOW

        # Simulate ~1200µs delay (the real firmware's start signal)
        busy_wait_us(1200)

        harness.on_pin_change(5, 1)     # HIGH
        busy_wait_us(55)

        t_dir_input = time.perf_counter_ns()
        harness.on_dir_change(5, 0)     # INPUT → triggers
        t_after_callback = time.perf_counter_ns()

        callback_us = (t_after_callback - t_dir_input) / 1000
        print(f'\n  dir_change(INPUT) callback duration: {callback_us:.0f}µs')

        time.sleep(1.0)  # wait for response

        events = harness.lib.pin_events
        self.assertGreater(len(events), 0, 'No pin events!')

        # Timing analysis
        t_first_event = events[0][0]
        t_last_event = events[-1][0]
        total_us = (t_last_event - t_first_event) / 1000

        # Time from callback to first pin drive (sync LOW in callback)
        sync_low_delay_us = (events[0][0] - t_dir_input) / 1000

        # Time from sync LOW to first HIGH (preamble HIGH)
        preamble_low_us = 0.0
        response_start_us = 0.0
        if len(events) >= 2:
            preamble_low_us = (events[1][0] - events[0][0]) / 1000
            response_start_us = (events[1][0] - t_after_callback) / 1000

        print(f'  Sync LOW delay from callback start: {sync_low_delay_us:.0f}µs')
        print(f'  Preamble LOW duration (expected 80µs): {preamble_low_us:.0f}µs')
        print(f'  Response thread first drive after callback return: {response_start_us:.0f}µs')
        print(f'  Total response waveform duration: {total_us:.0f}µs')
        print(f'  Total pin events: {len(events)}')

        # The preamble LOW should be close to 80µs (± tolerance for busy-wait accuracy)
        # At ratio ~1.0, we expect 80µs ± 50%
        self.assertGreater(preamble_low_us, 30,
                           f'Preamble LOW too short: {preamble_low_us:.0f}µs (expected ~80µs)')
        # On busy systems / GIL contention, preamble can be up to ~500µs
        self.assertLess(preamble_low_us, 1000,
                        f'Preamble LOW too long: {preamble_low_us:.0f}µs (expected ~80µs)')


class TestDHT22MultipleReads(unittest.TestCase):
    """Test that multiple consecutive reads work correctly."""

    def test_second_read_after_first_completes(self):
        harness = DHT22SimulatorHarness()
        harness.register_sensor(4, 'dht22', temperature=28.0, humidity=65.0)

        for attempt in range(3):
            # Reset events
            harness.lib.pin_events.clear()

            # Full sequence
            harness.on_dir_change(5, 1)     # OUTPUT
            harness.on_pin_change(5, 0)     # LOW
            time.sleep(0.001)
            harness.on_pin_change(5, 1)     # HIGH
            time.sleep(0.00005)
            harness.on_dir_change(5, 0)     # INPUT → triggers
            time.sleep(0.5)                 # wait for response

            sensor = harness.sensors[4]
            self.assertFalse(sensor['responding'],
                             f'Attempt {attempt+1}: responding should be False after completion')
            self.assertGreater(len(harness.lib.pin_events), 0,
                               f'Attempt {attempt+1}: no pin events!')
            print(f'  Attempt {attempt+1}: {len(harness.lib.pin_events)} pin events ✓')

    def test_sensor_reregistration_resets_state(self):
        """Simulate what happens when sensor_attach command arrives mid-read."""
        harness = DHT22SimulatorHarness()
        harness.register_sensor(4, 'dht22', temperature=28.0, humidity=65.0)

        # Start first read
        harness.on_dir_change(5, 1)     # OUTPUT
        harness.on_pin_change(5, 0)     # LOW → saw_low=True

        # Simulate sensor_attach command arriving (re-registration)
        harness.register_sensor(4, 'dht22', temperature=28.0, humidity=65.0)

        sensor = harness.sensors[4]
        self.assertFalse(sensor['saw_low'],
                         'saw_low should be reset after re-registration')

        # Continue the sequence
        time.sleep(0.001)
        harness.on_pin_change(5, 1)     # HIGH
        time.sleep(0.00005)
        harness.on_dir_change(5, 0)     # INPUT → should NOT trigger (saw_low was reset!)

        time.sleep(0.1)
        self.assertEqual(len(harness.lib.pin_events), 0,
                         'Re-registration reset saw_low, so response should NOT trigger!')
        print('  Sensor re-registration correctly prevents false trigger ✓')
        print('  ⚠ WARNING: If sensor_attach arrives between pin_change(LOW) and '
              'dir_change(INPUT), the read attempt will fail silently!')


class TestDHT22EdgeCases(unittest.TestCase):
    """Test edge cases that could cause the DHT22 to fail."""

    def test_no_sensor_registered(self):
        """pin_change/dir_change with no sensor should not crash."""
        harness = DHT22SimulatorHarness()
        harness.on_pin_change(5, 0)
        harness.on_dir_change(5, 1)
        harness.on_dir_change(5, 0)
        self.assertEqual(len(harness.lib.pin_events), 0)

    def test_wrong_gpio_pin(self):
        """Sensor on GPIO 4 should not respond to events on GPIO 5."""
        harness = DHT22SimulatorHarness()
        harness.register_sensor(4, 'dht22', temperature=28.0, humidity=65.0)

        # Trigger on slot 6 (GPIO 5) — wrong pin
        harness.on_dir_change(6, 1)
        harness.on_pin_change(6, 0)
        time.sleep(0.001)
        harness.on_dir_change(6, 0)
        time.sleep(0.1)

        sensor = harness.sensors[4]
        self.assertFalse(sensor['saw_low'])
        self.assertFalse(sensor['responding'])
        self.assertEqual(len(harness.lib.pin_events), 0)

    def test_dir_change_input_before_output(self):
        """Dir change to INPUT before OUTPUT should be ignored (no dir_out_ns)."""
        harness = DHT22SimulatorHarness()
        harness.register_sensor(4, 'dht22', temperature=28.0, humidity=65.0)

        # Skip OUTPUT, go straight to INPUT after a LOW
        harness.on_pin_change(5, 0)     # LOW → saw_low=True
        harness.on_dir_change(5, 0)     # INPUT → triggers (saw_low=True)

        time.sleep(0.5)

        sensor = harness.sensors[4]
        # It should still trigger (saw_low was True)
        events = harness.lib.pin_events
        if events:
            print(f'  Triggered without prior OUTPUT: {len(events)} pin events')
            print('  ⚠ NOTE: Ratio will be near-zero because dir_out_ns is missing. '
                  'This could produce invalid timing.')

    def test_slot_to_gpio_consistency(self):
        """Verify slot = gpio + 1 mapping in response matches on_dir_change."""
        harness = DHT22SimulatorHarness()
        harness.register_sensor(4, 'dht22', temperature=28.0, humidity=65.0)

        harness.on_dir_change(5, 1)
        harness.on_pin_change(5, 0)
        time.sleep(0.001)
        harness.on_pin_change(5, 1)
        time.sleep(0.00005)
        harness.on_dir_change(5, 0)
        time.sleep(0.5)

        events = harness.lib.pin_events
        if events:
            # All events should be on slot 5 (gpio 4 + 1)
            slots = {e[1] for e in events}
            self.assertEqual(slots, {5},
                             f'All pin drives should be on slot 5, got slots: {slots}')
            print(f'  All {len(events)} drives on slot 5 (GPIO 4): CONSISTENT ✓')


class TestBusyWaitAccuracy(unittest.TestCase):
    """Verify busy_wait_us accuracy on this system."""

    def test_busy_wait_100us(self):
        t0 = time.perf_counter_ns()
        busy_wait_us(100)
        elapsed_us = (time.perf_counter_ns() - t0) / 1000
        print(f'\n  busy_wait_us(100): actual={elapsed_us:.0f}µs (expected ~100µs)')
        self.assertGreater(elapsed_us, 50, 'Way too fast')
        self.assertLess(elapsed_us, 500, 'Way too slow')

    def test_busy_wait_1us(self):
        t0 = time.perf_counter_ns()
        busy_wait_us(1)
        elapsed_us = (time.perf_counter_ns() - t0) / 1000
        print(f'\n  busy_wait_us(1): actual={elapsed_us:.0f}µs')
        self.assertLess(elapsed_us, 100, 'Way too slow for 1µs wait')

    def test_perf_counter_resolution(self):
        """Check time.perf_counter_ns() resolution."""
        samples = []
        for _ in range(100):
            t0 = time.perf_counter_ns()
            t1 = time.perf_counter_ns()
            if t1 > t0:
                samples.append(t1 - t0)
        if samples:
            avg_ns = sum(samples) / len(samples)
            print(f'\n  perf_counter_ns resolution: ~{avg_ns:.0f}ns '
                  f'(min={min(samples)}ns, max={max(samples)}ns)')


if __name__ == '__main__':
    unittest.main(verbosity=2)
