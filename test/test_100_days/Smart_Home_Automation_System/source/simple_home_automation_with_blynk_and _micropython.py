'''Copyright (c) 2026 Kritish Mohapatra'''


import network # Library for network functionalities (Wi-Fi)
from machine import Pin # Library for controlling GPIO pins
import BlynkLib # Library for Blynk IoT platform communication
from time import sleep # Library for time delays
import dht # Library for DHT11 sensor communication

# Wi-Fi Credentials (replace with your own)
wifissid = "abcdef" # Your Wi-Fi SSID
wifipass = "@9090" # Your Wi-Fi password

# Blynk Authorization Token (replace with your Blynk app's token)
auth = "pottiIr9atOFmbvwsqTp7lTrYtje"

# LED Pin Configuration


# Connect to Wi-Fi
sta_if = network.WLAN(network.STA_IF)  #Create a Wi-Fi station interface object
sta_if.active(True) # Activate the Wi-Fi interface
sta_if.connect(wifissid, wifipass) # Connect to the Wi-Fi network

while not sta_if.isconnected(): # Wait until connected to Wi-Fi
    pass

print("Connected to Wi-Fi:", sta_if.ifconfig()) # Print the Wi-Fi connection details

# Initialize Blynk Connection
blynk = BlynkLib.Blynk(auth, insecure=True) # Create a Blynk object with the auth token

# Create LED Object
led1=Pin(16, Pin.OUT) # Initialize LED 1 on pin 16 (D0), set as output
led2=Pin(5, Pin.OUT) # Initialize LED 2 on pin 5 (D1), set as output
led3=Pin(4, Pin.OUT) # Initialize LED 3 on pin 4 (D2), set as output
led4=Pin(0, Pin.OUT) # Initialize LED 4 on pin 0 (D3), set as output
sensor=dht.DHT11(Pin(14)) # Initialize DHT11 sensor on pin 14 (D5)

led1.value(1) # Turn off LED 1 initially (active low)
led2.value(1) # Turn off LED 2 initially (active low)
led3.value(1) # Turn off LED 3 initially (active low)
led4.value(1) # Turn off LED 4 initially (active low)



# Virtual Pin V1 Handler (LED 1 control)
@blynk.on("V1")

def v0_handler(value):
    # Convert string value to integer (handle potential errors)
    try:
        led1.value(not int(value[0])) # Toggle LED 1 based on Blynk button state
    except ValueError:
        print("Invalid value received:", value)
        return

@blynk.on("V2")

def v2_handler(value):
    # Convert string value to integer (handle potential errors)
    try:
        led2.value(not int(value[0]))
    except ValueError:
        print("Invalid value received:", value)
        return

@blynk.on("V3")

def v3_handler(value):
    # Convert string value to integer (handle potential errors)
    try:
        led3.value(not int(value[0]))
    except ValueError:
        print("Invalid value received:", value)
        return
@blynk.on("V4")

def v4_handler(value):
    # Convert string value to integer (handle potential errors)
    try:
        led4.value(not int(value[0]))
    except ValueError:
        print("Invalid value received:", value)
        return
@blynk.on("V5")
# Create Blynk gauge widget
def write_value(pin, value):
# This function is not used for input, but required by blynk on decorator    
    pass



    

# Main Loop (run Blynk processes)
while True:
    blynk.run() # Run Blynk processes (handle incoming and outgoing data)
    sensor.measure()  # Measure temperature and humidity
    temperature = sensor.temperature() # Get the temperature value
    #print(temperature)
    blynk.virtual_write(5, temperature)  # Send temperature to Blynk virtual pin V5






















