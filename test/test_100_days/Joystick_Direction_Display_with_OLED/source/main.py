from machine import ADC, Pin, I2C
import ssd1306
import time

# Joystick
vrx = ADC(Pin(26))
vry = ADC(Pin(27))
sw  = Pin(15, Pin.IN, Pin.PULL_UP)

# OLED
i2c  = I2C(0, sda=Pin(0), scl=Pin(1), freq=400000)
oled = ssd1306.SSD1306_I2C(128, 64, i2c)

def show_direction(direction, x, y, btn):
    oled.fill(0)

    # Big arrow in center
    if direction == "UP":
        oled.text("^", 58, 20, 1)
        oled.text("UP", 52, 35, 1)
    elif direction == "DOWN":
        oled.text("v", 58, 20, 1)
        oled.text("DOWN", 48, 35, 1)
    elif direction == "RIGHT":
        oled.text(">", 58, 20, 1)
        oled.text("RIGHT", 44, 35, 1)
    elif direction == "LEFT":
        oled.text("<", 58, 20, 1)
        oled.text("LEFT", 48, 35, 1)
    elif direction == "PRESSED":
        oled.text("* SW *", 40, 20, 1)
        oled.text("PRESSED", 36, 35, 1)
    else:
        oled.text("+", 58, 20, 1)
        oled.text("CENTER", 40, 35, 1)

    # Raw values at bottom
    oled.text(f"X:{x:4d} Y:{y:4d}", 0, 52, 1)

    oled.show()

print("Pico 2 Joystick + OLED Ready!")

while True:
    x   = vrx.read_u16() >> 4
    y   = vry.read_u16() >> 4
    btn = sw.value()

    if btn == 0:
        direction = "PRESSED"
    elif x > 3000:
        direction = "RIGHT"
    elif x < 1000:
        direction = "LEFT"
    elif y > 3000:
        direction = "DOWN"
    elif y < 1000:
        direction = "UP"
    else:
        direction = "CENTER"

    show_direction(direction, x, y, btn)
    print(f"X={x:4d}  Y={y:4d}  SW={btn}  -> {direction}")
    time.sleep_ms(150)