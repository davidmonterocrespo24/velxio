import serial
import time
import matplotlib.pyplot as plt
from matplotlib.animation import FuncAnimation

# -------- Serial --------
time.sleep(2)
ser = serial.Serial("COM4", 115200, timeout=1)

temps = []
hums = []
x_vals = []

# -------- Dark Theme --------
plt.style.use("dark_background")
fig, ax = plt.subplots()
fig.patch.set_facecolor("#0f0f0f")
ax.set_facecolor("#0f0f0f")

# -------- Animate --------
def animate(i):
    if ser.in_waiting:
        data = ser.readline().decode().strip()
        if "," in data:
            t, h = data.split(",")

            temps.append(int(t))
            hums.append(int(h))
            x_vals.append(len(temps))

            ax.clear()
            ax.set_facecolor("#0f0f0f")

            # ===== Temperature =====
            # Glow (behind)
            ax.plot(
                x_vals[-30:], temps[-30:],
                color="#ff3131", linewidth=8, alpha=0.2
            )
            # Line
            ax.plot(
                x_vals[-30:], temps[-30:],
                color="#ff3131", linewidth=2.5
            )
            # Points (TOP layer)
            ax.scatter(
                x_vals[-30:], temps[-30:],
                color="#ff6b6b", s=40, zorder=5, label="Temperature (°C)"
            )

            # ===== Humidity =====
            ax.plot(
                x_vals[-30:], hums[-30:],
                color="#00ffff", linewidth=8, alpha=0.2
            )
            ax.plot(
                x_vals[-30:], hums[-30:],
                color="#00ffff", linewidth=2.5
            )
            ax.scatter(
                x_vals[-30:], hums[-30:],
                color="#7ffcff", s=40, zorder=5, label="Humidity (%)"
            )

            ax.set_title("ESP8266 DHT11 Live Monitor", fontsize=14)
            ax.set_xlabel("Samples")
            ax.set_ylabel("Value")
            ax.legend()
            ax.grid(alpha=0.2)

# -------- Start --------
ani = FuncAnimation(fig, animate, interval=1000)
plt.show()
