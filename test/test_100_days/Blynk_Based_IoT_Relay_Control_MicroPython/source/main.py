'''Copyright (c) 2025 Kritish Mohapatra'''

import network
from machine import Pin
import BlynkLib
from time import sleep

# -------- WIFI DETAILS --------
wifissid = "ssid" # Your Wi-Fi SSID
wifipass = "pass" # Your Wi-Fi password

# Blynk Authorization Token (replace with your Blynk app's token)
auth = "gmETsu4VJeGAjNaoV006ytWOUA"
# -------- RELAY / LED --------
relay = Pin(2, Pin.OUT)   # GP15 (Best for Pico 2 W)
relay.value(1)             # OFF (Active LOW)

# -------- WIFI CONNECT --------
sta_if = network.WLAN(network.STA_IF)
sta_if.active(True)
sta_if.connect(wifissid, wifipass)

while not sta_if.isconnected():
    sleep(1)

print("WiFi Connected:", sta_if.ifconfig())

# -------- BLYNK INIT --------
blynk = BlynkLib.Blynk(auth, insecure=True)

# -------- VIRTUAL PIN V1 --------
@blynk.on("V1")
def v1_handler(value):
    try:
        relay.value(not int(value[0]))
        print("Relay State:", value[0])
    except:
        print("Invalid data")

# -------- MAIN LOOP --------
while True:
    blynk.run()

