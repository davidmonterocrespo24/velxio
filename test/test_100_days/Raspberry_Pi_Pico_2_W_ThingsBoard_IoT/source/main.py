import network
import time
import json
import dht
from machine import Pin
from umqttsimple import MQTTClient

# --- Configuration ---
WIFI_SSID = "kritish"  #
WIFI_PASSWORD = "@pass"
THINGSBOARD_HOST = "eu.thingsboard.cloud"
ACCESS_TOKEN = "tokenn" 

# --- Hardware Setup ---
# Using "LED" for Pico W onboard LED, or Pin(15) for an external LED
led = Pin("LED", Pin.OUT) 
sensor = dht.DHT11(Pin(4)) 
led_state = False

# --- MQTT Callback (Handles Switch Commands) ---
def on_message(topic, msg):
    global led_state
    print(f"\n[RPC] Message received: {msg}")
    
    try:
        data = json.loads(msg)
        method = data.get("method")
        params = data.get("params")

        # Handling 'setState' from your ThingsBoard Switch
        if method == "setState":
            # This check ensures both boolean and string 'true' work
            if params is True or params == "true" or params == 1:
                led_state = True
                led.value(1)
            else:
                led_state = False
                led.value(0)
            
            print(f"Action: LED is now {'ON' if led_state else 'OFF'}")
            
        # Handling 'getState' to sync the dashboard switch
        elif method == "getState":
            request_id = topic.decode().split('/')[-1]
            client.publish(f"v1/devices/me/rpc/response/{request_id}", json.dumps(led_state))
            print("Action: Synced state with Dashboard")

    except Exception as e:
        print(f"RPC Error: {e}")

# --- Connection Functions ---
def connect_wifi():
    sta_if = network.WLAN(network.STA_IF)
    sta_if.active(True)
    sta_if.connect(WIFI_SSID, WIFI_PASSWORD)
    print("Connecting to WiFi", end="")
    while not sta_if.isconnected():
        print(".", end="")
        time.sleep(0.5)
    print(f"\nConnected! IP: {sta_if.ifconfig()[0]}")

def connect_mqtt():
    client = MQTTClient("Pico_W_Cuttack", THINGSBOARD_HOST, user=ACCESS_TOKEN, password="")
    client.set_callback(on_message)
    client.connect()
    client.subscribe(b"v1/devices/me/rpc/request/+")
    print("Connected to ThingsBoard MQTT!")
    return client

# --- Main Logic ---
connect_wifi()
client = connect_mqtt()

last_telemetry = 0

print("System Ready. Waiting for commands...")

while True:
    try:
        # Check for incoming RPC (Switch) messages
        client.check_msg() 

        # Send Telemetry every 10 seconds (standard for cloud stability)
        if (time.time() - last_telemetry) > 10:
            sensor.measure()
            t = sensor.temperature()
            h = sensor.humidity()
            
            payload = json.dumps({
                "temperature": t, 
                "humidity": h, 
                "ledStatus": led_state
            })
            
            client.publish("v1/devices/me/telemetry", payload)
            print(f"Published: {payload}")
            last_telemetry = time.time()

    except Exception as e:
        print(f"Error in Loop: {e}")
        time.sleep(5)
        import machine
        machine.reset() 
