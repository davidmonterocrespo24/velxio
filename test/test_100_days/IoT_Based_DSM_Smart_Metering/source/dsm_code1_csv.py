# ============================================================
#  DSM Smart Meter — Code 1: Data Collection
#  CSV Serial Output → Copy → MATLAB Plot
#  Author : Kritish Mohapatra
#
#  ZMPT101B  → GPIO34 (Voltage)
#  ACS712 #1 → GPIO35 (Fan / Light Load)
#  ACS712 #2 → GPIO32 (Iron / Heavy Load)
#  Relay 1   → GPIO26 (Fan)
#  Relay 2   → GPIO27 (Iron)
# ============================================================

import network
import machine
import math
import BlynkLib
from time import time

# ─── WiFi Credentials ────────────────────────────────────────
WIFI_SSID = "Kritish"
WIFI_PASS = "@pass"

# ─── Blynk Auth ──────────────────────────────────────────────
AUTH = "oizEb24"

# ─── ADC Setup ───────────────────────────────────────────────
adc_voltage  = machine.ADC(machine.Pin(34))
adc_current1 = machine.ADC(machine.Pin(35))
adc_current2 = machine.ADC(machine.Pin(32))
adc_voltage.atten(machine.ADC.ATTN_11DB)
adc_current1.atten(machine.ADC.ATTN_11DB)
adc_current2.atten(machine.ADC.ATTN_11DB)

# ─── Relay + LED ─────────────────────────────────────────────
r1  = machine.Pin(26, machine.Pin.OUT)
r2  = machine.Pin(27, machine.Pin.OUT)
led = machine.Pin(2,  machine.Pin.OUT)
r1.value(1)
r2.value(1)
led.value(0)

# ─── Calibration ─────────────────────────────────────────────

ADC_MAX            = 4095
ADC_VREF           = 3.3
ZMPT_SENSITIVITY   = 133.8    # voltage calibrated: actual=216V
ACS712_SENSITIVITY = 0.100    # V/A for 20A variant
ACS_ZERO_FAN       = 0.8736
ACS_ZERO_IRON      = 0.8746
CURR_FACTOR_FAN    = 0.005
CURR_FACTOR_IRON   = 0.055
CURRENT_THRESHOLD  = 0.01     # below this → 0.00A
SAMPLE_COUNT       = 500
# ─── Fake Time ───────────────────────────────────────────────
FAKE_START_HOUR = 18   # 6 PM
FAKE_START_MIN  = 0
fake_total_min  = FAKE_START_HOUR * 60 + FAKE_START_MIN

# ─── State ───────────────────────────────────────────────────
fan_on  = False
iron_on = False

# ─── WiFi Connect ────────────────────────────────────────────
sta_if = network.WLAN(network.STA_IF)
sta_if.active(True)
sta_if.connect(WIFI_SSID, WIFI_PASS)
print("Connecting to WiFi...")
while not sta_if.isconnected():
    pass
print("WiFi Connected:", sta_if.ifconfig())

# ─── Blynk Init ──────────────────────────────────────────────
blynk = BlynkLib.Blynk(AUTH, insecure=True)

# ─── Blynk Switch Handlers ───────────────────────────────────
@blynk.on("V3")
def v3_handler(value):
    global fan_on
    fan_on = value[0] == '1'
    r1.value(0 if fan_on else 1)
    led.value(1 if (fan_on or iron_on) else 0)
    print(f"# FAN {'ON' if fan_on else 'OFF'}")

@blynk.on("V4")
def v4_handler(value):
    global iron_on
    iron_on = value[0] == '1'
    r2.value(0 if iron_on else 1)
    led.value(1 if (fan_on or iron_on) else 0)
    print(f"# IRON {'ON' if iron_on else 'OFF'}")

# ─── Sensor Functions ────────────────────────────────────────
def read_voltage_rms():
    sum_sq = 0.0
    for _ in range(SAMPLE_COUNT):
        raw = adc_voltage.read()
        v = (raw / ADC_MAX) * ADC_VREF
        centered = v - (ADC_VREF / 2.0)
        scaled = centered * ZMPT_SENSITIVITY
        sum_sq += scaled * scaled
    return math.sqrt(sum_sq / SAMPLE_COUNT)

def read_current_rms(adc, zero_offset, factor):
    sum_sq = 0.0
    for _ in range(SAMPLE_COUNT):
        raw = adc.read()
        v = (raw / ADC_MAX) * ADC_VREF
        centered = v - zero_offset
        amps = centered / ACS712_SENSITIVITY
        sum_sq += amps * amps
    rms = math.sqrt(sum_sq / SAMPLE_COUNT) * factor
    return 0.0 if rms < CURRENT_THRESHOLD else rms

def get_readings():
    v  = read_voltage_rms()
    i1 = read_current_rms(adc_current1, ACS_ZERO_FAN,  CURR_FACTOR_FAN)
    i2 = read_current_rms(adc_current2, ACS_ZERO_IRON, CURR_FACTOR_IRON)

    if r1.value() == 1: i1 = 0.0
    if r2.value() == 1: i2 = 0.0
    if r1.value() == 1 and r2.value() == 1: v = 0.0

    p1 = v * i1
    p2 = v * i2
    pt = p1 + p2
    return v, p1, p2, pt

# ─── Fake Time ───────────────────────────────────────────────
def get_fake_time():
    global fake_total_min
    h = (fake_total_min // 60) % 24
    m = fake_total_min % 60
    fake_total_min += 1
    return h, m

# ─── Main Loop ───────────────────────────────────────────────
# CSV Header
print("# DSM Smart Meter — Code 1 Data Collection")
print("# Copy everything below (except lines with #) to data.csv")
print("Time,Voltage,FanPower,IronPower,TotalPower,FanStatus,IronStatus")

timer = 0

while True:
    blynk.run()
    timer += 1

    if timer >= 3000:
        timer = 0

        v, p1, p2, pt = get_readings()
        h, m = get_fake_time()
        time_str = f"{h:02d}:{m:02d}"

        # CSV line — copy this to MATLAB
        print(f"{time_str},{v:.2f},{p1:.1f},{p2:.1f},{pt:.1f},{1 if fan_on else 0},{1 if iron_on else 0}")

        # Blynk upload
        blynk.virtual_write(0, round(v,  2))
        blynk.virtual_write(1, round(p1, 1))
        blynk.virtual_write(2, round(p2, 1))
        blynk.virtual_write(3, 1 if fan_on  else 0)
        blynk.virtual_write(4, 1 if iron_on else 0)
        blynk.virtual_write(5, round(pt, 1))
        blynk.virtual_write(6, round(pt, 1))