from machine import ADC, Pin
import time

# MQ-7 analog output on GPIO 35
mq7 = ADC(Pin(35))
mq7.atten(ADC.ATTN_11DB)       # 0–3.3V
mq7.width(ADC.WIDTH_12BIT)     # 12-bit ADC

print("MQ-7 CO Sensor Test")
print("Warming up MQ-7 sensor (60 seconds)...")

# Warm-up phase
time.sleep(60)

print("Start reading MQ-7 values")

while True:
    readings = []
    for i in range(10):
        readings.append(mq7.read())
        time.sleep(0.1)

    avg_val = sum(readings) // len(readings)
    print("MQ-7 ADC Value:", avg_val)

    time.sleep(2)

