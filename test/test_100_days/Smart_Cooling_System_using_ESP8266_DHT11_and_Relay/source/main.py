import dht
import machine
import time

# Pin configuration
dht_pin = machine.Pin(2)                    # D4
fan_pin = machine.Pin(14, machine.Pin.OUT)  # D5 (Relay)

sensor = dht.DHT11(dht_pin)

TEMP_THRESHOLD = 30  # Celsius

FAN_ON  = 0   # Active LOW relay
FAN_OFF = 1

fan_pin.value(FAN_OFF)  # Fan OFF at startup

while True:
    try:
        sensor.measure()
        temp = sensor.temperature()
        hum = sensor.humidity()

        print("Temperature:", temp, "°C")
        print("Humidity:", hum, "%")

        if temp >= TEMP_THRESHOLD:
            fan_pin.value(FAN_ON)
            print("Fan ON 🔥")
        else:
            fan_pin.value(FAN_OFF)
            print("Fan OFF ❄️")

    except Exception as e:
        print("Error:", e)

    time.sleep(2)

