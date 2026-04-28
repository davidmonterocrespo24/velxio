import dht
import machine
import time

sensor = dht.DHT11(machine.Pin(2))  # D4 = GPIO2

while True:
    try:
        sensor.measure()
        temp = sensor.temperature()
        hum = sensor.humidity()

        # Send data to PC via USB serial
        print("{},{}".format(temp, hum))

    except:
        print("0,0")

    time.sleep(2)

