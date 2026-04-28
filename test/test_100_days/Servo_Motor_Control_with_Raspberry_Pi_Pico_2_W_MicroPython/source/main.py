from machine import Pin, PWM
import time

servo = PWM(Pin(15))
servo.freq(50)

print("=== Servo Angle Control (Safe Mode) ===")

def set_angle(angle):
    # Clamp angles to safe mechanical range
    if angle < 20:
        angle = 20
    elif angle > 170:
        angle = 170

    min_duty = 1200    # calibrated
    max_duty = 8800

    duty = int(min_duty + (angle / 180) * (max_duty - min_duty))
    servo.duty_u16(duty)

    print("Requested Angle:", angle)
    print("Applied Duty:", duty)

while True:
    try:
        angle = int(input("\nEnter angle (0-180): "))
        set_angle(angle)

    except ValueError:
        print("❌ Enter a valid number")
