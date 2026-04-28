# Copyright (c) 2026 Kritish Mohapatra

import network
from machine import ADC, Pin
import BlynkLib
from time import sleep

# WiFi
WIFI_SSID = "kritish"
WIFI_PASS = "pass"

# Blynk
AUTH = "jXJlUYM2K8a5uA2c"

# ADC
adc = ADC(0)
RATIO = 0.863

BATTERY_TABLE = [
    (4.20, 100), (4.10, 90), (4.00, 80),
    (3.90, 70),  (3.80, 60), (3.70, 45),
    (3.60, 30),  (3.50, 15), (3.40, 5),
    (2.80, 0)
]

def read_voltage(samples=20):
    raw = sum(adc.read() for _ in range(samples)) / samples
    v_a0 = (raw / 1023) * 3.3
    v_bat = (v_a0 * 2) * RATIO
    return round(v_bat, 2)

def volt_to_pct(v):
    if v >= 4.20: return 100
    if v <= 2.80: return 0
    for i in range(len(BATTERY_TABLE) - 1):
        v_high, pct_high = BATTERY_TABLE[i]
        v_low, pct_low   = BATTERY_TABLE[i + 1]
        if v >= v_low:
            ratio = (v - v_low) / (v_high - v_low)
            return int(pct_low + ratio * (pct_high - pct_low))
    return 0

# WiFi Connect
sta_if = network.WLAN(network.STA_IF)
sta_if.active(True)
sta_if.connect(WIFI_SSID, WIFI_PASS)
while not sta_if.isconnected():
    pass
print("WiFi Connected:", sta_if.ifconfig())

# Blynk Init
blynk = BlynkLib.Blynk(AUTH, insecure=True)

# Main Loop
timer = 0
while True:
    blynk.run()
    timer += 1
    if timer >= 3000:  
        timer = 0
        v = read_voltage()
        pct = volt_to_pct(v)
        blynk.virtual_write(0, v)    # V0 = Voltage
        blynk.virtual_write(1, pct)  # V1 = Battery %
        print(f"Sent → {v}V | {pct}%")
