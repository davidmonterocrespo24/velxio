from hcsr04 import HCSR04
from machine import Pin
from time import sleep

# LED setup
green_led = Pin(12, Pin.OUT)
red_led = Pin(13, Pin.OUT)

THRESHOLD = 20  # cm

# ESP32
sensor = HCSR04(trigger_pin=5, echo_pin=18, echo_timeout_us=10000)


while True:
    distance = sensor.distance_cm()
    print('Distance:', distance, 'cm')

    if distance > THRESHOLD:
        green_led.on()
        red_led.off()
    else:
        green_led.off()
        red_led.on()

    sleep(1)
