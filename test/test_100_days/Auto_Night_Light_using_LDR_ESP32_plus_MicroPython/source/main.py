from machine import Pin, ADC
from time import sleep

# Initialize LDR on ADC pin 34
ldr = ADC(Pin(34))
ldr.atten(ADC.ATTN_11DB)  # full range 0-3.3V

# Initialize LED on GPIO2
led = Pin(2, Pin.OUT)

# Threshold for turning LED on/off
threshold = 500

while True:
    light = ldr.read()       # Read LDR value
    print(light)
    
    if light < threshold:    # It's dark
        led.on()             # Turn LED ON
    else:                    # It's bright
        led.off()            # Turn LED OFF
    
    sleep(1)
