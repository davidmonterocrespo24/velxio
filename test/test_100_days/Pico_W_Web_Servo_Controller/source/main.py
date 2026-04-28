import network
import socket
from machine import Pin, PWM
import time

# Import credentials from the separate secrets file
ssid = "kritish"
password = "password"

# ====== WiFi Setup ======
print("Connecting to WiFi...")
sta = network.WLAN(network.STA_IF)
sta.active(True)

# Attempt to connect to the network
try:
    sta.connect(ssid, password)
except Exception as e:
    print(f"Connection error: {e}")

timeout_counter = 0
while not sta.isconnected() and timeout_counter < 20: # Timeout after ~10 seconds
    time.sleep(0.5)
    print(".", end="")
    timeout_counter += 1

if sta.isconnected():
    print("\nConnected!")
    print("IP address:", sta.ifconfig()[0])
else:
    print("\nConnection failed! Check credentials and signal.")
    raise OSError("WiFi connection failed.")


# ====== Servo Setup (Pico W Specific) ======
SERVO_PIN = 15 # Ensure the servo is connected to GP15.
servo = PWM(Pin(SERVO_PIN), freq=50)

SERVO_FREQ = 50 
SERVO_MIN_US = 500   # 0 degrees (0.5ms pulse width)
SERVO_MAX_US = 2500  # 180 degrees (2.5ms pulse width)
TOTAL_PERIOD_US = 1000000 / SERVO_FREQ # 20000 us (20ms)
DUTY_SCALE = 65535 # Max value for Pico's duty_u16 method

def write_servo(angle):
    """Sets the servo angle (0-180 degrees) by calculating the PWM duty_u16."""
    angle = max(0, min(180, angle)) 
    pulse_us = SERVO_MIN_US + (SERVO_MAX_US - SERVO_MIN_US) * (angle / 180)
    duty = int((pulse_us / TOTAL_PERIOD_US) * DUTY_SCALE)
    servo.duty_u16(duty)


# ====== HTML Page (Vibrant Redesign) ======
def webpage(pos):
    """Generates the HTML page with a vibrant design and current servo position."""
    html = f"""
    <!DOCTYPE html>
    <html>
    <head>
    <title>Pico W Servo</title>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;600;700&display=swap" rel="stylesheet">
    <style>
        :root {{
            --primary-color: #6a0dad; /* Deep Purple */
            --secondary-color: #ff6f61; /* Coral Red */
            --accent-color: #ffda03; /* Bright Yellow */
            --bg-light: #f0f8ff; /* Alice Blue */
            --text-dark: #2c3e50; /* Dark Grey Blue */
        }}

        body {{
            margin: 0;
            font-family: 'Poppins', sans-serif;
            background: linear-gradient(45deg, var(--bg-light) 0%, var(--primary-color) 100%);
            color: var(--text-dark);
            display: flex;
            justify-content: center;
            align-items: center;
            min-height: 100vh;
            overflow: hidden;
        }}

        .container {{
            background: rgba(255, 255, 255, 0.9);
            border-radius: 15px;
            padding: 40px;
            box-shadow: 0 10px 30px rgba(0, 0, 0, 0.2);
            text-align: center;
            max-width: 400px;
            width: 90%;
            backdrop-filter: blur(5px);
            -webkit-backdrop-filter: blur(5px);
        }}

        h1 {{
            color: var(--primary-color);
            margin-bottom: 10px;
            font-size: 2em;
            font-weight: 700;
        }}

        p {{
            font-size: 1.1em;
            margin-bottom: 25px;
            color: var(--text-dark);
        }}

        strong#servoVal {{
            font-size: 1.8em;
            color: var(--secondary-color);
            display: block;
            margin-top: 10px;
            font-weight: 600;
        }}

        .slider {{
            -webkit-appearance: none;
            width: 100%;
            height: 15px;
            background: linear-gradient(to right, var(--accent-color), var(--secondary-color));
            border-radius: 8px;
            outline: none;
            opacity: 0.8;
            transition: opacity .2s ease-in-out;
            margin-top: 20px;
            margin-bottom: 30px;
        }}

        .slider:hover {{
            opacity: 1;
        }}

        /* Slider Thumb Styling */
        .slider::-webkit-slider-thumb {{
            -webkit-appearance: none;
            appearance: none;
            width: 25px;
            height: 25px;
            border-radius: 50%;
            background: var(--primary-color);
            cursor: grab;
            box-shadow: 0 2px 5px rgba(0, 0, 0, 0.2);
            border: 2px solid var(--bg-light);
        }}

        .slider::-moz-range-thumb {{
            width: 25px;
            height: 25px;
            border-radius: 50%;
            background: var(--primary-color);
            cursor: grab;
            box-shadow: 0 2px 5px rgba(0, 0, 0, 0.2);
            border: 2px solid var(--bg-light);
        }}

        .info-text {{
            font-size: 0.9em;
            color: #7f8c8d; /* Grey */
            margin-top: 20px;
        }}
    </style>
    </head>
    <body>
        <div class="container">
            <h1>Servo Control</h1>
            <p>Current Angle:</p>
            <strong id="servoVal">{pos}&deg;</strong>

            <input type="range" min="0" max="180" value="{pos}" class="slider"
            id="servoSlider" oninput="update(this.value)"
            onchange="send(this.value)">

            <p class="info-text">Move and release the slider to update the servo position.</p>
        </div>

        <script>
            function update(val) {{
                document.getElementById("servoVal").innerHTML = val + '&deg;';
            }}

            function send(val) {{
                fetch('/?value=' + val)
                    .then(response => {{
                        if (response.ok) {{
                            console.log("Command sent successfully:", val);
                        }} else {{
                            console.error("Failed to send command:", response.status);
                        }}
                    }})
                    .catch(error => {{
                        console.error("Network error:", error);
                    }});
            }}
        </script>

    </body>
    </html>
    """
    return html


# ====== Web Server ======
s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(('', 80))
s.listen(5)

current_pos = 90
write_servo(current_pos)

print("Web server started on port 80...")

while True:
    try:
        conn, addr = s.accept()
        print("Client connected from:", addr)

        request = conn.recv(1024).decode('utf-8')
        request_line = request.split('\n')[0] 
        print("Request line:", request_line)

        if "GET /?value=" in request_line:
            try:
                value_str = request_line.split("/?value=")[1].split(" ")[0]
                new_pos = int(value_str)

                if 0 <= new_pos <= 180:
                    current_pos = new_pos
                    write_servo(current_pos)
                    print(f"Servo angle updated to: {current_pos}°")
                else:
                    print(f"Error: Angle {new_pos} is out of the 0-180° range.")
            
            except (ValueError, IndexError):
                print("Error: Invalid angle value or malformed URL in request.")
        
        response = webpage(current_pos)

        conn.send('HTTP/1.1 200 OK\r\n')
        conn.send('Content-Type: text/html\r\n')
        conn.send('Connection: close\r\n\r\n')
        conn.sendall(response.encode('utf-8'))
        conn.close()
        
    except OSError as e:
        print(f"Socket error: {e}")
        conn.close()
    except Exception as e:
        print(f"An unexpected error occurred in main loop: {e}")
