from machine import ADC, Pin
import time

# MQ-135 connected to GPIO 34
mq135 = ADC(Pin(34))
mq135.atten(ADC.ATTN_11DB)      # Allow 0–3.3V
mq135.width(ADC.WIDTH_12BIT)    # 12-bit ADC (0–4095)

print("MQ-135 Sensor Test")
print("Warming up sensor...")

time.sleep(10)   # short warm-up for testing

while True:
    total = 0
    samples = 10

    for i in range(samples):
        val = mq135.read()
        total += val
        time.sleep(0.1)

    avg_val = total // samples

    print("MQ-135 ADC Value:", avg_val)
    time.sleep(2)

