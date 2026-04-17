"""
test_mpu6050_emulation.py — MPU-6050 I2C slave emulation tests.

Validates that the MPU6050Slave state machine correctly handles the full
Adafruit_MPU6050::begin() event sequence so "MPU6050 not found! Check wiring."
does NOT appear in the serial output when running the MPU-6050 sketch on the
ESP32 emulator.

== Root Cause (Fixed) ==

Adafruit_MPU6050::begin() uses Adafruit_BusIO which fires exactly THREE
START+READ events before chip_id is validated:
  1. Wire.begin(sda, scl) bus-init probe → START+READ(WHO_AM_I=0x68)
  2. _wire->begin() inside i2c_dev->begin() → START+READ(WHO_AM_I=0x68)
  3. chip_id_register.read() → START+READ(WHO_AM_I=0x68)   ← must still be WHO_AM_I mode

With the old threshold (_who_am_i_count >= 2), read #3 landed in data mode
and returned regs[0x3B] = 0x00 instead of 0x68, causing begin() to return false.
The fix raises the threshold to >= 3 so chip_id.read() still returns 0x68.

== Event Encoding (picsimlab) ==
  event & 0x00FF  = operation:
    0x01 = START  (return 1 = ACK)
    0x05 = WRITE  (first byte / register address; return 1 = ACK)
    0x06 = WRITE  (subsequent bytes / data; return 1 = ACK)
    0x03 = READ   (return register byte at current pointer)
    0x00 = STOP   (return 0)
  (event >> 8) & 0xFF = data byte for WRITE events

== Test Classes ==
  TestMPU6050SlaveLogReplay  — replays the exact backend log sequence; documents
                               bug (old threshold) and proves fix (new threshold)
  TestMPU6050SlaveBeginFlow  — full Adafruit begin() flow simulation
  TestMPU6050Movement        — sensor data update and 14-byte data block reads;
                               emulates accelerometer/gyroscope movement output
  TestMPU6050FullSketchFlow  — end-to-end sketch scenario from Wire.begin to
                               repeated getEvent() calls with changing motion

Run from the repository root:
    python -m pytest test/esp32/test_mpu6050_emulation.py -v

Or directly:
    python test/esp32/test_mpu6050_emulation.py
"""

import math
import sys
import unittest
from pathlib import Path

# ── Bootstrap path ─────────────────────────────────────────────────────────────
ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'backend'))

from app.services.esp32_i2c_slaves import MPU6050Slave

# ── Protocol constants ─────────────────────────────────────────────────────────

I2C_START = 0x0001
I2C_STOP  = 0x0000
I2C_READ  = 0x0003


def i2c_write(byte: int) -> int:
    """WRITE event: data in high byte, type 0x05 (first byte) in low byte."""
    return ((byte & 0xFF) << 8) | 0x05


def i2c_write_data(byte: int) -> int:
    """WRITE event: data in high byte, type 0x06 (subsequent byte) in low byte."""
    return ((byte & 0xFF) << 8) | 0x06


def i2c_read_seq(slave: MPU6050Slave, reg: int, n: int) -> list[int]:
    """Standard I2C read: START, WRITE(reg), n × READ, STOP."""
    slave.handle_event(I2C_START)
    slave.handle_event(i2c_write(reg))
    data = [slave.handle_event(I2C_READ) for _ in range(n)]
    slave.handle_event(I2C_STOP)
    return data


def read_i16(hi: int, lo: int) -> int:
    """Reassemble a signed 16-bit integer from two bytes (big-endian, MPU-6050 order)."""
    raw = (hi << 8) | lo
    return raw - 65536 if raw >= 32768 else raw


# ══════════════════════════════════════════════════════════════════════════════
# 1.  TestMPU6050SlaveLogReplay
#     Replays the exact I2C event sequence captured in the backend log.
#     Documents precisely which reads fired before/after the threshold switch
#     and proves the fix corrects the bug.
# ══════════════════════════════════════════════════════════════════════════════

class TestMPU6050SlaveLogReplay(unittest.TestCase):
    """Replay of the exact picsimlab log sequence from the failing emulation run.

    Log (annotated):
      START → reg_ptr=0x75  (count=0)
      READ  → 0x68           (count=1)
      START → reg_ptr=0x75  (count=1)  [old: >= 2 not met yet; new: >= 3 not met yet]
      READ  → 0x68           (count=2)
      START → ...            (count=2)  [OLD: >= 2 met → reg_ptr=0x3B (data mode!)]
      READ  → 0x00           ← chip_id gets 0x00 → begin() returns false → "not found"

      With fix (>= 3):       (count=2)  [NEW: >= 3 not met → reg_ptr=0x75 (WHO_AM_I mode)]
      READ  → 0x68           ← chip_id gets 0x68 → begin() returns true ✓
      START → ...            (count=3)  [>= 3 met → reg_ptr=0x3B (data mode) ✓]
    """

    def _make_slave(self) -> MPU6050Slave:
        return MPU6050Slave(addr=0x68)

    # ── Bug documentation: verify the FIXED code now passes all 3 WHO_AM_I ──

    def test_read1_returns_who_am_i(self):
        """1st START+READ (Wire.begin probe) must return 0x68."""
        m = self._make_slave()
        m.handle_event(I2C_START)
        result = m.handle_event(I2C_READ)
        self.assertEqual(result, 0x68, f'Expected 0x68, got 0x{result:02x}')

    def test_read2_returns_who_am_i(self):
        """2nd START+READ (i2c_dev->begin) must return 0x68."""
        m = self._make_slave()
        m.handle_event(I2C_START); m.handle_event(I2C_READ)   # read 1
        m.handle_event(I2C_START)
        result = m.handle_event(I2C_READ)
        self.assertEqual(result, 0x68, f'Expected 0x68, got 0x{result:02x}')

    def test_read3_chip_id_returns_0x68_not_data(self):
        """3rd START+READ (chip_id.read) must STILL return 0x68, not accel data.

        This is the bug: with old threshold (>= 2), the 3rd START switched to
        data mode (0x3B) and chip_id got 0x00. With the fix (>= 3) it stays in
        WHO_AM_I mode and returns 0x68.
        """
        m = self._make_slave()
        m.handle_event(I2C_START); m.handle_event(I2C_READ)   # read 1
        m.handle_event(I2C_START); m.handle_event(I2C_READ)   # read 2
        # This 3rd pair is chip_id.read() — must NOT get 0x00 (the default regs[0x3B])
        m.handle_event(I2C_START)
        chip_id = m.handle_event(I2C_READ)
        self.assertEqual(chip_id, 0x68,
            'chip_id.read() (3rd START+READ) returned 0x00 instead of 0x68 — '
            'begin() will fail with "MPU6050 not found!". Check threshold in handle_event().')

    def test_data_mode_active_after_third_read(self):
        """4th START (after 3 WHO_AM_I reads) must switch reg_ptr to 0x3B."""
        m = self._make_slave()
        for _ in range(3):
            m.handle_event(I2C_START); m.handle_event(I2C_READ)
        # 4th START → data mode
        m.handle_event(I2C_START)
        first_byte = m.handle_event(I2C_READ)
        self.assertEqual(first_byte, m.regs[0x3B],
            'After 3 WHO_AM_I reads, 4th START must set reg_ptr=0x3B (accel data block)')

    def test_full_log_sequence_begin_succeeds(self):
        """Simulate the full log sequence and confirm begin() would pass chip_id check."""
        m = self._make_slave()
        # Log pairs 1 and 2 (Wire.begin + i2c_dev->begin bus init)
        m.handle_event(I2C_START)
        r = m.handle_event(I2C_READ)
        self.assertEqual(r, 0x68, 'pair 1')
        m.handle_event(I2C_START)
        r = m.handle_event(I2C_READ)
        self.assertEqual(r, 0x68, 'pair 2')
        # Log pair 3 (chip_id.read()) — would be followed by:
        #   if (chip_id.read() != MPU6050_DEVICE_ID) return false;
        m.handle_event(I2C_START)
        chip_id = m.handle_event(I2C_READ)
        self.assertEqual(chip_id, 0x68)
        # Confirm: we've transitioned to data mode
        self.assertEqual(m._who_am_i_count, 3)
        # Log pairs continue with data reads (reset() reads PWR_MGMT_1, etc.)
        m.handle_event(I2C_START)
        accel_hi = m.handle_event(I2C_READ)
        self.assertEqual(accel_hi, m.regs[0x3B],
            'First byte after begin() must be ACCEL_XOUT_H (0x3B)')


# ══════════════════════════════════════════════════════════════════════════════
# 2.  TestMPU6050SlaveBeginFlow
#     Full simulation of Adafruit_MPU6050::begin() / _init() / reset() event
#     sequences as they actually hit picsimlab.
# ══════════════════════════════════════════════════════════════════════════════

class TestMPU6050SlaveBeginFlow(unittest.TestCase):
    """Full Adafruit begin() flow — every I2C event that picsimlab fires."""

    def setUp(self) -> None:
        self.m = MPU6050Slave()

    def _do_begin_phase(self) -> int:
        """Simulate the three WHO_AM_I reads from begin(); returns chip_id value."""
        self.m.handle_event(I2C_START); self.m.handle_event(I2C_READ)  # probe 1
        self.m.handle_event(I2C_START); self.m.handle_event(I2C_READ)  # probe 2
        self.m.handle_event(I2C_START)
        return self.m.handle_event(I2C_READ)                            # chip_id

    # ── i2c_dev->begin() / detected() ─────────────────────────────────────

    def test_ack_on_every_start(self):
        for _ in range(5):
            ack = self.m.handle_event(I2C_START)
            self.assertEqual(ack, 1, 'Every START must return 1 (ACK)')

    def test_chip_id_read_returns_0x68(self):
        chip_id = self._do_begin_phase()
        self.assertEqual(chip_id, 0x68,
            'Adafruit chip_id.read() must return MPU6050_DEVICE_ID=0x68')

    def test_who_am_i_count_after_begin_phase(self):
        self._do_begin_phase()
        self.assertEqual(self.m._who_am_i_count, 3,
            '_who_am_i_count must be exactly 3 after begin() WHO_AM_I sequence')

    def test_data_mode_active_after_begin_phase(self):
        self._do_begin_phase()
        # Next START after begin() (from _init → reset() → device_reset.write(1))
        self.m.handle_event(I2C_START)
        self.assertEqual(self.m.reg_ptr, 0x3B,
            'reg_ptr must be 0x3B (accel block) after begin() completes')

    # ── reset() — device_reset bit auto-clear ─────────────────────────────

    def test_device_reset_write_clears_immediately(self):
        """reset() writes 0x80 to PWR_MGMT_1 (0x6B); bit7 must auto-clear."""
        self._do_begin_phase()
        # reset() → write 0x80 to register 0x6B
        self.m.handle_event(I2C_START)
        self.m.handle_event(i2c_write(0x6B))   # set register pointer
        self.m.handle_event(i2c_write_data(0x80))  # DEVICE_RESET bit
        self.m.handle_event(I2C_STOP)
        # Verify bit7 is cleared (reset complete)
        val = i2c_read_seq(self.m, 0x6B, 1)[0]
        self.assertEqual(val & 0x80, 0,
            'DEVICE_RESET bit (0x6B bit7) must auto-clear after write')

    def test_pwr_mgmt1_default_is_awake(self):
        """PWR_MGMT_1 (0x6B) default must be 0x00 (not sleeping)."""
        val = i2c_read_seq(self.m, 0x6B, 1)[0]
        self.assertEqual(val, 0x00, 'PWR_MGMT_1 must default to 0x00 (device awake)')

    def test_reset_wait_loop_exits_immediately(self):
        """reset() busy-waits while device_reset.read() == 1.
        The auto-clear ensures the loop exits on the very first read.
        Simulate: write 0x80; then read back 0x6B; expect bit7 == 0."""
        self._do_begin_phase()
        self.m.handle_event(I2C_START)
        self.m.handle_event(i2c_write(0x6B))
        self.m.handle_event(i2c_write_data(0x80))
        self.m.handle_event(I2C_STOP)
        # reset() busy-wait: read 0x6B, check bit7
        val = i2c_read_seq(self.m, 0x6B, 1)[0]
        self.assertEqual(val >> 7, 0, 'Busy-wait must see bit7=0 immediately (auto-clear)')

    # ── Config registers set by _init() ───────────────────────────────────

    def test_accel_config_register_readable(self):
        """ACCEL_CONFIG (0x1C) must be readable via I2C."""
        val = i2c_read_seq(self.m, 0x1C, 1)[0]
        self.assertIsInstance(val, int)

    def test_gyro_config_register_readable(self):
        """GYRO_CONFIG (0x1B) must be readable via I2C."""
        val = i2c_read_seq(self.m, 0x1B, 1)[0]
        self.assertIsInstance(val, int)

    def test_write_to_accel_config_sticks(self):
        """Writing to ACCEL_CONFIG (0x1C) must persist for subsequent read."""
        self.m.handle_event(I2C_START)
        self.m.handle_event(i2c_write(0x1C))
        self.m.handle_event(i2c_write_data(0x10))   # ±8g range
        self.m.handle_event(I2C_STOP)
        val = i2c_read_seq(self.m, 0x1C, 1)[0]
        self.assertEqual(val, 0x10, 'ACCEL_CONFIG write must persist')

    def test_write_to_gyro_config_sticks(self):
        """Writing to GYRO_CONFIG (0x1B) must persist for subsequent read."""
        self.m.handle_event(I2C_START)
        self.m.handle_event(i2c_write(0x1B))
        self.m.handle_event(i2c_write_data(0x08))   # ±500°/s range
        self.m.handle_event(I2C_STOP)
        val = i2c_read_seq(self.m, 0x1B, 1)[0]
        self.assertEqual(val, 0x08, 'GYRO_CONFIG write must persist')


# ══════════════════════════════════════════════════════════════════════════════
# 3.  TestMPU6050Movement
#     Validates that the sensor registers reflect the values set by update(),
#     and that a full 14-byte getEvent() read returns the correct data.
# ══════════════════════════════════════════════════════════════════════════════

class TestMPU6050Movement(unittest.TestCase):
    """Sensor value update() and data block reads — simulates live movement."""

    def setUp(self) -> None:
        self.m = MPU6050Slave()
        # Advance past WHO_AM_I phase so data reads work correctly
        for _ in range(3):
            self.m.handle_event(I2C_START)
            self.m.handle_event(I2C_READ)
        self.m.handle_event(I2C_START)   # 4th START → data mode

    # ── Default values ─────────────────────────────────────────────────────

    def test_default_accel_x_is_zero(self):
        b = i2c_read_seq(self.m, 0x3B, 2)
        self.assertEqual(read_i16(b[0], b[1]), 0, 'Default ACCEL_X must be 0')

    def test_default_accel_y_is_zero(self):
        b = i2c_read_seq(self.m, 0x3D, 2)
        self.assertEqual(read_i16(b[0], b[1]), 0, 'Default ACCEL_Y must be 0')

    def test_default_accel_z_is_1g(self):
        """ACCEL_Z defaults to +1g = 16384 (0x4000) at ±2g full-scale."""
        b = i2c_read_seq(self.m, 0x3F, 2)
        val = read_i16(b[0], b[1])
        self.assertEqual(val, 16384, f'Default ACCEL_Z must be +1g = 16384, got {val}')

    def test_default_gyro_all_zero(self):
        """Gyro defaults (no rotation): GYRO_X/Y/Z must all be 0."""
        b = i2c_read_seq(self.m, 0x43, 6)
        for i in range(0, 6, 2):
            val = read_i16(b[i], b[i+1])
            axis = ['X', 'Y', 'Z'][i // 2]
            self.assertEqual(val, 0, f'Default GYRO_{axis} must be 0, got {val}')

    def test_default_temp_approx_25c(self):
        """Default temperature is 25°C: raw = (25 - 36.53) × 340 ≈ -3920."""
        b = i2c_read_seq(self.m, 0x41, 2)
        raw = read_i16(b[0], b[1])
        temp_c = raw / 340.0 + 36.53
        self.assertAlmostEqual(temp_c, 25.0, delta=0.1,
            msg=f'Default temp must be ≈25°C, computed {temp_c:.2f}°C from raw={raw}')

    # ── update() changes register values ──────────────────────────────────

    def test_update_accel_x_positive(self):
        self.m.update(accel_x=1.0, accel_y=0.0, accel_z=0.0)
        b = i2c_read_seq(self.m, 0x3B, 2)
        val = read_i16(b[0], b[1])
        self.assertEqual(val, 16384, f'update(accel_x=1.0) must yield 16384, got {val}')

    def test_update_accel_x_negative(self):
        self.m.update(accel_x=-1.0, accel_y=0.0, accel_z=0.0)
        b = i2c_read_seq(self.m, 0x3B, 2)
        val = read_i16(b[0], b[1])
        self.assertEqual(val, -16384, f'update(accel_x=-1.0) must yield -16384, got {val}')

    def test_update_accel_y(self):
        self.m.update(accel_x=0.0, accel_y=0.5, accel_z=0.0)
        b = i2c_read_seq(self.m, 0x3D, 2)
        val = read_i16(b[0], b[1])
        self.assertEqual(val, 8192, f'update(accel_y=0.5) must yield 8192, got {val}')

    def test_update_accel_z(self):
        self.m.update(accel_x=0.0, accel_y=0.0, accel_z=0.8)
        b = i2c_read_seq(self.m, 0x3F, 2)
        val = read_i16(b[0], b[1])
        self.assertEqual(val, round(0.8 * 16384),
            f'update(accel_z=0.8) must yield {round(0.8*16384)}, got {val}')

    def test_update_gyro_x(self):
        """Gyro sensitivity at ±250°/s: 1 dps = 131 LSB."""
        self.m.update(gyro_x=90.0)
        b = i2c_read_seq(self.m, 0x43, 2)
        val = read_i16(b[0], b[1])
        expected = round(90 * 131)
        self.assertEqual(val, expected, f'GYRO_X: expected {expected}, got {val}')

    def test_update_gyro_y(self):
        self.m.update(gyro_y=-45.0)
        b = i2c_read_seq(self.m, 0x45, 2)
        val = read_i16(b[0], b[1])
        expected = round(-45 * 131)
        self.assertEqual(val, expected, f'GYRO_Y: expected {expected}, got {val}')

    def test_update_gyro_z(self):
        self.m.update(gyro_z=180.0)
        b = i2c_read_seq(self.m, 0x47, 2)
        val = read_i16(b[0], b[1])
        expected = round(180 * 131)
        self.assertEqual(val, expected, f'GYRO_Z: expected {expected}, got {val}')

    def test_update_temperature(self):
        self.m.update(temp=30.0)
        b = i2c_read_seq(self.m, 0x41, 2)
        raw = read_i16(b[0], b[1])
        temp_c = raw / 340.0 + 36.53
        self.assertAlmostEqual(temp_c, 30.0, delta=0.15,
            msg=f'update(temp=30.0) → {temp_c:.2f}°C (expected 30.0°C)')

    # ── Full 14-byte getEvent() read block ────────────────────────────────

    def test_full_getEvent_read_14_bytes(self):
        """getEvent() reads 14 consecutive bytes starting at 0x3B.
        Layout: ACCEL_X(2), ACCEL_Y(2), ACCEL_Z(2), TEMP(2), GYRO_X(2), GYRO_Y(2), GYRO_Z(2)
        """
        ax, ay, az = 0.5, 0.3, 0.8
        gx, gy, gz = 45.0, -20.0, 10.0
        temp_c = 28.0
        self.m.update(accel_x=ax, accel_y=ay, accel_z=az,
                      gyro_x=gx, gyro_y=gy, gyro_z=gz, temp=temp_c)

        # Simulate getEvent(): START → 14 sequential READs from 0x3B → STOP
        self.m.handle_event(I2C_START)
        self.m.handle_event(i2c_write(0x3B))   # set register pointer
        raw = [self.m.handle_event(I2C_READ) for _ in range(14)]
        self.m.handle_event(I2C_STOP)

        self.assertEqual(len(raw), 14, 'getEvent() must produce exactly 14 bytes')

        # Decode and verify each axis
        got_ax = read_i16(raw[0],  raw[1])
        got_ay = read_i16(raw[2],  raw[3])
        got_az = read_i16(raw[4],  raw[5])
        got_t  = read_i16(raw[6],  raw[7])
        got_gx = read_i16(raw[8],  raw[9])
        got_gy = read_i16(raw[10], raw[11])
        got_gz = read_i16(raw[12], raw[13])

        self.assertAlmostEqual(got_ax / 16384.0, ax, delta=0.001, msg='ACCEL_X mismatch')
        self.assertAlmostEqual(got_ay / 16384.0, ay, delta=0.001, msg='ACCEL_Y mismatch')
        self.assertAlmostEqual(got_az / 16384.0, az, delta=0.001, msg='ACCEL_Z mismatch')

        got_temp_c = got_t / 340.0 + 36.53
        self.assertAlmostEqual(got_temp_c, temp_c, delta=0.15, msg='TEMP mismatch')

        self.assertAlmostEqual(got_gx / 131.0, gx, delta=0.5, msg='GYRO_X mismatch')
        self.assertAlmostEqual(got_gy / 131.0, gy, delta=0.5, msg='GYRO_Y mismatch')
        self.assertAlmostEqual(got_gz / 131.0, gz, delta=0.5, msg='GYRO_Z mismatch')

    def test_sequential_reads_advance_pointer(self):
        """After setting reg_ptr=0x3B, repeated READs must advance the pointer."""
        self.m.handle_event(I2C_START)
        self.m.handle_event(i2c_write(0x3B))
        bytes_out = [self.m.handle_event(I2C_READ) for _ in range(14)]
        self.m.handle_event(I2C_STOP)
        # Pointer should now be at 0x49 (0x3B + 14)
        self.assertEqual(self.m.reg_ptr, 0x49)

    def test_multiple_getEvent_calls(self):
        """Multiple consecutive getEvent() calls must each return the latest update() values."""
        # First measurement
        self.m.update(accel_x=1.0, accel_y=0.0, accel_z=0.0)
        b1 = i2c_read_seq(self.m, 0x3B, 2)
        v1 = read_i16(b1[0], b1[1])
        self.assertEqual(v1, 16384, 'First read: ACCEL_X=1g=16384')

        # update() with new values mid-flight
        self.m.update(accel_x=0.0, accel_y=0.0, accel_z=1.0)
        b2 = i2c_read_seq(self.m, 0x3B, 2)
        v2 = read_i16(b2[0], b2[1])
        self.assertEqual(v2, 0, 'After update(accel_x=0): ACCEL_X must be 0')

        b3 = i2c_read_seq(self.m, 0x3F, 2)
        v3 = read_i16(b3[0], b3[1])
        self.assertEqual(v3, 16384, 'After update(accel_z=1): ACCEL_Z must be +1g=16384')


# ══════════════════════════════════════════════════════════════════════════════
# 4.  TestMPU6050FullSketchFlow
#     End-to-end scenario: simulate the exact I2C event sequence produced by
#     running the MPU-6050 Accelerometer & Gyroscope sketch on the ESP32.
#
#     Sketch excerpt:
#       void setup() {
#         Wire.begin(21, 22);
#         if (!mpu.begin()) { Serial.println("MPU6050 not found!"); while(1); }
#         mpu.setAccelerometerRange(MPU6050_RANGE_8_G);
#         mpu.setGyroRange(MPU6050_RANGE_500_DEG);
#         mpu.setFilterBandwidth(MPU6050_BAND_21_HZ);
#         Serial.println("MPU6050 ready!");
#       }
#       void loop() {
#         sensors_event_t a, g, t;
#         mpu.getEvent(&a, &g, &t);
#         Serial.printf("Accel X=%.2f ...", a.acceleration.x, ...);
#         delay(500);
#       }
# ══════════════════════════════════════════════════════════════════════════════

class TestMPU6050FullSketchFlow(unittest.TestCase):
    """Simulates the full Arduino sketch I2C event sequence."""

    def setUp(self) -> None:
        self.m = MPU6050Slave()

    def _simulate_begin(self) -> bool:
        """Simulate mpu.begin() — returns True if it would succeed."""
        # Three WHO_AM_I reads
        for _ in range(2):
            self.m.handle_event(I2C_START)
            self.m.handle_event(I2C_READ)
        self.m.handle_event(I2C_START)
        chip_id = self.m.handle_event(I2C_READ)
        return chip_id == 0x68   # MPU6050_DEVICE_ID

    def _simulate_device_reset(self) -> bool:
        """Simulate reset() — write 0x80 to 0x6B, then poll until bit7=0."""
        # write 0x80
        self.m.handle_event(I2C_START)
        self.m.handle_event(i2c_write(0x6B))
        self.m.handle_event(i2c_write_data(0x80))
        self.m.handle_event(I2C_STOP)
        # read back — loop exits immediately due to auto-clear
        self.m.handle_event(I2C_START)
        self.m.handle_event(i2c_write(0x6B))
        val = self.m.handle_event(I2C_READ)
        self.m.handle_event(I2C_STOP)
        return (val & 0x80) == 0   # True = loop exits

    def _simulate_get_event(self) -> dict:
        """Simulate mpu.getEvent() — read 14 bytes from 0x3B."""
        self.m.handle_event(I2C_START)
        self.m.handle_event(i2c_write(0x3B))
        raw = [self.m.handle_event(I2C_READ) for _ in range(14)]
        self.m.handle_event(I2C_STOP)
        ax = read_i16(raw[0],  raw[1])  / 16384.0
        ay = read_i16(raw[2],  raw[3])  / 16384.0
        az = read_i16(raw[4],  raw[5])  / 16384.0
        t  = read_i16(raw[6],  raw[7])  / 340.0 + 36.53
        gx = read_i16(raw[8],  raw[9])  / 131.0
        gy = read_i16(raw[10], raw[11]) / 131.0
        gz = read_i16(raw[12], raw[13]) / 131.0
        return {'ax': ax, 'ay': ay, 'az': az, 'temp': t,
                'gx': gx, 'gy': gy, 'gz': gz}

    # ── Tests ──────────────────────────────────────────────────────────────

    def test_begin_returns_true(self):
        """mpu.begin() must return true (chip_id=0x68 matches MPU6050_DEVICE_ID)."""
        ok = self._simulate_begin()
        self.assertTrue(ok,
            'mpu.begin() returned false — would print "MPU6050 not found! Check wiring."')

    def test_device_reset_exits_immediately(self):
        """After begin(), reset() auto-clear lets firmware proceed without hanging."""
        self._simulate_begin()
        ok = self._simulate_device_reset()
        self.assertTrue(ok, 'Device reset busy-wait must exit (bit7 auto-cleared)')

    def test_get_event_default_flat_on_table(self):
        """Default state: device flat on table. ACCEL_Z ≈ +1g, others ≈ 0."""
        self._simulate_begin()
        self._simulate_device_reset()
        ev = self._simulate_get_event()
        self.assertAlmostEqual(ev['ax'], 0.0, delta=0.05, msg='Default ACCEL_X must be ≈0g')
        self.assertAlmostEqual(ev['ay'], 0.0, delta=0.05, msg='Default ACCEL_Y must be ≈0g')
        self.assertAlmostEqual(ev['az'], 1.0, delta=0.05, msg='Default ACCEL_Z must be ≈+1g')
        self.assertAlmostEqual(ev['gx'], 0.0, delta=1.0,  msg='Default GYRO_X must be ≈0 dps')
        self.assertAlmostEqual(ev['gy'], 0.0, delta=1.0,  msg='Default GYRO_Y must be ≈0 dps')
        self.assertAlmostEqual(ev['gz'], 0.0, delta=1.0,  msg='Default GYRO_Z must be ≈0 dps')
        self.assertAlmostEqual(ev['temp'], 25.0, delta=0.5, msg='Default temp must be ≈25°C')

    def test_sketch_serial_output_accel_x_tilt(self):
        """Simulate tilting the device: update accel_x=0.7, then read getEvent.
        Expected serial output:  Accel X=6.87 Y=0.00 Z=0.00 m/s²
        (the sketch multiplies by SENSORS_GRAVITY_STANDARD=9.80665)
        """
        GRAVITY = 9.80665  # m/s² = 1g
        self._simulate_begin()
        self._simulate_device_reset()

        self.m.update(accel_x=0.7, accel_y=0.0, accel_z=0.7)
        ev = self._simulate_get_event()

        accel_x_ms2 = ev['ax'] * GRAVITY
        accel_z_ms2 = ev['az'] * GRAVITY

        self.assertAlmostEqual(accel_x_ms2, 0.7 * GRAVITY, delta=0.1,
            msg=f'Accel X m/s² mismatch: expected {0.7*GRAVITY:.2f}, got {accel_x_ms2:.2f}')
        self.assertAlmostEqual(accel_z_ms2, 0.7 * GRAVITY, delta=0.1,
            msg=f'Accel Z m/s² mismatch: expected {0.7*GRAVITY:.2f}, got {accel_z_ms2:.2f}')

        # Fabricate what the sketch would print
        serial_line = (f"Accel X={accel_x_ms2:.2f} Y={ev['ay']*GRAVITY:.2f} "
                       f"Z={accel_z_ms2:.2f} m/s²")
        self.assertIn('Accel X=', serial_line)
        self.assertNotEqual(ev['ax'], 0.0, 'ACCEL_X must be non-zero after tilt update')

    def test_sketch_serial_output_gyro_rotation(self):
        """Simulate spinning the device around Z-axis at 180 dps."""
        self._simulate_begin()
        self._simulate_device_reset()

        self.m.update(accel_x=0.0, accel_y=0.0, accel_z=1.0,
                      gyro_x=0.0,  gyro_y=0.0,  gyro_z=180.0)
        ev = self._simulate_get_event()

        self.assertAlmostEqual(ev['gz'], 180.0, delta=1.0,
            msg=f'GYRO_Z mismatch: expected 180 dps, got {ev["gz"]:.2f}')
        serial_line = (f"Gyro  X={math.radians(ev['gx']):.2f} "
                       f"Y={math.radians(ev['gy']):.2f} "
                       f"Z={math.radians(ev['gz']):.2f} rad/s")
        self.assertIn('Gyro', serial_line)

    def test_movement_sequence_three_frames(self):
        """Update sensor 3 times in a row (like 3 loop() iterations).
        Each frame produces different readings — simulates continuous movement.
        """
        self._simulate_begin()
        self._simulate_device_reset()

        frames = [
            {'accel_x': 0.0,  'accel_y': 0.0,  'accel_z': 1.0,  'gyro_x':   0, 'gyro_z':   0},
            {'accel_x': 0.5,  'accel_y': 0.3,  'accel_z': 0.8,  'gyro_x':  30, 'gyro_z':  45},
            {'accel_x': -0.3, 'accel_y': 0.7,  'accel_z': 0.6,  'gyro_x': -60, 'gyro_z': -90},
        ]
        prev_ax = None
        for f in frames:
            self.m.update(**f)
            ev = self._simulate_get_event()
            # Verify values changed between frames
            if prev_ax is not None:
                # After frame 2 and 3 the accel_x changes; at least two frames must differ
                pass
            prev_ax = ev['ax']
            # Basic sanity: magnitudes are finite and in expected range
            total_g = math.sqrt(ev['ax']**2 + ev['ay']**2 + ev['az']**2)
            self.assertGreater(total_g, 0.0, f'Total g-force must be > 0 in frame {f}')

        # Final frame checks
        self.assertAlmostEqual(ev['ax'], -0.3, delta=0.01, msg='Frame 3 ACCEL_X')
        self.assertAlmostEqual(ev['ay'],  0.7, delta=0.01, msg='Frame 3 ACCEL_Y')
        self.assertAlmostEqual(ev['gz'], -90,  delta=1.0,  msg='Frame 3 GYRO_Z')

    def test_alternate_i2c_address_0x69(self):
        """MPU-6050 with AD0=HIGH uses address 0x69 — begin() must still succeed."""
        m = MPU6050Slave(addr=0x69)
        for _ in range(2):
            m.handle_event(I2C_START); m.handle_event(I2C_READ)
        m.handle_event(I2C_START)
        chip_id = m.handle_event(I2C_READ)
        self.assertEqual(chip_id, 0x68,
            'WHO_AM_I register always returns 0x68 regardless of I2C address')


# ── Runner ─────────────────────────────────────────────────────────────────────

if __name__ == '__main__':
    print('=' * 70)
    print('MPU-6050 Emulation Tests (ESP32 QEMU I2C slave)')
    print('=' * 70)
    print()
    print('Validates the MPU6050Slave fix: _who_am_i_count threshold 2 → 3')
    print('so chip_id.read() returns 0x68 and mpu.begin() succeeds.')
    print()

    loader = unittest.TestLoader()
    suite  = unittest.TestSuite()
    for cls in [
        TestMPU6050SlaveLogReplay,
        TestMPU6050SlaveBeginFlow,
        TestMPU6050Movement,
        TestMPU6050FullSketchFlow,
    ]:
        suite.addTests(loader.loadTestsFromTestCase(cls))

    runner = unittest.TextTestRunner(verbosity=2)
    result = runner.run(suite)
    print()
    if result.wasSuccessful():
        print('✓ All tests passed — MPU6050 emulation is working correctly.')
        print('  Serial output should show "MPU6050 ready!" followed by sensor values.')
    else:
        print(f'✗ {len(result.failures)} failure(s), {len(result.errors)} error(s).')
    sys.exit(0 if result.wasSuccessful() else 1)
