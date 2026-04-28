import network
import espnow
from machine import Pin, SoftI2C
import ssd1306
import utime

wlan = network.WLAN(network.STA_IF)
wlan.active(True)

e = espnow.ESPNow()
e.active(True)

i2c    = SoftI2C(scl=Pin(5), sda=Pin(4))
oled   = ssd1306.SSD1306_I2C(128, 64, i2c)

def show(uid_str):
    oled.fill(0)
    oled.text("Day 75 ESP-NOW", 0, 0)
    oled.text("RFID Receiver", 0, 12)
    oled.hline(0, 24, 128, 1)
    oled.text("UID:", 0, 32)
    oled.text(uid_str[:16], 0, 44)
    if len(uid_str) > 16:
        oled.text(uid_str[16:], 0, 56)
    oled.show()

oled.fill(0)
oled.text("Day 75 ESP-NOW", 0, 0)
oled.text("Waiting for", 0, 24)
oled.text("card scan...", 0, 36)
oled.show()

print("Day 75 - ESP-NOW RFID Receiver")
print("Waiting for data...")

while True:
    host, msg = e.recv()
    if msg:
        uid_str = msg.decode()
        print("Received UID:", uid_str)
        show(uid_str)
