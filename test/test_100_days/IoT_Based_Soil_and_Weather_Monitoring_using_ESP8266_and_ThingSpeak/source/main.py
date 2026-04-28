import network
import urequests
import time
from machine import Pin, ADC
import dht

# --------------------------
# WiFi Credentials
# --------------------------
SSID = "kritish"
PASS = "@pass"

# --------------------------
# ThingSpeak
# --------------------------
API_KEY = "write"
BASE_URL = "http://api.thingspeak.com/update"

# --------------------------
# Sensors
# --------------------------
d = dht.DHT11(Pin(2))   # D4 = GPIO2
soil = ADC(0)           # A0

# --------------------------
# WiFi Connect
# --------------------------
def connect_wifi():
    sta = network.WLAN(network.STA_IF)
    sta.active(True)
    if not sta.isconnected():
        print("Connecting WiFi...")
        sta.connect(SSID, PASS)
        while not sta.isconnected():
            time.sleep(1)

    print("WiFi Connected ✅")
    print(sta.ifconfig())
    time.sleep(3)   

connect_wifi()

# --------------------------
# Upload Loop
# --------------------------
while True:
    r = None
    try:
        d.measure()
        temp = d.temperature()
        hum = d.humidity()
        s = soil.read()

        print("Temp:", temp, "Hum:", hum, "Soil:", s)

        url = "{}?api_key={}&field1={}&field2={}&field3={}".format(
            BASE_URL, API_KEY, s, temp, hum
        )

        r = urequests.get(url)
        print("Uploaded to ThingSpeak 🚀")

    except Exception as e:
        print("Error:", e)

    finally:
        if r:
            r.close()

    time.sleep(20)   

