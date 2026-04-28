import network, urequests, time, dht
from machine import ADC, Pin

ssid = "kritish"
password = "@Krrs2069"

# MQ-2
mq2 = ADC(Pin(34))
mq2.atten(ADC.ATTN_11DB)

# Soil
soil = ADC(Pin(35))
soil.atten(ADC.ATTN_11DB)

# DHT
d = dht.DHT11(Pin(4))

# WiFi
wlan = network.WLAN(network.STA_IF)
wlan.active(True)
wlan.connect(ssid, password)

t = 0
while not wlan.isconnected() and t < 10:
    time.sleep(1)
    t += 1

if not wlan.isconnected():
    print("WiFi Failed")
    raise SystemExit

print("ESP IP:", wlan.ifconfig())

url = "http://10.201.102.81:5000/data"

while True:
    try:
        d.measure()
        temp = d.temperature()
        hum = d.humidity()
    except:
        temp, hum = None, None

    gas = mq2.read()
    soil_val = soil.read()

    payload = {
        "gas": gas,
        "temp": temp,
        "humidity": hum,
        "soil": soil_val
    }

    try:
        r = urequests.post(url, json=payload)
        print(payload, "->", r.text)
        r.close()
        del r
    except Exception as e:
        print("Failed", e)

    time.sleep(3)

