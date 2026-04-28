from machine import ADC, Pin, SoftI2C
import ssd1306
import time

# OLED setup
i2c = SoftI2C(scl=Pin(22), sda=Pin(21))
oled = ssd1306.SSD1306_I2C(128, 64, i2c)

# Sensor setup
sensor = ADC(Pin(34))
sensor.atten(ADC.ATTN_11DB)

# BPM variables
THRESHOLD = 2500
MIN_PEAK_INTERVAL = 300
last_peak_time = 0
peak_times = []
bpm = 0

# Graph buffer
graph = [0] * 80

def draw_heart(x, y):
    oled.pixel(x+1, y, 1); oled.pixel(x+2, y, 1)
    oled.pixel(x+4, y, 1); oled.pixel(x+5, y, 1)
    oled.pixel(x, y+1, 1); oled.pixel(x+1, y+1, 1)
    oled.pixel(x+2, y+1, 1); oled.pixel(x+3, y+1, 1)
    oled.pixel(x+4, y+1, 1); oled.pixel(x+5, y+1, 1)
    oled.pixel(x+6, y+1, 1)
    oled.pixel(x+1, y+2, 1); oled.pixel(x+2, y+2, 1)
    oled.pixel(x+3, y+2, 1); oled.pixel(x+4, y+2, 1)
    oled.pixel(x+5, y+2, 1)
    oled.pixel(x+2, y+3, 1); oled.pixel(x+3, y+3, 1)
    oled.pixel(x+4, y+3, 1)
    oled.pixel(x+3, y+4, 1)

while True:
    value = sensor.read()
    current_time = time.ticks_ms()

    # Peak detection
    if value > THRESHOLD:
        if time.ticks_diff(current_time, last_peak_time) > MIN_PEAK_INTERVAL:
            last_peak_time = current_time
            peak_times.append(current_time)
            if len(peak_times) > 10:
                peak_times.pop(0)
            if len(peak_times) >= 2:
                intervals = [time.ticks_diff(peak_times[i+1], peak_times[i]) 
                           for i in range(len(peak_times)-1)]
                avg_interval = sum(intervals) / len(intervals)
                bpm = int(60000 / avg_interval)

    # Update graph buffer
    graph_val = int((value / 4095) * 30)
    graph.pop(0)
    graph.append(graph_val)

    # Draw OLED
    oled.fill(0)

    # Draw waveform (top half)
    for i in range(len(graph) - 1):
        y1 = 32 - graph[i]
        y2 = 32 - graph[i+1]
        oled.line(i + 48, y1, i + 49, y2, 1)

    # Divider line
    oled.hline(0, 38, 128, 1)
    

    # Heart symbol + BPM (bottom half)
    draw_heart(4, 44)
    oled.text(": " + str(bpm) + " BPM", 14, 45)

    oled.show()
    time.sleep_ms(10)
