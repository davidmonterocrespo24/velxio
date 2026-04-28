from machine import ADC, Pin
import time

rain = ADC(0)           # A0
led = Pin(2, Pin.OUT)   # D4 (optional)

while True:
    value = rain.read()   # 0–1023

    print("Rain Analog Value:", value)

    if value < 400:
        led.off()
        print("🌧️ Heavy Rain")
    elif value < 700:
        led.off()
        print("🌦️ Light Rain")
    else:
        led.on()
        print("☀️ No Rain")

    time.sleep(1)

