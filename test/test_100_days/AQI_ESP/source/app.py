from flask import Flask, request, jsonify

app = Flask(__name__)

@app.route("/predict", methods=["POST"])
def predict():
    data = request.get_json()

    pm25 = data.get("pm25", 0) * 100
    co   = data.get("co",   0) / 1000
    no   = data.get("no",   0) / 1000
    nox  = data.get("nox",  0) / 1000

    aqi = round((pm25 + co + no + nox) / 4, 2)

    if aqi <= 50:    status = "Good"
    elif aqi <= 100: status = "Moderate"
    elif aqi <= 200: status = "Unhealthy"
    else:            status = "Hazardous"

    return jsonify({"predicted_aqi": aqi, "status": status})

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=True)