"""
Tests for ESP32 I2C slave state machines.

Covers BMP280Slave, DS1307Slave, DS3231Slave, I2CWriteSink, and MPU6050Slave
from app/services/esp32_i2c_slaves.py.

Correct picsimlab I2C event encoding (from hw/i2c/picsimlab_i2c.c + QEMU i2c.h):
  event & 0xFF  = operation type:
    0x00 = I2C_START_RECV  — firmware called requestFrom  (read  direction START)
    0x01 = I2C_START_SEND  — firmware called beginTransmission (write direction START)
    0x03 = I2C_FINISH      — end of transaction (STOP or RSTART between write+read)
    0x05 = WRITE byte      — (event >> 8) & 0xFF is the data byte
    0x06 = READ  byte      — return value is the data byte to deliver to firmware

  ACK convention: return 0 = ACK (success), non-zero = NACK.
  For READ events: return value is the data byte sent to the firmware.

Run from the backend/ directory:
    python test_esp32_i2c_slaves.py
"""

import sys
import unittest
from pathlib import Path

# Ensure backend/ is importable (for direct execution; pytest uses conftest.py)
sys.path.insert(0, str(Path(__file__).parent.parent.parent.parent / 'backend'))

from app.services.esp32_i2c_slaves import (
    BMP280Slave,
    DS1307Slave,
    DS3231Slave,
    I2CWriteSink,
    MPU6050Slave,
    I2C_START_RECV,
    I2C_START_SEND,
    I2C_FINISH,
    I2C_WRITE,
    I2C_READ,
)


# ── I2C protocol helpers ──────────────────────────────────────────────────────

def i2c_write(byte: int) -> int:
    """WRITE event: data in high byte, op 0x05 in low byte."""
    return ((byte & 0xFF) << 8) | I2C_WRITE


def i2c_read_seq(slave, reg: int, n: int) -> list[int]:
    """Simulate write-then-read: write register address, then read n bytes.

    Models the Adafruit BusIO write_then_read pattern:
      beginTransmission → write(reg) → endTransmission(false) → requestFrom → read()*n
    """
    slave.handle_event(I2C_START_SEND)   # write direction START
    slave.handle_event(i2c_write(reg))   # set register pointer
    slave.handle_event(I2C_FINISH)       # RSTART (repeated start before read phase)
    slave.handle_event(I2C_START_RECV)   # read direction START
    data = [slave.handle_event(I2C_READ) for _ in range(n)]
    slave.handle_event(I2C_FINISH)       # STOP
    return data


def read_u16_le(regs: bytearray, addr: int) -> int:
    """Read unsigned 16-bit little-endian from register array."""
    return regs[addr] | (regs[addr + 1] << 8)


def bcd_valid(value: int) -> bool:
    """Return True if both nibbles of a BCD byte are in 0–9."""
    return (value >> 4) <= 9 and (value & 0xF) <= 9


# ══════════════════════════════════════════════════════════════════════════════
# BMP280 Slave Tests
# ══════════════════════════════════════════════════════════════════════════════

class TestBMP280Slave(unittest.TestCase):

    def setUp(self):
        self.slave = BMP280Slave()

    # ── I2C protocol ───────────────────────────────────────────────────────────

    def test_ack_on_start_send(self):
        result = self.slave.handle_event(I2C_START_SEND)
        self.assertEqual(result, 0, 'START_SEND must return 0 (ACK)')

    def test_ack_on_start_recv(self):
        result = self.slave.handle_event(I2C_START_RECV)
        self.assertEqual(result, 0, 'START_RECV must return 0 (ACK)')

    def test_ack_on_write(self):
        self.slave.handle_event(I2C_START_SEND)
        result = self.slave.handle_event(i2c_write(0xD0))
        self.assertEqual(result, 0, 'WRITE must return 0 (ACK)')

    def test_finish_returns_zero(self):
        self.slave.handle_event(I2C_START_SEND)
        result = self.slave.handle_event(I2C_FINISH)
        self.assertEqual(result, 0)

    # ── Chip identity ──────────────────────────────────────────────────────────

    def test_chip_id_register_0xd0(self):
        chip_id = i2c_read_seq(self.slave, 0xD0, 1)[0]
        self.assertEqual(chip_id, 0x58, 'chip_id must be 0x58 for BMP280')

    # ── Calibration registers ──────────────────────────────────────────────────

    def test_calibration_t1_little_endian(self):
        # DIG_T1=27504 stored at 0x88 (LSB) and 0x89 (MSB)
        t1 = read_u16_le(self.slave.regs, 0x88)
        self.assertEqual(t1, BMP280Slave.DIG_T1)

    def test_calibration_p1_little_endian(self):
        p1 = read_u16_le(self.slave.regs, 0x8E)
        self.assertEqual(p1, BMP280Slave.DIG_P1)

    # ── Default measurement values ─────────────────────────────────────────────

    def test_default_temp_25c(self):
        """Default state: 25°C → compensated centidegrees ≈ 2500."""
        adc_t_bytes = i2c_read_seq(self.slave, 0xFA, 3)
        adc_t = ((adc_t_bytes[0] << 12) | (adc_t_bytes[1] << 4) | (adc_t_bytes[2] >> 4))
        compensated = self.slave._compensate_t(adc_t)
        # Allow ±1 centidegree tolerance (binary-search rounding)
        self.assertAlmostEqual(compensated, 2500, delta=1)

    def test_default_pressure_1013hpa(self):
        """Default state: 1013.25 hPa → compensated Pa within 100 Pa tolerance."""
        adc_t_bytes = i2c_read_seq(self.slave, 0xFA, 3)
        adc_t = ((adc_t_bytes[0] << 12) | (adc_t_bytes[1] << 4) | (adc_t_bytes[2] >> 4))
        adc_p_bytes = i2c_read_seq(self.slave, 0xF7, 3)
        adc_p = ((adc_p_bytes[0] << 12) | (adc_p_bytes[1] << 4) | (adc_p_bytes[2] >> 4))
        compensated_pa = self.slave._compensate_p(adc_p, adc_t)
        target_pa = 1013.25 * 100.0
        self.assertAlmostEqual(compensated_pa, target_pa, delta=100)  # ±1 hPa

    # ── update() changes ADC registers ────────────────────────────────────────

    def test_update_changes_temp_regs(self):
        before = list(self.slave.regs[0xFA:0xFD])
        self.slave.update(30.0, 1013.25)
        after = list(self.slave.regs[0xFA:0xFD])
        self.assertNotEqual(before, after, 'Temp ADC regs must change after update(30.0,...)')

    def test_update_changes_pressure_regs(self):
        before = list(self.slave.regs[0xF7:0xFA])
        self.slave.update(25.0, 900.0)
        after = list(self.slave.regs[0xF7:0xFA])
        self.assertNotEqual(before, after, 'Pressure ADC regs must change after update(...,900.0)')

    def test_update_temp_compensates_correctly(self):
        self.slave.update(40.0, 1013.25)
        adc_t_bytes = i2c_read_seq(self.slave, 0xFA, 3)
        adc_t = ((adc_t_bytes[0] << 12) | (adc_t_bytes[1] << 4) | (adc_t_bytes[2] >> 4))
        compensated = self.slave._compensate_t(adc_t)
        self.assertAlmostEqual(compensated, 4000, delta=1)

    # ── Sequential register reads ──────────────────────────────────────────────

    def test_sequential_read_advances_pointer(self):
        """Reading 3 bytes from 0xF7 must yield distinct pressure MSB/LSB/XLSB."""
        bytes_ = i2c_read_seq(self.slave, 0xF7, 3)
        self.assertEqual(len(bytes_), 3)
        # At least two of the three bytes must differ (non-trivial measurement)
        self.assertFalse(bytes_[0] == bytes_[1] == bytes_[2],
                         'All three pressure ADC bytes should not be identical')

    # ── State machine ─────────────────────────────────────────────────────────

    def test_write_sets_register_ptr(self):
        """Write-then-read: write reg address 0xD0, then read returns chip_id."""
        self.slave.handle_event(I2C_START_SEND)
        self.slave.handle_event(i2c_write(0xD0))   # set ptr to chip_id reg
        self.slave.handle_event(I2C_FINISH)
        self.slave.handle_event(I2C_START_RECV)
        val = self.slave.handle_event(I2C_READ)
        self.assertEqual(val, 0x58)

    def test_finish_resets_first_byte_flag(self):
        """After FINISH, the next transaction's first WRITE must set reg_ptr."""
        self.slave.handle_event(I2C_START_SEND)
        self.slave.handle_event(i2c_write(0xD0))
        self.slave.handle_event(I2C_FINISH)
        # New transaction: WRITE 0xD0 again → should set reg_ptr, not write data
        self.slave.handle_event(I2C_START_SEND)
        self.slave.handle_event(i2c_write(0xD0))
        self.slave.handle_event(I2C_FINISH)
        self.slave.handle_event(I2C_START_RECV)
        val = self.slave.handle_event(I2C_READ)
        self.assertEqual(val, 0x58, 'chip_id should still be 0x58 after FINISH + new transaction')


# ══════════════════════════════════════════════════════════════════════════════
# DS1307 Slave Tests
# ══════════════════════════════════════════════════════════════════════════════

class TestDS1307Slave(unittest.TestCase):

    def setUp(self):
        self.slave = DS1307Slave()

    def test_ack_on_start_send(self):
        self.assertEqual(self.slave.handle_event(I2C_START_SEND), 0)

    def test_ack_on_write(self):
        self.slave.handle_event(I2C_START_SEND)
        self.assertEqual(self.slave.handle_event(i2c_write(0x00)), 0)

    def test_seconds_is_valid_bcd(self):
        seconds = i2c_read_seq(self.slave, 0x00, 1)[0]
        tens  = (seconds >> 4) & 0xF
        units =  seconds       & 0xF
        self.assertLessEqual(tens,  5, 'Seconds tens digit must be ≤ 5')
        self.assertLessEqual(units, 9, 'Seconds units digit must be ≤ 9')

    def test_minutes_is_valid_bcd(self):
        minutes = i2c_read_seq(self.slave, 0x01, 1)[0]
        self.assertLessEqual((minutes >> 4) & 0xF, 5)
        self.assertLessEqual( minutes       & 0xF, 9)

    def test_hours_is_valid_bcd(self):
        hours = i2c_read_seq(self.slave, 0x02, 1)[0]
        # BCD 00–23
        tens  = (hours >> 4) & 0xF
        units =  hours       & 0xF
        value = tens * 10 + units
        self.assertGreaterEqual(value, 0)
        self.assertLessEqual(value, 23)

    def test_year_is_valid_bcd(self):
        year = i2c_read_seq(self.slave, 0x06, 1)[0]
        self.assertTrue(bcd_valid(year), f'Year 0x{year:02X} is not valid BCD')

    def test_sequential_read_7_regs(self):
        """Read all 7 time registers in one transaction — all must be valid BCD."""
        data = i2c_read_seq(self.slave, 0x00, 7)
        self.assertEqual(len(data), 7)
        for i, b in enumerate(data):
            self.assertTrue(bcd_valid(b), f'Register {i} value 0x{b:02X} is not valid BCD')


# ══════════════════════════════════════════════════════════════════════════════
# DS3231 Slave Tests
# ══════════════════════════════════════════════════════════════════════════════

class TestDS3231Slave(unittest.TestCase):

    def setUp(self):
        self.slave = DS3231Slave()

    def test_inherits_time_registers(self):
        """DS3231 regs 0–6 must return the same valid BCD as DS1307."""
        data = i2c_read_seq(self.slave, 0x00, 7)
        self.assertEqual(len(data), 7)
        for i, b in enumerate(data):
            self.assertTrue(bcd_valid(b), f'Register {i} value 0x{b:02X} is not valid BCD')

    def test_control_register_0x0e(self):
        val = self.slave._read_reg(0x0E)
        self.assertEqual(val, 0x00)

    def test_status_register_0x0f(self):
        val = self.slave._read_reg(0x0F)
        self.assertEqual(val, 0x00)

    def test_temperature_msb_default_25c(self):
        val = self.slave._read_reg(0x11)
        self.assertEqual(val, 25, 'Temp MSB must be 25 (integer °C) at default 25.0°C')

    def test_temperature_lsb_zero_frac(self):
        val = self.slave._read_reg(0x12)
        self.assertEqual(val, 0, 'Temp LSB must be 0 when fractional part is .00')

    def test_temperature_update_quarter_degree(self):
        """25.25°C → LSB bits 7:6 == 0b01 (0.25°C step)."""
        self.slave.temperatureC = 25.25
        msb = self.slave._read_reg(0x11)
        lsb = self.slave._read_reg(0x12)
        self.assertEqual(msb, 25)
        frac_bits = (lsb >> 6) & 0x03
        self.assertEqual(frac_bits, 1, '0.25°C → bits 7:6 must be 0b01')

    def test_temperature_update_half_degree(self):
        """25.5°C → LSB bits 7:6 == 0b10 (0.50°C step)."""
        self.slave.temperatureC = 25.5
        lsb = self.slave._read_reg(0x12)
        frac_bits = (lsb >> 6) & 0x03
        self.assertEqual(frac_bits, 2, '0.50°C → bits 7:6 must be 0b10')

    def test_temperature_read_via_i2c(self):
        """Temperature registers are accessible via I2C READ from 0x11."""
        self.slave.temperatureC = 30.0
        data = i2c_read_seq(self.slave, 0x11, 2)
        self.assertEqual(data[0], 30)   # MSB = integer °C
        self.assertEqual(data[1], 0)    # LSB = 0 (no fractional part)


# ══════════════════════════════════════════════════════════════════════════════
# I2CWriteSink Tests
# ══════════════════════════════════════════════════════════════════════════════

class TestI2CWriteSink(unittest.TestCase):

    def setUp(self):
        self.emitted: list[dict] = []
        self.sink = I2CWriteSink(addr=0x3C, emit_fn=self.emitted.append)

    def test_ack_on_start_send(self):
        self.assertEqual(self.sink.handle_event(I2C_START_SEND), 0)

    def test_ack_on_start_recv(self):
        self.assertEqual(self.sink.handle_event(I2C_START_RECV), 0)

    def test_ack_on_write(self):
        self.sink.handle_event(I2C_START_SEND)
        for byte in [0x00, 0x21, 0xAB]:
            result = self.sink.handle_event(i2c_write(byte))
            self.assertEqual(result, 0, f'WRITE 0x{byte:02X} must return 0 (ACK)')

    def test_read_returns_0xff(self):
        """Write-only device: READ must return 0xFF (no data to send)."""
        self.sink.handle_event(I2C_START_SEND)
        result = self.sink.handle_event(I2C_READ)
        self.assertEqual(result, 0xFF)

    def test_emits_on_finish(self):
        """After 3 writes + FINISH, emit_fn must be called exactly once."""
        self.sink.handle_event(I2C_START_SEND)
        for b in [0x00, 0x21, 0x7F]:
            self.sink.handle_event(i2c_write(b))
        self.sink.handle_event(I2C_FINISH)
        self.assertEqual(len(self.emitted), 1, 'emit_fn must be called once on FINISH')

    def test_emit_payload_addr(self):
        self.sink.handle_event(I2C_START_SEND)
        self.sink.handle_event(i2c_write(0xAB))
        self.sink.handle_event(I2C_FINISH)
        self.assertEqual(self.emitted[0]['addr'], 0x3C)

    def test_emit_payload_type(self):
        self.sink.handle_event(I2C_START_SEND)
        self.sink.handle_event(i2c_write(0xAB))
        self.sink.handle_event(I2C_FINISH)
        self.assertEqual(self.emitted[0]['type'], 'i2c_transaction')

    def test_emit_payload_data(self):
        bytes_ = [0x00, 0x21, 0x7F]
        self.sink.handle_event(I2C_START_SEND)
        for b in bytes_:
            self.sink.handle_event(i2c_write(b))
        self.sink.handle_event(I2C_FINISH)
        self.assertEqual(self.emitted[0]['data'], bytes_)

    def test_no_emit_for_empty_buffer(self):
        """START then immediate FINISH with no writes must NOT emit."""
        self.sink.handle_event(I2C_START_SEND)
        self.sink.handle_event(I2C_FINISH)
        self.assertEqual(len(self.emitted), 0, 'Empty buffer must not trigger emit_fn')

    def test_resets_buffer_after_emit(self):
        """Second transaction accumulates fresh bytes, not leftover from first."""
        # First transaction: writes [0xAA]
        self.sink.handle_event(I2C_START_SEND)
        self.sink.handle_event(i2c_write(0xAA))
        self.sink.handle_event(I2C_FINISH)
        # Second transaction: writes [0xBB]
        self.sink.handle_event(I2C_START_SEND)
        self.sink.handle_event(i2c_write(0xBB))
        self.sink.handle_event(I2C_FINISH)
        self.assertEqual(len(self.emitted), 2)
        self.assertEqual(self.emitted[0]['data'], [0xAA])
        self.assertEqual(self.emitted[1]['data'], [0xBB])

    def test_custom_addr_forwarded(self):
        """Sink created with addr=0x27 emits with that addr."""
        sink = I2CWriteSink(addr=0x27, emit_fn=self.emitted.append)
        sink.handle_event(I2C_START_SEND)
        sink.handle_event(i2c_write(0x38))
        sink.handle_event(I2C_FINISH)
        self.assertEqual(self.emitted[0]['addr'], 0x27)

    def test_finish_return_value(self):
        """FINISH always returns 0."""
        self.sink.handle_event(I2C_START_SEND)
        result = self.sink.handle_event(I2C_FINISH)
        self.assertEqual(result, 0)


# ══════════════════════════════════════════════════════════════════════════════
# MPU6050 Slave Tests
# ══════════════════════════════════════════════════════════════════════════════

class TestMPU6050Slave(unittest.TestCase):

    def setUp(self):
        self.mpu = MPU6050Slave()

    def test_who_am_i_default_addr(self):
        """WHO_AM_I register (0x75) must return 0x68."""
        result = i2c_read_seq(self.mpu, 0x75, 1)
        self.assertEqual(result[0], 0x68)

    def test_start_send_ack(self):
        """START_SEND event must return 0 (ACK)."""
        self.assertEqual(self.mpu.handle_event(I2C_START_SEND), 0)

    def test_start_recv_ack(self):
        """START_RECV event must return 0 (ACK)."""
        self.assertEqual(self.mpu.handle_event(I2C_START_RECV), 0)

    def test_write_then_read_who_am_i(self):
        """Full write-then-read: write reg 0x75, then read returns 0x68."""
        m = MPU6050Slave()
        m.handle_event(I2C_START_SEND)           # beginTransmission
        m.handle_event(i2c_write(0x75))           # write register address
        m.handle_event(I2C_FINISH)                # RSTART
        m.handle_event(I2C_START_RECV)            # requestFrom
        result = m.handle_event(I2C_READ)         # read byte
        self.assertEqual(result, 0x68, f"WHO_AM_I must be 0x68, got 0x{result:02x}")

    def test_detected_pattern(self):
        """detected() pattern: START_SEND then FINISH (no data bytes) returns ACK."""
        m = MPU6050Slave()
        # beginTransmission + endTransmission (no data)
        r1 = m.handle_event(I2C_START_SEND)
        self.assertEqual(r1, 0, "START_SEND must return 0 (ACK) for detected()")
        r2 = m.handle_event(I2C_FINISH)
        self.assertEqual(r2, 0, "FINISH must return 0")

    def test_accel_z_default_1g(self):
        """ACCEL_Z should default to +1g = 0x4000 (MSB=0x40, LSB=0x00)."""
        result = i2c_read_seq(self.mpu, 0x3F, 2)
        accel_z = (result[0] << 8) | result[1]
        self.assertEqual(accel_z, 0x4000, f"Expected ACCEL_Z=0x4000, got 0x{accel_z:04x}")

    def test_update_accel(self):
        """update() must reflect new accel values in register reads."""
        self.mpu.update(accel_x=1.0, accel_y=0.0, accel_z=0.0)
        result = i2c_read_seq(self.mpu, 0x3B, 2)
        accel_x = (result[0] << 8) | result[1]
        # 1g at ±2g full-scale = 16384 = 0x4000
        self.assertEqual(accel_x, 0x4000)

    def test_sequential_read_14_bytes(self):
        """getEvent() reads 14 bytes from 0x3B — all must come from correct regs."""
        result = i2c_read_seq(self.mpu, 0x3B, 14)
        self.assertEqual(len(result), 14)
        expected = list(self.mpu.regs[0x3B:0x3B + 14])
        self.assertEqual(result, expected, "14-byte read from 0x3B must match register map")

    def test_device_reset_bit_auto_cleared(self):
        """Writing 0x80 to PWR_MGMT_1 (0x6B) must auto-clear bit 7 immediately."""
        self.mpu.handle_event(I2C_START_SEND)
        self.mpu.handle_event(i2c_write(0x6B))   # register address
        self.mpu.handle_event(i2c_write(0x80))   # write 0x80 (DEVICE_RESET bit)
        self.mpu.handle_event(I2C_FINISH)
        # Read back: bit 7 should be 0 (auto-cleared)
        result = i2c_read_seq(self.mpu, 0x6B, 1)
        self.assertEqual(result[0] & 0x80, 0, "DEVICE_RESET bit must auto-clear")

    def test_alternate_address(self):
        """MPU6050 at address 0x69 (AD0=HIGH) must still return WHO_AM_I=0x68."""
        mpu69 = MPU6050Slave(addr=0x69)
        result = i2c_read_seq(mpu69, 0x75, 1)
        self.assertEqual(result[0], 0x68)

    def test_reg_ptr_preserved_across_rstart(self):
        """Write sets reg_ptr; FINISH then START_RECV should NOT reset reg_ptr."""
        m = MPU6050Slave()
        m.handle_event(I2C_START_SEND)
        m.handle_event(i2c_write(0x75))   # set reg_ptr = 0x75
        m.handle_event(I2C_FINISH)        # RSTART — must NOT reset reg_ptr
        m.handle_event(I2C_START_RECV)    # read direction START
        val = m.handle_event(I2C_READ)
        self.assertEqual(val, 0x68, "reg_ptr must be preserved across RSTART")

    def test_write_to_reg(self):
        """Writing two bytes sets reg address then reg value."""
        m = MPU6050Slave()
        m.handle_event(I2C_START_SEND)
        m.handle_event(i2c_write(0x6B))   # reg address
        m.handle_event(i2c_write(0x01))   # value
        m.handle_event(I2C_FINISH)
        result = i2c_read_seq(m, 0x6B, 1)
        self.assertEqual(result[0], 0x01)


# ── Runner ────────────────────────────────────────────────────────────────────

if __name__ == '__main__':
    print('=' * 60)
    print('ESP32 I2C Slave Tests')
    print('=' * 60)
    loader = unittest.TestLoader()
    suite  = unittest.TestSuite()
    for cls in [
        TestBMP280Slave,
        TestDS1307Slave,
        TestDS3231Slave,
        TestI2CWriteSink,
        TestMPU6050Slave,
    ]:
        suite.addTests(loader.loadTestsFromTestCase(cls))

    runner = unittest.TextTestRunner(verbosity=2)
    result = runner.run(suite)
    sys.exit(0 if result.wasSuccessful() else 1)
