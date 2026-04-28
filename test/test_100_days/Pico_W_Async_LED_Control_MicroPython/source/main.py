import uasyncio as asyncio
import network
from machine import Pin

SSID = "kritish"
PASSWORD = "pass"

led = Pin("LED", Pin.OUT)
led.off()

# ---------- Async WiFi Connect ----------
async def wifi_connect():
    wlan = network.WLAN(network.STA_IF)
    wlan.active(True)
    wlan.connect(SSID, PASSWORD)

    print("Connecting WiFi...")
    while not wlan.isconnected():
        await asyncio.sleep(0.5)

    print("IP:", wlan.ifconfig()[0])


# ---------- HTML ----------
HTML_PAGE = """<!DOCTYPE html>
<html>
<head>
<title>Pico Async LED</title>
</head>
<body>
<h2>Pico W Async LED Control</h2>
<p>Status: <span id="status">--</span></p>

<button onclick="ledOn()">ON</button>
<button onclick="ledOff()">OFF</button>

<script>
function ledOn(){
 fetch("/on").then(r=>r.text()).then(t=>{
   document.getElementById("status").innerText=t;
 });
}
function ledOff(){
 fetch("/off").then(r=>r.text()).then(t=>{
   document.getElementById("status").innerText=t;
 });
}
</script>
</body>
</html>
"""


# ---------- Client Handler ----------
async def handle_client(reader, writer):
    request_line = await reader.readline()
    request = request_line.decode()

    # skip headers
    while await reader.readline() != b"\r\n":
        pass

    print("REQ:", request)

    if "GET /on" in request:
        led.on()
        body = "ON"
        content_type = "text/plain"

    elif "GET /off" in request:
        led.off()
        body = "OFF"
        content_type = "text/plain"

    else:
        body = HTML_PAGE
        content_type = "text/html"

    response = (
        "HTTP/1.1 200 OK\r\n"
        f"Content-Type: {content_type}\r\n"
        "Connection: close\r\n\r\n"
        + body
    )

    writer.write(response.encode())
    await writer.drain()
    await writer.wait_closed()


# ---------- Main ----------
async def main():
    await wifi_connect()

    server = await asyncio.start_server(handle_client, "0.0.0.0", 80)
    print("Server running on port 80")

    while True:
        await asyncio.sleep(1)


asyncio.run(main())



