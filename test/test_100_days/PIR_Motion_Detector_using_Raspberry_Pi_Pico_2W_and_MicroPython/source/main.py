from machine import Pin
import time

pir = Pin(16, Pin.IN, Pin.PULL_DOWN)   # PIR sensor pin
led = Pin("LED", Pin.OUT)              # Built-in LED

print("PIR Motion Detector Started...")

while True:
    if pir.value() == 1:
        print("Motion Detected!")
        led.value(1)
        time.sleep(1)
    else:
        print("No motion")
        led.value(0)
        time.sleep(0.2)