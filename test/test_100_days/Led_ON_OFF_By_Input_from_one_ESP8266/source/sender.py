from machine import Pin      
import network               
import espnow                
# -------------------- Wi-Fi Setup --------------------
sta = network.WLAN(network.STA_IF)  
sta.active(True)                    
sta.disconnect()                    

# -------------------- ESP-NOW Setup --------------------
esp = espnow.ESPNow()        
esp.active(True)            
# -------------------- Peer (Receiver) Setup --------------------
peer = b'\xd8\xbf\xc0\xed\xe9'  
esp.add_peer(peer)               

# -------------------- Main Loop --------------------
while True:
    try:
        
        val = int(input("Enter 1 to ON, 0 to OFF: "))
        
        
        msg = str(val).encode()
        
        
        esp.send(peer, msg)
        
        
        if val == 1:
            print("LED ON command sent")
        else:
            print("LED OFF command sent")
    
    except ValueError:
        
        print("Please enter only 1 or 0")
