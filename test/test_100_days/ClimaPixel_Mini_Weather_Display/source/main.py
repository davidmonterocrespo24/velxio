from machine import Pin, I2C
from time import sleep
import dht
import ssd1306

# Sensor Setup
# Note: Double check your pin. On standard ESP8266, Pin(16) is often used for Wake, 
# but if you are using D4 it might be Pin(2). Adjust if needed.
dht_sensor = dht.DHT11(Pin(16)) 

# OLED Setup
i2c = I2C(sda=Pin(4), scl=Pin(5))
oled = ssd1306.SSD1306_I2C(128, 64, i2c)

# ------------------- ICON HELPER FUNCTIONS ------------------- #

def draw_bitmap(x, y, bitmap, w, h):
    """
    Draws an icon using simple pixel commands.
    bitmap: a list of byte values (one per row)
    """
    for r in range(h):           # For each row
        row_data = bitmap[r]
        for c in range(w):       # For each pixel in width
            # Check if the bit at this position is 1
            if (row_data >> (w - 1 - c)) & 1:
                oled.pixel(x + c, y + r, 1)

def draw_hline_manual(x, y, w):
    """Manually draws a horizontal line using pixel()"""
    for i in range(w):
        oled.pixel(x + i, y, 1)

# ------------------- ICON DEFINITIONS ------------------- #
# These are defined row-by-row.
# You can visualize the 1s as the drawing.

# Thermometer (8 pixels wide, 8 pixels tall)
ICON_TEMP = [
    0b00011000, # ...XX...
    0b00011000, # ...XX...
    0b00011000, # ...XX...
    0b00011000, # ...XX...
    0b00111100, # ..XXXX..
    0b01111110, # .XXXXXX.
    0b01111110, # .XXXXXX.
    0b00111100, # ..XXXX..
]

# Water Droplet (8 pixels wide, 8 pixels tall)
ICON_HUM = [
    0b00010000, # ...X....
    0b00111000, # ..XXX...
    0b01111100, # .XXXXX..
    0b11111110, # XXXXXXX.
    0b11111110, # XXXXXXX.
    0b01111100, # .XXXXX..
    0b00111000, # ..XXX...
    0b00000000, # ........
]

# ---------------------------------------------------------------- #

while True:
    try:
        dht_sensor.measure()
        temp = dht_sensor.temperature()
        hum  = dht_sensor.humidity()
        
        oled.fill(0) # Clear screen

        # --- Title ---
        oled.text("Mini Weather", 15, 0)
        draw_hline_manual(0, 10, 128) # Draw line manually

        # --- Draw Temperature ---
        draw_bitmap(10, 22, ICON_TEMP, 8, 8)
        oled.text("{} C".format(temp), 25, 22)

        # --- Draw Humidity ---
        draw_bitmap(10, 42, ICON_HUM, 8, 8)
        oled.text("{} %".format(hum), 25, 42)

        oled.show()
    except OSError as e:
        # This handles errors if the sensor temporarily disconnects
        oled.fill(0)
        oled.text("Sensor Error", 10, 20)
        oled.show()
    
    sleep(2)
