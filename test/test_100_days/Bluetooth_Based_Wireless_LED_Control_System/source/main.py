from machine import Pin, UART

uart = UART(0, 9600)
led = Pin("LED", Pin.OUT)

print("Bluetooth Control Ready")

while True:
    if uart.any() > 0:
        data = uart.read().decode().strip()   # decode bytes → string
        print("Received:", data)

        if "on" in data.lower():
            led.value(1)
            print("LED ON")
            uart.write("LED ON\n")

        elif "off" in data.lower():
            led.value(0)
            print("LED OFF")
            uart.write("LED OFF\n")

