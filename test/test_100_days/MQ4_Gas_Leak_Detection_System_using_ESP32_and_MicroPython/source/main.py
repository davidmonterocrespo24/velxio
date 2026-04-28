from machine import ADC, Pin
import time

# MQ4 gas sensor setup
mq4 = ADC(Pin(34))  # Analog input pin
mq4.atten(ADC.ATTN_11DB)  # Full voltage range
mq4.width(ADC.WIDTH_10BIT)  # 10-bit resolution

# Buzzer setup
buzzer = Pin(15, Pin.OUT)

# Threshold for gas alert (tune this based on testing)
GAS_THRESHOLD = 240

while True:
    gas_value = mq4.read()
    voltage = gas_value * 3.3 / 1023
    
    print("Gas reading (raw):", gas_value)
    print("Voltage:", round(voltage, 2), "V")

    # Alert condition
    if gas_value > GAS_THRESHOLD:
        buzzer.on()
        print("⚠️ Gas leak detected! Buzzer ON")
    else:
        buzzer.off()

    print("----------------------------")
    time.sleep(2)

