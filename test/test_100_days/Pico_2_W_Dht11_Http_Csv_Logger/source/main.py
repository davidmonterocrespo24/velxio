import network, time, urequests
import dht
from machine import Pin

ssid = "kritish"
password = "pas"

url = "http://ip:5000/data"  # laptop IP

sensor = dht.DHT11(Pin(15))

wlan = network.WLAN(network.STA_IF)
wlan.active(True)
wlan.connect(ssid, password)

while not wlan.isconnected():
    time.sleep(1)

print("WiFi connected")

while True:
    sensor.measure()
    temp = sensor.temperature()
    hum = sensor.humidity()

    data = {
        "temperature": temp,
        "humidity": hum
    }

    try:
        r = urequests.post(url, json=data)
        r.close()
        print("Sent:", data)
    except Exception as e:
        print("Error:", e)

    time.sleep(5)

