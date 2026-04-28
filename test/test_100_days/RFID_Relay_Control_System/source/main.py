from machine import Pin, SPI
from mfrc522 import MFRC522
import utime

spi    = SPI(0, baudrate=1600000, polarity=0, phase=0,
             sck=Pin(18), mosi=Pin(19), miso=Pin(16))
reader = MFRC522(spi=spi, gpioCs=17)

relay = Pin(2, Pin.OUT)
relay.value(1)

AUTHORISED = (89, 138, 214, 5, 0)

fan_on    = False
last_uid  = None
last_time = 0

reader.init()
print("Day 74 - RFID Relay Control")
print("Hold card to toggle fan...")

while True:
    (stat, tag_type) = reader.request(reader.REQIDL)

    if stat == reader.OK:
        (stat, uid) = reader.anticoll()

        if stat == reader.OK:
            uid_tuple = tuple(uid)
            now       = utime.ticks_ms()

            if uid_tuple == last_uid and utime.ticks_diff(now, last_time) < 2000:
                continue

            last_uid  = uid_tuple
            last_time = now

            if uid_tuple == AUTHORISED:
                fan_on = not fan_on
                relay.value(0 if fan_on else 1)
                print("Fan:", "ON" if fan_on else "OFF")
            else:
                print("Unknown card")

    utime.sleep_ms(50)
