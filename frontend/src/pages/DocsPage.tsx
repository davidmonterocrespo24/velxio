import React, { useState, useEffect } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { AppHeader } from '../components/layout/AppHeader';
import { CodeBlock } from '../components/layout/CodeBlock';
import './DocsPage.css';

const GITHUB_URL = 'https://github.com/davidmonterocrespo24/velxio';
const BASE_URL = 'https://velxio.dev';
const AUTHOR = {
  '@type': 'Person',
  name: 'David Montero Crespo',
  url: 'https://github.com/davidmonterocrespo24',
} as const;

/* ── Icons ─────────────────────────────────────────────── */
const IcoGitHub = () => (
  <svg viewBox="0 0 24 24" fill="currentColor">
    <path d="M12 0C5.37 0 0 5.37 0 12c0 5.3 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61-.546-1.385-1.335-1.755-1.335-1.755-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 21.795 24 17.295 24 12c0-6.63-5.37-12-12-12z" />
  </svg>
);

/* ── Doc sections ──────────────────────────────────────── */
type SectionId =
  | 'intro'
  | 'getting-started'
  | 'emulator'
  | 'riscv-emulation'
  | 'esp32-emulation'
  | 'rp2040-emulation'
  | 'raspberry-pi3-emulation'
  | 'components'
  | 'roadmap'
  | 'architecture'
  | 'wokwi-libs'
  | 'mcp'
  | 'setup';

const VALID_SECTIONS: SectionId[] = [
  'intro',
  'getting-started',
  'emulator',
  'riscv-emulation',
  'esp32-emulation',
  'rp2040-emulation',
  'raspberry-pi3-emulation',
  'components',
  'roadmap',
  'architecture',
  'wokwi-libs',
  'mcp',
  'setup',
];

interface NavItem {
  id: SectionId;
  label: string;
}

const NAV_ITEMS: NavItem[] = [
  { id: 'intro', label: 'Introduction' },
  { id: 'getting-started', label: 'Getting Started' },
  { id: 'emulator', label: 'Emulator Architecture' },
  { id: 'riscv-emulation', label: 'RISC-V Emulation (ESP32-C3)' },
  { id: 'esp32-emulation', label: 'ESP32 Emulation (Xtensa)' },
  { id: 'rp2040-emulation', label: 'RP2040 Emulation (Raspberry Pi Pico)' },
  { id: 'raspberry-pi3-emulation', label: 'Raspberry Pi 3 Emulation (QEMU)' },
  { id: 'components', label: 'Components Reference' },
  { id: 'architecture', label: 'Project Architecture' },
  { id: 'wokwi-libs', label: 'Wokwi Libraries' },
  { id: 'mcp', label: 'MCP Server' },
  { id: 'setup', label: 'Project Status' },
  { id: 'roadmap', label: 'Roadmap' },
];

/* ── Per-section SEO metadata ──────────────────────────── */
interface SectionMeta {
  title: string;
  description: string;
}
const SECTION_META: Record<SectionId, SectionMeta> = {
  intro: {
    title: 'Introduction | Velxio Documentation',
    description:
      'Learn about Velxio, the free open-source Arduino emulator with real AVR8 and RP2040 CPU emulation and 48+ interactive electronic components.',
  },
  'getting-started': {
    title: 'Getting Started | Velxio Documentation',
    description:
      'Get started with Velxio: use the hosted editor, self-host with Docker, or set up a local development environment. Simulate your first Arduino sketch in minutes.',
  },
  emulator: {
    title: 'Emulator Architecture | Velxio Documentation',
    description:
      'How Velxio emulates AVR8 (ATmega328p), RP2040, and RISC-V (ESP32-C3) CPUs. Covers execution loops, peripherals, and pin mapping for all supported boards.',
  },
  'riscv-emulation': {
    title: 'RISC-V Emulation (ESP32-C3) | Velxio Documentation',
    description:
      'Browser-side RV32IMC emulator for ESP32-C3, XIAO ESP32-C3, and C3 SuperMini. Covers memory map, GPIO, UART0, the ESP32 image parser, RV32IMC ISA, and test suite.',
  },
  'esp32-emulation': {
    title: 'ESP32 Emulation (Xtensa) | Velxio Documentation',
    description:
      'QEMU-based emulation for ESP32 and ESP32-S3 (Xtensa LX6/LX7). Covers the lcgamboa fork, libqemu-xtensa, GPIO, WiFi, I2C, SPI, RMT/NeoPixel, and LEDC/PWM.',
  },
  components: {
    title: 'Components Reference | Velxio Documentation',
    description:
      'Full reference for all 48+ interactive electronic components in Velxio: LEDs, displays, sensors, buttons, potentiometers, and more. Includes wiring and property details.',
  },
  roadmap: {
    title: 'Roadmap | Velxio Documentation',
    description:
      "Velxio's feature roadmap: what's implemented, what's in progress, and what's planned for future releases.",
  },
  architecture: {
    title: 'Project Architecture | Velxio Documentation',
    description:
      'Detailed overview of the Velxio system architecture: frontend, backend, AVR8 emulation pipeline, data flows, Zustand stores, and wire system.',
  },
  'wokwi-libs': {
    title: 'Wokwi Libraries | Velxio Documentation',
    description:
      'How Velxio integrates the official Wokwi open-source libraries: avr8js, wokwi-elements, and rp2040js. Covers configuration, updates, and the 48 available components.',
  },
  mcp: {
    title: 'MCP Server | Velxio Documentation',
    description:
      'Velxio MCP Server reference: integrate AI agents (Claude, Cursor) with Velxio via Model Context Protocol. Covers tools, transports, circuit format, and example walkthroughs.',
  },
  setup: {
    title: 'Project Status | Velxio Documentation',
    description:
      'Complete status of all implemented Velxio features: AVR emulation, component system, wire system, code editor, example projects, and next steps.',
  },
  'rp2040-emulation': {
    title: 'RP2040 Emulation (Raspberry Pi Pico) | Velxio Documentation',
    description:
      'How Velxio emulates the Raspberry Pi Pico and Pico W using rp2040js: ARM Cortex-M0+ at 133 MHz, GPIO, UART, ADC, I2C, SPI, PWM and WFI optimization.',
  },
  'raspberry-pi3-emulation': {
    title: 'Raspberry Pi 3 Emulation (QEMU) | Velxio Documentation',
    description:
      'How Velxio emulates a full Raspberry Pi 3B using QEMU raspi3b: real Raspberry Pi OS, Python + RPi.GPIO shim, dual-channel UART, VFS, and multi-board serial bridge.',
  },
};

/* ── Section content ───────────────────────────────────── */
const IntroSection: React.FC = () => (
  <div className="docs-section">
    <span className="docs-label">// overview</span>
    <h1>Introduction</h1>
    <p>
      <strong>Velxio</strong> is a fully local, open-source Arduino emulator that runs entirely in
      your browser. Write Arduino C++ code, compile it with a real <code>arduino-cli</code> backend,
      and simulate it using true AVR8 / RP2040 CPU emulation, with 48+ interactive electronic
      components, all without installing any software on your machine.
    </p>

    <h2>Why Velxio?</h2>
    <ul>
      <li>
        <strong>No installation required</strong>: everything runs in the browser.
      </li>
      <li>
        <strong>Real emulation</strong>: not a simplified model, but accurate AVR8 / RP2040 CPU
        emulation.
      </li>
      <li>
        <strong>Interactive components</strong>: LEDs, buttons, potentiometers, displays, sensors,
        and more.
      </li>
      <li>
        <strong>Open-source</strong>: inspect, modify, and self-host it yourself.
      </li>
    </ul>

    <h2>Supported Boards</h2>
    <table>
      <thead>
        <tr>
          <th>Board</th>
          <th>CPU</th>
          <th>Emulator</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>Arduino Uno</td>
          <td>ATmega328p @ 16 MHz</td>
          <td>avr8js</td>
        </tr>
        <tr>
          <td>Arduino Nano</td>
          <td>ATmega328p @ 16 MHz</td>
          <td>avr8js</td>
        </tr>
        <tr>
          <td>Arduino Mega</td>
          <td>ATmega2560 @ 16 MHz</td>
          <td>avr8js</td>
        </tr>
        <tr>
          <td>Raspberry Pi Pico</td>
          <td>RP2040 @ 133 MHz</td>
          <td>rp2040js</td>
        </tr>
        <tr>
          <td>ESP32-C3 / XIAO C3 / C3 SuperMini</td>
          <td>RV32IMC @ 160 MHz</td>
          <td>Esp32C3Simulator (browser)</td>
        </tr>
        <tr>
          <td>ESP32 / ESP32-S3</td>
          <td>Xtensa LX6/LX7 @ 240 MHz</td>
          <td>QEMU (lcgamboa)</td>
        </tr>
      </tbody>
    </table>

    <div className="docs-callout">
      <strong>Live Demo:</strong>{' '}
      <a href="https://velxio.dev" target="_blank" rel="noopener noreferrer">
        velxio.dev
      </a>{' '}
      , no installation needed, open the editor and start simulating immediately.
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
      No installation needed, go to{' '}
      <a href="https://velxio.dev" target="_blank" rel="noopener noreferrer">
        https://velxio.dev
      </a>{' '}
      and start coding immediately.
    </p>

    <h2>Option 2: Self-Host with Docker</h2>
    <p>Run a single Docker command to start a fully local instance:</p>
    <CodeBlock language="bash">{`docker run -d \\
  --name velxio \\
  -p 3080:80 \\
  -v $(pwd)/data:/app/data \\
  ghcr.io/davidmonterocrespo24/velxio:master`}</CodeBlock>
    <p>
      Then open <strong>http://localhost:3080</strong> in your browser.
    </p>

    <h2>Option 3: Manual Setup (Development)</h2>
    <p>
      <strong>Prerequisites:</strong> Node.js 18+, Python 3.12+, <code>arduino-cli</code>
    </p>

    <h3>1. Clone the repository</h3>
    <CodeBlock language="bash">{`git clone https://github.com/davidmonterocrespo24/velxio.git
cd velxio`}</CodeBlock>

    <h3>2. Start the backend</h3>
    <CodeBlock language="bash">{`cd backend
python -m venv venv && source venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8001`}</CodeBlock>

    <h3>3. Start the frontend</h3>
    <CodeBlock language="bash">{`cd frontend
npm install
npm run dev`}</CodeBlock>
    <p>
      Open <strong>http://localhost:5173</strong>.
    </p>

    <h3>4. Set up arduino-cli (first time)</h3>
    <CodeBlock language="bash">{`arduino-cli core update-index
arduino-cli core install arduino:avr

# For Raspberry Pi Pico support:
arduino-cli config add board_manager.additional_urls \\
  https://github.com/earlephilhower/arduino-pico/releases/download/global/package_rp2040_index.json
arduino-cli core install rp2040:rp2040`}</CodeBlock>

    <h2>Your First Simulation</h2>
    <ol>
      <li>
        <strong>Open the editor</strong> at{' '}
        <a href="https://velxio.dev/editor" target="_blank" rel="noopener noreferrer">
          velxio.dev/editor
        </a>
        .
      </li>
      <li>
        <strong>Select a board</strong> from the toolbar (e.g., <em>Arduino Uno</em>).
      </li>
      <li>
        <strong>Write Arduino code</strong> in the Monaco editor, for example:
      </li>
    </ol>
    <CodeBlock language="cpp">{`void setup() {
  pinMode(13, OUTPUT);
}

void loop() {
  digitalWrite(13, HIGH);
  delay(500);
  digitalWrite(13, LOW);
  delay(500);
}`}</CodeBlock>
    <ol start={4}>
      <li>
        <strong>Click Compile</strong>: the backend calls <code>arduino-cli</code> and returns a{' '}
        <code>.hex</code> file.
      </li>
      <li>
        <strong>Click Run</strong>: the AVR8 emulator executes the compiled program.
      </li>
      <li>
        <strong>Add components</strong> using the component picker (click the <strong>+</strong>{' '}
        button on the canvas).
      </li>
      <li>
        <strong>Connect wires</strong> by clicking a component pin and then another pin.
      </li>
    </ol>

    <h2>Troubleshooting</h2>
    <table>
      <thead>
        <tr>
          <th>Problem</th>
          <th>Solution</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>
            <code>arduino-cli: command not found</code>
          </td>
          <td>
            Install <code>arduino-cli</code> and add it to your PATH.
          </td>
        </tr>
        <tr>
          <td>LED doesn't blink</td>
          <td>
            Check the browser console for port listener errors; verify pin assignment in the
            component property dialog.
          </td>
        </tr>
        <tr>
          <td>Serial Monitor is empty</td>
          <td>
            Ensure <code>Serial.begin()</code> is called inside <code>setup()</code> before any{' '}
            <code>Serial.print()</code>.
          </td>
        </tr>
        <tr>
          <td>Compilation errors</td>
          <td>
            Check the compilation console at the bottom of the editor for full{' '}
            <code>arduino-cli</code> output.
          </td>
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
      Velxio uses <strong>real CPU emulation</strong> rather than a simplified model. This document
      describes how each layer of the simulation works.
    </p>

    <h2>High-Level Data Flow</h2>
    <CodeBlock language="text">{`User Code (Monaco Editor)
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
  PinManager ──► Component state ──► React re-renders`}</CodeBlock>

    <h2>AVR8 Emulation (Arduino Uno / Nano / Mega)</h2>
    <p>
      The AVR backend uses{' '}
      <a href="https://github.com/wokwi/avr8js" target="_blank" rel="noopener noreferrer">
        avr8js
      </a>
      , which implements a complete ATmega328p / ATmega2560 processor.
    </p>

    <h3>Execution Loop</h3>
    <p>Each animation frame executes approximately 267,000 CPU cycles (16 MHz ÷ 60 FPS):</p>
    <CodeBlock language="typescript">{`avrInstruction(cpu);  // decode and execute one AVR instruction
cpu.tick();           // advance peripheral timers and counters`}</CodeBlock>

    <h3>Supported Peripherals</h3>
    <table>
      <thead>
        <tr>
          <th>Peripheral</th>
          <th>Details</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>GPIO</td>
          <td>PORTB (pins 8–13), PORTC (A0–A5), PORTD (pins 0–7)</td>
        </tr>
        <tr>
          <td>Timer0 / Timer1 / Timer2</td>
          <td>
            <code>millis()</code>, <code>delay()</code>, PWM via <code>analogWrite()</code>
          </td>
        </tr>
        <tr>
          <td>USART</td>
          <td>Full transmit and receive, powers the Serial Monitor</td>
        </tr>
        <tr>
          <td>ADC</td>
          <td>10-bit, 5 V reference on pins A0–A5</td>
        </tr>
        <tr>
          <td>SPI</td>
          <td>Hardware SPI (enables ILI9341, SD card, etc.)</td>
        </tr>
        <tr>
          <td>I2C (TWI)</td>
          <td>Hardware I2C with virtual device bus</td>
        </tr>
      </tbody>
    </table>

    <h3>Pin Mapping</h3>
    <table>
      <thead>
        <tr>
          <th>Arduino Pin</th>
          <th>AVR Port</th>
          <th>Bit</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>0–7</td>
          <td>PORTD</td>
          <td>0–7</td>
        </tr>
        <tr>
          <td>8–13</td>
          <td>PORTB</td>
          <td>0–5</td>
        </tr>
        <tr>
          <td>A0–A5</td>
          <td>PORTC</td>
          <td>0–5</td>
        </tr>
      </tbody>
    </table>

    <h2>RP2040 Emulation (Raspberry Pi Pico)</h2>
    <p>
      The RP2040 backend uses{' '}
      <a href="https://github.com/wokwi/rp2040js" target="_blank" rel="noopener noreferrer">
        rp2040js
      </a>
      .
    </p>
    <ul>
      <li>Real RP2040 emulation at 133 MHz</li>
      <li>UART0 serial output displayed in the Serial Monitor</li>
      <li>12-bit ADC on GPIO 26–29 (A0–A3) with 3.3 V reference</li>
    </ul>

    <h2>HEX File Format</h2>
    <p>
      Arduino compilation produces <strong>Intel HEX</strong> format. The parser in{' '}
      <code>hexParser.ts</code>:
    </p>
    <ol>
      <li>
        Reads lines starting with <code>:</code>
      </li>
      <li>Extracts the address, record type, and data bytes</li>
      <li>
        Returns a <code>Uint8Array</code> of program bytes
      </li>
      <li>
        <code>AVRSimulator</code> converts this to a <code>Uint16Array</code> (16-bit words,
        little-endian)
      </li>
    </ol>

    <h2>Key Source Files</h2>
    <table>
      <thead>
        <tr>
          <th>File</th>
          <th>Purpose</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>
            <code>frontend/src/simulation/AVRSimulator.ts</code>
          </td>
          <td>AVR8 CPU emulator wrapper</td>
        </tr>
        <tr>
          <td>
            <code>frontend/src/simulation/PinManager.ts</code>
          </td>
          <td>Maps Arduino pins to UI components</td>
        </tr>
        <tr>
          <td>
            <code>frontend/src/utils/hexParser.ts</code>
          </td>
          <td>Intel HEX parser</td>
        </tr>
        <tr>
          <td>
            <code>frontend/src/components/simulator/SimulatorCanvas.tsx</code>
          </td>
          <td>Canvas rendering</td>
        </tr>
        <tr>
          <td>
            <code>backend/app/services/arduino_cli.py</code>
          </td>
          <td>arduino-cli wrapper</td>
        </tr>
        <tr>
          <td>
            <code>backend/app/api/routes/compile.py</code>
          </td>
          <td>Compilation API endpoint</td>
        </tr>
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
      <a href="https://github.com/wokwi/wokwi-elements" target="_blank" rel="noopener noreferrer">
        wokwi-elements
      </a>
      . All components can be placed on the simulation canvas, connected with wires, and interact
      with your Arduino sketch in real time.
    </p>

    <h2>Adding Components</h2>
    <ol>
      <li>
        Click the <strong>+</strong> button on the simulation canvas.
      </li>
      <li>
        Use <strong>search</strong> or browse by <strong>category</strong> in the component picker.
      </li>
      <li>Click a component to place it on the canvas.</li>
      <li>
        <strong>Drag</strong> to reposition; click to open the <strong>Property Dialog</strong>.
      </li>
    </ol>

    <h2>Connecting Components</h2>
    <ol>
      <li>
        Click a <strong>pin</strong> on any component, a wire starts from that pin.
      </li>
      <li>
        Click a <strong>destination pin</strong> to complete the connection.
      </li>
      <li>
        Wires are <strong>color-coded</strong> by signal type:
      </li>
    </ol>
    <table>
      <thead>
        <tr>
          <th>Color</th>
          <th>Signal Type</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>
            <span className="wire-dot" style={{ background: '#ef4444' }} /> Red
          </td>
          <td>VCC (power)</td>
        </tr>
        <tr>
          <td>
            <span className="wire-dot" style={{ background: '#374151' }} /> Black
          </td>
          <td>GND (ground)</td>
        </tr>
        <tr>
          <td>
            <span className="wire-dot" style={{ background: '#3b82f6' }} /> Blue
          </td>
          <td>Analog</td>
        </tr>
        <tr>
          <td>
            <span className="wire-dot" style={{ background: '#22c55e' }} /> Green
          </td>
          <td>Digital</td>
        </tr>
        <tr>
          <td>
            <span className="wire-dot" style={{ background: '#a855f7' }} /> Purple
          </td>
          <td>PWM</td>
        </tr>
        <tr>
          <td>
            <span className="wire-dot" style={{ background: '#eab308' }} /> Gold
          </td>
          <td>I2C (SDA/SCL)</td>
        </tr>
        <tr>
          <td>
            <span className="wire-dot" style={{ background: '#f97316' }} /> Orange
          </td>
          <td>SPI (MOSI/MISO/SCK)</td>
        </tr>
        <tr>
          <td>
            <span className="wire-dot" style={{ background: '#06b6d4' }} /> Cyan
          </td>
          <td>USART (TX/RX)</td>
        </tr>
      </tbody>
    </table>

    <h2>Component Categories</h2>

    <h3>Output</h3>
    <table>
      <thead>
        <tr>
          <th>Component</th>
          <th>Description</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>LED</td>
          <td>Single LED with configurable color</td>
        </tr>
        <tr>
          <td>RGB LED</td>
          <td>Three-color LED (red, green, blue channels)</td>
        </tr>
        <tr>
          <td>7-Segment Display</td>
          <td>Single digit numeric display</td>
        </tr>
        <tr>
          <td>LCD 16×2</td>
          <td>2-line character LCD (I2C or parallel)</td>
        </tr>
        <tr>
          <td>LCD 20×4</td>
          <td>4-line character LCD</td>
        </tr>
        <tr>
          <td>ILI9341 TFT</td>
          <td>240×320 color TFT display (SPI)</td>
        </tr>
        <tr>
          <td>Buzzer</td>
          <td>Passive piezo buzzer</td>
        </tr>
        <tr>
          <td>NeoPixel</td>
          <td>Individually addressable RGB LED strip</td>
        </tr>
      </tbody>
    </table>

    <h3>Input</h3>
    <table>
      <thead>
        <tr>
          <th>Component</th>
          <th>Description</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>Push Button</td>
          <td>Momentary push button</td>
        </tr>
        <tr>
          <td>Slide Switch</td>
          <td>SPDT slide switch</td>
        </tr>
        <tr>
          <td>Potentiometer</td>
          <td>Analog voltage divider (ADC input)</td>
        </tr>
        <tr>
          <td>Rotary Encoder</td>
          <td>Incremental rotary encoder</td>
        </tr>
        <tr>
          <td>Keypad 4×4</td>
          <td>16-button matrix keypad</td>
        </tr>
        <tr>
          <td>Joystick</td>
          <td>Dual-axis analog joystick</td>
        </tr>
      </tbody>
    </table>

    <h3>Sensors</h3>
    <table>
      <thead>
        <tr>
          <th>Component</th>
          <th>Description</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>HC-SR04</td>
          <td>Ultrasonic distance sensor</td>
        </tr>
        <tr>
          <td>DHT22</td>
          <td>Temperature and humidity sensor</td>
        </tr>
        <tr>
          <td>PIR Motion</td>
          <td>Passive infrared motion sensor</td>
        </tr>
        <tr>
          <td>Photoresistor</td>
          <td>Light-dependent resistor (LDR)</td>
        </tr>
        <tr>
          <td>IR Receiver</td>
          <td>38 kHz infrared receiver</td>
        </tr>
      </tbody>
    </table>

    <h3>Passive Components</h3>
    <table>
      <thead>
        <tr>
          <th>Component</th>
          <th>Description</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>Resistor</td>
          <td>Standard resistor (configurable value)</td>
        </tr>
        <tr>
          <td>Capacitor</td>
          <td>Electrolytic capacitor</td>
        </tr>
        <tr>
          <td>Inductor</td>
          <td>Coil inductor</td>
        </tr>
      </tbody>
    </table>

    <h2>Component Properties</h2>
    <p>
      Each component has a <strong>Property Dialog</strong> accessible by clicking it on the canvas:
    </p>
    <table>
      <thead>
        <tr>
          <th>Property</th>
          <th>Description</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>Arduino Pin</td>
          <td>The digital or analog pin this component is connected to</td>
        </tr>
        <tr>
          <td>Color</td>
          <td>Visual color (LEDs, wires)</td>
        </tr>
        <tr>
          <td>Value</td>
          <td>Component value (e.g., resistance in Ω)</td>
        </tr>
        <tr>
          <td>Rotation</td>
          <td>Rotate in 90° increments</td>
        </tr>
        <tr>
          <td>Delete</td>
          <td>Remove the component from the canvas</td>
        </tr>
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
      <li>Multi-file workspace, create, rename, delete, and switch between files</li>
      <li>
        Arduino compilation via <code>arduino-cli</code> (multi-file sketch support)
      </li>
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
      <li>Functional wire connections, electrical signal routing and validation</li>
      <li>Wire connection error handling, detect short circuits and invalid connections</li>
    </ul>

    <h2>🗓 Planned: Near-Term</h2>
    <ul>
      <li>Undo / redo for code edits and canvas changes</li>
      <li>
        Export / import projects as <code>.zip</code> files
      </li>
      <li>More boards, ESP32, Arduino Leonardo</li>
      <li>Breadboard, place components with automatic wire routing</li>
    </ul>

    <h2>🗓 Planned: Mid-Term</h2>
    <ul>
      <li>TypeDoc API documentation, auto-generated from source code</li>
      <li>
        GitHub Pages docs site, automatic deployment on push to <code>main</code>
      </li>
      <li>More sensor simulations, HC-SR04, DHT22, IR receiver</li>
      <li>EEPROM emulation, persistent read/write across simulation restarts</li>
      <li>Oscilloscope component, plot analog pin voltages over time</li>
    </ul>

    <h2>🗓 Planned: Long-Term</h2>
    <ul>
      <li>Multiplayer, share and co-edit simulations in real time</li>
      <li>Embedded tutorial system, step-by-step guided projects inside the editor</li>
      <li>Custom component SDK, define new components with a JSON/TypeScript API</li>
      <li>Mobile / tablet support, responsive layout for touch devices</li>
    </ul>

    <div className="docs-callout">
      <strong>Want to contribute?</strong> Feature requests, bug reports, and pull requests are
      welcome at{' '}
      <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer">
        github.com/davidmonterocrespo24/velxio
      </a>
      .
    </div>
  </div>
);

/* ── Architecture Section ─────────────────────────────── */
const ArchitectureSection: React.FC = () => (
  <div className="docs-section">
    <span className="docs-label">// system design</span>
    <h1>Project Architecture</h1>
    <p>
      Velxio is a fully local Arduino emulator using official Wokwi repositories for maximum
      compatibility. It features real AVR8 CPU emulation, 48+ interactive electronic components, a
      comprehensive wire system, and a build-time component discovery pipeline.
    </p>

    <h2>High-Level Overview</h2>
    <CodeBlock language="text">{`Browser (React + Vite)
  ├── Monaco Editor ──► useEditorStore (Zustand)
  ├── SimulatorCanvas ──► useSimulatorStore (Zustand)
  │     ├── AVRSimulator (avr8js)   16 MHz AVR8 CPU
  │     ├── RP2040Simulator (rp2040js)
  │     ├── PinManager              pin → component mapping
  │     ├── PartSimulationRegistry  16 interactive parts
  │     └── 48+ wokwi-elements      Lit Web Components
  └── HTTP (Axios) ──► FastAPI Backend (port 8001)
        └── ArduinoCLIService ──► arduino-cli subprocess`}</CodeBlock>

    <h2>Data Flows</h2>

    <h3>1. Compilation</h3>
    <CodeBlock language="text">{`Click "Compile"
  → EditorToolbar reads all workspace files
  → POST /api/compile/  { files, board_fqbn }
  → Backend: ArduinoCLIService writes temp dir
  → arduino-cli compile --fqbn <board> --output-dir build/
  → Returns hex_content (Intel HEX string)
  → useSimulatorStore.setCompiledHex() → loadHex()`}</CodeBlock>

    <h3>2. Simulation Loop</h3>
    <CodeBlock language="text">{`Click "Run"
  → AVRSimulator.start()
  → requestAnimationFrame loop @ ~60 FPS
  → Each frame: Math.floor(267 000 × speed) cycles
    ├── avrInstruction(cpu)   — decode + execute one AVR instruction
    └── cpu.tick()            — advance Timer0/1/2, USART, ADC
  → PORTB/C/D write listeners fire
  → PinManager.updatePort() → per-pin callbacks
  → PartSimulationRegistry.onPinStateChange()
  → wokwi-elements update visually`}</CodeBlock>

    <h3>3. Input Components</h3>
    <CodeBlock language="text">{`User presses button on canvas
  → wokwi web component fires 'button-press' event
  → DynamicComponent catches event
  → PartSimulationRegistry.attachEvents() handler
  → AVRSimulator.setPinState(arduinoPin, LOW)
  → AVRIOPort.setPin() injects external pin state
  → CPU reads pin in next instruction`}</CodeBlock>

    <h2>Key Frontend Stores (Zustand)</h2>
    <table>
      <thead>
        <tr>
          <th>Store</th>
          <th>Key State</th>
          <th>Purpose</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>
            <code>useEditorStore</code>
          </td>
          <td>files[], activeFileId</td>
          <td>Multi-file Monaco workspace</td>
        </tr>
        <tr>
          <td>
            <code>useSimulatorStore</code>
          </td>
          <td>simulator, components, wires, running</td>
          <td>Simulation + canvas state</td>
        </tr>
        <tr>
          <td>
            <code>useAuthStore</code>
          </td>
          <td>user, token</td>
          <td>Auth (persisted localStorage)</td>
        </tr>
        <tr>
          <td>
            <code>useProjectStore</code>
          </td>
          <td>projectId, slug</td>
          <td>Currently open project</td>
        </tr>
      </tbody>
    </table>

    <h2>Backend Routes</h2>
    <table>
      <thead>
        <tr>
          <th>Route</th>
          <th>Description</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>
            <code>POST /api/compile/</code>
          </td>
          <td>Compile sketch files → Intel HEX / UF2</td>
        </tr>
        <tr>
          <td>
            <code>GET /api/compile/boards</code>
          </td>
          <td>List available boards</td>
        </tr>
        <tr>
          <td>
            <code>GET/POST /api/auth/*</code>
          </td>
          <td>Email/password + Google OAuth</td>
        </tr>
        <tr>
          <td>
            <code>GET/POST /api/projects/*</code>
          </td>
          <td>CRUD project persistence (SQLite)</td>
        </tr>
        <tr>
          <td>
            <code>GET /api/libraries/*</code>
          </td>
          <td>Arduino Library Manager integration</td>
        </tr>
        <tr>
          <td>
            <code>GET /health</code>
          </td>
          <td>Health check endpoint</td>
        </tr>
      </tbody>
    </table>

    <h2>Wire System</h2>
    <p>Wires are stored as objects with start/end endpoints tied to component pin positions:</p>
    <CodeBlock language="typescript">{`{
  id: string
  start: { componentId, pinName, x, y }
  end:   { componentId, pinName, x, y }
  color: string
  signalType: 'digital' | 'analog' | 'power-vcc' | 'power-gnd'
}`}</CodeBlock>
    <ul>
      <li>Orthogonal routing, no diagonal segments</li>
      <li>Segment drag, drag perpendicular to segment orientation</li>
      <li>Auto-update, wire positions recalculate when components move</li>
      <li>Grid snapping, 20 px grid for all wire endpoints</li>
    </ul>

    <div className="docs-callout">
      <strong>Full details:</strong> See{' '}
      <a
        href={`${GITHUB_URL}/blob/master/docs/ARCHITECTURE.md`}
        target="_blank"
        rel="noopener noreferrer"
      >
        docs/ARCHITECTURE.md
      </a>{' '}
      in the repository.
    </div>
  </div>
);

/* ── Wokwi Libraries Section ──────────────────────────── */
const WokwiLibsSection: React.FC = () => (
  <div className="docs-section">
    <span className="docs-label">// open-source libs</span>
    <h1>Wokwi Libraries</h1>
    <p>
      Velxio uses official Wokwi open-source repositories cloned locally in <code>wokwi-libs/</code>
      . This gives you up-to-date, compatible emulation engines and visual components without npm
      registry dependencies.
    </p>

    <h2>Cloned Repositories</h2>
    <table>
      <thead>
        <tr>
          <th>Library</th>
          <th>Location</th>
          <th>Purpose</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>
            <a
              href="https://github.com/wokwi/wokwi-elements"
              target="_blank"
              rel="noopener noreferrer"
            >
              wokwi-elements
            </a>
          </td>
          <td>
            <code>wokwi-libs/wokwi-elements/</code>
          </td>
          <td>48+ Lit Web Components (LEDs, LCDs, sensors, buttons…)</td>
        </tr>
        <tr>
          <td>
            <a href="https://github.com/wokwi/avr8js" target="_blank" rel="noopener noreferrer">
              avr8js
            </a>
          </td>
          <td>
            <code>wokwi-libs/avr8js/</code>
          </td>
          <td>ATmega328p / ATmega2560 CPU emulator at 16 MHz</td>
        </tr>
        <tr>
          <td>
            <a href="https://github.com/wokwi/rp2040js" target="_blank" rel="noopener noreferrer">
              rp2040js
            </a>
          </td>
          <td>
            <code>wokwi-libs/rp2040js/</code>
          </td>
          <td>Raspberry Pi Pico (RP2040) emulator</td>
        </tr>
      </tbody>
    </table>

    <h2>Vite Configuration</h2>
    <p>
      <code>frontend/vite.config.ts</code> uses path aliases so imports resolve to the local builds:
    </p>
    <CodeBlock language="typescript">{`resolve: {
  alias: {
    'avr8js':          '../wokwi-libs/avr8js/dist/esm',
    '@wokwi/elements': '../wokwi-libs/wokwi-elements/dist/esm',
  },
}`}</CodeBlock>

    <h2>Updating the Libraries</h2>
    <h3>All at once (recommended)</h3>
    <CodeBlock language="bash">{`# Windows
update-wokwi-libs.bat`}</CodeBlock>

    <h3>Manually</h3>
    <CodeBlock language="bash">{`cd wokwi-libs/wokwi-elements
git pull origin main
npm install && npm run build

cd ../avr8js
git pull origin main
npm install && npm run build

cd ../rp2040js
git pull origin main
npm install && npm run build`}</CodeBlock>

    <h3>After updating wokwi-elements</h3>
    <p>Regenerate component metadata so new components appear in the picker:</p>
    <CodeBlock language="bash">{`cd frontend
npx tsx ../scripts/generate-component-metadata.ts`}</CodeBlock>

    <h2>Available Wokwi Components (48)</h2>
    <table>
      <thead>
        <tr>
          <th>Category</th>
          <th>Components</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>Boards</td>
          <td>Arduino Uno, Mega, Nano, ESP32 DevKit</td>
        </tr>
        <tr>
          <td>Sensors</td>
          <td>DHT22, HC-SR04, PIR, Photoresistor, NTC, Joystick</td>
        </tr>
        <tr>
          <td>Displays</td>
          <td>LCD 16×2, LCD 20×4, 7-Segment</td>
        </tr>
        <tr>
          <td>Input</td>
          <td>Push button, 6mm button, Slide switch, DIP switch 8, Potentiometer</td>
        </tr>
        <tr>
          <td>Output</td>
          <td>LED, RGB LED, LED bar graph, Buzzer, NeoPixel</td>
        </tr>
        <tr>
          <td>Motors</td>
          <td>Servo, Stepper motor</td>
        </tr>
        <tr>
          <td>Passive</td>
          <td>Resistor, Slide potentiometer, LED ring, Matrix keypad</td>
        </tr>
        <tr>
          <td>Other</td>
          <td>IR receiver, DS1307 RTC, breadboards, etc.</td>
        </tr>
      </tbody>
    </table>

    <h2>How avr8js Powers the Simulation</h2>
    <CodeBlock language="typescript">{`import { CPU, avrInstruction, AVRTimer, AVRUSART, AVRADC, AVRIOPort } from 'avr8js';

const cpu   = new CPU(programMemory);          // ATmega328p at 16 MHz
const portB = new AVRIOPort(cpu, portBConfig); // digital pins 8-13
const portC = new AVRIOPort(cpu, portCConfig); // analog pins A0-A5
const portD = new AVRIOPort(cpu, portDConfig); // digital pins 0-7

function runFrame() {
  const cycles = Math.floor(267_000 * speed);
  for (let i = 0; i < cycles; i++) {
    avrInstruction(cpu); // execute one AVR instruction
    cpu.tick();          // advance timers + peripherals
  }
  requestAnimationFrame(runFrame);
}`}</CodeBlock>

    <div className="docs-callout">
      <strong>Full details:</strong> See{' '}
      <a
        href={`${GITHUB_URL}/blob/master/docs/WOKWI_LIBS.md`}
        target="_blank"
        rel="noopener noreferrer"
      >
        docs/WOKWI_LIBS.md
      </a>{' '}
      in the repository.
    </div>
  </div>
);

/* ── MCP Server Section ───────────────────────────────── */
const McpSection: React.FC = () => (
  <div className="docs-section">
    <span className="docs-label">// AI integration</span>
    <h1>MCP Server</h1>
    <p>
      Velxio exposes a{' '}
      <a href="https://modelcontextprotocol.io/" target="_blank" rel="noopener noreferrer">
        Model Context Protocol
      </a>{' '}
      (MCP) server that lets AI agents (Claude, Cursor, and others) create circuits, generate code,
      and compile Arduino sketches directly.
    </p>

    <h2>Available Tools</h2>
    <table>
      <thead>
        <tr>
          <th>Tool</th>
          <th>Description</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>
            <code>compile_project</code>
          </td>
          <td>Compile Arduino sketch files → Intel HEX / binary</td>
        </tr>
        <tr>
          <td>
            <code>run_project</code>
          </td>
          <td>Compile and mark artifact as simulation-ready</td>
        </tr>
        <tr>
          <td>
            <code>import_wokwi_json</code>
          </td>
          <td>
            Parse a Wokwi <code>diagram.json</code> → Velxio circuit
          </td>
        </tr>
        <tr>
          <td>
            <code>export_wokwi_json</code>
          </td>
          <td>
            Serialise a Velxio circuit → Wokwi <code>diagram.json</code>
          </td>
        </tr>
        <tr>
          <td>
            <code>create_circuit</code>
          </td>
          <td>Create a new circuit definition</td>
        </tr>
        <tr>
          <td>
            <code>update_circuit</code>
          </td>
          <td>Merge changes into an existing circuit</td>
        </tr>
        <tr>
          <td>
            <code>generate_code_files</code>
          </td>
          <td>
            Generate starter <code>.ino</code> code from a circuit
          </td>
        </tr>
      </tbody>
    </table>

    <h2>Transport Options</h2>

    <h3>1. stdio: Claude Desktop / CLI agents</h3>
    <CodeBlock language="bash">{`cd backend
python mcp_server.py`}</CodeBlock>
    <p>
      Claude Desktop config (<code>~/.claude/claude_desktop_config.json</code>):
    </p>
    <CodeBlock language="json">{`{
  "mcpServers": {
    "velxio": {
      "command": "python",
      "args": ["/absolute/path/to/velxio/backend/mcp_server.py"]
    }
  }
}`}</CodeBlock>

    <h3>2. SSE / HTTP: Cursor IDE / web agents</h3>
    <CodeBlock language="bash">{`cd backend
python mcp_sse_server.py --port 8002`}</CodeBlock>
    <p>MCP client config:</p>
    <CodeBlock language="json">{`{
  "mcpServers": {
    "velxio": { "url": "http://localhost:8002/sse" }
  }
}`}</CodeBlock>

    <h2>Circuit Data Format</h2>
    <p>Velxio circuits are plain JSON objects:</p>
    <CodeBlock language="json">{`{
  "board_fqbn": "arduino:avr:uno",
  "version": 1,
  "components": [
    { "id": "led1", "type": "wokwi-led", "left": 200, "top": 100,
      "rotate": 0, "attrs": { "color": "red" } }
  ],
  "connections": [
    { "from_part": "uno", "from_pin": "13",
      "to_part": "led1", "to_pin": "A", "color": "green" }
  ]
}`}</CodeBlock>

    <h3>Supported Board FQBNs</h3>
    <table>
      <thead>
        <tr>
          <th>Board</th>
          <th>FQBN</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>Arduino Uno</td>
          <td>
            <code>arduino:avr:uno</code>
          </td>
        </tr>
        <tr>
          <td>Arduino Mega</td>
          <td>
            <code>arduino:avr:mega</code>
          </td>
        </tr>
        <tr>
          <td>Arduino Nano</td>
          <td>
            <code>arduino:avr:nano</code>
          </td>
        </tr>
        <tr>
          <td>Raspberry Pi Pico</td>
          <td>
            <code>rp2040:rp2040:rpipico</code>
          </td>
        </tr>
      </tbody>
    </table>

    <h2>Example: Blink LED from Scratch</h2>
    <CodeBlock language="json">{`// Step 1 — Create a circuit
{
  "tool": "create_circuit",
  "arguments": {
    "board_fqbn": "arduino:avr:uno",
    "components": [
      { "id": "led1", "type": "wokwi-led",
        "left": 150, "top": 100, "attrs": { "color": "red" } },
      { "id": "r1", "type": "wokwi-resistor",
        "left": 150, "top": 180, "attrs": { "value": "220" } }
    ],
    "connections": [
      { "from_part": "uno", "from_pin": "13",
        "to_part": "led1", "to_pin": "A", "color": "green" },
      { "from_part": "led1", "from_pin": "C",
        "to_part": "r1",   "to_pin": "1", "color": "black" },
      { "from_part": "r1",   "from_pin": "2",
        "to_part": "uno",  "to_pin": "GND.1", "color": "black" }
    ]
  }
}

// Step 2 — Generate code
{
  "tool": "generate_code_files",
  "arguments": {
    "circuit": "<result from Step 1>",
    "sketch_name": "blink",
    "extra_instructions": "Blink the red LED every 500ms"
  }
}

// Step 3 — Compile
{
  "tool": "compile_project",
  "arguments": {
    "files": [
      {
        "name": "blink.ino",
        "content": "void setup(){pinMode(13,OUTPUT);}\\nvoid loop(){digitalWrite(13,HIGH);delay(500);digitalWrite(13,LOW);delay(500);}"
      }
    ],
    "board": "arduino:avr:uno"
  }
}`}</CodeBlock>

    <h2>Setup</h2>
    <CodeBlock language="bash">{`cd backend
pip install -r requirements.txt

# Ensure arduino-cli is installed
arduino-cli version
arduino-cli core update-index
arduino-cli core install arduino:avr

# Run tests
python -m pytest tests/test_mcp_tools.py -v`}</CodeBlock>

    <div className="docs-callout">
      <strong>Full reference:</strong> See{' '}
      <a href={`${GITHUB_URL}/blob/master/docs/MCP.md`} target="_blank" rel="noopener noreferrer">
        docs/MCP.md
      </a>{' '}
      in the repository.
    </div>
  </div>
);

/* ── Setup / Project Status Section ──────────────────── */
const SetupSection: React.FC = () => (
  <div className="docs-section">
    <span className="docs-label">// project status</span>
    <h1>Project Status</h1>
    <p>A comprehensive overview of all features currently implemented in Velxio.</p>

    <h2>AVR Emulation (avr8js)</h2>
    <table>
      <thead>
        <tr>
          <th>Feature</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>ATmega328p CPU at 16 MHz</td>
          <td>✅ Working</td>
        </tr>
        <tr>
          <td>Timer0, Timer1, Timer2</td>
          <td>✅ Working</td>
        </tr>
        <tr>
          <td>USART (Serial)</td>
          <td>✅ Working</td>
        </tr>
        <tr>
          <td>
            ADC (<code>analogRead</code>)
          </td>
          <td>✅ Working</td>
        </tr>
        <tr>
          <td>Full GPIO (PORTB / PORTC / PORTD)</td>
          <td>✅ Working</td>
        </tr>
        <tr>
          <td>~60 FPS loop (267k cycles/frame)</td>
          <td>✅ Working</td>
        </tr>
        <tr>
          <td>Speed control (0.1× – 10×)</td>
          <td>✅ Working</td>
        </tr>
        <tr>
          <td>PWM monitoring (6 channels)</td>
          <td>✅ Working</td>
        </tr>
        <tr>
          <td>External pin injection (inputs)</td>
          <td>✅ Working</td>
        </tr>
      </tbody>
    </table>

    <h2>Component System (48+)</h2>
    <table>
      <thead>
        <tr>
          <th>Feature</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>Automatic discovery via AST</td>
          <td>✅ 48 components detected</td>
        </tr>
        <tr>
          <td>ComponentPickerModal with search</td>
          <td>✅ Working</td>
        </tr>
        <tr>
          <td>9 categories with filters</td>
          <td>✅ Working</td>
        </tr>
        <tr>
          <td>Generic DynamicComponent renderer</td>
          <td>✅ Working</td>
        </tr>
        <tr>
          <td>Drag-and-drop on canvas</td>
          <td>✅ Working</td>
        </tr>
        <tr>
          <td>Rotation (90° increments)</td>
          <td>✅ Working</td>
        </tr>
        <tr>
          <td>Properties dialog (single-click)</td>
          <td>✅ Working</td>
        </tr>
        <tr>
          <td>Pin overlay (clickable cyan dots)</td>
          <td>✅ Working</td>
        </tr>
      </tbody>
    </table>

    <h2>Interactive Parts (16 simulated)</h2>
    <table>
      <thead>
        <tr>
          <th>Part</th>
          <th>Type</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>LED</td>
          <td>Output</td>
          <td>✅</td>
        </tr>
        <tr>
          <td>RGB LED</td>
          <td>Output (digital + PWM)</td>
          <td>✅</td>
        </tr>
        <tr>
          <td>LED Bar Graph (10 LEDs)</td>
          <td>Output</td>
          <td>✅</td>
        </tr>
        <tr>
          <td>7-Segment Display</td>
          <td>Output</td>
          <td>✅</td>
        </tr>
        <tr>
          <td>Pushbutton</td>
          <td>Input</td>
          <td>✅</td>
        </tr>
        <tr>
          <td>Pushbutton 6mm</td>
          <td>Input</td>
          <td>✅</td>
        </tr>
        <tr>
          <td>Slide Switch</td>
          <td>Input</td>
          <td>✅</td>
        </tr>
        <tr>
          <td>DIP Switch 8</td>
          <td>Input</td>
          <td>✅</td>
        </tr>
        <tr>
          <td>Potentiometer</td>
          <td>Input (ADC)</td>
          <td>✅</td>
        </tr>
        <tr>
          <td>Slide Potentiometer</td>
          <td>Input (ADC)</td>
          <td>✅</td>
        </tr>
        <tr>
          <td>Photoresistor</td>
          <td>Input / Output</td>
          <td>✅</td>
        </tr>
        <tr>
          <td>Analog Joystick</td>
          <td>Input (ADC + digital)</td>
          <td>✅</td>
        </tr>
        <tr>
          <td>Servo</td>
          <td>Output</td>
          <td>✅</td>
        </tr>
        <tr>
          <td>Buzzer</td>
          <td>Output (Web Audio)</td>
          <td>✅</td>
        </tr>
        <tr>
          <td>LCD 1602</td>
          <td>Output (full HD44780)</td>
          <td>✅</td>
        </tr>
        <tr>
          <td>LCD 2004</td>
          <td>Output (full HD44780)</td>
          <td>✅</td>
        </tr>
      </tbody>
    </table>

    <h2>Wire System</h2>
    <table>
      <thead>
        <tr>
          <th>Feature</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>Pin-to-pin creation with click</td>
          <td>✅ Working</td>
        </tr>
        <tr>
          <td>Real-time preview (green dashed)</td>
          <td>✅ Working</td>
        </tr>
        <tr>
          <td>Orthogonal routing (no diagonals)</td>
          <td>✅ Working</td>
        </tr>
        <tr>
          <td>Segment editing (perpendicular drag)</td>
          <td>✅ Working</td>
        </tr>
        <tr>
          <td>8 colours by signal type</td>
          <td>✅ Working</td>
        </tr>
        <tr>
          <td>Auto-update when moving components</td>
          <td>✅ Working</td>
        </tr>
        <tr>
          <td>Grid snapping (20 px)</td>
          <td>✅ Working</td>
        </tr>
        <tr>
          <td>Wire selection and deletion</td>
          <td>✅ Working</td>
        </tr>
      </tbody>
    </table>

    <h2>Example Projects (8)</h2>
    <table>
      <thead>
        <tr>
          <th>Example</th>
          <th>Category</th>
          <th>Difficulty</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>Blink LED</td>
          <td>Basics</td>
          <td>Beginner</td>
        </tr>
        <tr>
          <td>Traffic Light</td>
          <td>Basics</td>
          <td>Beginner</td>
        </tr>
        <tr>
          <td>Button Control</td>
          <td>Basics</td>
          <td>Beginner</td>
        </tr>
        <tr>
          <td>Fade LED (PWM)</td>
          <td>Basics</td>
          <td>Beginner</td>
        </tr>
        <tr>
          <td>Serial Hello World</td>
          <td>Communication</td>
          <td>Beginner</td>
        </tr>
        <tr>
          <td>RGB LED Colors</td>
          <td>Basics</td>
          <td>Intermediate</td>
        </tr>
        <tr>
          <td>Simon Says Game</td>
          <td>Games</td>
          <td>Advanced</td>
        </tr>
        <tr>
          <td>LCD 20×4 Display</td>
          <td>Displays</td>
          <td>Intermediate</td>
        </tr>
      </tbody>
    </table>

    <h2>Troubleshooting</h2>
    <table>
      <thead>
        <tr>
          <th>Problem</th>
          <th>Solution</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>Components not displayed</td>
          <td>
            <pre style={{ margin: 0 }}>
              <code>cd wokwi-libs/wokwi-elements{'\n'}npm run build</code>
            </pre>
          </td>
        </tr>
        <tr>
          <td>
            <code>Cannot find module 'avr8js'</code>
          </td>
          <td>
            <pre style={{ margin: 0 }}>
              <code>cd wokwi-libs/avr8js{'\n'}npm install && npm run build</code>
            </pre>
          </td>
        </tr>
        <tr>
          <td>LED doesn't blink</td>
          <td>
            Compile first, then click Run. Check pin assignment in the component property dialog.
          </td>
        </tr>
        <tr>
          <td>New component not in picker</td>
          <td>
            <pre style={{ margin: 0 }}>
              <code>cd frontend{'\n'}npx tsx ../scripts/generate-component-metadata.ts</code>
            </pre>
          </td>
        </tr>
      </tbody>
    </table>

    <div className="docs-callout">
      <strong>Full status:</strong> See{' '}
      <a
        href={`${GITHUB_URL}/blob/master/docs/SETUP_COMPLETE.md`}
        target="_blank"
        rel="noopener noreferrer"
      >
        docs/SETUP_COMPLETE.md
      </a>{' '}
      in the repository.
    </div>
  </div>
);

const RiscVEmulationSection: React.FC = () => (
  <div className="docs-section">
    <span className="docs-label">// risc-v</span>
    <h1>RISC-V Emulation (ESP32-C3)</h1>
    <p>
      ESP32-C3, XIAO ESP32-C3, and C3 SuperMini boards use a <strong>RISC-V RV32IMC</strong> core
      running at 160 MHz. Velxio emulates them entirely in the browser, no backend, no QEMU, no
      WebAssembly pipeline. The emulator is written in pure TypeScript and runs at real-time speeds.
    </p>

    <h2>Supported Boards</h2>
    <div className="docs-board-gallery">
      <div className="docs-board-card">
        <img src="/boards/esp32-c3.svg" alt="ESP32-C3 DevKit" />
        <span>ESP32-C3 DevKit</span>
      </div>
      <div className="docs-board-card">
        <img src="/boards/xiao-esp32-c3.svg" alt="Seeed XIAO ESP32-C3" />
        <span>Seeed XIAO ESP32-C3</span>
      </div>
      <div className="docs-board-card">
        <img src="/boards/esp32c3-supermini.svg" alt="ESP32-C3 SuperMini" />
        <span>ESP32-C3 SuperMini</span>
      </div>
    </div>
    <table>
      <thead>
        <tr>
          <th>Board</th>
          <th>CPU</th>
          <th>Flash</th>
          <th>RAM</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>ESP32-C3</td>
          <td>RV32IMC @ 160 MHz</td>
          <td>4 MB</td>
          <td>384 KB DRAM</td>
        </tr>
        <tr>
          <td>XIAO ESP32-C3</td>
          <td>RV32IMC @ 160 MHz</td>
          <td>4 MB</td>
          <td>384 KB DRAM</td>
        </tr>
        <tr>
          <td>C3 SuperMini</td>
          <td>RV32IMC @ 160 MHz</td>
          <td>4 MB</td>
          <td>384 KB DRAM</td>
        </tr>
      </tbody>
    </table>

    <h2>Memory Map</h2>
    <table>
      <thead>
        <tr>
          <th>Region</th>
          <th>Base Address</th>
          <th>Size</th>
          <th>Description</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>IROM (Flash)</td>
          <td>
            <code>0x42000000</code>
          </td>
          <td>4 MB</td>
          <td>Code stored in flash</td>
        </tr>
        <tr>
          <td>DROM (Flash R/O)</td>
          <td>
            <code>0x3C000000</code>
          </td>
          <td>4 MB</td>
          <td>Read-only data in flash</td>
        </tr>
        <tr>
          <td>DRAM</td>
          <td>
            <code>0x3FC80000</code>
          </td>
          <td>384 KB</td>
          <td>Data RAM (stack + heap)</td>
        </tr>
        <tr>
          <td>IRAM</td>
          <td>
            <code>0x4037C000</code>
          </td>
          <td>384 KB</td>
          <td>Instruction RAM (copied from flash)</td>
        </tr>
        <tr>
          <td>UART0</td>
          <td>
            <code>0x60000000</code>
          </td>
          <td>1 KB</td>
          <td>Serial port 0 (GPIO 20/21)</td>
        </tr>
        <tr>
          <td>GPIO</td>
          <td>
            <code>0x60004000</code>
          </td>
          <td>512 B</td>
          <td>GPIO output / input / enable</td>
        </tr>
      </tbody>
    </table>

    <h2>ISA Support</h2>
    <ul>
      <li>
        <strong>RV32I</strong>: Full base integer instruction set (ALU, load/store, branches,
        JAL/JALR)
      </li>
      <li>
        <strong>RV32M</strong>: Multiply/divide: MUL, MULH, MULHSU, MULHU, DIV, DIVU, REM, REMU
      </li>
      <li>
        <strong>RV32C</strong>: 16-bit compressed instructions: C.LI, C.ADDI, C.LUI, C.J, C.JAL,
        C.BEQZ, C.BNEZ, C.MV, C.ADD, C.JR, C.JALR, C.LW, C.SW, C.LWSP, C.SWSP, C.SLLI, C.ADDI4SPN
      </li>
    </ul>

    <h2>Compilation Flow</h2>
    <p>
      When you click <strong>Compile + Run</strong> for an ESP32-C3 board:
    </p>
    <ol>
      <li>
        The backend compiles your sketch with <code>arduino-cli</code> using the{' '}
        <code>esp32:esp32</code> core.
      </li>
      <li>
        The resulting binary is a <strong>merged 4 MB flash image</strong>: bootloader at{' '}
        <code>0x1000</code>, partition table at <code>0x8000</code>, application at{' '}
        <code>0x10000</code>.
      </li>
      <li>
        The frontend's <code>esp32ImageParser.ts</code> finds the app at offset <code>0x10000</code>
        , reads the 24-byte ESP32 image header (magic <code>0xE9</code>), and extracts all segments
        (load address + data).
      </li>
      <li>
        Each segment is written into the correct memory region (IROM, DROM, DRAM, or IRAM) of the{' '}
        <code>Esp32C3Simulator</code>.
      </li>
      <li>The CPU starts executing from the entry point specified in the image header.</li>
    </ol>

    <h2>GPIO Registers</h2>
    <table>
      <thead>
        <tr>
          <th>Register</th>
          <th>Offset</th>
          <th>Description</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>
            <code>GPIO_OUT_REG</code>
          </td>
          <td>
            <code>+0x04</code>
          </td>
          <td>Current output value</td>
        </tr>
        <tr>
          <td>
            <code>GPIO_OUT_W1TS</code>
          </td>
          <td>
            <code>+0x08</code>
          </td>
          <td>Set bits (write 1 to set)</td>
        </tr>
        <tr>
          <td>
            <code>GPIO_OUT_W1TC</code>
          </td>
          <td>
            <code>+0x0C</code>
          </td>
          <td>Clear bits (write 1 to clear)</td>
        </tr>
        <tr>
          <td>
            <code>GPIO_ENABLE_REG</code>
          </td>
          <td>
            <code>+0x20</code>
          </td>
          <td>Output enable</td>
        </tr>
        <tr>
          <td>
            <code>GPIO_IN_REG</code>
          </td>
          <td>
            <code>+0x3C</code>
          </td>
          <td>Input pin states</td>
        </tr>
      </tbody>
    </table>

    <h2>UART0</h2>
    <p>
      Writing a byte to <code>0x60000000</code> (UART0 FIFO) triggers the <code>onSerialData</code>{' '}
      callback, which streams characters to the Serial Monitor. Reading from the same address pops
      from the receive FIFO (used by <code>Serial.read()</code>). The UART status register always
      returns 0 (TX ready).
    </p>

    <h2>Key Source Files</h2>
    <table>
      <thead>
        <tr>
          <th>File</th>
          <th>Role</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>
            <code>simulation/RiscVCore.ts</code>
          </td>
          <td>RV32IMC interpreter (step, MMIO hooks)</td>
        </tr>
        <tr>
          <td>
            <code>simulation/Esp32C3Simulator.ts</code>
          </td>
          <td>ESP32-C3 peripherals, memory map, lifecycle</td>
        </tr>
        <tr>
          <td>
            <code>utils/esp32ImageParser.ts</code>
          </td>
          <td>Parses merged flash image, extracts segments</td>
        </tr>
      </tbody>
    </table>

    <div className="docs-callout">
      <strong>Full details:</strong>{' '}
      <a
        href={`${GITHUB_URL}/blob/master/docs/RISCV_EMULATION.md`}
        target="_blank"
        rel="noopener noreferrer"
      >
        docs/RISCV_EMULATION.md
      </a>{' '}
      in the repository.
    </div>
  </div>
);

const Esp32EmulationSection: React.FC = () => (
  <div className="docs-section">
    <span className="docs-label">// xtensa</span>
    <h1>ESP32 Emulation (Xtensa)</h1>
    <p>
      ESP32 and ESP32-S3 boards use an <strong>Xtensa LX6 / LX7</strong> architecture. Because no
      production-quality Xtensa emulator is available as pure JavaScript, Velxio uses a
      <strong> QEMU-based backend</strong> for these boards, the lcgamboa fork with libqemu-xtensa,
      compiled to a native binary and served by the FastAPI backend.
    </p>

    <div className="docs-callout">
      <strong>Note:</strong> This section applies only to <strong>ESP32</strong> and{' '}
      <strong>ESP32-S3</strong> (Xtensa). For ESP32-C3, XIAO ESP32-C3, and C3 SuperMini (RISC-V),
      see <strong>RISC-V Emulation (ESP32-C3)</strong> in the sidebar, those boards run entirely in
      the browser.
    </div>

    <h2>How It Works</h2>
    <ol>
      <li>
        Arduino sketch is compiled by <code>arduino-cli</code> to an ESP32 <code>.bin</code> flash
        image.
      </li>
      <li>
        Frontend sends the binary to the backend via WebSocket (<code>Esp32Bridge</code>).
      </li>
      <li>Backend spawns a QEMU process with the lcgamboa Xtensa plugin, loads the image.</li>
      <li>GPIO and UART events are forwarded over the WebSocket back to the browser.</li>
      <li>Frontend updates component states (LEDs, display, etc.) in real time.</li>
    </ol>

    <h2>Supported Boards</h2>
    <div className="docs-board-gallery">
      <div className="docs-board-card">
        <img src="/boards/esp32-devkit-c-v4.svg" alt="ESP32 DevKit C V4" />
        <span>ESP32 DevKit C V4</span>
      </div>
      <div className="docs-board-card">
        <img src="/boards/esp32-s3.svg" alt="ESP32-S3" />
        <span>ESP32-S3</span>
      </div>
      <div className="docs-board-card">
        <img src="/boards/esp32-cam.svg" alt="ESP32-CAM" />
        <span>ESP32-CAM</span>
      </div>
      <div className="docs-board-card">
        <img src="/boards/xiao-esp32-s3.svg" alt="Seeed XIAO ESP32-S3" />
        <span>Seeed XIAO ESP32-S3</span>
      </div>
      <div className="docs-board-card">
        <img src="/boards/arduino-nano-esp32.svg" alt="Arduino Nano ESP32" />
        <span>Arduino Nano ESP32</span>
      </div>
    </div>
    <table>
      <thead>
        <tr>
          <th>Board</th>
          <th>CPU</th>
          <th>Emulation</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>ESP32</td>
          <td>Xtensa LX6 dual-core @ 240 MHz</td>
          <td>QEMU (lcgamboa)</td>
        </tr>
        <tr>
          <td>ESP32-S3</td>
          <td>Xtensa LX7 dual-core @ 240 MHz</td>
          <td>QEMU (lcgamboa)</td>
        </tr>
      </tbody>
    </table>

    <h2>Peripheral Support</h2>
    <ul>
      <li>
        <strong>GPIO</strong>: digital output / input, LED control
      </li>
      <li>
        <strong>UART</strong>: Serial Monitor via <code>Serial.print()</code>
      </li>
      <li>
        <strong>I2C / SPI</strong>: peripheral communication
      </li>
      <li>
        <strong>RMT / NeoPixel</strong>: addressable LED strips
      </li>
      <li>
        <strong>LEDC / PWM</strong>: hardware PWM channels
      </li>
      <li>
        <strong>WiFi</strong>: partial (connection events forwarded)
      </li>
    </ul>

    <h2>Requirements</h2>
    <p>
      QEMU-based emulation requires the Velxio backend to be running. This means it works with the{' '}
      <strong>hosted version</strong> at{' '}
      <a href="https://velxio.dev" target="_blank" rel="noopener noreferrer">
        velxio.dev
      </a>{' '}
      and with <strong>Docker self-hosting</strong>, but not in a pure static frontend deployment.
    </p>

    <div className="docs-callout">
      <strong>Full details:</strong>{' '}
      <a
        href={`${GITHUB_URL}/blob/master/docs/ESP32_EMULATION.md`}
        target="_blank"
        rel="noopener noreferrer"
      >
        docs/ESP32_EMULATION.md
      </a>{' '}
      in the repository.
    </div>
  </div>
);

/* ── RP2040 Emulation Section ─────────────────────────── */
const Rp2040EmulationSection: React.FC = () => (
  <div className="docs-section">
    <span className="docs-label">// arm cortex-m0+</span>
    <h1>RP2040 Emulation (Raspberry Pi Pico)</h1>
    <p>
      The Raspberry Pi Pico and Pico W are emulated entirely in the browser using{' '}
      <a href="https://github.com/wokwi/rp2040js" target="_blank" rel="noopener noreferrer">
        rp2040js
      </a>
      , an open-source ARM Cortex-M0+ emulator. No QEMU or backend process is required, the binary
      runs at full speed inside a Web Worker.
    </p>

    <h2>Supported Boards</h2>
    <div className="docs-board-gallery">
      <div className="docs-board-card">
        <img src="/boards/pi-pico.svg" alt="Raspberry Pi Pico" />
        <span>Raspberry Pi Pico</span>
      </div>
      <div className="docs-board-card">
        <img src="/boards/pi-pico-w.svg" alt="Raspberry Pi Pico W" />
        <span>Raspberry Pi Pico W</span>
      </div>
    </div>
    <table>
      <thead>
        <tr>
          <th>Board</th>
          <th>FQBN</th>
          <th>Built-in LED</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>Raspberry Pi Pico</td>
          <td>
            <code>rp2040:rp2040:rpipico</code>
          </td>
          <td>GPIO 25</td>
        </tr>
        <tr>
          <td>Raspberry Pi Pico W</td>
          <td>
            <code>rp2040:rp2040:rpipicow</code>
          </td>
          <td>GPIO 25 (via CYW43)</td>
        </tr>
      </tbody>
    </table>

    <h2>Binary Format</h2>
    <p>
      The backend compiles the sketch with <code>arduino-cli</code> targeting{' '}
      <code>rp2040:rp2040:rpipico</code> and returns a raw ARM binary (<code>.bin</code>) encoded in
      base64. Unlike AVR, there is no Intel HEX, the binary is loaded directly into the RP2040 flash
      at offset 0.
    </p>
    <p>
      The backend also prepends <code>#define Serial Serial1</code> to the sketch so that Arduino{' '}
      <code>Serial</code> calls are redirected to UART0 (the virtual serial port streamed to the
      Serial Monitor).
    </p>

    <h2>Peripherals</h2>
    <table>
      <thead>
        <tr>
          <th>Peripheral</th>
          <th>Support</th>
          <th>Notes</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>GPIO (30 pins)</td>
          <td>Full</td>
          <td>Digital read/write, pull-up/down</td>
        </tr>
        <tr>
          <td>UART0 / UART1</td>
          <td>Full</td>
          <td>Serial Monitor via UART0</td>
        </tr>
        <tr>
          <td>ADC (ch 0–3)</td>
          <td>Full</td>
          <td>GPIO 26–29; ch 4 = temperature sensor</td>
        </tr>
        <tr>
          <td>I2C0 / I2C1</td>
          <td>Partial</td>
          <td>DS1307 RTC, TempSensor, EEPROM virtual devices</td>
        </tr>
        <tr>
          <td>SPI0 / SPI1</td>
          <td>Loopback</td>
          <td>TX looped back to RX</td>
        </tr>
        <tr>
          <td>PWM</td>
          <td>Frequency only</td>
          <td>No waveform output to components</td>
        </tr>
        <tr>
          <td>Timer / Alarm</td>
          <td>Full</td>
          <td>
            Used by <code>delay()</code> and <code>millis()</code>
          </td>
        </tr>
      </tbody>
    </table>

    <h2>WFI Optimisation</h2>
    <p>
      When the CPU executes a <strong>WFI</strong> (Wait For Interrupt) instruction, the emulator
      fast-forwards the system clock to the next scheduled alarm instead of spinning through idle
      cycles. This dramatically reduces CPU usage during <code>delay()</code> calls.
    </p>

    <h2>Simulation Loop</h2>
    <p>
      The simulation runs inside <code>requestAnimationFrame</code> at ~60 FPS. Each frame executes
      approximately <strong>2,200,000</strong> CPU cycles (133 MHz / 60 fps). GPIO listeners fire
      whenever a pin state changes and update the visual components on the canvas.
    </p>

    <h2>Known Limitations</h2>
    <ul>
      <li>Pico W wireless chip (CYW43439) is not emulated, WiFi/Bluetooth will not work</li>
      <li>SPI loopback only, no real SPI device emulation</li>
      <li>PWM produces correct frequency but no visual waveform on components</li>
      <li>DMA not emulated</li>
      <li>
        Second CPU core (core 1) not emulated, <code>multicore_launch_core1()</code> has no effect
      </li>
    </ul>

    <h2>Full Documentation</h2>
    <p>
      See the complete technical reference:{' '}
      <a
        href="https://github.com/davidmonterocrespo24/velxio/blob/master/docs/RP2040_EMULATION.md"
        target="_blank"
        rel="noopener noreferrer"
      >
        RP2040_EMULATION.md
      </a>
    </p>
  </div>
);

/* ── Raspberry Pi 3 Emulation Section ─────────────────── */
const RaspberryPi3EmulationSection: React.FC = () => (
  <div className="docs-section">
    <span className="docs-label">// qemu raspi3b</span>
    <h1>Raspberry Pi 3 Emulation (QEMU)</h1>
    <p>
      The Raspberry Pi 3B is emulated using <strong>QEMU 8.1.3</strong> with <code>-M raspi3b</code>
      . This is the only board in Velxio that runs a full operating system, a real{' '}
      <strong>Raspberry Pi OS (Trixie)</strong> image booted inside the emulator. Users write Python
      scripts (not C++), which are executed by the real Python 3 interpreter inside the VM.
    </p>

    <h2>Supported Boards</h2>
    <div className="docs-board-gallery">
      <div className="docs-board-card">
        <img src="/boards/Raspberry_Pi_3.svg" alt="Raspberry Pi 3B" />
        <span>Raspberry Pi 3B</span>
      </div>
    </div>
    <table>
      <thead>
        <tr>
          <th>Board</th>
          <th>QEMU Machine</th>
          <th>CPU</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>Raspberry Pi 3B</td>
          <td>
            <code>raspi3b</code>
          </td>
          <td>BCM2837, 4× Cortex-A53 @ 1.2 GHz</td>
        </tr>
      </tbody>
    </table>

    <h2>Dual-Channel Serial Architecture</h2>
    <p>QEMU exposes two UART channels to the backend:</p>
    <ul>
      <li>
        <strong>ttyAMA0</strong>: User serial: interactive terminal (Serial Monitor). The user's{' '}
        <code>print()</code> output appears here.
      </li>
      <li>
        <strong>ttyAMA1</strong>: GPIO shim: carries a text protocol between the GPIO shim inside
        the VM and the backend.
      </li>
    </ul>

    <h2>RPi.GPIO Shim</h2>
    <p>
      A custom <code>RPi.GPIO</code> shim is injected at{' '}
      <code>/usr/local/lib/python3.11/dist-packages/RPi/GPIO.py</code>
      inside the VM. When user code calls <code>GPIO.output(pin, value)</code>, the shim writes a
      line like <code>GPIO 17 1</code> to <strong>ttyAMA1</strong>. The backend reads this, fires a{' '}
      <code>gpio_change</code> WebSocket event, and the frontend updates the visual component on the
      canvas.
    </p>
    <p>
      The reverse also works: the frontend can send <code>SET 17 1</code> via WebSocket → backend →
      ttyAMA1 → shim → user code reads it via <code>GPIO.input(17)</code>.
    </p>

    <h2>Virtual File System (VFS)</h2>
    <p>
      Each Raspberry Pi board instance has its own VFS that maps to files inside the running VM. The
      default tree is:
    </p>
    <CodeBlock language="text">{`/home/pi/
├── script.py     ← user's main Python script
└── lib/
    └── helper.py ← optional helper library`}</CodeBlock>

    <h2>Overlay Images</h2>
    <p>
      The base Raspberry Pi OS SD image is never modified. Each session creates a fresh
      <strong> qcow2 overlay</strong> on top of the base image, so all runtime changes are isolated
      and discarded when the session ends.
    </p>

    <h2>Known Limitations</h2>
    <ul>
      <li>No I2C or SPI device emulation</li>
      <li>No PWM waveform output to components</li>
      <li>No networking (WiFi/Ethernet not emulated)</li>
      <li>Session state is not persisted, overlay is discarded on stop</li>
      <li>Boot time is slow (~10–20 s) as a full OS must start</li>
      <li>Requires the ~5.67 GB base SD image to be present on the server</li>
    </ul>

    <h2>Full Documentation</h2>
    <p>
      See the complete technical reference:{' '}
      <a
        href="https://github.com/davidmonterocrespo24/velxio/blob/master/docs/RASPBERRYPI3_EMULATION.md"
        target="_blank"
        rel="noopener noreferrer"
      >
        RASPBERRYPI3_EMULATION.md
      </a>
    </p>
  </div>
);

const SECTION_MAP: Record<SectionId, React.FC> = {
  intro: IntroSection,
  'getting-started': GettingStartedSection,
  emulator: EmulatorSection,
  'riscv-emulation': RiscVEmulationSection,
  'esp32-emulation': Esp32EmulationSection,
  'rp2040-emulation': Rp2040EmulationSection,
  'raspberry-pi3-emulation': RaspberryPi3EmulationSection,
  components: ComponentsSection,
  roadmap: RoadmapSection,
  architecture: ArchitectureSection,
  'wokwi-libs': WokwiLibsSection,
  mcp: McpSection,
  setup: SetupSection,
};

/* ── Page ─────────────────────────────────────────────── */
export const DocsPage: React.FC = () => {
  const { section } = useParams<{ section?: string }>();
  const navigate = useNavigate();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Derive active section from URL; fall back to 'intro'
  const activeSection: SectionId =
    section && VALID_SECTIONS.includes(section as SectionId) ? (section as SectionId) : 'intro';

  // Redirect bare /docs → /docs/intro so every section has a canonical URL
  useEffect(() => {
    if (!section) {
      navigate('/docs/intro', { replace: true });
    }
  }, [section, navigate]);

  // Capture the original <head> values once on mount and restore them on unmount
  useEffect(() => {
    const origTitle = document.title;

    // Helper to capture an element and its original attribute value
    const captureAttr = <E extends Element>(selector: string, attr: string): [E | null, string] => {
      const el = document.querySelector<E>(selector);
      return [el, el?.getAttribute(attr) ?? ''];
    };

    const [descEl, origDesc] = captureAttr<HTMLMetaElement>('meta[name="description"]', 'content');
    const [canonicalEl, origCanonical] = captureAttr<HTMLLinkElement>(
      'link[rel="canonical"]',
      'href',
    );
    const [ogTitleEl, origOgTitle] = captureAttr<HTMLMetaElement>(
      'meta[property="og:title"]',
      'content',
    );
    const [ogDescEl, origOgDesc] = captureAttr<HTMLMetaElement>(
      'meta[property="og:description"]',
      'content',
    );
    const [ogUrlEl, origOgUrl] = captureAttr<HTMLMetaElement>('meta[property="og:url"]', 'content');
    const [twTitleEl, origTwTitle] = captureAttr<HTMLMetaElement>(
      'meta[name="twitter:title"]',
      'content',
    );
    const [twDescEl, origTwDesc] = captureAttr<HTMLMetaElement>(
      'meta[name="twitter:description"]',
      'content',
    );

    return () => {
      document.title = origTitle;
      descEl?.setAttribute('content', origDesc);
      canonicalEl?.setAttribute('href', origCanonical);
      ogTitleEl?.setAttribute('content', origOgTitle);
      ogDescEl?.setAttribute('content', origOgDesc);
      ogUrlEl?.setAttribute('content', origOgUrl);
      twTitleEl?.setAttribute('content', origTwTitle);
      twDescEl?.setAttribute('content', origTwDesc);
      document.getElementById('docs-jsonld')?.remove();
    };
  }, []); // runs once on mount; cleanup runs once on unmount

  // Update all head metadata + JSON-LD per section.
  // No cleanup here — the mount effect above restores defaults on unmount,
  // and on a section change the next run of this effect immediately overwrites.
  useEffect(() => {
    const meta = SECTION_META[activeSection];
    const pageUrl = `${BASE_URL}/docs/${activeSection}`;

    document.title = meta.title;

    const set = (selector: string, value: string) =>
      document.querySelector<HTMLMetaElement>(selector)?.setAttribute('content', value);

    set('meta[name="description"]', meta.description);
    set('meta[property="og:title"]', meta.title);
    set('meta[property="og:description"]', meta.description);
    set('meta[property="og:url"]', pageUrl);
    set('meta[name="twitter:title"]', meta.title);
    set('meta[name="twitter:description"]', meta.description);

    const canonicalEl = document.querySelector<HTMLLinkElement>('link[rel="canonical"]');
    if (canonicalEl) canonicalEl.setAttribute('href', pageUrl);

    // Build the breadcrumb section label for JSON-LD
    const activeNav = NAV_ITEMS.find((i) => i.id === activeSection);
    const sectionLabel = activeNav?.label ?? activeSection;

    // Inject / update JSON-LD structured data for this doc page
    const ldId = 'docs-jsonld';
    let ldScript = document.getElementById(ldId) as HTMLScriptElement | null;
    if (!ldScript) {
      ldScript = document.createElement('script');
      ldScript.id = ldId;
      ldScript.type = 'application/ld+json';
      document.head.appendChild(ldScript);
    }
    ldScript.textContent = JSON.stringify({
      '@context': 'https://schema.org',
      '@graph': [
        {
          '@type': 'TechArticle',
          headline: meta.title,
          description: meta.description,
          url: pageUrl,
          isPartOf: { '@type': 'WebSite', url: `${BASE_URL}/`, name: 'Velxio' },
          inLanguage: 'en-US',
          author: AUTHOR,
        },
        {
          '@type': 'BreadcrumbList',
          itemListElement: [
            { '@type': 'ListItem', position: 1, name: 'Home', item: `${BASE_URL}/` },
            {
              '@type': 'ListItem',
              position: 2,
              name: 'Documentation',
              item: `${BASE_URL}/docs/intro`,
            },
            { '@type': 'ListItem', position: 3, name: sectionLabel, item: pageUrl },
          ],
        },
      ],
    });
  }, [activeSection]);

  const ActiveContent = SECTION_MAP[activeSection];
  const activeIdx = NAV_ITEMS.findIndex((i) => i.id === activeSection);

  return (
    <div className="docs-page">
      <AppHeader />
      <div className="docs-mobile-bar">
        <button
          className="docs-sidebar-toggle"
          onClick={() => setSidebarOpen((v) => !v)}
          aria-label="Toggle sidebar"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          >
            <line x1="3" y1="6" x2="21" y2="6" />
            <line x1="3" y1="12" x2="21" y2="12" />
            <line x1="3" y1="18" x2="21" y2="18" />
          </svg>
        </button>
        <span className="docs-mobile-bar-title">Documentation</span>
      </div>

      <div className="docs-body">
        {/* Sidebar */}
        <aside className={`docs-sidebar${sidebarOpen ? ' docs-sidebar--open' : ''}`}>
          <div className="docs-sidebar-title">Documentation</div>
          <nav className="docs-sidebar-nav">
            {NAV_ITEMS.map((item) => (
              <Link
                key={item.id}
                to={`/docs/${item.id}`}
                className={`docs-sidebar-item${activeSection === item.id ? ' docs-sidebar-item--active' : ''}`}
                onClick={() => setSidebarOpen(false)}
              >
                {item.label}
              </Link>
            ))}
          </nav>
          <div className="docs-sidebar-divider" />
          <div className="docs-sidebar-title docs-sidebar-title--pages">Pages</div>
          <nav className="docs-sidebar-nav">
            <Link
              to="/"
              className="docs-sidebar-item docs-sidebar-link"
              onClick={() => setSidebarOpen(false)}
            >
              Home
            </Link>
            <Link
              to="/editor"
              className="docs-sidebar-item docs-sidebar-link"
              onClick={() => setSidebarOpen(false)}
            >
              Editor
            </Link>
            <Link
              to="/examples"
              className="docs-sidebar-item docs-sidebar-link"
              onClick={() => setSidebarOpen(false)}
            >
              Examples
            </Link>
          </nav>
          <div className="docs-sidebar-footer">
            <a
              href={GITHUB_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="docs-sidebar-gh"
            >
              <IcoGitHub /> View on GitHub
            </a>
          </div>
        </aside>

        {/* Main content */}
        <main className="docs-main">
          <ActiveContent />

          {/* Prev / Next navigation */}
          <div className="docs-pagination">
            {activeIdx > 0 && (
              <Link
                to={`/docs/${NAV_ITEMS[activeIdx - 1].id}`}
                className="docs-pagination-btn docs-pagination-btn--prev"
                onClick={() => window.scrollTo(0, 0)}
              >
                ← {NAV_ITEMS[activeIdx - 1].label}
              </Link>
            )}
            {activeIdx < NAV_ITEMS.length - 1 && (
              <Link
                to={`/docs/${NAV_ITEMS[activeIdx + 1].id}`}
                className="docs-pagination-btn docs-pagination-btn--next"
                onClick={() => window.scrollTo(0, 0)}
              >
                {NAV_ITEMS[activeIdx + 1].label} →
              </Link>
            )}
          </div>
        </main>
      </div>
    </div>
  );
};
