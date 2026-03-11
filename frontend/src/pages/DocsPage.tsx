import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuthStore } from '../store/useAuthStore';
import './DocsPage.css';

const GITHUB_URL = 'https://github.com/davidmonterocrespo24/velxio';

/* ── Icons ─────────────────────────────────────────────── */
const IcoChip = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <rect x="5" y="5" width="14" height="14" rx="2" />
    <rect x="9" y="9" width="6" height="6" />
    <path d="M9 1v4M15 1v4M9 19v4M15 19v4M1 9h4M1 15h4M19 9h4M19 15h4" />
  </svg>
);

const IcoGitHub = () => (
  <svg viewBox="0 0 24 24" fill="currentColor">
    <path d="M12 0C5.37 0 0 5.37 0 12c0 5.3 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61-.546-1.385-1.335-1.755-1.335-1.755-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 21.795 24 17.295 24 12c0-6.63-5.37-12-12-12z" />
  </svg>
);

/* ── Doc sections ──────────────────────────────────────── */
type SectionId = 'intro' | 'getting-started' | 'emulator' | 'components' | 'roadmap';

interface NavItem {
  id: SectionId;
  label: string;
}

const NAV_ITEMS: NavItem[] = [
  { id: 'intro', label: 'Introduction' },
  { id: 'getting-started', label: 'Getting Started' },
  { id: 'emulator', label: 'Emulator Architecture' },
  { id: 'components', label: 'Components Reference' },
  { id: 'roadmap', label: 'Roadmap' },
];

/* ── Section content ───────────────────────────────────── */
const IntroSection: React.FC = () => (
  <div className="docs-section">
    <span className="docs-label">// overview</span>
    <h1>Introduction</h1>
    <p>
      <strong>Velxio</strong> is a fully local, open-source Arduino emulator that runs entirely in your browser.
      Write Arduino C++ code, compile it with a real <code>arduino-cli</code> backend, and simulate it using
      true AVR8 / RP2040 CPU emulation — with 48+ interactive electronic components, all without installing
      any software on your machine.
    </p>

    <h2>Why Velxio?</h2>
    <ul>
      <li><strong>No installation required</strong> — everything runs in the browser.</li>
      <li><strong>Real emulation</strong> — not a simplified model, but accurate AVR8 / RP2040 CPU emulation.</li>
      <li><strong>Interactive components</strong> — LEDs, buttons, potentiometers, displays, sensors, and more.</li>
      <li><strong>Open-source</strong> — inspect, modify, and self-host it yourself.</li>
    </ul>

    <h2>Supported Boards</h2>
    <table>
      <thead>
        <tr><th>Board</th><th>CPU</th><th>Emulator</th></tr>
      </thead>
      <tbody>
        <tr><td>Arduino Uno</td><td>ATmega328p @ 16 MHz</td><td>avr8js</td></tr>
        <tr><td>Arduino Nano</td><td>ATmega328p @ 16 MHz</td><td>avr8js</td></tr>
        <tr><td>Arduino Mega</td><td>ATmega2560 @ 16 MHz</td><td>avr8js</td></tr>
        <tr><td>Raspberry Pi Pico</td><td>RP2040 @ 133 MHz</td><td>rp2040js</td></tr>
      </tbody>
    </table>

    <div className="docs-callout">
      <strong>Live Demo:</strong>{' '}
      <a href="https://velxio.dev" target="_blank" rel="noopener noreferrer">velxio.dev</a>
      {' '}— no installation needed, open the editor and start simulating immediately.
    </div>
  </div>
);

const GettingStartedSection: React.FC = () => (
  <div className="docs-section">
    <span className="docs-label">// setup</span>
    <h1>Getting Started</h1>
    <p>Follow these steps to simulate your first Arduino sketch.</p>

    <h2>Option 1: Use the Hosted Version</h2>
    <p>
      No installation needed — go to{' '}
      <a href="https://velxio.dev" target="_blank" rel="noopener noreferrer">https://velxio.dev</a>{' '}
      and start coding immediately.
    </p>

    <h2>Option 2: Self-Host with Docker</h2>
    <p>Run a single Docker command to start a fully local instance:</p>
    <pre><code>{`docker run -d \\
  --name velxio \\
  -p 3080:80 \\
  -v $(pwd)/data:/app/data \\
  ghcr.io/davidmonterocrespo24/velxio:master`}</code></pre>
    <p>Then open <strong>http://localhost:3080</strong> in your browser.</p>

    <h2>Option 3: Manual Setup (Development)</h2>
    <p><strong>Prerequisites:</strong> Node.js 18+, Python 3.12+, <code>arduino-cli</code></p>

    <h3>1. Clone the repository</h3>
    <pre><code>{`git clone https://github.com/davidmonterocrespo24/velxio.git
cd velxio`}</code></pre>

    <h3>2. Start the backend</h3>
    <pre><code>{`cd backend
python -m venv venv && source venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8001`}</code></pre>

    <h3>3. Start the frontend</h3>
    <pre><code>{`cd frontend
npm install
npm run dev`}</code></pre>
    <p>Open <strong>http://localhost:5173</strong>.</p>

    <h3>4. Set up arduino-cli (first time)</h3>
    <pre><code>{`arduino-cli core update-index
arduino-cli core install arduino:avr

# For Raspberry Pi Pico support:
arduino-cli config add board_manager.additional_urls \\
  https://github.com/earlephilhower/arduino-pico/releases/download/global/package_rp2040_index.json
arduino-cli core install rp2040:rp2040`}</code></pre>

    <h2>Your First Simulation</h2>
    <ol>
      <li><strong>Open the editor</strong> at <a href="https://velxio.dev/editor" target="_blank" rel="noopener noreferrer">velxio.dev/editor</a>.</li>
      <li><strong>Select a board</strong> from the toolbar (e.g., <em>Arduino Uno</em>).</li>
      <li><strong>Write Arduino code</strong> in the Monaco editor, for example:</li>
    </ol>
    <pre><code>{`void setup() {
  pinMode(13, OUTPUT);
}

void loop() {
  digitalWrite(13, HIGH);
  delay(500);
  digitalWrite(13, LOW);
  delay(500);
}`}</code></pre>
    <ol start={4}>
      <li><strong>Click Compile</strong> — the backend calls <code>arduino-cli</code> and returns a <code>.hex</code> file.</li>
      <li><strong>Click Run</strong> — the AVR8 emulator executes the compiled program.</li>
      <li><strong>Add components</strong> using the component picker (click the <strong>+</strong> button on the canvas).</li>
      <li><strong>Connect wires</strong> by clicking a component pin and then another pin.</li>
    </ol>

    <h2>Troubleshooting</h2>
    <table>
      <thead>
        <tr><th>Problem</th><th>Solution</th></tr>
      </thead>
      <tbody>
        <tr>
          <td><code>arduino-cli: command not found</code></td>
          <td>Install <code>arduino-cli</code> and add it to your PATH.</td>
        </tr>
        <tr>
          <td>LED doesn't blink</td>
          <td>Check the browser console for port listener errors; verify pin assignment in the component property dialog.</td>
        </tr>
        <tr>
          <td>Serial Monitor is empty</td>
          <td>Ensure <code>Serial.begin()</code> is called inside <code>setup()</code> before any <code>Serial.print()</code>.</td>
        </tr>
        <tr>
          <td>Compilation errors</td>
          <td>Check the compilation console at the bottom of the editor for full <code>arduino-cli</code> output.</td>
        </tr>
      </tbody>
    </table>
  </div>
);

const EmulatorSection: React.FC = () => (
  <div className="docs-section">
    <span className="docs-label">// internals</span>
    <h1>Emulator Architecture</h1>
    <p>
      Velxio uses <strong>real CPU emulation</strong> rather than a simplified model.
      This document describes how each layer of the simulation works.
    </p>

    <h2>High-Level Data Flow</h2>
    <pre><code>{`User Code (Monaco Editor)
        │
        ▼
   Zustand Store (useEditorStore)
        │
        ▼
  FastAPI Backend ──► arduino-cli ──► .hex / .uf2 file
        │
        ▼
  AVRSimulator / RP2040Simulator
        │ loadHex()
        ▼
  CPU execution loop (~60 FPS via requestAnimationFrame)
        │
        ▼
  Port listeners (PORTB / PORTC / PORTD)
        │
        ▼
  PinManager ──► Component state ──► React re-renders`}</code></pre>

    <h2>AVR8 Emulation (Arduino Uno / Nano / Mega)</h2>
    <p>
      The AVR backend uses <a href="https://github.com/wokwi/avr8js" target="_blank" rel="noopener noreferrer">avr8js</a>,
      which implements a complete ATmega328p / ATmega2560 processor.
    </p>

    <h3>Execution Loop</h3>
    <p>Each animation frame executes approximately 267,000 CPU cycles (16 MHz ÷ 60 FPS):</p>
    <pre><code>{`avrInstruction(cpu);  // decode and execute one AVR instruction
cpu.tick();           // advance peripheral timers and counters`}</code></pre>

    <h3>Supported Peripherals</h3>
    <table>
      <thead>
        <tr><th>Peripheral</th><th>Details</th></tr>
      </thead>
      <tbody>
        <tr><td>GPIO</td><td>PORTB (pins 8–13), PORTC (A0–A5), PORTD (pins 0–7)</td></tr>
        <tr><td>Timer0 / Timer1 / Timer2</td><td><code>millis()</code>, <code>delay()</code>, PWM via <code>analogWrite()</code></td></tr>
        <tr><td>USART</td><td>Full transmit and receive — powers the Serial Monitor</td></tr>
        <tr><td>ADC</td><td>10-bit, 5 V reference on pins A0–A5</td></tr>
        <tr><td>SPI</td><td>Hardware SPI (enables ILI9341, SD card, etc.)</td></tr>
        <tr><td>I2C (TWI)</td><td>Hardware I2C with virtual device bus</td></tr>
      </tbody>
    </table>

    <h3>Pin Mapping</h3>
    <table>
      <thead>
        <tr><th>Arduino Pin</th><th>AVR Port</th><th>Bit</th></tr>
      </thead>
      <tbody>
        <tr><td>0–7</td><td>PORTD</td><td>0–7</td></tr>
        <tr><td>8–13</td><td>PORTB</td><td>0–5</td></tr>
        <tr><td>A0–A5</td><td>PORTC</td><td>0–5</td></tr>
      </tbody>
    </table>

    <h2>RP2040 Emulation (Raspberry Pi Pico)</h2>
    <p>
      The RP2040 backend uses <a href="https://github.com/wokwi/rp2040js" target="_blank" rel="noopener noreferrer">rp2040js</a>.
    </p>
    <ul>
      <li>Real RP2040 emulation at 133 MHz</li>
      <li>UART0 serial output displayed in the Serial Monitor</li>
      <li>12-bit ADC on GPIO 26–29 (A0–A3) with 3.3 V reference</li>
    </ul>

    <h2>HEX File Format</h2>
    <p>Arduino compilation produces <strong>Intel HEX</strong> format. The parser in <code>hexParser.ts</code>:</p>
    <ol>
      <li>Reads lines starting with <code>:</code></li>
      <li>Extracts the address, record type, and data bytes</li>
      <li>Returns a <code>Uint8Array</code> of program bytes</li>
      <li><code>AVRSimulator</code> converts this to a <code>Uint16Array</code> (16-bit words, little-endian)</li>
    </ol>

    <h2>Key Source Files</h2>
    <table>
      <thead>
        <tr><th>File</th><th>Purpose</th></tr>
      </thead>
      <tbody>
        <tr><td><code>frontend/src/simulation/AVRSimulator.ts</code></td><td>AVR8 CPU emulator wrapper</td></tr>
        <tr><td><code>frontend/src/simulation/PinManager.ts</code></td><td>Maps Arduino pins to UI components</td></tr>
        <tr><td><code>frontend/src/utils/hexParser.ts</code></td><td>Intel HEX parser</td></tr>
        <tr><td><code>frontend/src/components/simulator/SimulatorCanvas.tsx</code></td><td>Canvas rendering</td></tr>
        <tr><td><code>backend/app/services/arduino_cli.py</code></td><td>arduino-cli wrapper</td></tr>
        <tr><td><code>backend/app/api/routes/compile.py</code></td><td>Compilation API endpoint</td></tr>
      </tbody>
    </table>
  </div>
);

const ComponentsSection: React.FC = () => (
  <div className="docs-section">
    <span className="docs-label">// reference</span>
    <h1>Components Reference</h1>
    <p>
      Velxio ships with <strong>48+ interactive electronic components</strong> powered by{' '}
      <a href="https://github.com/wokwi/wokwi-elements" target="_blank" rel="noopener noreferrer">wokwi-elements</a>.
      All components can be placed on the simulation canvas, connected with wires, and interact with your Arduino sketch in real time.
    </p>

    <h2>Adding Components</h2>
    <ol>
      <li>Click the <strong>+</strong> button on the simulation canvas.</li>
      <li>Use <strong>search</strong> or browse by <strong>category</strong> in the component picker.</li>
      <li>Click a component to place it on the canvas.</li>
      <li><strong>Drag</strong> to reposition; click to open the <strong>Property Dialog</strong>.</li>
    </ol>

    <h2>Connecting Components</h2>
    <ol>
      <li>Click a <strong>pin</strong> on any component — a wire starts from that pin.</li>
      <li>Click a <strong>destination pin</strong> to complete the connection.</li>
      <li>Wires are <strong>color-coded</strong> by signal type:</li>
    </ol>
    <table>
      <thead>
        <tr><th>Color</th><th>Signal Type</th></tr>
      </thead>
      <tbody>
        <tr><td><span className="wire-dot" style={{ background: '#ef4444' }} /> Red</td><td>VCC (power)</td></tr>
        <tr><td><span className="wire-dot" style={{ background: '#374151' }} /> Black</td><td>GND (ground)</td></tr>
        <tr><td><span className="wire-dot" style={{ background: '#3b82f6' }} /> Blue</td><td>Analog</td></tr>
        <tr><td><span className="wire-dot" style={{ background: '#22c55e' }} /> Green</td><td>Digital</td></tr>
        <tr><td><span className="wire-dot" style={{ background: '#a855f7' }} /> Purple</td><td>PWM</td></tr>
        <tr><td><span className="wire-dot" style={{ background: '#eab308' }} /> Gold</td><td>I2C (SDA/SCL)</td></tr>
        <tr><td><span className="wire-dot" style={{ background: '#f97316' }} /> Orange</td><td>SPI (MOSI/MISO/SCK)</td></tr>
        <tr><td><span className="wire-dot" style={{ background: '#06b6d4' }} /> Cyan</td><td>USART (TX/RX)</td></tr>
      </tbody>
    </table>

    <h2>Component Categories</h2>

    <h3>Output</h3>
    <table>
      <thead><tr><th>Component</th><th>Description</th></tr></thead>
      <tbody>
        <tr><td>LED</td><td>Single LED with configurable color</td></tr>
        <tr><td>RGB LED</td><td>Three-color LED (red, green, blue channels)</td></tr>
        <tr><td>7-Segment Display</td><td>Single digit numeric display</td></tr>
        <tr><td>LCD 16×2</td><td>2-line character LCD (I2C or parallel)</td></tr>
        <tr><td>LCD 20×4</td><td>4-line character LCD</td></tr>
        <tr><td>ILI9341 TFT</td><td>240×320 color TFT display (SPI)</td></tr>
        <tr><td>Buzzer</td><td>Passive piezo buzzer</td></tr>
        <tr><td>NeoPixel</td><td>Individually addressable RGB LED strip</td></tr>
      </tbody>
    </table>

    <h3>Input</h3>
    <table>
      <thead><tr><th>Component</th><th>Description</th></tr></thead>
      <tbody>
        <tr><td>Push Button</td><td>Momentary push button</td></tr>
        <tr><td>Slide Switch</td><td>SPDT slide switch</td></tr>
        <tr><td>Potentiometer</td><td>Analog voltage divider (ADC input)</td></tr>
        <tr><td>Rotary Encoder</td><td>Incremental rotary encoder</td></tr>
        <tr><td>Keypad 4×4</td><td>16-button matrix keypad</td></tr>
        <tr><td>Joystick</td><td>Dual-axis analog joystick</td></tr>
      </tbody>
    </table>

    <h3>Sensors</h3>
    <table>
      <thead><tr><th>Component</th><th>Description</th></tr></thead>
      <tbody>
        <tr><td>HC-SR04</td><td>Ultrasonic distance sensor</td></tr>
        <tr><td>DHT22</td><td>Temperature and humidity sensor</td></tr>
        <tr><td>PIR Motion</td><td>Passive infrared motion sensor</td></tr>
        <tr><td>Photoresistor</td><td>Light-dependent resistor (LDR)</td></tr>
        <tr><td>IR Receiver</td><td>38 kHz infrared receiver</td></tr>
      </tbody>
    </table>

    <h3>Passive Components</h3>
    <table>
      <thead><tr><th>Component</th><th>Description</th></tr></thead>
      <tbody>
        <tr><td>Resistor</td><td>Standard resistor (configurable value)</td></tr>
        <tr><td>Capacitor</td><td>Electrolytic capacitor</td></tr>
        <tr><td>Inductor</td><td>Coil inductor</td></tr>
      </tbody>
    </table>

    <h2>Component Properties</h2>
    <p>Each component has a <strong>Property Dialog</strong> accessible by clicking it on the canvas:</p>
    <table>
      <thead><tr><th>Property</th><th>Description</th></tr></thead>
      <tbody>
        <tr><td>Arduino Pin</td><td>The digital or analog pin this component is connected to</td></tr>
        <tr><td>Color</td><td>Visual color (LEDs, wires)</td></tr>
        <tr><td>Value</td><td>Component value (e.g., resistance in Ω)</td></tr>
        <tr><td>Rotation</td><td>Rotate in 90° increments</td></tr>
        <tr><td>Delete</td><td>Remove the component from the canvas</td></tr>
      </tbody>
    </table>
  </div>
);

const RoadmapSection: React.FC = () => (
  <div className="docs-section">
    <span className="docs-label">// future</span>
    <h1>Roadmap</h1>
    <p>Features that are implemented, in progress, and planned for future releases of Velxio.</p>

    <h2>✅ Implemented</h2>
    <ul>
      <li>Monaco Editor with C++ syntax highlighting, autocomplete, and minimap</li>
      <li>Multi-file workspace — create, rename, delete, and switch between files</li>
      <li>Arduino compilation via <code>arduino-cli</code> (multi-file sketch support)</li>
      <li>Real ATmega328p / ATmega2560 emulation at 16 MHz via avr8js</li>
      <li>Full GPIO, Timers, USART, ADC, SPI, I2C support</li>
      <li>Real RP2040 emulation at 133 MHz via rp2040js</li>
      <li>48+ wokwi-elements components with component picker</li>
      <li>Wire creation, orthogonal routing, and segment-based editing</li>
      <li>Serial Monitor with auto baud-rate detection and send support</li>
      <li>Library Manager (browse and install Arduino libraries)</li>
      <li>Email/password and Google OAuth authentication</li>
      <li>Project save, update, delete with permanent URLs</li>
      <li>8 built-in example projects</li>
      <li>Single-container Docker image published to GHCR + Docker Hub</li>
    </ul>

    <h2>🔄 In Progress</h2>
    <ul>
      <li>Functional wire connections — electrical signal routing and validation</li>
      <li>Wire connection error handling — detect short circuits and invalid connections</li>
    </ul>

    <h2>🗓 Planned — Near-Term</h2>
    <ul>
      <li>Undo / redo for code edits and canvas changes</li>
      <li>Export / import projects as <code>.zip</code> files</li>
      <li>More boards — ESP32, Arduino Leonardo</li>
      <li>Breadboard — place components with automatic wire routing</li>
    </ul>

    <h2>🗓 Planned — Mid-Term</h2>
    <ul>
      <li>TypeDoc API documentation — auto-generated from source code</li>
      <li>GitHub Pages docs site — automatic deployment on push to <code>main</code></li>
      <li>More sensor simulations — HC-SR04, DHT22, IR receiver</li>
      <li>EEPROM emulation — persistent read/write across simulation restarts</li>
      <li>Oscilloscope component — plot analog pin voltages over time</li>
    </ul>

    <h2>🗓 Planned — Long-Term</h2>
    <ul>
      <li>Multiplayer — share and co-edit simulations in real time</li>
      <li>Embedded tutorial system — step-by-step guided projects inside the editor</li>
      <li>Custom component SDK — define new components with a JSON/TypeScript API</li>
      <li>Mobile / tablet support — responsive layout for touch devices</li>
    </ul>

    <div className="docs-callout">
      <strong>Want to contribute?</strong>{' '}
      Feature requests, bug reports, and pull requests are welcome at{' '}
      <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer">github.com/davidmonterocrespo24/velxio</a>.
    </div>
  </div>
);

const SECTION_MAP: Record<SectionId, React.FC> = {
  intro: IntroSection,
  'getting-started': GettingStartedSection,
  emulator: EmulatorSection,
  components: ComponentsSection,
  roadmap: RoadmapSection,
};

/* ── Page ─────────────────────────────────────────────── */
export const DocsPage: React.FC = () => {
  const [activeSection, setActiveSection] = useState<SectionId>('intro');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const user = useAuthStore((s) => s.user);

  const ActiveContent = SECTION_MAP[activeSection];

  return (
    <div className="docs-page">
      {/* Nav */}
      <nav className="docs-nav">
        <Link to="/" className="docs-nav-brand">
          <IcoChip />
          <span>Velxio</span>
        </Link>
        <span className="docs-nav-divider">/</span>
        <span className="docs-nav-section">Docs</span>
        <div className="docs-nav-links">
          <Link to="/examples" className="docs-nav-link">Examples</Link>
          <Link to="/editor" className="docs-nav-link">Editor</Link>
          <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer" className="docs-nav-link">
            <IcoGitHub /> GitHub
          </a>
          {user ? (
            <Link to={`/${user.username}`} className="docs-nav-btn">My Projects</Link>
          ) : (
            <Link to="/login" className="docs-nav-btn">Sign in</Link>
          )}
        </div>
        <button
          className="docs-sidebar-toggle"
          onClick={() => setSidebarOpen((v) => !v)}
          aria-label="Toggle sidebar"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <line x1="3" y1="6" x2="21" y2="6" />
            <line x1="3" y1="12" x2="21" y2="12" />
            <line x1="3" y1="18" x2="21" y2="18" />
          </svg>
        </button>
      </nav>

      <div className="docs-body">
        {/* Sidebar */}
        <aside className={`docs-sidebar${sidebarOpen ? ' docs-sidebar--open' : ''}`}>
          <div className="docs-sidebar-title">Documentation</div>
          <nav className="docs-sidebar-nav">
            {NAV_ITEMS.map((item) => (
              <button
                key={item.id}
                className={`docs-sidebar-item${activeSection === item.id ? ' docs-sidebar-item--active' : ''}`}
                onClick={() => { setActiveSection(item.id); setSidebarOpen(false); }}
              >
                {item.label}
              </button>
            ))}
          </nav>
          <div className="docs-sidebar-footer">
            <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer" className="docs-sidebar-gh">
              <IcoGitHub /> View on GitHub
            </a>
          </div>
        </aside>

        {/* Main content */}
        <main className="docs-main">
          <ActiveContent />

          {/* Prev / Next navigation */}
          <div className="docs-pagination">
            {NAV_ITEMS.findIndex((i) => i.id === activeSection) > 0 && (
              <button
                className="docs-pagination-btn docs-pagination-btn--prev"
                onClick={() => {
                  const idx = NAV_ITEMS.findIndex((i) => i.id === activeSection);
                  setActiveSection(NAV_ITEMS[idx - 1].id);
                  window.scrollTo(0, 0);
                }}
              >
                ← {NAV_ITEMS[NAV_ITEMS.findIndex((i) => i.id === activeSection) - 1].label}
              </button>
            )}
            {NAV_ITEMS.findIndex((i) => i.id === activeSection) < NAV_ITEMS.length - 1 && (
              <button
                className="docs-pagination-btn docs-pagination-btn--next"
                onClick={() => {
                  const idx = NAV_ITEMS.findIndex((i) => i.id === activeSection);
                  setActiveSection(NAV_ITEMS[idx + 1].id);
                  window.scrollTo(0, 0);
                }}
              >
                {NAV_ITEMS[NAV_ITEMS.findIndex((i) => i.id === activeSection) + 1].label} →
              </button>
            )}
          </div>
        </main>
      </div>
    </div>
  );
};
