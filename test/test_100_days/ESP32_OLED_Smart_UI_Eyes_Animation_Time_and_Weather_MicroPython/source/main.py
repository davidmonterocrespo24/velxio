from machine import Pin, SoftI2C
import ssd1306
from time import sleep, localtime, time
import network, ntptime
import urequests as requests
import urandom as random 

# ================= CONFIG =================
SSID = "ssid"
PASSWORD = "pass"
# IST Offset: 5 hours 30 mins = (5*3600 + 30*60) = 19800 seconds
UTC_OFFSET = 19800  
OWM_API_KEY = "key"
CITY = "city"

# ================= HARDWARE =================
i2c = SoftI2C(scl=Pin(22), sda=Pin(21))
oled = ssd1306.SSD1306_I2C(128, 64, i2c)

touch_next = Pin(14, Pin.IN) 
touch_sel  = Pin(27, Pin.IN) 

# ================= UTILS =================
def wifi_connect():
    wlan = network.WLAN(network.STA_IF)
    wlan.active(True)
    if not wlan.isconnected():
        wlan.connect(SSID, PASSWORD)
        for _ in range(20):
            if wlan.isconnected(): break
            sleep(0.5)

def sync_time():
    try:
       
        ntptime.host = "pool.ntp.org" 
        ntptime.settime()
        print("Time Synced!")
        return True
    except:
        print("Sync Failed")
        return False

def get_local_time():
    
    return localtime(time() + UTC_OFFSET)

def wait_for_release(pin):
    while pin.value():
        sleep(0.05)

def pressed(pin):
    if pin.value():
        sleep(0.1) 
        wait_for_release(pin)
        return True
    return False

# ================= EYE SYSTEM  =================
def draw_eye(x, y, state=2, look=0):
    w, h = 24, 16
    if state == 0: # Closed
        oled.fill_rect(x, y + (h//2), w, 2, 1)
    elif state == 1: # Half-open
        oled.rect(x, y + (h//4), w, h//2, 1)
        oled.fill_rect(x + 8 + look, y + (h//4) + 2, 8, 4, 1)
    elif state == 2: # Fully Open
        oled.rect(x, y, w, h, 1)
        oled.fill_rect(x + 6 + look, y + 4, 10, 8, 1)

def animate_eyes_step():
    dirs = [-4, 0, 4]
    look_dir = dirs[random.getrandbits(8) % 3]
    for _ in range(30): 
        oled.fill(0)
        draw_eye(25, 22, state=2, look=look_dir)
        draw_eye(78, 22, state=2, look=look_dir)
        oled.show()
        if touch_sel.value():
            wait_for_release(touch_sel)
            return True 
        sleep(0.1)
    for p in [1, 0, 1]:
        oled.fill(0)
        draw_eye(25, 22, state=p, look=look_dir)
        draw_eye(78, 22, state=p, look=look_dir)
        oled.show()
        sleep(0.05)
    return False

# ================= SCREENS =================
def show_time_screen():
    while True:
        t = get_local_time()
        oled.fill(0)
        oled.text("TIME (IST)", 30, 0)
        # Time format: HH:MM:SS
        oled.text("{:02d}:{:02d}:{:02d}".format(t[3], t[4], t[5]), 30, 25)
        # Date format: DD/MM/YYYY
        oled.text("{:02d}/{:02d}/{}".format(t[2], t[1], t[0]), 22, 40)
        oled.text("Nxt:Sync,Sel:Ext", 0, 55)
        oled.show()
        
        if touch_next.value():
            sync_time()
            wait_for_release(touch_next)
        if pressed(touch_sel): 
            break

def show_weather_screen():
    oled.fill(0)
    oled.text("Loading...", 30, 25)
    oled.show()
    try:
        url = "http://api.openweathermap.org/data/2.5/weather?q={}&appid={}&units=metric".format(CITY, OWM_API_KEY)
        res = requests.get(url).json()
        temp, hum = res['main']['temp'], res['main']['humidity']
        desc = res['weather'][0]['main']
        while True:
            oled.fill(0)
            oled.text("WEATHER: " + CITY, 0, 0)
            oled.text("Temp: {}C".format(temp), 10, 20)
            oled.text("Hum:  {}%".format(hum), 10, 35)
            oled.text("Cond: " + desc, 10, 50)
            oled.show()
            if pressed(touch_sel): break
    except:
        oled.fill(0)
        oled.text("API Error", 30, 25)
        oled.show()
        sleep(2)

# ================= MAIN =================
WELCOME, EYES, MENU, TIME_S, WEATHER = range(5)
state = WELCOME
menu = ["TIME", "WEATHER", "BACK"]
menu_index = 0

wifi_connect()
sync_time()

while True:
    if state == WELCOME:
        oled.fill(0)
        oled.text("Welcome Kritish", 5, 25)
        oled.show()
        sleep(2)
        state = EYES

    elif state == EYES:
        if animate_eyes_step():
            state = MENU

    elif state == MENU:
        oled.fill(0)
        oled.text("-- MENU --", 30, 0)
        for i, item in enumerate(menu):
            marker = ">" if i == menu_index else " "
            oled.text("{} {}".format(marker, item), 10, 20 + i*12)
        oled.show()

        if pressed(touch_next):
            menu_index = (menu_index + 1) % len(menu)
        if pressed(touch_sel):
            choice = menu[menu_index]
            if choice == "TIME": state = TIME_S
            elif choice == "WEATHER": state = WEATHER
            else: state = EYES

    elif state == TIME_S:
        show_time_screen()
        state = MENU

    elif state == WEATHER:
        show_weather_screen()
        state = MENU
