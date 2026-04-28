import network
import urequests
import machine
import time
import ujson

# -------- WiFi --------
SSID = "ssid"
PASSWORD = "@pass"

wifi = network.WLAN(network.STA_IF)
wifi.active(True)
wifi.connect(SSID, PASSWORD)

print("Connecting to WiFi...")
while not wifi.isconnected():
    time.sleep(1)

print("WiFi Connected ✅")
print(wifi.ifconfig())

# -------- Telegram --------
BOT_TOKEN = "bottoken"
CHAT_ID = -12457   # int ONLY

def send_telegram(msg):
    msg = msg.replace(" ", "%20").replace("\n", "%0A")
    url = (
        "https://api.telegram.org/bot"
        + BOT_TOKEN
        + "/sendMessage?chat_id="
        + str(CHAT_ID)
        + "&text="
        + msg
    )
    r = urequests.get(url)
    print("Telegram response:", r.text)
    r.close()

# -------- IR Sensor --------
ir = machine.Pin(27, machine.Pin.IN)

print("System Ready 🚀")

last_alert = 0
ALERT_DELAY = 10

while True:
    if ir.value() == 0:
        if time.time() - last_alert > ALERT_DELAY:
            print("🚨 Object Detected!")
            send_telegram("🚨 IR ALERT!\nObject detected near ESP32")
            last_alert = time.time()
        time.sleep(1)

