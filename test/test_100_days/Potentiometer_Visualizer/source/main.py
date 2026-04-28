from machine import Pin, ADC
from time import sleep

led_pins = [2, 4, 5, 12, 13, 14, 15, 16, 17, 18]
leds = [Pin(pin, Pin.OUT) for pin in led_pins]

pot = ADC(Pin(34))
pot.atten(ADC.ATTN_11DB)

while True:
    val = pot.read()
    level = min(10, round((val / 4095) * 10))  # Fixed

    for i in range(10):
        leds[i].value(1 if i < level else 0)

    on_leds = [led_pins[i] for i in range(level)]
    print(f"Analog Value: {val}, Level: {level}, LEDs ON: {on_leds}")

    sleep(0.2)

