from machine import Pin
import network
import ntptime
import tm1637
import time

# ===== TM1637 Setup =====
tm = tm1637.TM1637(clk=Pin(5), dio=Pin(4))
tm.brightness(7)

# ===== Custom Segment Map =====
digits = [
    0x3f, # 0
    0x06, # 1
    0x5b, # 2
    0x4f, # 3
    0x66, # 4
    0x6d, # 5
    0x7d, # 6
    0x07, # 7
    0x7f, # 8
    0x6f  # 9
]

def show_time(h, m, colon):
    seg = [
        digits[h // 10],
        digits[h % 10] | (0x80 if colon else 0x00),  # colon bit
        digits[m // 10],
        digits[m % 10]
    ]
    tm.write(seg)

# ===== WiFi Setup =====

SSID = "ssid"
PASSWORD = "pass"

wlan = network.WLAN(network.STA_IF)
wlan.active(True)
wlan.connect(SSID, PASSWORD)

while not wlan.isconnected():
    time.sleep(0.5)

# ===== NTP Sync (once) =====
try:
    ntptime.settime()   # UTC
except:
    pass

IST = 19800
colon = True

print("NTP Clock Started")

# ===== Main Loop =====
while True:
    t = time.localtime(time.time() + IST)
    h = t[3]
    m = t[4]

    show_time(h, m, colon)
    colon = not colon

    time.sleep(1)

