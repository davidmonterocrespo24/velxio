
'''Copyright (c) 2026 Kritish Mohapatra'''

import network
from machine import SoftI2C, Pin
import BlynkLib
from time import sleep
from bmp180 import BMP180

# -------- WiFi --------
wifissid = "Wokwi-GUEST"
wifipass = ""

# -------- Blynk Token --------
auth = "dashboard-token"

# Connect WiFi
sta_if = network.WLAN(network.STA_IF)
sta_if.active(True)
sta_if.connect(wifissid, wifipass)

while not sta_if.isconnected():
    pass

print("Connected to Wi-Fi:", sta_if.ifconfig())

# Start Blynk
blynk = BlynkLib.Blynk(auth, insecure=True)

# -------- BMP180 I2C --------
i2c = SoftI2C(scl=Pin(22), sda=Pin(21))
bmp = BMP180(i2c)
bmp.oversample = 2
bmp.sealevel = 101325   # sea level pressure

# -------- MAIN LOOP --------
while True:
    blynk.run()

    temp = bmp.temperature
    pressure = bmp.pressure / 100   # Pa → hPa
    altitude = bmp.altitude

    print("Temp:", temp, "C")
    print("Pressure:", pressure, "hPa")
    print("Altitude:", altitude, "m")
    print("----------------------")

    # Send to Blynk
    blynk.virtual_write(0, temp)       # V0 Temperature
    blynk.virtual_write(1, pressure)   # V1 Pressure
    blynk.virtual_write(2, altitude)   # V2 Altitude

    sleep(2)
