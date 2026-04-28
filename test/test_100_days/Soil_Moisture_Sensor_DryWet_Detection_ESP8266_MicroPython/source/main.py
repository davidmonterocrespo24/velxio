from machine import ADC
import time

soil = ADC(0)   # A0 pin
THRESHOLD = 700

while True:
    value = soil.read()   # 0–1023
    if value > THRESHOLD:
        status = "DRY"
    else:
        status = "WET"

    print("Soil Value:", value, "| Status:", status)
    time.sleep(1)

