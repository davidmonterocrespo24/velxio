from flask import Flask, jsonify, render_template

app = Flask(__name__)

led_state = {"value": 0}

@app.route("/")
def home():
    return render_template("index.html")

@app.route("/led/on")
def led_on():
    led_state["value"] = 1
    return "OK"

@app.route("/led/off")
def led_off():
    led_state["value"] = 0
    return "OK"

@app.route("/led/state")
def get_state():
    return jsonify(led_state)

app.run(host="0.0.0.0", port=5000)
