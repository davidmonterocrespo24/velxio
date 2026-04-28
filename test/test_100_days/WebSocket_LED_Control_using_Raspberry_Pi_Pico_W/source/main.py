import socket
import network
import time
from machine import Pin
import ubinascii
import uhashlib

# LED Setup
led = Pin(15, Pin.OUT)
led.value(0)

# WiFi Configuration
SSID = "kritish"
PASSWORD = "pass"

def websocket_accept(key):
    GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
    sha1 = uhashlib.sha1((key + GUID).encode()).digest()
    return ubinascii.b2a_base64(sha1).strip().decode()

def ws_decode(data):
    if len(data) < 6: return ""
    payload_len = data[1] & 127
    mask = data[2:6]
    payload = data[6:6 + payload_len]
    decoded = bytearray()
    for i in range(len(payload)):
        decoded.append(payload[i] ^ mask[i % 4])
    return decoded.decode()

# Connect to WiFi
wlan = network.WLAN(network.STA_IF)
wlan.active(True)
wlan.connect(SSID, PASSWORD)

print("Connecting to WiFi...")
while not wlan.isconnected():
    time.sleep(1)
print("Connected! Pico IP:", wlan.ifconfig()[0])

# Start Server
server = socket.socket()
server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
server.bind(("0.0.0.0", 80))
server.listen(1)

while True:
    print("\n--- Waiting for fresh connection ---")
    conn, addr = server.accept()
    print("New client from:", addr)
    
    try:
        # 1. Handle Handshake
        raw_request = conn.recv(1024).decode()
        if "Sec-WebSocket-Key" in raw_request:
            ws_key = raw_request.split("Sec-WebSocket-Key: ")[1].split("\r\n")[0].strip()
            accept_key = websocket_accept(ws_key)
            
            handshake = (
                "HTTP/1.1 101 Switching Protocols\r\n"
                "Upgrade: websocket\r\n"
                "Connection: Upgrade\r\n"
                f"Sec-WebSocket-Accept: {accept_key}\r\n\r\n"
            )
            conn.send(handshake)
            print("Handshake Success!")

            # 2. Communication Loop
            while True:
                data = conn.recv(1024)
                if not data:
                    print("Client disconnected.")
                    break
                
                msg = ws_decode(data)
                print("Cmd:", msg)

                if msg == "ON":
                    led.value(1)
                    reply = "LED IS ON"
                elif msg == "OFF":
                    led.value(0)
                    reply = "LED IS OFF"
                else:
                    reply = "OK"

                # Send response frame
                frame = bytearray([0x81, len(reply)]) + reply.encode()
                conn.send(frame)
        else:
            print("Not a WebSocket request.")
            
    except Exception as e:
        print("Error during session:", e)
    finally:
        conn.close()
        print("Connection closed. Ready for next.")
