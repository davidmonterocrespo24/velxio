"""
esp32_i2c_slaves.py — Standalone I2C slave state machines for ESP32 QEMU simulation.

Each class emulates the I2C register map of a real sensor, handling the picsimlab
I2C event protocol as defined in hw/i2c/picsimlab_i2c.c:

  picsimlab_i2c_ev(event)  → passes raw QEMU i2c_event enum value:
    0x00 = I2C_START_RECV  — firmware doing requestFrom  (read  direction START)
    0x01 = I2C_START_SEND  — firmware doing beginTransmission (write direction START)
    0x02 = I2C_START_SEND_ASYNC  (rarely used)
    0x03 = I2C_FINISH      — end of transaction (STOP or RSTART between write+read)
    0x04 = I2C_NACK

  picsimlab_i2c_tx(data)   → event = (data << 8) | (I2C_NACK+1) = (data<<8)|0x05
  picsimlab_i2c_rx()       → event = I2C_NACK+2 = 0x06  (return data byte to firmware)

ACK convention (matches QEMU i2c core):
  return 0  → ACK  (success, device present / byte accepted)
  return ≠0 → NACK (error)
  For READ events: return value is the data byte delivered to the firmware.
"""

import datetime as _datetime


# ── Protocol constants ────────────────────────────────────────────────────────

I2C_START_RECV = 0x00   # firmware called requestFrom  (read  direction START)
I2C_START_SEND = 0x01   # firmware called beginTransmission (write direction START)
I2C_FINISH     = 0x03   # end of transaction (STOP or repeated-START between phases)
I2C_WRITE      = 0x05   # firmware sent a byte; data = (event >> 8) & 0xFF
I2C_READ       = 0x06   # firmware requesting a byte; return the data byte


# ── MPU-6050 IMU ──────────────────────────────────────────────────────────────

class MPU6050Slave:
    """Full MPU-6050 register-map I2C slave emulation (address 0x68 or 0x69)."""

    def __init__(self, addr: int = 0x68):
        self.addr       = addr
        self.regs       = bytearray(256)
        self.reg_ptr    = 0
        self.first_byte = True

        # WHO_AM_I
        self.regs[0x75] = 0x68
        # PWR_MGMT_1 — awake (0 = no sleep)
        self.regs[0x6B] = 0x00
        # ACCEL_CONFIG / GYRO_CONFIG (default ±2g / ±250°/s)
        self.regs[0x1C] = 0x00
        self.regs[0x1B] = 0x00
        # ACCEL_Z = +1g = 16384 (0x4000) at ±2g full-scale
        self.regs[0x3B] = 0x00; self.regs[0x3C] = 0x00  # X
        self.regs[0x3D] = 0x00; self.regs[0x3E] = 0x00  # Y
        self.regs[0x3F] = 0x40; self.regs[0x40] = 0x00  # Z = +1g
        # TEMP: T(°C) = raw/340 + 36.53 → raw = (25 - 36.53) × 340 ≈ -3920 = 0xF190
        temp_raw = round((25.0 - 36.53) * 340) & 0xFFFF
        self.regs[0x41] = (temp_raw >> 8) & 0xFF
        self.regs[0x42] =  temp_raw        & 0xFF
        # GYRO all zero (stationary)

    def handle_event(self, event: int) -> int:
        op   = event & 0xFF          # low byte = operation type
        data = (event >> 8) & 0xFF   # high byte = data byte (for WRITE)

        if op in (I2C_START_RECV, I2C_START_SEND):
            # New transaction beginning.  Reset first_byte flag.
            # reg_ptr is NOT reset here — a write-then-read (repeated START)
            # relies on reg_ptr having been set by the preceding WRITE phase.
            self.first_byte = True
            return 0   # ACK (0 = success in QEMU convention)

        elif op == I2C_WRITE:
            if self.first_byte:
                # First byte after START is the register address pointer
                self.reg_ptr    = data
                self.first_byte = False
            else:
                # Subsequent bytes are data written into the register map
                self.regs[self.reg_ptr] = data
                # Auto-clear DEVICE_RESET bit (bit 7 of PWR_MGMT_1 = 0x6B)
                # so the Adafruit begin() reset-wait loop exits immediately.
                if self.reg_ptr == 0x6B:
                    self.regs[0x6B] &= 0x7F
                self.reg_ptr = (self.reg_ptr + 1) & 0xFF
            return 0   # ACK

        elif op == I2C_READ:
            # Return the byte at the current register pointer, then advance it.
            val = self.regs[self.reg_ptr]
            self.reg_ptr = (self.reg_ptr + 1) & 0xFF
            return val

        else:                         # I2C_FINISH, I2C_NACK, unknown
            self.first_byte = True
            return 0

    def _write_i16(self, reg_h: int, raw_float: float) -> None:
        raw = max(-32768, min(32767, round(raw_float))) & 0xFFFF
        self.regs[reg_h]     = (raw >> 8) & 0xFF
        self.regs[reg_h + 1] =  raw        & 0xFF

    def update(self, accel_x: float = 0, accel_y: float = 0, accel_z: float = 1,
               gyro_x: float = 0, gyro_y: float = 0, gyro_z: float = 0,
               temp: float = 25.0) -> None:
        self._write_i16(0x3B, accel_x * 16384)
        self._write_i16(0x3D, accel_y * 16384)
        self._write_i16(0x3F, accel_z * 16384)
        self._write_i16(0x43, gyro_x  * 131)
        self._write_i16(0x45, gyro_y  * 131)
        self._write_i16(0x47, gyro_z  * 131)
        self._write_i16(0x41, (temp - 36.53) * 340)


# ── BMP280 Barometric Pressure + Temperature Sensor ───────────────────────────

class BMP280Slave:
    """Full BMP280 register-map I2C slave (address 0x76 or 0x77).

    Uses BMP280 datasheet Section 8.2 example calibration constants.
    Implements Bosch compensation formulas with binary-search inversion
    to find raw ADC values from the desired temperature / pressure.
    """

    # Section 8.2 calibration constants
    DIG_T1 =  27504; DIG_T2 =  26435; DIG_T3 =   -1000
    DIG_P1 =  36477; DIG_P2 = -10685; DIG_P3 =    3024
    DIG_P4 =   2855; DIG_P5 =    140; DIG_P6 =      -7
    DIG_P7 =  15500; DIG_P8 = -14600; DIG_P9 =    6000

    def __init__(self, addr: int = 0x76):
        self.addr       = addr
        self.regs       = bytearray(256)
        self.reg_ptr    = 0
        self.first_byte = True
        self._temp_c    = 25.0
        self._press_hpa = 1013.25
        self._init_calibration()
        self._update_measurements()

    # ── calibration register layout ───────────────────────────────────────────
    def _wu16(self, a: int, v: int) -> None:
        self.regs[a] = v & 0xFF; self.regs[a + 1] = (v >> 8) & 0xFF

    def _ws16(self, a: int, v: int) -> None:
        self._wu16(a, v & 0xFFFF)

    def _init_calibration(self) -> None:
        self.regs[0xD0] = 0x58  # chip_id BMP280 (production silicon; BME280 uses 0x60)
        self.regs[0xF3] = 0x00  # status  (done)
        self._wu16(0x88, self.DIG_T1); self._ws16(0x8A, self.DIG_T2); self._ws16(0x8C, self.DIG_T3)
        self._wu16(0x8E, self.DIG_P1); self._ws16(0x90, self.DIG_P2); self._ws16(0x92, self.DIG_P3)
        self._ws16(0x94, self.DIG_P4); self._ws16(0x96, self.DIG_P5); self._ws16(0x98, self.DIG_P6)
        self._ws16(0x9A, self.DIG_P7); self._ws16(0x9C, self.DIG_P8); self._ws16(0x9E, self.DIG_P9)

    # ── Bosch compensation formulas ───────────────────────────────────────────
    def _t_fine(self, adc_t: int) -> int:
        v1 = (((adc_t >> 3) - (self.DIG_T1 << 1)) * self.DIG_T2) >> 11
        s  = (adc_t >> 4) - self.DIG_T1
        v2 = ((s * s >> 12) * self.DIG_T3) >> 14
        return v1 + v2

    def _compensate_t(self, adc_t: int) -> int:
        return (self._t_fine(adc_t) * 5 + 128) >> 8

    def _compensate_p(self, adc_p: int, adc_t: int) -> float:
        tf = self._t_fine(adc_t)
        v1 = tf / 2.0 - 64000.0
        v2 = v1 * v1 * self.DIG_P6 / 32768.0
        v2 = v2 + v1 * self.DIG_P5 * 2.0
        v2 = v2 / 4.0 + self.DIG_P4 * 65536.0
        v1 = (self.DIG_P3 * v1 * v1 / 524288.0 + self.DIG_P2 * v1) / 524288.0
        v1 = (1.0 + v1 / 32768.0) * self.DIG_P1
        if v1 == 0:
            return 0.0
        p = 1048576.0 - adc_p
        p = (p - v2 / 4096.0) * 6250.0 / v1
        p = p + (self.DIG_P9 * p * p / 2147483648.0 + p * self.DIG_P8 / 32768.0 + self.DIG_P7) / 16.0
        return p

    def _find_adc_t(self, target_centideg: int) -> int:
        lo, hi = 0, (1 << 20) - 1
        while lo < hi:
            mid = (lo + hi) >> 1
            if self._compensate_t(mid) < target_centideg:
                lo = mid + 1
            else:
                hi = mid
        return lo

    def _find_adc_p(self, target_pa: float, adc_t: int) -> int:
        lo, hi = 0, (1 << 20) - 1
        while lo < hi:
            mid = (lo + hi) >> 1
            if self._compensate_p(mid, adc_t) > target_pa:
                lo = mid + 1
            else:
                hi = mid
        return lo

    def _encode20(self, v: int) -> tuple:
        return (v >> 12) & 0xFF, (v >> 4) & 0xFF, (v & 0xF) << 4

    def _update_measurements(self) -> None:
        adc_t = self._find_adc_t(round(self._temp_c * 100))
        adc_p = self._find_adc_p(self._press_hpa * 100.0, adc_t)
        pm, pl, px = self._encode20(adc_p)
        tm, tl, tx = self._encode20(adc_t)
        self.regs[0xF7] = pm; self.regs[0xF8] = pl; self.regs[0xF9] = px
        self.regs[0xFA] = tm; self.regs[0xFB] = tl; self.regs[0xFC] = tx

    def update(self, temperature_c: float, pressure_hpa: float) -> None:
        self._temp_c    = temperature_c
        self._press_hpa = pressure_hpa
        self._update_measurements()

    def handle_event(self, event: int) -> int:
        op   = event & 0xFF
        data = (event >> 8) & 0xFF

        if op in (I2C_START_RECV, I2C_START_SEND):
            self.first_byte = True; return 0
        elif op == I2C_WRITE:
            if self.first_byte:
                self.reg_ptr = data; self.first_byte = False
            else:
                self.regs[self.reg_ptr] = data
                self.reg_ptr = (self.reg_ptr + 1) & 0xFF
            return 0
        elif op == I2C_READ:
            val = self.regs[self.reg_ptr]
            self.reg_ptr = (self.reg_ptr + 1) & 0xFF
            return val
        else:
            self.first_byte = True; return 0


# ── DS1307 / DS3231 Real-Time Clock ──────────────────────────────────────────

class DS1307Slave:
    """DS1307 I2C RTC — returns current system time in BCD (address 0x68)."""

    def __init__(self) -> None:
        self.reg_ptr    = 0
        self.first_byte = True

    @staticmethod
    def _bcd(n: int) -> int:
        return ((n // 10) << 4) | (n % 10)

    def _read_reg(self, reg: int) -> int:
        now = _datetime.datetime.now()
        if   reg == 0x00: return self._bcd(now.second)
        elif reg == 0x01: return self._bcd(now.minute)
        elif reg == 0x02: return self._bcd(now.hour)
        elif reg == 0x03: return self._bcd(now.weekday() + 1)  # Mon=1..Sun=7
        elif reg == 0x04: return self._bcd(now.day)
        elif reg == 0x05: return self._bcd(now.month)
        elif reg == 0x06: return self._bcd(now.year % 100)
        return 0x00

    def handle_event(self, event: int) -> int:
        op   = event & 0xFF
        data = (event >> 8) & 0xFF

        if op in (I2C_START_RECV, I2C_START_SEND):
            self.first_byte = True; return 0
        elif op == I2C_WRITE:
            if self.first_byte:
                self.reg_ptr = data; self.first_byte = False
            return 0
        elif op == I2C_READ:
            val = self._read_reg(self.reg_ptr)
            self.reg_ptr = (self.reg_ptr + 1) & 0x3F
            return val
        else:
            self.first_byte = True; return 0


class DS3231Slave(DS1307Slave):
    """DS3231 I2C RTC with on-chip temperature (address 0x68)."""

    def __init__(self) -> None:
        super().__init__()
        self.temperatureC = 25.0

    def _read_reg(self, reg: int) -> int:
        if reg == 0x0E: return 0x00   # Control
        if reg == 0x0F: return 0x00   # Status (OSF cleared)
        if reg == 0x11:               # Temp MSB (signed integer °C)
            return int(self.temperatureC) & 0xFF
        if reg == 0x12:               # Temp LSB (fractional bits 7:6)
            frac = abs(self.temperatureC) - int(abs(self.temperatureC))
            return (round(frac / 0.25) & 0x03) << 6
        return super()._read_reg(reg)


# ── I2C Write Sink (relay for write-only devices: SSD1306, PCF8574) ──────────

class I2CWriteSink:
    """ACKs all I2C writes, emits complete transaction to frontend on FINISH."""

    def __init__(self, addr: int, emit_fn) -> None:
        self.addr  = addr
        self._emit = emit_fn
        self._buf: list[int] = []

    def handle_event(self, event: int) -> int:
        op   = event & 0xFF
        data = (event >> 8) & 0xFF

        if op in (I2C_START_RECV, I2C_START_SEND):
            self._buf = []; return 0
        elif op == I2C_WRITE:
            self._buf.append(data); return 0
        elif op == I2C_READ:
            return 0xFF   # write-only device
        else:             # I2C_FINISH — emit accumulated transaction
            if self._buf:
                self._emit({'type': 'i2c_transaction',
                            'addr': self.addr, 'data': list(self._buf)})
                self._buf = []
            return 0
