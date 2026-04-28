import espnow
import network
import dht
import machine
import sh1106
import time

# WiFi init
wlan = network.WLAN(network.STA_IF)
wlan.active(True)

# ESP-NOW init
e = espnow.ESPNow()
e.active(True)
peer = b'\x48\x3f\xda\xc0\x35\xe9'  # Node A MAC
e.add_peer(peer)

# DHT11 on D2 (GPIO4)
sensor = dht.DHT11(machine.Pin(4))

# SH1106 OLED using SoftI2C
i2c = machine.SoftI2C(scl=machine.Pin(14), sda=machine.Pin(12))
display = sh1106.SH1106_I2C(128, 64, i2c, addr=0x3C, rotate=180)

remote_temp = '--'
remote_hum = '--'

while True:
    # Receive any pending data
    try:
        mac, msg = e.irecv(0)
        if msg:
            data = msg.decode()
            parts = data.split(',')
            if len(parts) == 2:
                remote_temp = parts[0]
                remote_hum = parts[1]
    except Exception:
        pass

    # Read DHT11 and send
    try:
        sensor.measure()
        temp = sensor.temperature()
        hum = sensor.humidity()
        msg = '{},{}'.format(temp, hum)
        e.send(peer, msg)
    except Exception:
        temp = '--'
        hum = '--'

    # Update display
    display.fill(0)
    display.text('Local:', 0, 0)
    display.text('{}C  {}%'.format(temp, hum), 0, 12)
    display.text('Remote:', 0, 32)
    display.text('{}C  {}%'.format(remote_temp, remote_hum), 0, 44)
    display.show()

    time.sleep(2)
