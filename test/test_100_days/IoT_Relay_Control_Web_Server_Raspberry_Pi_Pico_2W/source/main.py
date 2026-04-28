import network
import socket
import machine
import time

# -------- Relay Setup --------
relay = machine.Pin(2, machine.Pin.OUT)   # GP2 (active LOW)
relay_state = 1   # 1 = OFF, 0 = ON
relay.value(relay_state)

# -------- WiFi --------
ssid = "ssid"
password = "pass"

wlan = network.WLAN(network.STA_IF)
wlan.active(True)
wlan.connect(ssid, password)

print("Connecting...")
while not wlan.isconnected():
    time.sleep(0.5)

ip = wlan.ifconfig()[0]
print("Connected at:", ip)

# -------- Web Page --------
def webpage(state):
    checked = "checked" if state == 0 else ""
    status = "ON" if state == 0 else "OFF"

    return """
<!DOCTYPE html>
<html>
<head>
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Relay Switch</title>

<style>
body {
    background:#111;
    color:white;
    font-family:Arial;
    text-align:center;
    margin-top:60px;
}
.switch {
  position: relative;
  display: inline-block;
  width: 80px;
  height: 40px;
}
.switch input {
  opacity: 0;
  width: 0;
  height: 0;
}
.slider {
  position: absolute;
  cursor: pointer;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background-color: red;
  transition: .2s;
  border-radius: 40px;
}
.slider:before {
  position: absolute;
  content: "";
  height: 32px;
  width: 32px;
  left: 4px;
  bottom: 4px;
  background-color: white;
  transition: .2s;
  border-radius: 50%;
}
input:checked + .slider {
  background-color: green;
}
input:checked + .slider:before {
  transform: translateX(40px);
}
</style>

<script>
function send(cmd, state){
  fetch(cmd);
  document.getElementById("status").innerHTML = state;
  history.pushState({}, "", cmd);
}
</script>
</head>

<body>
<h1>IOT RELAY WEB SWITCH</h1>
<h2>Status: <span id="status">""" + status + """</span></h2>

<label class="switch">
  <input type="checkbox" """ + checked + """
    onchange="
      if(this.checked){
        send('/on','ON');
      } else {
        send('/off','OFF');
      }
    ">
  <span class="slider"></span>
</label>

</body>
</html>
"""

# -------- Socket --------
s = socket.socket()
s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind((ip, 80))
s.listen(1)

print("Open browser: http://" + ip)

# -------- Main Loop --------
while True:
    conn, addr = s.accept()
    request = conn.recv(1024)
    request = str(request)

    if "/on" in request:
        relay_state = 0
        relay.value(relay_state)

    elif "/off" in request:
        relay_state = 1
        relay.value(relay_state)

    conn.send("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n\r\n")
    conn.sendall(webpage(relay_state))
    conn.close()

