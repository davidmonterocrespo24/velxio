# Velxio — Arduino Emulator

**Live at [velxio.dev](https://velxio.dev)**

A fully local, open-source Arduino emulator. Write Arduino code, compile it, and simulate it with real AVR8 CPU emulation and 48+ interactive electronic components — all running in your browser.

[![Live Demo](https://img.shields.io/badge/Live%20Demo-velxio.dev-007acc?style=for-the-badge)](https://velxio.dev)
[![Docker Image](https://img.shields.io/badge/Docker-ghcr.io%2Fdavidmonterocrespo24%2Fvelxio-2496ED?style=for-the-badge&logo=docker&logoColor=white)](https://github.com/davidmonterocrespo24/velxio/pkgs/container/velxio)
[![GitHub stars](https://img.shields.io/github/stars/davidmonterocrespo24/velxio?style=for-the-badge)](https://github.com/davidmonterocrespo24/velxio/stargazers)
[![License: AGPLv3](https://img.shields.io/badge/License-AGPL%20v3-blue?style=for-the-badge)](LICENSE)
[![Commercial License](https://img.shields.io/badge/Commercial%20License-Available-green?style=for-the-badge)](COMMERCIAL_LICENSE.md)

---
<a href="https://www.producthunt.com/products/velxio?embed=true&amp;utm_source=badge-featured&amp;utm_medium=badge&amp;utm_campaign=badge-velxio" target="_blank" rel="noopener noreferrer"><img alt="Velxio - Arduino emulator running entirely in the browser | Product Hunt" width="250" height="54" src="https://api.producthunt.com/widgets/embed-image/v1/featured.svg?post_id=1092514&amp;theme=dark&amp;t=1772998619179"></a>



---

## Support the Project

Velxio is free and open-source. Building and maintaining a full Arduino emulator takes a lot of time — if it saves you time or you enjoy the project, sponsoring me directly helps keep development going.

| Platform | Link |
|---|---|
| **GitHub Sponsors** (preferred) | [github.com/sponsors/davidmonterocrespo24](https://github.com/sponsors/davidmonterocrespo24) |
| **PayPal** | [paypal.me/odoonext](https://paypal.me/odoonext) |

Your support helps cover server costs, library maintenance, and frees up time to add new boards, components, and features. Thank you! 

---

## Try it now

**[https://velxio.dev](https://velxio.dev)** — no installation needed. Open the editor, write your sketch, and simulate directly in the browser.

To self-host with Docker (single command):

```bash
docker run -d -p 3080:80 ghcr.io/davidmonterocrespo24/velxio:master
```

Then open **http://localhost:3080**.

---

## Screenshots

![Raspberry Pi Pico ADC simulation with Serial Monitor](docs/img1.png)

Raspberry Pi Pico simulation — ADC read test with two potentiometers, Serial Monitor showing live output, and compilation console at the bottom.

![ILI9341 TFT display simulation on Arduino Uno](docs/img2.png)

Arduino Uno driving an ILI9341 240×320 TFT display via SPI — rendering a real-time graphics demo using Adafruit_GFX + Adafruit_ILI9341.

![Library Manager with full library list](docs/img3.png)

Library Manager loads the full Arduino library index on open — browse and install libraries without typing first.

![Component Picker with 48 components](docs/img4.png)

Component Picker showing 48 available components with visual previews, search, and category filters.

---

## Features

### Code Editing
- **Monaco Editor** — Full C++ editor with syntax highlighting, autocomplete, minimap, and dark theme
- **Multi-file workspace** — create, rename, delete, and switch between multiple `.ino` / `.h` / `.cpp` files
- **Arduino compilation** via `arduino-cli` backend — compile sketches to `.hex` / `.uf2` files
- **Compile / Run / Stop / Reset** toolbar buttons with status messages
- **Compilation console** — resizable output panel showing full compiler output, warnings, and errors

### Multi-Board Support
- **Arduino Uno** (ATmega328p) — full AVR8 emulation via avr8js
- **Arduino Nano** (ATmega328p) — full AVR8 emulation
- **Arduino Mega** (ATmega2560) — full AVR8 emulation
- **Raspberry Pi Pico** (RP2040) — full RP2040 emulation via rp2040js, compiled with arduino-pico core
- Board selector in the toolbar — switch boards without restarting

### AVR8 Simulation (Arduino Uno / Nano / Mega)
- **Real ATmega328p emulation** at 16 MHz using avr8js
- **Full GPIO support** — PORTB (pins 8-13), PORTC (A0-A5), PORTD (pins 0-7)
- **Timer0/Timer1/Timer2** peripheral support (`millis()`, `delay()`, PWM via `analogWrite()`)
- **USART (Serial)** — full transmit and receive support
- **ADC** — `analogRead()` on pins A0-A5, voltage injection from UI components
- **SPI** — hardware SPI peripheral (enables ILI9341, SD card, etc.)
- **I2C (TWI)** — hardware I2C with virtual device bus
- **~60 FPS simulation loop** with `requestAnimationFrame`

### RP2040 Simulation (Raspberry Pi Pico)
- **Real RP2040 emulation** via rp2040js at 133 MHz
- **UART0** serial output displayed in Serial Monitor
- **ADC** — 12-bit, 3.3V reference on GPIO 26-29 (A0-A3)

### Serial Monitor
- **Live serial output** — characters as the sketch sends them via `Serial.print()`
- **Auto baud-rate detection** — reads hardware registers, no manual configuration needed
- **Send data** to the Arduino RX pin from the UI
- **Autoscroll** with toggle

### Component System (48+ Components)
- **48 electronic components** from wokwi-elements
- **Component picker** with search, category filters, and live previews
- **Drag-and-drop** repositioning on the simulation canvas
- **Component rotation** in 90° increments
- **Property dialog** — pin roles, Arduino pin assignment, rotate & delete

### Wire System
- **Wire creation** — click a pin to start, click another pin to connect
- **Orthogonal routing** — no diagonal paths
- **8 signal-type wire colors**: Red (VCC), Black (GND), Blue (Analog), Green (Digital), Purple (PWM), Gold (I2C), Orange (SPI), Cyan (USART)
- **Segment-based wire editing** — drag segments perpendicular to their orientation

### Library Manager
- Browse and install the full Arduino library index directly from the UI
- Live search, installed tab, version display

### Auth & Project Persistence
- **Email/password** and **Google OAuth** sign-in
- **Project save** with name, description, and public/private visibility
- **Project URL** — each project gets a permanent URL at `/project/:id`
- **Sketch files stored on disk** per project (accessible from the host via Docker volume)
- **User profile** at `/:username` showing public projects

### Example Projects
- 8 built-in examples (Blink, Traffic Light, Button Control, Fade LED, Serial Hello World, RGB LED, Simon Says, LCD 20×4)
- One-click loading into the editor

---

## Self-Hosting

### Option A: Docker (single container, recommended)

```bash
# Pull and run
docker run -d \
  --name velxio \
  -p 3080:80 \
  -v $(pwd)/data:/app/data \
  ghcr.io/davidmonterocrespo24/velxio:master
```

Open **http://localhost:3080**.

The `/app/data` volume contains:
- `velxio.db` — SQLite database (users, projects metadata)
- `projects/{id}/` — sketch files per project

### Option B: Docker Compose

```bash
git clone https://github.com/davidmonterocrespo24/velxio.git
cd velxio
cp backend/.env.example backend/.env   # edit as needed
docker compose -f docker-compose.prod.yml up -d
```

#### Environment variables (`backend/.env`)

| Variable | Default | Description |
|---|---|---|
| `SECRET_KEY` | *(required)* | JWT signing secret |
| `DATABASE_URL` | `sqlite+aiosqlite:////app/data/velxio.db` | SQLite path |
| `DATA_DIR` | `/app/data` | Directory for project files |
| `FRONTEND_URL` | `http://localhost:5173` | Used for OAuth redirect |
| `GOOGLE_CLIENT_ID` | — | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | — | Google OAuth client secret |
| `GOOGLE_REDIRECT_URI` | `http://localhost:8001/api/auth/google/callback` | Must match Google Console |
| `COOKIE_SECURE` | `false` | Set `true` when serving over HTTPS |

### Option C: Manual Setup

**Prerequisites:** Node.js 18+, Python 3.12+, arduino-cli

```bash
git clone https://github.com/davidmonterocrespo24/velxio.git
cd velxio

# Backend
cd backend
python -m venv venv && source venv/bin/activate  # Windows: venv\Scripts\activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8001

# Frontend (new terminal)
cd frontend
npm install
npm run dev
```

Open **http://localhost:5173**.

**arduino-cli setup (first time):**
```bash
arduino-cli core update-index
arduino-cli core install arduino:avr
# For Raspberry Pi Pico:
arduino-cli config add board_manager.additional_urls \
  https://github.com/earlephilhower/arduino-pico/releases/download/global/package_rp2040_index.json
arduino-cli core install rp2040:rp2040
```

---

## Project Structure

```
velxio/
├── frontend/                    # React + Vite + TypeScript
│   └── src/
│       ├── pages/               # LandingPage, EditorPage, ProjectByIdPage, ...
│       ├── components/          # Editor, simulator canvas, modals, layout
│       ├── simulation/          # AVRSimulator, RP2040Simulator, PinManager
│       ├── store/               # Zustand stores (auth, editor, simulator, project)
│       └── services/            # API clients
├── backend/                     # FastAPI + Python
│   └── app/
│       ├── api/routes/          # compile, auth, projects, libraries
│       ├── models/              # User, Project (SQLAlchemy)
│       ├── services/            # arduino_cli, project_files
│       └── core/                # config, security, dependencies
├── wokwi-libs/                  # Local clones of Wokwi repos
│   ├── wokwi-elements/
│   ├── avr8js/
│   └── rp2040js/
├── deploy/                      # nginx.conf, entrypoint.sh
├── Dockerfile.standalone        # Single-container production image
├── docker-compose.yml           # Development compose
└── docker-compose.prod.yml      # Production compose
```

---

## Technologies

| Layer | Stack |
|---|---|
| Frontend | React 19, Vite 7, TypeScript 5.9, Monaco Editor, Zustand, React Router 7 |
| Backend | FastAPI, SQLAlchemy 2.0 async, aiosqlite, uvicorn |
| Simulation | avr8js (AVR8), rp2040js (RP2040), wokwi-elements (Web Components) |
| Compiler | arduino-cli (subprocess) |
| Auth | JWT (httpOnly cookie), Google OAuth 2.0 |
| Persistence | SQLite + disk volume (`/app/data/projects/{id}/`) |
| Deploy | Docker, nginx, GitHub Actions → GHCR + Docker Hub |

---

## Troubleshooting

**`arduino-cli: command not found`** — install arduino-cli and add to PATH.

**LED doesn't blink** — check port listeners in browser console; verify pin mapping in the component property dialog.

**Serial Monitor shows nothing** — ensure `Serial.begin()` is called before `Serial.print()`.

**Compilation errors** — check the compilation console; verify the correct core is installed.

---

## Contributing

Suggestions, bug reports, and pull requests are welcome at [github.com/davidmonterocrespo24/velxio](https://github.com/davidmonterocrespo24/velxio).

If you'd like to support the project financially, see the [Support the Project](#️-support-the-project) section above or sponsor directly at [github.com/sponsors/davidmonterocrespo24](https://github.com/sponsors/davidmonterocrespo24).

> **Note:** All contributors must sign a Contributor License Agreement (CLA) so that the dual-licensing model remains valid. A CLA check runs automatically on pull requests.

## License

Velxio uses a **dual-licensing** model:

| Use case | License | Cost |
|----------|---------|------|
| Personal, educational, open-source (AGPLv3 compliant) | [AGPLv3](LICENSE) | Free |
| Proprietary / closed-source product or SaaS | [Commercial License](COMMERCIAL_LICENSE.md) | Paid |

The AGPLv3 is a certified Open Source license. It is free for all uses — including commercial — as long as any modifications or network-accessible deployments make their source code available under the same license. Companies that cannot comply with that requirement can purchase a Commercial License.

For commercial licensing inquiries: [davidmonterocrespo24@gmail.com](mailto:davidmonterocrespo24@gmail.com)

See [LICENSE](LICENSE) and [COMMERCIAL_LICENSE.md](COMMERCIAL_LICENSE.md) for full terms.

## References

- [Wokwi](https://wokwi.com) — Inspiration
- [avr8js](https://github.com/wokwi/avr8js) — AVR8 emulator
- [wokwi-elements](https://github.com/wokwi/wokwi-elements) — Electronic web components
- [rp2040js](https://github.com/wokwi/rp2040js) — RP2040 emulator
- [arduino-cli](https://github.com/arduino/arduino-cli) — Arduino compiler
- [Monaco Editor](https://microsoft.github.io/monaco-editor/) — Code editor
