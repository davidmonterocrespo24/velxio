import network
import time

ap=network.WLAN(network.AP_IF)

ap.active(True)
ap.config(essid="ESP32_HOTSPOT", password="@Kritish", authmode=network.AUTH_WPA_WPA2_PSK)

while not ap.active():
    time.sleep(1)
    
print("✅ ESP32 Hotspot Started")
print("📶 SSID: ESP32_HOTSPOT")
print("🌐 IP Address:", ap.ifconfig()[0])
