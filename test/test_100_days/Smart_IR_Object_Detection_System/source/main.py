from machine import Pin
import time

# Pin setup (ESP8266)
ir_sensor = Pin(14, Pin.IN)   # D5
led = Pin(2, Pin.OUT)         # D4 (onboard LED)
buzzer = Pin(12, Pin.OUT)     # D6

print("Smart IR Object Detection - ESP8266")

while True:
    if ir_sensor.value() == 0:   # Object detected
        led.on()
        buzzer.on()
        print("Object Detected")
    else:
        led.off()
        buzzer.off()
        print("No Object")

    time.sleep(0.2)

