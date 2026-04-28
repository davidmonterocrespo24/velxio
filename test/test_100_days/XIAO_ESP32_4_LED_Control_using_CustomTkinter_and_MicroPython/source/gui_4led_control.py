import customtkinter as ctk
import serial
import time

# -------- SERIAL CONFIG --------
COM_PORT = "COM14"   # change if needed
BAUD = 115200

ser = serial.Serial(COM_PORT, BAUD, timeout=1)
time.sleep(5)

# -------- GUI CONFIG --------
ctk.set_appearance_mode("dark")
ctk.set_default_color_theme("blue")

app = ctk.CTk()
app.title("ESP32 – 4 LED Controller")
app.geometry("420x350")

# -------- FUNCTIONS --------
def send(cmd):
    ser.write((cmd + "\n").encode())

def toggle(led, state_var, btn):
    if state_var.get():
        send(f"{led}:ON")
        btn.configure(text=f"{led} ON", fg_color="green")
    else:
        send(f"{led}:OFF")
        btn.configure(text=f"{led} OFF", fg_color="red")

# -------- UI --------
title = ctk.CTkLabel(app, text="ESP32 4 LED CONTROL",
                     font=ctk.CTkFont(size=20, weight="bold"))
title.pack(pady=20)

frame = ctk.CTkFrame(app)
frame.pack(pady=10, padx=20, fill="both", expand=True)

led_states = {}

for i in range(1, 5):
    led_name = f"LED{i}"
    state = ctk.BooleanVar(value=False)
    led_states[led_name] = state

    btn = ctk.CTkSwitch(
        frame,
        text=f"{led_name} OFF",
        variable=state,
        command=lambda l=led_name, s=state, b=None: None
    )

    def make_cmd(led=led_name, var=state, switch=btn):
        toggle(led, var, switch)

    btn.configure(command=make_cmd)
    btn.pack(pady=10)

def on_close():
    ser.close()
    app.destroy()

app.protocol("WM_DELETE_WINDOW", on_close)
app.mainloop()
