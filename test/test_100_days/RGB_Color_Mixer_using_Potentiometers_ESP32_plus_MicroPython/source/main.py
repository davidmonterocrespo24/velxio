# ESP32 MicroPython - RGB controlled by 3 potentiometers (common-cathode example)
from machine import ADC, Pin, PWM
import time

# PWM pins for RGB
p_r = PWM(Pin(25), freq=1000)  # R
p_g = PWM(Pin(26), freq=1000)  # G
p_b = PWM(Pin(27), freq=1000)  # B

# ADC pins for pots
a_r = ADC(Pin(36))  # Pot for R
a_r.atten(ADC.ATTN_11DB)
a_g = ADC(Pin(39))
a_g.atten(ADC.ATTN_11DB)
a_b = ADC(Pin(34))
a_b.atten(ADC.ATTN_11DB)

# Helper: map ADC (0-4095) to PWM duty (0-1023)
def map_adc_to_duty(x):
    return int((x / 4095) * 1023) 
# If you have common-anode LED, set invert = True
invert = False

while True:
    # Read potentiometer values
    raw_r = a_r.read()
    raw_g = a_g.read()
    raw_b = a_b.read()

    # Map to PWM duty
    r = map_adc_to_duty(raw_r)
    g = map_adc_to_duty(raw_g)
    b = map_adc_to_duty(raw_b)

    if invert:
        r = 1023 - r
        g = 1023 - g
        b = 1023 - b

    # Apply PWM
    p_r.duty(r)
    p_g.duty(g)
    p_b.duty(b)

    # Print live values
    print("ADC R: {:4d}  G: {:4d}  B: {:4d}  |  PWM R: {:4d}  G: {:4d}  B: {:4d}".format(
        raw_r, raw_g, raw_b, r, g, b
    ))

    time.sleep_ms(200)

