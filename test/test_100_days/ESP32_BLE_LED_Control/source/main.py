from machine import Pin, Timer
import ubluetooth
from time import sleep_ms

message = ""
led = Pin(2, Pin.OUT)  # Normal ESP32 onboard LED

class ESP32_BLE():
    def __init__(self, name):
        self.timer = Timer(0)
        self.name = name
        self.is_connected = False
        self.ble = ubluetooth.BLE()
        self.ble.active(True)
        self.disconnected()
        self.ble.irq(self.ble_irq)
        self.register()
        self.advertiser()

    def connected(self):
        self.is_connected = True
        self.timer.deinit()
        led.value(1)  # Solid ON = connected

    def disconnected(self):
        self.is_connected = False
        led.value(0)
        self.timer.init(period=500, mode=Timer.PERIODIC,
                        callback=lambda t: led.value(not led.value()))  # Blink = disconnected

    def ble_irq(self, event, data):
        global message
        if event == 1:
            self.connected()
        elif event == 2:
            self.advertiser()
            self.disconnected()
        elif event == 3:
            buffer = self.ble.gatts_read(self.rx)
            message = buffer.decode('UTF-8').strip()
            print("Received:", message)

    def register(self):
        NUS_UUID = '6E400001-B5A3-F393-E0A9-E50E24DCCA9E'
        RX_UUID  = '6E400002-B5A3-F393-E0A9-E50E24DCCA9E'
        TX_UUID  = '6E400003-B5A3-F393-E0A9-E50E24DCCA9E'

        BLE_NUS = ubluetooth.UUID(NUS_UUID)
        BLE_RX  = (ubluetooth.UUID(RX_UUID), ubluetooth.FLAG_WRITE)
        BLE_TX  = (ubluetooth.UUID(TX_UUID), ubluetooth.FLAG_NOTIFY)

        BLE_UART = (BLE_NUS, (BLE_TX, BLE_RX,))
        SERVICES = (BLE_UART,)
        ((self.tx, self.rx,),) = self.ble.gatts_register_services(SERVICES)

    def send(self, data):
        if not self.is_connected:
            print("Not connected!")
            return
        try:
            if isinstance(data, str):
                data = data.encode('UTF-8')
            self.ble.gatts_notify(0, self.tx, data + b'\n')
        except Exception as e:
            print("Send error:", e)

    def advertiser(self):
        name = bytes(self.name, 'UTF-8')
        adv_data = bytearray(b'\x02\x01\x02') + bytearray((len(name) + 1, 0x09)) + name
        self.ble.gap_advertise(100, adv_data)
        print("Advertising as:", self.name)

ble = ESP32_BLE("ESP32")

while True:
    if message == "LED_ON":
        led.value(1)
        print("LED ON")
        ble.send("LED is ON")
        message = ""
    elif message == "LED_OFF":
        led.value(0)
        print("LED OFF")
        ble.send("LED is OFF")
        message = ""
    elif message == "STATUS":
        status = "LED is ON" if led.value() else "LED is OFF"
        print(status)
        ble.send(status)
        message = ""
    sleep_ms(100)
