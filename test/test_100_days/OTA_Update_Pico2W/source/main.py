import time
from machine import Pin

led = Pin("LED", Pin.OUT)

while True:
    led.on()
    print("LED ON - Version 1.0.0")
    time.sleep(1)
    led.off()
    print("LED OFF - Version 1.0.0")
    time.sleep(1)