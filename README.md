# Arduino Emulator - Wokwi Clone

Local Arduino emulator with code editor and visual simulator.

## Support This Project

If you find this project helpful, please consider giving it a star! Your support helps the project grow and motivates continued development.

[![GitHub stars](https://img.shields.io/github/stars/davidmonterocrespo24/openwokwi?style=social)](https://github.com/davidmonterocrespo24/openwokwi/stargazers)

Every star counts and helps make this project better!

## Features

- ✅ Code editor with syntax highlighting (Monaco Editor)
- ✅ Arduino code compilation with arduino-cli
- ✅ **Official Wokwi repositories cloned locally**
  - ✅ **wokwi-elements** - Electronic web components
  - ✅ **avr8js** - AVR8 emulator
  - ✅ **rp2040js** - RP2040 emulator (future)
- ✅ Visual components using wokwi-elements (Arduino Uno, LEDs, etc.)
- ⏳ Full emulation with avr8js (in progress)
- ⏳ SQLite persistence (coming soon)

## Screenshots

![Arduino Emulator - Editor and Simulator](doc/img1.png)

Arduino emulator with Monaco code editor and visual simulator with wokwi-elements

![Arduino Emulator - Component Properties and Wire Editing](doc/img2.png)

Interactive component properties dialog and segment-based wire editing

## Prerequisites

### 1. Node.js
- Version 18 or higher
- Download from: https://nodejs.org/

### 2. Python
- Version 3.12 or higher
- Download from: https://www.python.org/

### 3. Arduino CLI
Install arduino-cli on your system:

**Windows (with Chocolatey):**
```bash
choco install arduino-cli
```

**Windows (manual):**
1. Download from: https://github.com/arduino/arduino-cli/releases
2. Add to system PATH

**Verify installation:**
```bash
arduino-cli version
```

**Initialize arduino-cli:**
```bash
arduino-cli core update-index
arduino-cli core install arduino:avr
```

## Installation

### 1. Clone the repository
```bash
cd e:\Hardware\wokwi_clon
```

### 2. Setup Backend

```bash
cd backend

# Create virtual environment
python -m venv venv

# Activate virtual environment (Windows)
venv\Scripts\activate

# Install dependencies
pip install -r requirements.txt
```

### 3. Setup Frontend

```bash
cd frontend

# Install dependencies
npm install
```

## Running

### Start Backend

```bash
cd backend
venv\Scripts\activate
uvicorn app.main:app --reload --port 8001
```

The backend will be available at:
- API: http://localhost:8001
- Documentation: http://localhost:8001/docs

### Start Frontend

```bash
cd frontend
npm run dev
```

The frontend will be available at:
- App: http://localhost:5173

## Usage

1. Open http://localhost:5173 in your browser
2. Write Arduino code in the editor (there's a Blink example by default)
3. Click "Compile" to compile the code
4. If compilation is successful, click "Run" to start the simulation
5. Watch the simulated LED blinking

## Project Structure

```
wokwi_clon/
├── frontend/                    # React + Vite
│   ├── src/
│   │   ├── components/          # React components
│   │   │   ├── components-wokwi/  # wokwi-elements wrappers
│   │   │   ├── editor/          # Monaco Editor
│   │   │   └── simulator/       # Simulation canvas
│   │   ├── store/               # Global state (Zustand)
│   │   ├── services/            # API clients
│   │   └── App.tsx              # Main component
│   └── package.json
│
├── backend/                     # FastAPI + Python
│   ├── app/
│   │   ├── api/routes/          # REST endpoints
│   │   ├── services/            # Business logic
│   │   └── main.py              # Entry point
│   └── requirements.txt
│
├── wokwi-libs/                  # Cloned Wokwi repositories
│   ├── wokwi-elements/          # Web Components
│   ├── avr8js/                  # AVR8 Emulator
│   ├── rp2040js/                # RP2040 Emulator
│   └── wokwi-features/          # Features and documentation
│
├── README.md
├── WOKWI_LIBS.md                # Wokwi integration documentation
└── update-wokwi-libs.bat        # Update script
```

## Technologies Used

### Frontend
- **React** 18 - UI framework
- **Vite** 5 - Build tool
- **TypeScript** - Static typing
- **Monaco Editor** - Code editor (VSCode)
- **Zustand** - State management
- **Axios** - HTTP client

### Backend
- **FastAPI** - Python web framework
- **uvicorn** - ASGI server
- **arduino-cli** - Arduino compiler
- **SQLAlchemy** - ORM (coming soon)
- **SQLite** - Database (coming soon)

### Simulation
- **avr8js** - AVR8 emulator (coming soon)
- **@wokwi/elements** - Electronic components (coming soon)

## Upcoming Features

### Phase 2: Real Emulation with avr8js
- [ ] Integrate avr8js for real ATmega328p emulation
- [ ] .hex file parser
- [ ] PinManager for pin management
- [ ] Real-time execution

### Phase 3: Visual Components
- [ ] Integrate @wokwi/elements
- [ ] LED component with real state
- [ ] Resistor component
- [ ] Component drag & drop
- [ ] Visual connections (wires)

### Phase 4: Persistence
- [ ] SQLite database
- [ ] Project CRUD
- [ ] Save/load code and circuit
- [ ] Project history

### Phase 5: Advanced Features
- [ ] More components (buttons, potentiometers, sensors)
- [ ] Serial monitor
- [ ] Simulation speed control
- [ ] Example projects
- [ ] Export/import projects

## Update Wokwi Libraries

This project uses official Wokwi repositories cloned locally. To get the latest updates:

```bash
# Run update script
update-wokwi-libs.bat
```

Or manually:

```bash
cd wokwi-libs/wokwi-elements
git pull origin main
npm install
npm run build
```

See [WOKWI_LIBS.md](WOKWI_LIBS.md) for more details about Wokwi integration.

## Troubleshooting

### Error: "arduino-cli: command not found"
- Make sure arduino-cli is installed and in PATH
- Verify with: `arduino-cli version`

### Error: "arduino:avr core not found"
- Run: `arduino-cli core install arduino:avr`

### Frontend doesn't connect to backend
- Verify backend is running at http://localhost:8001
- Check CORS logs in browser console

### Compilation errors
- Check backend console for arduino-cli logs
- Make sure Arduino code is valid
- Verify you have the `arduino:avr` core installed

## Contributing

This is an educational project. Suggestions and improvements are welcome!

## License

MIT

## References

- [Wokwi](https://wokwi.com) - Project inspiration
- [avr8js](https://github.com/wokwi/avr8js) - AVR8 emulator
- [wokwi-elements](https://github.com/wokwi/wokwi-elements) - Web components
- [arduino-cli](https://github.com/arduino/arduino-cli) - Arduino compiler
- [Monaco Editor](https://microsoft.github.io/monaco-editor/) - Code editor

