from machine import Pin, SPI
from mfrc522 import MFRC522
import utime

spi    = SPI(1, baudrate=1600000, polarity=0, phase=0)
reader = MFRC522(spi=spi, gpioCs=15)

led_green = Pin(2, Pin.OUT)
led_red   = Pin(0, Pin.OUT)
led_green.value(0)
led_red.value(0)

AUTHORISED = [
    (0x7a, 0xdb, 0x8d, 0x4, 0xcf), ##add yours
]

def uid_to_hex(uid):
    return ":".join("{:02X}".format(b) for b in uid)

def grant_access(uid_str):
    print("[GRANTED]", uid_str)
    led_green.value(1)
    utime.sleep_ms(800)
    led_green.value(0)

def deny_access(uid_str):
    print("[DENIED] ", uid_str)
    for _ in range(3):
        led_red.value(1)
        utime.sleep_ms(100)
        led_red.value(0)
        utime.sleep_ms(100)

utime.sleep_ms(200)
print("RFID Access Control")
print("Hold card near reader...")

reader.init()

last_uid  = None
last_time = 0

while True:
    (stat, tag_type) = reader.request(reader.REQIDL)

    if stat == reader.OK:
        (stat, uid) = reader.anticoll()

        if stat == reader.OK:
            uid_tuple = tuple(uid)
            uid_str   = uid_to_hex(uid)
            now       = utime.ticks_ms()

            if uid_tuple == last_uid and utime.ticks_diff(now, last_time) < 1500:
                continue

            last_uid  = uid_tuple
            last_time = now

            print("Card UID:", uid_str)

            if uid_tuple in AUTHORISED:
                grant_access(uid_str)
            else:
                deny_access(uid_str)

    utime.sleep_ms(50)
