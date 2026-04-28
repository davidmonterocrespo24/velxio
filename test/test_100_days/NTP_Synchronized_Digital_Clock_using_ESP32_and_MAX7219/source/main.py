

from machine import Pin, SPI
import max7219
import time
import network
import ntptime

# ========== WIFI CONFIG ==========
SSID = "Wokwi-GUEST"
PASSWORD = ""

# ========== CONNECT WIFI ==========
wlan = network.WLAN(network.STA_IF)
wlan.active(True)
wlan.connect(SSID, PASSWORD)

print("Connecting WiFi...")
while not wlan.isconnected():
    time.sleep(1)

print("WiFi Connected:", wlan.ifconfig())

# ========== NTP TIME SYNC ==========
print("Syncing time from NTP...")
ntptime.settime()   # UTC time

# ========== SPI MAX7219 ==========
spi = SPI(1, baudrate=10000000, polarity=1, phase=0,
          sck=Pin(4), mosi=Pin(2))
cs = Pin(5, Pin.OUT)

display = max7219.Matrix8x8(spi, cs, 5)  # 5 matrices
display.brightness(5)

# Colon draw function
def draw_colon(x):
    display.pixel(x, 2, 1)
    display.pixel(x, 5, 1)

# Timezone offset (India = UTC +5:30)
TZ_OFFSET = 5*3600 + 30*60  

# ========== MAIN LOOP ==========
while True:
    t = time.time() + TZ_OFFSET
    tm = time.localtime(t)

    hh = "{:02d}".format(tm[3])
    mm = "{:02d}".format(tm[4])
    ss = "{:02d}".format(tm[5])

    # SERIAL PRINT
    print("TIME:", hh, mm)

    # DISPLAY
    display.fill(0)
    display.text(hh, 0, 0, 1)
    draw_colon(18)
    draw_colon(19)
    display.text(mm, 22, 0, 1)
    display.show()

    time.sleep(1) 