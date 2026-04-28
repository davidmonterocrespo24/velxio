from machine import Pin
import time

touch = Pin(14, Pin.IN)    # D5 (TTP223 OUT)
led = Pin(2, Pin.OUT)      # External LED

led.value(0)               # LED OFF initially

led_state = False
last_touch = 0

while True:
    current_touch = touch.value()

    if current_touch == 1 and last_touch == 0:
        led_state = not led_state
        led.value(1 if led_state else 0)
        print("LED State:", "ON" if led_state else "OFF")
        time.sleep(0.3)   # debounce delay

    last_touch = current_touch