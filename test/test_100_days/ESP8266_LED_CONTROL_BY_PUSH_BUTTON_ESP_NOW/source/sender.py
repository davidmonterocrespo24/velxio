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
peer = b'\xd8\xf\xc\x0ed\xe9'      
esp.add_peer(peer)                   

# ----------------------------
#  Button Setup
# ----------------------------

button = Pin(5, Pin.IN, Pin.PULL_UP)

# ----------------------------
#  State Variables
# ----------------------------
led_state = 0                        
last_press_time = 0                  

print("Sender ready. Press the button to toggle LED.")

# ----------------------------
#  Main Loop
# ----------------------------
while True:
    if button.value() == 0:          
        
        if time.ticks_diff(time.ticks_ms(), last_press_time) > 300:
            led_state = 1 - led_state   

            
            msg = str(led_state).encode()

            
            esp.send(peer, msg)

            
            print("Sent:", "LED ON" if led_state else "LED OFF")

            
            last_press_time = time.ticks_ms()

    
    time.sleep_ms(20)

