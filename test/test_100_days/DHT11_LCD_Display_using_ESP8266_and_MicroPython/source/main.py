# Import required libraries
from machine import Pin, I2C
from time import sleep_ms
import dht
from i2c_lcd import I2cLcd

# ==========================
# LCD and Sensor Setup
# ==========================
# Initialize I2C for LCD (SCL = D1/GPIO5, SDA = D2/GPIO4)
i2c = I2C(scl=Pin(5), sda=Pin(4), freq=400000)

# Define LCD address (0x27) and size (2 rows, 16 columns)
lcd = I2cLcd(i2c, 0x27, 2, 16)

# Initialize DHT11 sensor on D4 (GPIO2)
sensor = dht.DHT11(Pin(2))

# ==========================
# Initial LCD Labels
# ==========================
# Display static text only once to prevent flicker
lcd.putstr("Temp:      C")     # Line 1 label
lcd.move_to(0, 1)
lcd.putstr("Humidity:     %")  # Line 2 label

# ==========================
# Main Loop
# ==========================
while True:
    sensor.measure()                  # Take new temperature & humidity reading
    temp = sensor.temperature()       # Read temperature (°C)
    hum = sensor.humidity()           # Read humidity (%)

    # Update only numerical values on LCD
    # Avoids using lcd.clear() which causes flickering
    lcd.move_to(6, 0)                 # Move to temperature value position
    lcd.putstr("{:>2}".format(temp))  # Display temperature (right-aligned)
    lcd.move_to(10, 1)                # Move to humidity value position
    lcd.putstr("{:>2}".format(hum))   # Display humidity (right-aligned)

    sleep_ms(2000)                    # Update every 2 seconds
