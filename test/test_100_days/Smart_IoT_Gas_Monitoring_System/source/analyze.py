import pandas as pd
import matplotlib.pyplot as plt

# Read CSV
df = pd.read_csv(
    "data.csv",
    header=None,
    names=["time", "gas", "temp", "humidity", "soil"]
)

df["time"] = pd.to_datetime(df["time"])

sensors = [
    ("gas", "Gas Sensor"),
    ("temp", "Temperature"),
    ("soil", "Soil Moisture")
]

fig, axes = plt.subplots(3, 1, figsize=(12, 8), sharex=True)

for ax, (col, title) in zip(axes, sensors):
    mean = df[col].mean()
    std = df[col].std()
    threshold = mean + 2 * std

    alert = df[col] > threshold

    print(f"\n{title}")
    print("Mean:", mean)
    print("Std :", std)
    print("Alerts:", alert.sum())

    ax.plot(df["time"], df[col], label=col)
    ax.scatter(
        df[alert]["time"],
        df[alert][col],
        label="ALERT"
    )
    ax.axhline(threshold, linestyle="--", label="Threshold")
    ax.set_ylabel(col)
    ax.set_title(title)
    ax.legend()

axes[-1].set_xlabel("Time")
plt.suptitle("IoT Sensor Analytics Dashboard", fontsize=14)
plt.tight_layout()
plt.show()
