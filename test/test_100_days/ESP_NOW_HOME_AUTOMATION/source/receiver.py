import network
import espnow
from machine import Pin

# ----------------------------
#  Wi-Fi Initialization (STA Mode)
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
#  Relay Setup (4-channel)
# ----------------------------
relays = [
    Pin(10, Pin.OUT),   # Relay 1 → GPIO10
    Pin(14, Pin.OUT),   # Relay 2 → GPIO14
    Pin(12, Pin.OUT),   # Relay 3 → GPIO12
    Pin(13, Pin.OUT)   # Relay 4 → GPIO13
]

# Ensure all relays start OFF
for r in relays:
    r.value(1)


print("Receiver ready for 4-channel relay control...")

# ----------------------------
#  Main Loop (Receive Data)
# ----------------------------
while True:
    peer, msg = esp.recv()
    print(msg)
    if msg is not None:
        try:
            print(msg)
            data = msg.decode()
            print(data)# Convert bytes -> string
            if data.startswith("R") and ":" in data:
                # Extract relay number and value
                r_num = int(data[1:data.index(":")]) - 1   # Convert 1-based to 0-based index
                r_val = int(data[data.index(":")+1:])

                if 0 <= r_num < 4:
                    relays[r_num].value(not r_val)
                    print(f"Relay {r_num+1} {'ON' if r_val else 'OFF'}")
        except Exception as e:
            print("Error:", e, "Received:", msg)

