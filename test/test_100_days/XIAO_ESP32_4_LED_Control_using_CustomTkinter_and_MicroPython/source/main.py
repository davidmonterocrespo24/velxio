from machine import Pin
import sys
import time

leds = {
    "LED1": Pin(2, Pin.OUT),
    "LED2": Pin(3, Pin.OUT),
    "LED3": Pin(4, Pin.OUT),
    "LED4": Pin(5, Pin.OUT),
}

# All OFF at start
for led in leds.values():
    led.value(0)

print("ESP READY")
print("Commands: LED1:ON, LED1:OFF ... LED4")

while True:
    cmd = sys.stdin.readline()
    if not cmd:
        continue

    cmd = cmd.strip().upper()
    print("RECEIVED:", cmd)

    if ":" in cmd:
        name, action = cmd.split(":", 1)

        if name in leds:
            if action == "ON":
                leds[name].value(1)
                print(f"OK:{name} ON")

            elif action == "OFF":
                leds[name].value(0)
                print(f"OK:{name} OFF")

    time.sleep(0.05)

