import network
from machine import Pin
import BlynkLib
from time import sleep

# -------- WIFI DETAILS --------
wifissid = "ssid"
wifipass = "pass"

# -------- BLYNK AUTH --------
auth = "gmETsutWOUA"

# -------- RELAY --------
relay = Pin(15, Pin.OUT)
relay.value(1)   # Relay OFF (Active LOW)

# -------- WIFI CONNECT --------
wifi = network.WLAN(network.STA_IF)
wifi.active(True)
wifi.connect(wifissid, wifipass)

print("Connecting WiFi...")
while not wifi.isconnected():
    sleep(1)

print("WiFi Connected:", wifi.ifconfig())

# -------- BLYNK INIT --------
blynk = BlynkLib.Blynk(auth, insecure=True)

# -------- BUTTON ON V1 --------
@blynk.on("V1")
def v1_handler(value):
    state = int(value[0])

    if state == 1:
        relay.value(0)   # Relay ON
        print("Fan ON")
    else:
        relay.value(1)   # Relay OFF
        print("Fan OFF")

# -------- MAIN LOOP --------
while True:
    blynk.run()

