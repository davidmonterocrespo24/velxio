from machine import Pin, ADC, PWM
from time import sleep

pot = ADC(Pin(34))       # Potentiometer
pot.atten(ADC.ATTN_11DB) # 0 - 3.3V range
led = PWM(Pin(2))        # LED on GPIO2
led.freq(1000)            # 1 kHz PWM frequency

while True:
    val = pot.read()  # 0–4095 range
    duty = int((val / 4095) * 1023)  # scale to PWM duty
    led.duty(duty)
    print("ADC:", val, "→ PWM:", duty)
    sleep(0.1)

