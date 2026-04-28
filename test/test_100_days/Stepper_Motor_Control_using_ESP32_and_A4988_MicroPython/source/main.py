import time
import machine

# A4988 pins
dir_pin  = machine.Pin(12, machine.Pin.OUT)
step_pin = machine.Pin(14, machine.Pin.OUT)

def move_stepper(direction, steps, delay_us):
    print("Direction:", "CW" if direction else "CCW")
    dir_pin.value(direction)

    steps = abs(steps)
    for i in range(steps):
        step_pin.value(1)
        time.sleep_us(delay_us)
        step_pin.value(0)
        time.sleep_us(delay_us)

    print("Moved", steps, "steps")

def stop_stepper():
    step_pin.value(0)
    print("Stepper stopped")

print("Stepper motor program started")

while True:
    move_stepper(1, 200, 2000)   # Clockwise
    time.sleep(2)

    move_stepper(0, 200, 2000)   # Anti-clockwise
    time.sleep(2)
