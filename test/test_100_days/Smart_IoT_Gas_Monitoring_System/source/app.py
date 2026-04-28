# from flask import Flask, request
# import csv
# from datetime import datetime

# app = Flask(__name__)

# @app.route("/")
# def home():
#     return "Flask server running OK"

# @app.route("/data", methods=["POST"])
# def receive():
#     data = request.json
#     with open("data.csv", "a", newline="") as f:
#         writer = csv.writer(f)
#         writer.writerow([
#             datetime.now(),
#             data["gas"],
#             data["temp"],
#             data["humidity"],
#             data["soil"]
#         ])
#     return {"status": "ok"}

# app.run(host="0.0.0.0", port=5000, debug=True)

# -------------------- IMPORTS --------------------
# Flask framework for building web server
# request       -> to receive JSON data from ESP32
# render_template -> to serve HTML dashboard
# jsonify       -> to send JSON response to frontend

from flask import Flask, request, render_template, jsonify

# CSV module to store sensor data logs
import csv

# datetime module to store timestamp
from datetime import datetime


# -------------------- FLASK APP INITIALIZATION --------------------
app = Flask(__name__)


# -------------------- LIVE DATA STORAGE --------------------
# This dictionary stores the latest sensor readings
# It is used by the dashboard and live graphs
latest_data = {
    "gas": 0,
    "temp": 0,
    "humidity": 0,
    "soil": 0,
    "status": "SAFE"
}


# -------------------- AI MEMORY (HISTORY BUFFER) --------------------
# List to store recent gas sensor values
gas_history = []

# Number of past readings used for moving average
WINDOW_SIZE = 10

# Sensitivity margin for anomaly detection
# If gas > average + margin → DANGER
GAS_MARGIN = 300


# -------------------- DASHBOARD ROUTE --------------------
# Loads the main dashboard page
@app.route("/")
def dashboard():
    return render_template("index.html", data=latest_data)


# -------------------- ESP32 DATA RECEIVER --------------------
# ESP32 sends sensor data to this route using POST request
@app.route("/data", methods=["POST"])
def receive():
    global latest_data, gas_history

    # Read JSON data sent by ESP32
    data = request.json

    # Extract sensor values (default = 0 if missing)
    gas = data.get("gas", 0)
    temp = data.get("temp", 0)
    humidity = data.get("humidity", 0)
    soil = data.get("soil", 0)

    # ---------------- AI LOGIC (Moving Average Based Detection) ----------------
    # Store current gas value in history
    gas_history.append(gas)

    # Keep only the last WINDOW_SIZE readings
    if len(gas_history) > WINDOW_SIZE:
        gas_history.pop(0)

    # Calculate average gas level
    avg_gas = sum(gas_history) / len(gas_history)

    # Detect abnormal gas rise
    # Sudden spike beyond threshold is marked as DANGER
    status = "DANGER" if gas > avg_gas + GAS_MARGIN else "SAFE"

    # Update latest data dictionary
    latest_data = {
        "gas": gas,
        "temp": temp,
        "humidity": humidity,
        "soil": soil,
        "status": status
    }

    # ---------------- CSV DATA LOGGING ----------------
    # Store all readings in CSV file for analysis
    with open("data.csv", "a", newline="") as f:
        writer = csv.writer(f)
        writer.writerow([
            datetime.now(),  # Timestamp
            gas,
            temp,
            humidity,
            soil,
            status
        ])

    # Send acknowledgment to ESP32
    return {"status": "ok"}


# -------------------- LIVE DATA API --------------------
# Frontend uses this route to fetch live data for graphs
@app.route("/latest")
def latest():
    return jsonify(latest_data)


# -------------------- RUN FLASK SERVER --------------------
if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=True)

