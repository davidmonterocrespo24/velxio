from machine import Pin, I2C
from time import sleep
from i2c_lcd import I2cLcd

# LCD setup
i2c = I2C(0, scl=Pin(22), sda=Pin(21), freq=400000)
lcd = I2cLcd(i2c, 0x27, 2, 16)

# LEDs
green = Pin(5, Pin.OUT)
red = Pin(4, Pin.OUT)

# Password
PASSWORD = "12ABC8"
entered = ""

# Keypad pins
rows = [13,12,14,27]
cols = [26,25,33,32]

row_pins = [Pin(r, Pin.OUT) for r in rows]
col_pins = [Pin(c, Pin.IN, Pin.PULL_DOWN) for c in cols]

keys = [
    ['1','2','3','A'],
    ['4','5','6','B'],
    ['7','8','9','C'],
    ['*','0','#','D']
]

lcd.clear()
lcd.putstr("Enter Password")

def read_keypad():
    for i, row in enumerate(row_pins):
        row.value(1)
        for j, col in enumerate(col_pins):
            if col.value():
                row.value(0)
                sleep(0.3)
                return keys[i][j]
        row.value(0)
    return None

while True:
    key = read_keypad()
    if key:
        if key == '#':
            lcd.clear()
            if entered == PASSWORD:
                lcd.putstr("Access Granted")
                green.on()
                sleep(2)
                green.off()
            else:
                lcd.putstr("Access Denied")
                red.on()
                sleep(2)
                red.off()

            entered = ""
            lcd.clear()
            lcd.putstr("Enter Password")

        elif key == '*':
            entered = ""
            lcd.clear()
            lcd.putstr("Cleared")
            sleep(1)
            lcd.clear()
            lcd.putstr("Enter Password")

        else:
            entered += key
            lcd.move_to(len(entered)-1, 1)
            lcd.putstr("*")

