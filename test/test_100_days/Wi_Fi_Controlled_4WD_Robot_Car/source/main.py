import network
import socket
from machine import Pin
import time

# Wi-Fi credentials
SSID = "kritish"
PASSWORD = "pass"
# Driver 1 (Front)
IN1 = Pin(27, Pin.OUT)
IN2 = Pin(26, Pin.OUT)
IN3 = Pin(25, Pin.OUT)
IN4 = Pin(33, Pin.OUT)

# Driver 2 (Rear)
IN5 = Pin(19, Pin.OUT)
IN6 = Pin(18, Pin.OUT)
IN7 = Pin(5, Pin.OUT)
IN8 = Pin(17, Pin.OUT)

def forward():
    IN1.value(1); IN2.value(0)
    IN3.value(0); IN4.value(1)
    IN5.value(1); IN6.value(0)
    IN7.value(0); IN8.value(1)

def backward():
    IN1.value(0); IN2.value(1)
    IN3.value(1); IN4.value(0)
    IN5.value(0); IN6.value(1)
    IN7.value(1); IN8.value(0)

def left():
    IN1.value(1); IN2.value(0)  
    IN3.value(1); IN4.value(0)  
    IN5.value(1); IN6.value(0)  
    IN7.value(1); IN8.value(0)  

def right():
    IN1.value(0); IN2.value(1)  
    IN3.value(0); IN4.value(1)  
    IN5.value(0); IN6.value(1)  
    IN7.value(0); IN8.value(1)  

def stop():
    IN1.value(0); IN2.value(0)
    IN3.value(0); IN4.value(0)
    IN5.value(0); IN6.value(0)
    IN7.value(0); IN8.value(0)

# Wi-Fi Connect
wifi = network.WLAN(network.STA_IF)
wifi.active(True)
wifi.connect(SSID, PASSWORD)

print("Connecting to Wi-Fi...")
while not wifi.isconnected():
    time.sleep(0.5)
    print(".")

print("Connected! IP:", wifi.ifconfig()[0])

# Web Page
def webpage():
    html = """<!DOCTYPE html>
<html>
<head>
    <title>ESP32 Car</title>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
        body { text-align: center; font-family: Arial; background: #1a1a2e; color: white; }
        h1 { color: #e94560; }
        .btn {
            display: inline-block;
            padding: 20px 30px;
            margin: 10px;
            font-size: 24px;
            background: #16213e;
            color: white;
            border: 2px solid #e94560;
            border-radius: 10px;
            cursor: pointer;
            text-decoration: none;
        }
        .btn:hover { background: #e94560; }
        .row { margin: 10px; }
    </style>
</head>
<body>
    <h1>ESP32 Car Control</h1>
    <div class="row">
        <a class="btn" href="/forward">Forward</a>
    </div>
    <div class="row">
        <a class="btn" href="/left">Left</a>
        <a class="btn" href="/stop">Stop</a>
        <a class="btn" href="/right">Right</a>
    </div>
    <div class="row">
        <a class="btn" href="/backward">Backward</a>
    </div>
</body>
</html>"""
    return html

# Web Server
server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
server.bind(('', 80))
server.listen(5)
print("Server started!")

while True:
    conn, addr = server.accept()
    request = conn.recv(1024).decode()
    
    if '/forward' in request:
        forward()
    elif '/backward' in request:
        backward()
    elif '/left' in request:
        left()
    elif '/right' in request:
        right()
    elif '/stop' in request:
        stop()
    
    conn.send('HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n\r\n')
    conn.send(webpage())
    conn.close()
