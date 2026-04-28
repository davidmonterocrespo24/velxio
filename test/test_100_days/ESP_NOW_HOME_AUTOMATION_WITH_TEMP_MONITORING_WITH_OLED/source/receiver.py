from machine import Pin
import network
import espnow
import dht
import time

# ----------------------------
# Wi-Fi Init
# ----------------------------
sta = network.WLAN(network.STA_IF)
sta.active(True)
sta.disconnect()

# ----------------------------
# ESP-NOW Init
# ----------------------------
esp = espnow.ESPNow()
esp.active(True)

print("Receiver ready. Controls 4 relays + sends DHT data")

# ----------------------------
# Relays Setup
# ----------------------------
relays = [
    Pin(10, Pin.OUT),   # Relay 1
    Pin(14, Pin.OUT),   # Relay 2
    Pin(12, Pin.OUT),   # Relay 3
    Pin(13, Pin.OUT)    # Relay 4
]
for r in relays:
    r.value(1)  # HIGH = Relay OFF

relay_states = [0, 0, 0, 0]

# ----------------------------
# DHT11 Setup
# ----------------------------
dht_sensor = dht.DHT11(Pin(4))  # adjust pin

# Store last sender MAC
last_sender = None

while True:
    # ----- Receive Messages -----
    if esp.any():
        host, msg = esp.recv()
        last_sender = host  # save sender MAC for DHT reply
        try:
            msg = msg.decode()
            # Expected format: "1:1" or "2:0" etc.
            if ":" in msg:
                r_num, state = msg.split(":")
                r_num = int(r_num) - 1  # convert 1-based to 0-based index
                state = int(state)
                if 0 <= r_num < 4:
                    relays[r_num].value(0 if state==1 else 1)  # active-low logic
                    relay_states[r_num] = state
                    print(f"Relay {r_num+1} set to {'ON' if state else 'OFF'}")

        except Exception as e:
            print("Error decoding msg:", e)

    # ----- Read DHT11 and Send Back -----
    if last_sender:
        try:
            dht_sensor.measure()
            temp = dht_sensor.temperature()
            hum = dht_sensor.humidity()
            data = f"T:{temp},H:{hum}".encode()
            esp.send(last_sender, data)
            print("Sent DHT Data:", data)
        except Exception as e:
            print("DHT read error:", e)

    time.sleep(2)  # every 2 seconds send DHT data

