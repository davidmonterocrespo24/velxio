from machine import Pin
import time

sound = Pin(15, Pin.IN)
led = Pin(2, Pin.OUT)

state = 0          # 0 = OFF, 1 = ON
last_time = 0
debounce = 500     # ms (clap gap)

while True:
    if sound.value() == 1:
        current_time = time.ticks_ms()

        # debounce check
        if time.ticks_diff(current_time, last_time) > debounce:
            state = not state   # TOGGLE
            led.value(state)
            print("Clap! LED:", "ON" if state else "OFF")
            last_time = current_time

        # wait until sound goes low
        while sound.value() == 1:
            pass

    time.sleep_ms(20)

