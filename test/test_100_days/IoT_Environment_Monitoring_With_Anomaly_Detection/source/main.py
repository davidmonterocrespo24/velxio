import network
import urequests as requests
import time
from machine import Pin, ADC
import dht

# --------------------------
# WiFi Credentials
# --------------------------

SSID = "yourssid"
PASS = "yourpassword"
# --------------------------
# ThingSpeak Details
# --------------------------
API_KEY = "yourapikey"  
BASE_URL = "http://api.thingspeak.com/update"

# --------------------------a
# Sensors Setup
# --------------------------
d = dht.DHT11(Pin(2))     # D2 = GPIO4
ldr = ADC(0)              # A0 pin for LDR

# --------------------------
# Connect to WiFi
# --------------------------
def connect_wifi():
    sta = network.WLAN(network.STA_IF)
    sta.active(True)
    if not sta.isconnected():
        print("Connecting WiFi...")
        sta.connect(SSID, PASS)
        while not sta.isconnected():
            time.sleep(0.5)
    print("Connected:", sta.ifconfig())

connect_wifi()

# --------------------------
# Upload Loop
# --------------------------
while True:
    try:
        d.measure()
        temp = d.temperature()
        hum = d.humidity()
        light = ldr.read()

        print("Temp:", temp, "°C", "Hum:", hum, "%", "LDR:", light)

        url = f"{BASE_URL}?api_key={API_KEY}&field1={temp}&field2={hum}&field3={light}"
        r = requests.get(url)
        print("Uploaded:", r.text)
        r.close()

    except Exception as e:
        print("Error:", e)

    time.sleep(15)   # ThingSpeak min 15 sec

