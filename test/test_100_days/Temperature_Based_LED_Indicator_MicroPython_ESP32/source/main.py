import network
import socket
from machine import Pin, PWM
from time import sleep_ms

# -------- WiFi --------
ssid = "kritish"
password = "pass"

wlan = network.WLAN(network.STA_IF)
wlan.active(True)
wlan.connect(ssid, password)

while not wlan.isconnected():
    pass

print("Open:", wlan.ifconfig()[0])

# -------- Motor --------
ENA = PWM(Pin(13), freq=1000)
IN1 = Pin(12, Pin.OUT)
IN2 = Pin(14, Pin.OUT)

IN1.on()
IN2.off()
ENA.duty(0)

def set_motor(speed):
    speed = int(speed)

    if speed <= 0:
        ENA.duty(0)
        return

    # kick start for 6V + L298N
    ENA.duty(1023)
    sleep_ms(150)
    ENA.duty(speed)

# -------- HTML --------
html = """<!DOCTYPE html>
<html>
<body>
<h2>ESP32 DC Motor Control</h2>
<input type="range" min="0" max="1023" value="0"
oninput="send(this.value)">
<p>Speed: <span id="v">0</span></p>

<script>
function send(val){
 document.getElementById("v").innerHTML = val;
 fetch("/set?speed=" + val);
}
</script>
</body>
</html>
"""

# -------- Server --------
addr = socket.getaddrinfo('0.0.0.0', 80)[0][-1]
s = socket.socket()
s.bind(addr)
s.listen(1)

print("Server running")

while True:
    cl, addr = s.accept()
    req = cl.recv(1024).decode()

    if "/set?speed=" in req:
        try:
            part = req.split("/set?speed=")[1]
            spd = part.split(" ")[0]
            set_motor(spd)
            print("Speed set:", spd)
        except:
            pass

        cl.send("HTTP/1.1 200 OK\r\n\r\nOK")
        cl.close()
        continue

    cl.send("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n\r\n")
    cl.send(html)
    cl.close()

