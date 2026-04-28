from machine import Pin, I2C
import network
import espnow
import time
import ssd1306

# ----------------------------
#  Wi-Fi Initialization
# ----------------------------
sta = network.WLAN(network.STA_IF)
sta.active(True)
sta.disconnect()

# ----------------------------
#  ESP-NOW Initialization
# ----------------------------
esp = espnow.ESPNow()
esp.active(True)

# ----------------------------
#  Add Peer (Receiver MAC)
# ----------------------------
peer = b'\xd8\xbf\xc0\x0ed\xe9'   # Replace with receiver MAC
esp.add_peer(peer)

# ----------------------------
#  OLED Setup (0.96 inch I2C OLED)
# ----------------------------
i2c = I2C(scl=Pin(5), sda=Pin(4))  # adjust pins for your wiring
oled = ssd1306.SSD1306_I2C(128, 64, i2c)

# ----------------------------
#  Buttons Setup
# ----------------------------
buttons = [
    Pin(10, Pin.IN, Pin.PULL_UP),   # Button 1 → Relay 1
    Pin(14, Pin.IN, Pin.PULL_UP),   # Button 2 → Relay 2
    Pin(12, Pin.IN, Pin.PULL_UP),   # Button 3 → Relay 3
    Pin(13, Pin.IN, Pin.PULL_UP)    # Button 4 → Relay 4
]

relay_states = [0, 0, 0, 0]
last_press_times = [0, 0, 0, 0]

# Variables for received sensor data
temp = 0
hum = 0

print("Sender ready. Buttons → Relay Control | OLED → DHT Data")

# ----------------------------
#  Main Loop
# ----------------------------
while True:
    # ----- Handle Button Press -----
    for i, button in enumerate(buttons):
        if button.value() == 0:  # pressed
            if time.ticks_diff(time.ticks_ms(), last_press_times[i]) > 300:
                # Toggle relay state
                relay_states[i] = 1 - relay_states[i]

                # Sirf 1 ya 0 bhejna (R1:1 or R1:0)
                msg = f"{i+1}:{relay_states[i]}".encode()
                esp.send(peer, msg)
                print("Sent:", msg)

                last_press_times[i] = time.ticks_ms()

    # ----- Handle Received Data (Temp/Hum from receiver) -----
    if esp.any():
        host, msg = esp.recv()
        try:
            msg = msg.decode()
            if msg.startswith("T:"):
                parts = msg.split(",")
                temp = int(parts[0].split(":")[1])
                hum = int(parts[1].split(":")[1])
                print(f"Received → Temp={temp}°C, Hum={hum}%")
        except:
            pass

    # ----- Update OLED -----
    oled.fill(0)
    oled.text("ESP-NOW Sender", 0, 0)
    oled.text(f"Temp: {temp} C", 0, 20)
    oled.text(f"Hum : {hum} %", 0, 35)

   
    oled.show()

    time.sleep_ms(100)

