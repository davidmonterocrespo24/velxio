import network
import ntptime
import urequests
import ssd1306
import utime
from machine import Pin, SoftI2C

last_weather_time = 0
weather_temp = 0

i2c = SoftI2C(sda=Pin(5), scl=Pin(6), freq=100000)
oled=ssd1306.SSD1306_I2C(128, 64, i2c)

ssid="ssid"
password="pass"
API_KEY = "8ac1a66e4d9097"



def connect_wifi():
    wlan=network.WLAN(network.STA_IF)
    wlan.active(True)
    wlan.connect(ssid, password)
    
    oled.fill(0)
    oled.text("Connecting...", 0, 20, 1)
    oled.show()
    
    while not wlan.isconnected():
        utime.sleep(1)
    oled.fill(0)
    oled.text("Wifi ok!", 20, 20, 1)
    oled.text(wlan.ifconfig()[0], 0, 35, 1)
    oled.show()
    utime.sleep(2)
def show_greeting():
    oled.fill(0)
    oled.text("Hi Kritish!", 20, 28, 1)
    oled.show()
    utime.sleep(2)
def sync_time():
    try:
        ntptime.settime()
    except:
        pass
def get_time():
    IST=5*3600+30*60
    return utime.localtime(utime.time()+IST)
def show_time():
    lt=get_time()
    
    h= "{:02d}".format(lt[3])
    m="{:02d}".format(lt[4])
    day="{:02d}".format(lt[2])
    month="{:02d}".format(lt[1])
    yr="{:02d}".format(lt[0])
    
    
    
    oled.fill(0)
    oled.hline(0, 0, 128, 1)   # top line
    oled.hline(0, 63, 128, 1)  # bottom line
    oled.text(h+":"+m,30, 20, 1)
    oled.text(day+"/"+month+"/"+yr, 20, 35, 1)
    global last_weather_time, weather_temp
    if utime.time() - last_weather_time >= 600:
        weather_temp = get_weather()
        last_weather_time = utime.time()
    oled.text(str(int(weather_temp))+" Cel", 45, 50, 1)
    oled.show()

def get_weather():
    url = "http://api.openweathermap.org/data/2.5/weather?q=Bhubaneswar,IN&appid={}&units=metric".format(API_KEY)
    r = urequests.get(url)
    data = r.json()
    r.close()
    temp = data["main"]["temp"]
    return temp
def show_logo():
    oled.fill(0)
    oled.fill_rect(0, 0, 32, 32, 1)
    oled.fill_rect(2, 2, 28, 28, 0)
    oled.vline(9, 8, 22, 1)
    oled.vline(16, 2, 22, 1)
    oled.vline(23, 8, 22, 1)
    oled.fill_rect(26, 24, 2, 4, 1)
    oled.text('MicroPython', 40, 0, 1)
    oled.text('Clock', 40, 12, 1)
    oled.text('By Kritish', 40, 24, 1)
    oled.show()
    utime.sleep(2)
connect_wifi()
show_greeting()
show_logo()
sync_time()
while True:
    show_time()
    utime.sleep(1)

