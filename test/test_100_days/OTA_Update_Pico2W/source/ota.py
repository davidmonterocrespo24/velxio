import network
import urequests
import time
import machine

# ---- FILL YOUR DETAILS HERE ----
SSID = "your_wifi_name"
PASSWORD = "your_wifi_password"
GITHUB_USER = "kritishmohapatra"
GITHUB_REPO = "pico-ota-test"
# --------------------------------

BASE_URL = f"https://raw.githubusercontent.com/{GITHUB_USER}/{GITHUB_REPO}/main/"

def connect_wifi():
    wlan = network.WLAN(network.STA_IF)
    wlan.active(True)
    if not wlan.isconnected():
        print("Connecting to WiFi...")
        wlan.connect(SSID, PASSWORD)
        timeout = 15
        while not wlan.isconnected() and timeout > 0:
            time.sleep(1)
            timeout -= 1
    if wlan.isconnected():
        print("WiFi connected! IP:", wlan.ifconfig()[0])
        return True
    print("WiFi connection failed!")
    return False

def get_local_version():
    try:
        with open("local_version.txt", "r") as f:
            return f.read().strip()
    except:
        return "0.0.0"

def get_remote_version():
    try:
        r = urequests.get(BASE_URL + "version.txt")
        v = r.text.strip()
        r.close()
        return v
    except Exception as e:
        print("Version check failed:", e)
        return None

def check_and_update():
    if not connect_wifi():
        return

    remote = get_remote_version()
    local = get_local_version()

    print(f"Local version:  {local}")
    print(f"Remote version: {remote}")

    if remote and remote != local:
        print("New update found! Downloading...")
        try:
            r = urequests.get(BASE_URL + "main.py")
            with open("main.py", "w") as f:
                f.write(r.text)
            r.close()
            with open("local_version.txt", "w") as f:
                f.write(remote)
            print("Update done! Restarting...")
            time.sleep(2)
            machine.reset()
        except Exception as e:
            print("Update failed:", e)
    else:
        print("Already on latest version!")