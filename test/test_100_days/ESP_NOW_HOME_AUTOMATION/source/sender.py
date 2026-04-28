from machine import Pin
import network
import espnow
import time

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
#  Add Peer (Receiver MAC)
# ----------------------------
peer =b'\xd8\xbf\xc0\x0ed\xe9'   # Replace with receiver MAC
esp.add_peer(peer)

# ----------------------------
#  Button Setup (4 buttons)
# ----------------------------
buttons = [
    Pin(10, Pin.IN, Pin.PULL_UP),   # Button 1 → Relay 1
    Pin(14, Pin.IN, Pin.PULL_UP),  # Button 2 → Relay 2
    Pin(12, Pin.IN, Pin.PULL_UP),  # Button 3 → Relay 3
    Pin(13, Pin.IN, Pin.PULL_UP)   # Button 4 → Relay 4
]

# ----------------------------
#  State Variables
# ----------------------------
relay_states = [0, 0, 0, 0]        # Store state of 4 relays
last_press_times = [0, 0, 0, 0]    # Debounce timer for each button

print("Sender ready. Press any button to toggle its relay.")

# ----------------------------
#  Main Loop
# ----------------------------
while True:
    for i, button in enumerate(buttons):
        if button.value() == 0:  # Active low → pressed
            if time.ticks_diff(time.ticks_ms(), last_press_times[i]) > 300:
                # Toggle state
                relay_states[i] = 1 - relay_states[i]
                
                # Prepare message (e.g. "R1:1" or "R2:0")
                msg = f"R{i+1}:{relay_states[i]}".encode()
                print(msg)
                
                # Send via ESP-NOW
                esp.send(peer, msg)
                
                print(f"Button {i+1} pressed → Relay {i+1} {'ON' if relay_states[i] else 'OFF'}")
                
                # Update debounce
                last_press_times[i] = time.ticks_ms()
    
    time.sleep_ms(20)

