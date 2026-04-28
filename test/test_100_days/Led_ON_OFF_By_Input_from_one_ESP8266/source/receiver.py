import network        
import espnow         
from machine import Pin  

# -------------------- Wi-Fi Setup --------------------
sta = network.WLAN(network.STA_IF)  
sta.active(True)                    
sta.disconnect()                    

# -------------------- ESP-NOW Setup --------------------
esp = espnow.ESPNow()     
esp.active(True)          

# -------------------- LED Setup --------------------
led = Pin(2, Pin.OUT)     
led.value(0)              

print("Receiver ready...")  

# -------------------- Main Loop --------------------
while True:
    peer, msg = esp.recv()      
    if msg is not None:         
        try:
            val = int(msg)      
            if val == 1:        
                led.value(1)    
                print("LED ON") 
            else:               
                led.value(0)    
                print("LED OFF")
        except ValueError:      
            print("Invalid data received:", msg)  
