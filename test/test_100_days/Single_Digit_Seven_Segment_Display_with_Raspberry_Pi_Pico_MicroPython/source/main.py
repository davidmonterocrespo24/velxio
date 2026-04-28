from machine import Pin  # Import Pin class to control GPIO pins

# ----------------------------
# Define 7-segment display pins
# Each pin corresponds to one segment: a, b, c, d, e, f, g
# Adjust wiring as per your circuit
# ----------------------------
led_a = Pin(2, Pin.OUT)
led_b = Pin(3, Pin.OUT)
led_c = Pin(6, Pin.OUT)
led_d = Pin(5, Pin.OUT)
led_e = Pin(4, Pin.OUT)
led_f = Pin(1, Pin.OUT)
led_g = Pin(0, Pin.OUT)

# ----------------------------
# Functions for digits 0-9
# Each function turns ON/OFF segments to display the correct number
# ----------------------------

def value_one():
    led_a.value(0)
    led_b.value(0)
    led_c.value(0)
    led_d.value(0)
    led_e.value(1)
    led_f.value(1)
    led_g.value(0)

def value_two():
    led_a.value(1)
    led_b.value(1)
    led_c.value(0)
    led_d.value(1)
    led_e.value(1)
    led_f.value(0)
    led_g.value(1)

def value_three():
    led_a.value(1)
    led_b.value(1)
    led_c.value(1)
    led_d.value(1)
    led_e.value(0)
    led_f.value(0)
    led_g.value(1)

def value_four():
    led_a.value(0)
    led_b.value(1)
    led_c.value(1)
    led_d.value(0)
    led_e.value(0)
    led_f.value(1)
    led_g.value(1)

def value_five():
    led_a.value(1)
    led_b.value(0)
    led_c.value(1)
    led_d.value(1)
    led_e.value(0)
    led_f.value(1)
    led_g.value(1)

def value_six():
    led_a.value(1)
    led_b.value(0)
    led_c.value(1)
    led_d.value(1)
    led_e.value(1)
    led_f.value(1)
    led_g.value(1)

def value_seven():
    led_a.value(1)
    led_b.value(1)
    led_c.value(1)
    led_d.value(0)
    led_e.value(0)
    led_f.value(0)
    led_g.value(0)

def value_eight():
    led_a.value(1)
    led_b.value(1)
    led_c.value(1)
    led_d.value(1)
    led_e.value(1)
    led_f.value(1)
    led_g.value(1)

def value_nine():
    led_a.value(1)
    led_b.value(1)
    led_c.value(1)
    led_d.value(0)
    led_e.value(0)
    led_f.value(1)
    led_g.value(1)

def value_zero():
    led_a.value(1)
    led_b.value(1)
    led_c.value(1)
    led_d.value(1)
    led_e.value(1)
    led_f.value(1)
    led_g.value(0)

# ----------------------------
# Main Loop
# User enters a digit (0-9) via input
# That digit is displayed on the 7-segment
# ----------------------------
while True:
    k = int(input("Enter a number (0-9): "))
    if k == 0:
        value_zero()
    elif k == 1:
        value_one()
    elif k == 2:
        value_two()
    elif k == 3:
        value_three()
    elif k == 4:
        value_four()
    elif k == 5:
        value_five()
    elif k == 6:
        value_six()
    elif k == 7:
        value_seven()
    elif k == 8:
        value_eight()
    elif k == 9:
        value_nine()
    else:
        print("Please Enter a value between 0-9 and one digit")

