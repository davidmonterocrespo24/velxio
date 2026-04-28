# ============================================================
#  DSM Smart Meter — Code 2: Peak Shifting (With DSM)
#  Auto Iron OFF during peak hour
#  Author : Kritish Mohapatra
#
#  ZMPT101B  → GPIO34 (Voltage)
#  ACS712 #1 → GPIO35 (Fan / Light Load)
#  ACS712 #2 → GPIO32 (Iron / Heavy Load)
#  Relay 1   → GPIO26 (Fan)
#  Relay 2   → GPIO27 (Iron)
#
#  BLYNK VIRTUAL PINS
#  V0 → Voltage gauge
#  V1 → Light Load power (Fan)
#  V2 → Heavy Load power (Iron)
#  V3 → Switch 1 (Fan ON/OFF)
#  V4 → Switch 2 (Iron ON/OFF)
#  V5 → Power Graph (SuperChart)
#  V6 → Total Power gauge
#
#  FAKE TIME SCHEDULE (IST):
#  18:00 – 18:06  → All OFF
#  18:06           → Fan ON
#  18:17 – 18:48  → PEAK ZONE → Iron AUTO OFF
#  18:49           →  Iron AUTO restore
#  18:57           → Fan OFF
# ============================================================

import network
import machine
import math
import BlynkLib
from time import time

# ─── WiFi Credentials ────────────────────────────────────────
WIFI_SSID = "kritish"
WIFI_PASS = "pass"

# ─── Blynk Auth ──────────────────────────────────────────────
AUTH = "auth"

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
FAKE_START_HOUR = 18
FAKE_START_MIN  = 0
fake_total_min  = FAKE_START_HOUR * 60 + FAKE_START_MIN

# ─── Peak Window (fake IST minutes) ──────────────────────────
PEAK_START = 18 * 60 + 17   # 18:17
PEAK_END   = 18 * 60 + 49   # 18:49

# ─── State ───────────────────────────────────────────────────
fan_on          = False
iron_on         = False
iron_wanted     = False   
dsm_active      = False   
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
    global iron_wanted
    iron_wanted = value[0] == '1'
    print(f"# IRON {'ON' if iron_wanted else 'OFF'} (requested)")

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
    current = fake_total_min
    fake_total_min += 1
    return h, m, current

# ─── DSM Peak Shifting Logic ─────────────────────────────────
def run_dsm(current_min):
    global iron_on, dsm_active

    is_peak = (PEAK_START <= current_min < PEAK_END)

    if is_peak and iron_wanted and not dsm_active:
        # Peak hour mein iron OFF karo
        iron_on = False
        r2.value(1)
        dsm_active = True
        led.value(1 if fan_on else 0)
        print("# DSM: PEAK HOUR → Iron AUTO OFF!")
        blynk.virtual_write(7, "⚠ PEAK! Iron AUTO OFF")

    elif not is_peak and dsm_active:
     
        if iron_wanted:
            iron_on = True
            r2.value(0)
        dsm_active = False
        led.value(1 if (fan_on or iron_on) else 0)
        print("# DSM: Peak over → Iron RESTORED!")
        blynk.virtual_write(7, "✓ Peak over. Iron restored!")

    elif not is_peak and iron_wanted and not dsm_active:
      
        iron_on = True
        r2.value(0)

    elif not iron_wanted:
        iron_on = False
        r2.value(1)
        dsm_active = False

# ─── Main Loop ───────────────────────────────────────────────
print("# DSM Smart Meter — Code 2: Peak Shifting Mode")
print(f"# Peak window: 18:17 – 18:49 (fake IST)")
print("Time,Voltage,FanPower,IronPower,TotalPower,FanStatus,IronStatus,DSM")

timer = 0

while True:
    blynk.run()
    timer += 1

    if timer >= 3000:
        timer = 0

        h, m, current_min = get_fake_time()

        # DSM logic
        run_dsm(current_min)

        v, p1, p2, pt = get_readings()
        time_str = f"{h:02d}:{m:02d}"
        dsm_flag = 1 if dsm_active else 0

        # CSV output
        print(f"{time_str},{v:.2f},{p1:.1f},{p2:.1f},{pt:.1f},{1 if fan_on else 0},{1 if iron_on else 0},{dsm_flag}")

        # Blynk upload
        blynk.virtual_write(0, round(v,  2))
        blynk.virtual_write(1, round(p1, 1))
        blynk.virtual_write(2, round(p2, 1))
        blynk.virtual_write(3, 1 if fan_on  else 0)
        blynk.virtual_write(4, 1 if iron_on else 0)
        blynk.virtual_write(5, round(pt, 1))
        blynk.virtual_write(6, round(pt, 1))

