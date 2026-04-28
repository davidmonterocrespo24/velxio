'''Copyright (c) 2026 Kritish Mohapatra'''

import network
import time
from machine import Pin, ADC
import BlynkLib

# 🔑 Blynk
BLYNK_AUTH = "auth"

# 🌐 WiFi
WIFI_SSID = "kritish"
WIFI_PASS = "@pass"

# 📍 Pins
SOIL_PIN  = 3   # ADC
RELAY_PIN = 1   # Relay (active LOW)

# 🌱 Soil ADC setup
soil = ADC(Pin(SOIL_PIN))
soil.atten(ADC.ATTN_11DB)      # 0–3.3V
soil.width(ADC.WIDTH_12BIT)    # 0–4095

# 💧 Relay setup
relay = Pin(RELAY_PIN, Pin.OUT)
relay.on()   # Pump OFF initially

# 🌐 WiFi connect (safe)
wifi = network.WLAN(network.STA_IF)
wifi.active(False)
time.sleep(1)
wifi.active(True)
time.sleep(1)
wifi.connect(WIFI_SSID, WIFI_PASS)

print("Connecting WiFi", end="")
t0 = time.time()
while not wifi.isconnected():
    print(".", end="")
    time.sleep(1)
    if time.time() - t0 > 20:
        print("\nWiFi failed")
        break

if wifi.isconnected():
    print("\nWiFi OK:", wifi.ifconfig())

# 📲 Blynk init
blynk = BlynkLib.Blynk(BLYNK_AUTH, insecure=True)

# 🔘 Manual Pump Control (V1)
@blynk.on("V1")
def pump_control(value):
    if int(value[0]) == 1:
        relay.off()   # Pump ON
        print("Pump ON")
    else:
        relay.on()    # Pump OFF
        print("Pump OFF")

# 📊 Read soil & send to Blynk
def read_soil():
    raw = soil.read()  # 0–4095
    moisture = int((4095 - raw) * 100 / 4095)
    moisture = max(0, min(100, moisture))
    print("Soil:", moisture, "%")
    blynk.virtual_write(5, moisture)

# 🔁 Main loop
last = time.ticks_ms()
while True:
    if wifi.isconnected():
        blynk.run()

    if time.ticks_diff(time.ticks_ms(), last) > 2000:
        read_soil()
        last = time.ticks_ms()

