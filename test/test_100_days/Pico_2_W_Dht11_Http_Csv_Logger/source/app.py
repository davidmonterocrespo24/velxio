from flask import Flask, request
import csv, os
from datetime import datetime

app = Flask(__name__)
CSV_FILE = "data.csv"

if not os.path.exists(CSV_FILE):
    with open(CSV_FILE, 'w', newline='') as f:
        csv.writer(f).writerow(
            ["time", "temperature", "humidity"]
        )

@app.route('/data', methods=['POST'])
def data():
    d = request.json
    print("Received:", d)

    with open(CSV_FILE, 'a', newline='') as f:
        csv.writer(f).writerow([
            datetime.now().strftime("%H:%M:%S"),
            d["temperature"],
            d["humidity"]
        ])

    return "OK"

app.run(host="0.0.0.0", port=5000)
