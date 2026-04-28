# ============================================================
# 🕒 Basic RTC Clock (Serial Monitor Display)
# Board: ESP8266 | Module: DS3231 | Language: MicroPython
# Author: Kritish Mohapatra
# Description:
# Reads real-time date, time, and temperature from DS3231 RTC
# and displays it on the Serial Monitor every second.
# ============================================================

from machine import I2C, Pin
import time
import urtc

# ------------------------------------------------------------
# Initialize I2C communication
# For ESP8266:
#   SCL -> D1 (GPIO5)
#   SDA -> D2 (GPIO4)
# ------------------------------------------------------------
i2c = I2C(scl=Pin(5), sda=Pin(4))
rtc = urtc.DS3231(i2c)  # Create RTC object

# List of day names for readable display
DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']

# ------------------------------------------------------------
# Sync RTC with system time (so RTC starts with correct time)
# You can also manually set RTC using:
# rtc.datetime((2025, 11, 2, 0, 22, 30, 0, 0))
# ------------------------------------------------------------
current_tuple = time.localtime()  # Get local system time
rtc.datetime(urtc.seconds2tuple(time.mktime(current_tuple)))  # Convert and set to RTC

# Confirmation message
print("\n✅ RTC Initialized Successfully!")
print("Displaying current Date, Time & Temperature:\n")

# ------------------------------------------------------------
# Main Loop: Display time and temperature every second
# ------------------------------------------------------------
while True:
    # Read date & time from RTC
    dt = rtc.datetime()

    # Read internal temperature from DS3231
    temp = rtc.get_temperature()

    # Format the output in readable form
    formatted_time = (
        f"{DAYS[dt.weekday]}, "
        f"{dt.year:04d}-{dt.month:02d}-{dt.day:02d}  "
        f"{dt.hour:02d}:{dt.minute:02d}:{dt.second:02d}"
    )

    # Display formatted data on Serial Monitor
    print("--------------------------------------------------")
    print(f"📅 Date & Time : {formatted_time}")
    print(f"🌡️  Temperature : {temp:.2f} °C")
    print("--------------------------------------------------\n")

    # Wait 1 second before next update
    time.sleep(1)

