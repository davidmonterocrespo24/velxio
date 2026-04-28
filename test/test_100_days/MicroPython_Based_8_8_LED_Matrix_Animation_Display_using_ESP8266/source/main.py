from machine import Pin, SPI
from time import sleep
from DIYables_MicroPython_LED_Matrix import Max7219

# Initialize SPI interface
# ESP8266 SPI1 uses:
# SCK  -> GPIO14 (D5)
# MOSI -> GPIO13 (D7)
spi = SPI(1, baudrate=10000000)

# Chip Select pin for MAX7219 (CS -> GPIO15 / D8)
cs = Pin(15, Pin.OUT)

# Create display object for 1 MAX7219 matrix
display = Max7219(spi, cs, num_matrices=1)

# Set display brightness (0–15)
display.set_brightness(15)

# Clear any previous garbage on matrix
display.clear()
display.show()

# First heart pattern (Frame 1)
heart = [
  0b00000000,
  0b01100110,
  0b11111111,
  0b11111111,
  0b11111111,
  0b01111110,
  0b00111100,
  0b00011000
]

# Second heart pattern (Frame 2)
heart_2 = [
  0b01100110,
  0b10011101,
  0b10000001,
  0b10000001,
  0b01000010,
  0b00100100,
  0b00011000,
  0b00000000
]

# Infinite animation loop
while True:
    # ----------------------------
    # Display Heart Frame 1
    # ----------------------------
    display.clear()                      # Clear screen buffer
    display.show()                       # Update display
    display.print_custom_char(heart, col=0)  # Print heart at column 0
    display.show()                       # Show frame on LED matrix
    sleep(1)                             # Hold for 1 second

    # ----------------------------
    # Display Heart Frame 2
    # ----------------------------
    display.clear()
    display.show()
    display.print_custom_char(heart_2, col=0)
    display.show()
    sleep(1)
