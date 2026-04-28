import network
import espnow
from machine import Pin, SPI
from mfrc522 import MFRC522
import utime

wlan = network.WLAN(network.STA_IF)
wlan.active(True)

e = espnow.ESPNow()
e.active(True)

RECEIVER_MAC = b'\xd8\xbf\xc0\x0e\x64\xe9'
e.add_peer(RECEIVER_MAC)

spi    = SPI(1, baudrate=1600000, polarity=0, phase=0)
reader = MFRC522(spi=spi, gpioCs=15)

def uid_to_str(uid):
    return ":".join("{:02X}".format(b) for b in uid)

reader.init()
print("Day 75 - ESP-NOW RFID Sender")
print("Hold card near reader...")

last_uid  = None
last_time = 0

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

            uid_str = uid_to_str(uid)
            print("Sending UID:", uid_str)
            e.send(RECEIVER_MAC, uid_str)

    utime.sleep_ms(50)
