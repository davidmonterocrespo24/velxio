import network
import urequests
import utime
import ntptime
import time
from machine import Pin, SPI
from mfrc522 import MFRC522


WIFI_SSID     = "kritish"
WIFI_PASSWORD = "pass"
SCRIPT_URL = "https://script.google.com/macros/s/AKfycbzEilPyLNuzryfIeVIp2K2IrlPSxpdNpYiya5uHfZus6bzHESvkeIU3L2hxhgpT9QK4aQ/exec"

STUDENTS = {
    (0x9a, 0xdb, 0x8a, 0x4, 0xcf): "Student 1",
    (0x59, 0x8a, 0xd6, 0x5, 0x0):  "Student 2",
}

status_tracker = {}

spi = SPI(2, baudrate=1600000, polarity=0, phase=0,
          sck=Pin(18), mosi=Pin(23), miso=Pin(19))
reader = MFRC522(spi=spi, gpioCs=5)


led_green = Pin(2, Pin.OUT)
led_red   = Pin(0, Pin.OUT)
led_green.value(0)
led_red.value(0)

def connect_wifi():
    wlan = network.WLAN(network.STA_IF)
    wlan.active(True)
    wlan.connect(WIFI_SSID, WIFI_PASSWORD)
    print("Connecting to Wi-Fi", end="")
    while not wlan.isconnected():
        print(".", end="")
        utime.sleep(1)
    print("\nConnected:", wlan.ifconfig()[0])


def get_timestamp():
    try:
        ntptime.settime()
    except:
        pass
    IST_OFFSET = 5 * 3600 + 30 * 60
    t = time.localtime(time.time() + IST_OFFSET)
    return "{:04d}-{:02d}-{:02d} {:02d}:{:02d}:{:02d}".format(
        t[0], t[1], t[2], t[3], t[4], t[5])
def log_to_sheet(student, status):
    timestamp = get_timestamp()
    json_data = {
        "timestamp": timestamp,
        "student":   student,
        "status":    status
    }
    try:
        response = urequests.post(SCRIPT_URL, json=json_data)
        response.close()
        print("Logged ->", student, status, timestamp)
        return True
    except Exception as e:
        print("Error:", e)
        return False

def uid_to_hex(uid):
    return ":".join("{:02X}".format(b) for b in uid)

connect_wifi()

utime.sleep_ms(200)
print("Day 73 - RFID Attendance Logger")
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
            now       = utime.ticks_ms()

            if uid_tuple == last_uid and utime.ticks_diff(now, last_time) < 3000:
                continue

            last_uid  = uid_tuple
            last_time = now

            print("Card UID:", uid_to_hex(uid))

            if uid_tuple in STUDENTS:
                name = STUDENTS[uid_tuple]

                if uid_tuple not in status_tracker or status_tracker[uid_tuple] == "OUT":
                    status = "IN"
                else:
                    status = "OUT"

                status_tracker[uid_tuple] = status
                print("{} -> {}".format(name, status))

                success = log_to_sheet(name, status)

                if success:
                    led_green.value(1)
                    utime.sleep_ms(800)
                    led_green.value(0)
                else:
                    for _ in range(2):
                        led_green.value(1)
                        utime.sleep_ms(200)
                        led_green.value(0)
                        utime.sleep_ms(200)
            else:
                print("Unknown card")
                for _ in range(3):
                    led_red.value(1)
                    utime.sleep_ms(100)
                    led_red.value(0)
                    utime.sleep_ms(100)

    utime.sleep_ms(50)
