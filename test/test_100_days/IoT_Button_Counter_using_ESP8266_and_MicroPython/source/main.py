import machine
import network
import time
import socket

# --- Configuration ---
SSID = 'kritish'
PASSWORD = '@' 
HOST_PORT = 80

# --- Hardware Setup (ESP8266 Pinout) ---
btn_inc = machine.Pin(14, machine.Pin.IN, machine.Pin.PULL_UP) # Increment Button
btn_dec = machine.Pin(12, machine.Pin.IN, machine.Pin.PULL_UP) # Decrement Button
btn_rst = machine.Pin(5, machine.Pin.IN, machine.Pin.PULL_UP)  # Reset Button

# --- Global Variables ---
counter = 0

# --- WiFi Connection ---
def connect_wifi(ssid, password):
    station = network.WLAN(network.STA_IF)
    station.active(True)
    if not station.isconnected():
        print("Connecting to WiFi...", end="")
        station.connect(ssid, password)
        max_wait = 20
        while max_wait > 0 and not station.isconnected():
            print(".", end="")
            time.sleep(0.5)
            max_wait -= 1
    
    if station.isconnected():
        ip_info = station.ifconfig()
        print("\nConnected! IP:", ip_info[0])
        return ip_info[0]
    else:
        print("\nCould not connect to WiFi.")
        return None

# --- Web Page Function (Sends the HTML and the JavaScript) ---
def web_page():
    # NO <meta refresh> TAG! The update is handled by the JavaScript below.
    html = """\
HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n\r\n
<!DOCTYPE html>
<html>
<head>
<title>ESP8266 Dynamic Counter</title>
<style>
    body { background-color:#111; color:#00ffaa; text-align:center; font-family:Arial, sans-serif; }
    h1 { font-size: 2.5em; }
    .value { font-size:60px; font-weight: bold; }
    .hint { color: #777; margin-top: 20px; }
</style>
<script>
    // AJAX Function to dynamically update the counter
    function updateCounter() {
        var xhr = new XMLHttpRequest();
        xhr.onreadystatechange = function() {
            if (this.readyState == 4 && this.status == 200) {
                // Update the counter display with the received plain text
                document.getElementById("counter-display").innerHTML = this.responseText;
            }
        };
        // Request the raw count data from the /count URL
        xhr.open("GET", "/count", true);
        xhr.send();
    }
    // Call the updateCounter function every 500 milliseconds (0.5 seconds)
    // This provides a smooth update when a button is pressed.
    setInterval(updateCounter, 500); 
</script>
</head>
<body>
<h1>IoT Button Counter</h1>
<h2>Current Count:</h2>
<div class="value" id="counter-display">...loading...</div>
<p class="hint">Updates automatically every 0.5s when buttons change the value.</p>
<hr>
<p>Increment: Pin 14 | Decrement: Pin 12 | Reset: Pin 5</p>
</body>
</html>
"""
    return html

# --- Main Program Execution ---

# 1. Connect to WiFi
ip_address = connect_wifi(SSID, PASSWORD)
if ip_address is None:
    machine.reset() 

# 2. Server Setup
s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
s.bind(('', HOST_PORT))
s.listen(1)
# Set the socket to NON-BLOCKING mode for continuous button checking
s.setblocking(False) 
print("Web Server running at: http://{}:{}".format(ip_address, HOST_PORT))

# --- Main Loop ---
last_inc = last_dec = last_rst = 1 

print("\n--- Starting Counter Loop ---")
while True:
    
    # 1. Button Handling (Prioritized)
    inc = btn_inc.value()
    dec = btn_dec.value()
    rst = btn_rst.value()

    # Debouncing Logic
    if inc == 0 and last_inc == 1:
        counter += 1
        print("Increment →", counter)
    if dec == 0 and last_dec == 1:
        counter -= 1
        print("Decrement →", counter)
    if rst == 0 and last_rst == 1:
        counter = 0
        print("Reset →", counter)

    last_inc, last_dec, last_rst = inc, dec, rst

    # 2. Web Handling (Non-Blocking)
    try:
        conn, addr = s.accept() 
        
        # If a connection is accepted:
        conn.settimeout(0.5) 
        request = conn.recv(1024).decode('utf-8')
        
        # Determine the response based on the requested URL
        if "/count" in request:
            # If the browser asked for the count via AJAX, send ONLY the number
            response = "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\n" + str(counter)
        else:
            # Otherwise, send the full HTML page (initial load)
            response = web_page() 
            
        conn.sendall(response.encode('utf-8'))
        conn.close()
        
    except OSError as e:
        # Ignore Error 11 (no client ready), but print other socket errors
        if e.args[0] != 11:
            print("Socket Error:", e)
        
    # Introduce a small pause for stability
    time.sleep_ms(50)
