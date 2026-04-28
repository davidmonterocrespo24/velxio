import machine
import time

# ── Hardware setup ────────────────────────────────────────────
vrx = machine.ADC(machine.Pin(26))  # Joystick X axis
servo = machine.PWM(machine.Pin(0))
servo.freq(50)  # SG90 = 50Hz

# ── Servo helper ──────────────────────────────────────────────
def set_angle(angle):
    # 0° = 1000us, 90° = 1500us, 180° = 2000us
    us = int(1000 + (angle / 180) * 1000)
    duty = int(us * 65535 / 20000)
    servo.duty_u16(duty)

# ── Map helper ────────────────────────────────────────────────
def map_val(x, in_min, in_max, out_min, out_max):
    return int((x - in_min) * (out_max - out_min) / (in_max - in_min) + out_min)

# ── Main loop ─────────────────────────────────────────────────
print("Joystick Servo Control ready!")

while True:
    # Average 5 samples for smooth reading
    x_raw = sum(vrx.read_u16() for _ in range(5)) // 5
    
    # Map joystick (0-65535) to angle (0-180)
    angle = map_val(x_raw, 0, 65535, 0, 180)
    
    set_angle(angle)
    print(f"Raw: {x_raw}  Angle: {angle}°")
    
    time.sleep(0.05)
