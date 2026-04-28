import network, urequests, time
from machine import Pin

# LED
led = Pin("LED", Pin.OUT)

# WiFi
ssid = "kritish"
password = "pass"

wlan = network.WLAN(network.STA_IF)
wlan.active(True)
wlan.connect(ssid, password)

while not wlan.isconnected():
    time.sleep(1)

print("Connected:", wlan.ifconfig())

# Flask server URL
SERVER = "http://ip:5000/led/state"

while True:
    try:
        r = urequests.get(SERVER)
        state = r.json()["value"]
        r.close()

        led.value(state)
        print("LED =", state)

    except Exception as e:
        print("Error:", e)

    time.sleep(2)

