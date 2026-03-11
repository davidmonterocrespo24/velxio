# Getting Started

Velxio is an open-source Arduino emulator that runs entirely in your browser. Follow these steps to simulate your first Arduino sketch.

---

## Option 1: Use the Hosted Version

No installation needed — go to **[https://velxio.dev](https://velxio.dev)** and start coding immediately.

---

## Option 2: Self-Host with Docker

Run a single Docker command to start a fully local instance:

```bash
docker run -d \
  --name velxio \
  -p 3080:80 \
  -v $(pwd)/data:/app/data \
  ghcr.io/davidmonterocrespo24/velxio:master
```

Then open **http://localhost:3080** in your browser.

---

## Option 3: Manual Setup (Development)

**Prerequisites:** Node.js 18+, Python 3.12+, `arduino-cli`

### 1. Clone the repository

```bash
git clone https://github.com/davidmonterocrespo24/velxio.git
cd velxio
```

### 2. Start the backend

```bash
cd backend
python -m venv venv && source venv/bin/activate  # Windows: venv\Scripts\activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8001
```

### 3. Start the frontend

```bash
# In a new terminal:
cd frontend
npm install
npm run dev
```

Open **http://localhost:5173**.

### 4. Set up arduino-cli (first time)

```bash
arduino-cli core update-index
arduino-cli core install arduino:avr

# For Raspberry Pi Pico support:
arduino-cli config add board_manager.additional_urls \
  https://github.com/earlephilhower/arduino-pico/releases/download/global/package_rp2040_index.json
arduino-cli core install rp2040:rp2040
```

---

## Your First Simulation

1. **Open the editor** at [velxio.dev/editor](https://velxio.dev/editor) (or your local instance).
2. **Select a board** from the toolbar (e.g., *Arduino Uno*).
3. **Write Arduino code** in the Monaco editor, for example:

```cpp
void setup() {
  pinMode(13, OUTPUT);
}

void loop() {
  digitalWrite(13, HIGH);
  delay(500);
  digitalWrite(13, LOW);
  delay(500);
}
```

4. **Click Compile** — the backend calls `arduino-cli` and returns a `.hex` file.
5. **Click Run** — the AVR8 emulator executes the compiled program.
6. **Add components** using the component picker (click the **+** button on the canvas).
7. **Connect wires** by clicking a component pin and then another pin.

---

## Loading an Example Project

1. Click **Examples** in the navigation bar.
2. Choose a project such as *Blink*, *Traffic Light*, or *LCD 20×4*.
3. Click **Load** — the code and components are imported automatically.
4. Click **Run** to start the simulation.

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| `arduino-cli: command not found` | Install `arduino-cli` and add it to your PATH. |
| LED doesn't blink | Check the browser console for port listener errors; verify pin assignment in the component property dialog. |
| Serial Monitor is empty | Ensure `Serial.begin()` is called inside `setup()` before any `Serial.print()`. |
| Compilation errors | Check the compilation console at the bottom of the editor for full `arduino-cli` output. |
