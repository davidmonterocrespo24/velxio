import network
import urequests
import time
from machine import Pin, ADC, I2C
import dht
import ssd1306

# ================= WIFI =================
SSID = "kritish"
PASSWORD = "@Kpass"
SERVER_URL = "http://ip:5000/predict"

wifi = network.WLAN(network.STA_IF)
wifi.active(True)
wifi.connect(SSID, PASSWORD)

while not wifi.isconnected():
    time.sleep(1)

print("WiFi Connected:", wifi.ifconfig())

# ================= OLED =================
i2c = I2C(0, scl=Pin(22), sda=Pin(21))
oled = ssd1306.SSD1306_I2C(128, 64, i2c)

# ================= DHT11 =================
dht_sensor = dht.DHT11(Pin(27))
last_temp = 0
last_hum = 0

# ================= SENSORS =================
mq135 = ADC(Pin(34))   # NO / NOx (estimated)
mq7   = ADC(Pin(33))   # CO
pm_adc = ADC(Pin(35))
pm_led = Pin(4, Pin.OUT)

for adc in [mq135, mq7, pm_adc]:
    adc.atten(ADC.ATTN_11DB)
    adc.width(ADC.WIDTH_12BIT)

# ================= FUNCTIONS =================
def read_avg(adc, n=10):
    return sum(adc.read() for _ in range(n)) // n

def read_pm25():
    pm_led.off()
    time.sleep_us(280)
    val = pm_adc.read()
    time.sleep_us(40)
    pm_led.on()
    time.sleep_us(9680)
    return round(val * (3.3 / 4095), 3)

# ================= MAIN LOOP =================
print("System Initializing...")
time.sleep(5)
print("System Ready")

while True:
    # ---- DHT11 (LOCAL DISPLAY ONLY) ----
    try:
        dht_sensor.measure()
        last_temp = dht_sensor.temperature()
        last_hum = dht_sensor.humidity()
    except:
        pass  # keep last valid value

    payload = {
        "no": read_avg(mq135),
        "co": read_avg(mq7),
        "nox": read_avg(mq135),
        "pm25": read_pm25()
    }

    try:
        response = urequests.post(SERVER_URL, json=payload)
        result = response.json()
        response.close()

        aqi = round(result["predicted_aqi"], 2)
        status = result["status"]

        # ---- OLED DISPLAY ----
        oled.fill(0)
        oled.text("AQI MONITOR", 0, 0)
        oled.text("AQI: {}".format(aqi), 0, 14)
        oled.text(status, 0, 26)
        oled.text("Temp: {} C".format(last_temp), 0, 42)
        oled.text("Hum : {} %".format(last_hum), 0, 54)
        oled.show()

        print("Sent:", payload)
        print("AQI:", aqi, status)

    except Exception as e:
        print("Error:", e)

    time.sleep(5)


