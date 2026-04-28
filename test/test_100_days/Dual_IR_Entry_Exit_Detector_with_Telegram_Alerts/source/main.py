import network
import urequests
import machine
import time

# ─── WiFi ─────────────────────────────────────────────
SSID     = "kritish"
PASSWORD = "iot"

wifi = network.WLAN(network.STA_IF)
wifi.active(True)
wifi.connect(SSID, PASSWORD)
print("Connecting to WiFi...")
while not wifi.isconnected():
    time.sleep(1)
print("WiFi Connected!")
print(wifi.ifconfig())

# ─── Telegram ─────────────────────────────────────────
BOT_TOKEN = ""
CHAT_ID   = 54  # int only, no quotes

def send_telegram(msg):
    msg_encoded = msg.replace(" ", "%20").replace("\n", "%0A")
    url = (
        "https://api.telegram.org/bot"
        + BOT_TOKEN
        + "/sendMessage?chat_id="
        + str(CHAT_ID)
        + "&text="
        + msg_encoded
    )
    try:
        r = urequests.get(url)
        print("Telegram response:", r.text[:60])
        r.close()
    except Exception as e:
        print("Telegram error:", e)

# ─── Pins ─────────────────────────────────────────────
ir_entry  = machine.Pin(14, machine.Pin.IN)   # Entry IR
ir_exit   = machine.Pin(27, machine.Pin.IN)   # Exit IR
red_led   = machine.Pin(26, machine.Pin.OUT)  # Red LED
green_led = machine.Pin(25, machine.Pin.OUT)  # Green LED

red_led.value(0)
green_led.value(0)

print("System Ready!")

# ─── Main Loop ────────────────────────────────────────
entry_triggered = False
exit_triggered  = False

while True:
    entry_val = ir_entry.value()
    exit_val  = ir_exit.value()

    # Entry IR blocked
    if entry_val == 0 and not entry_triggered:
        entry_triggered = True
        exit_triggered  = False
        red_led.value(1)    # Red ON - object inside
        green_led.value(0)
        print("Object Entered!")
        send_telegram("Object Entered!")

    # Exit IR blocked
    if exit_val == 0 and not exit_triggered and entry_triggered:
        exit_triggered  = True
        entry_triggered = False
        red_led.value(0)    # Red OFF
        green_led.value(1)  # Green ON - object gone
        print("Object Gone!")
        send_telegram("Object Gone!")
        time.sleep(2)       # Green stays for 2 sec
        green_led.value(0)

    time.sleep(0.1)
