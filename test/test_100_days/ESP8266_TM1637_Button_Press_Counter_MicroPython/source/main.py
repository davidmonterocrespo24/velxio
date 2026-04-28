from machine import Pin
import tm1637
from time import sleep_ms

# TM1637 Setup
tm = tm1637.TM1637(clk=Pin(5), dio=Pin(4))
tm.brightness(7)   # max brightness

# Button Setup
btn = Pin(14, Pin.IN, Pin.PULL_UP)  # D5 button → GND

# Custom correct segment bytes for your display
digits = [
    0x3f, # 0
    0x06, # 1
    0x5b, # 2
    0x4f, # 3
    0x66, # 4
    0x6d, # 5
    0x7d, # 6
    0x07, # 7
    0x7f, # 8
    0x6f  # 9
]

# Function to display a 4-digit number correctly
def show_number(num):
    num_str = "{:04d}".format(num)        # always 4 digits
    seg_data = [digits[int(d)] for d in num_str]
    tm.write(seg_data)

# Counter variables
count = 0
debounce = 0

print("System Ready! Press button to increase count.")

while True:

    # Button press detect
    if btn.value() == 0:        # button pressed
        if debounce == 0:
            count += 1
            if count > 9999:
                count = 0
            print("Button pressed → Count:", count)
            debounce = 50       # debounce time

    else:
        if debounce > 0:
            debounce -= 1

    # Update display
    show_number(count)

    sleep_ms(5)

