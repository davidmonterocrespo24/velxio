/**
 * /arduino-simulator — SEO landing page
 * Target keywords: "arduino simulator", "arduino simulator free"
 */

import React from 'react';
import { Link } from 'react-router-dom';
import { AppHeader } from '../components/layout/AppHeader';
import { useSEO } from '../utils/useSEO';
import { getSeoMeta } from '../seoRoutes';
import { trackClickCTA } from '../utils/analytics';
import './SEOPage.css';

const META = getSeoMeta('/arduino-simulator')!;

const FAQ_ITEMS = [
  {
    q: 'Is this Arduino simulator free?',
    a: 'Yes. Velxio is completely free and open-source (GNU AGPLv3). No account, no payment, no cloud subscription — run it in your browser or self-host it with one Docker command.',
  },
  {
    q: 'Does the Arduino simulator work without installing anything?',
    a: 'The simulation engine runs entirely in your browser. Compiling code requires the arduino-cli backend, which you can run locally or via Docker. No IDE installation is needed.',
  },
  {
    q: 'What Arduino boards can I simulate?',
    a: 'Velxio supports 19 boards: Arduino Uno (ATmega328P), Arduino Nano, Arduino Mega 2560, ATtiny85, Arduino Leonardo, Arduino Pro Mini (AVR8) — plus Raspberry Pi Pico (RP2040), ESP32-C3 / XIAO ESP32-C3 / CH32V003 (RISC-V), ESP32 / ESP32-S3 / ESP32-CAM (Xtensa via QEMU), and Raspberry Pi 3B (Linux via QEMU).',
  },
  {
    q: 'Can I simulate LEDs, sensors, and displays?',
    a: 'Yes. Velxio includes 48+ interactive wokwi-elements: LEDs, resistors, buttons, servo motors, ultrasonic sensors, ILI9341 TFT displays, LCD, NeoPixel strips, buzzers, DHT22, and more.',
  },
  {
    q: 'Is Velxio a Wokwi alternative?',
    a: 'Yes. Velxio is a free, self-hosted alternative to Wokwi. It uses the same avr8js emulation library and wokwi-elements visual components, but runs entirely on your own machine with no cloud dependency.',
  },
];

const JSON_LD: object[] = [
  {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: 'Velxio — Free Online Arduino Simulator',
    applicationCategory: 'DeveloperApplication',
    operatingSystem: 'Any (browser-based)',
    description:
      'Free online Arduino simulator with real AVR8 emulation at 16 MHz. Simulate Arduino code with 48+ interactive electronic components directly in your browser — no install, no account.',
    url: 'https://velxio.dev/arduino-simulator',
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
    author: { '@type': 'Person', name: 'David Montero Crespo' },
    license: 'https://www.gnu.org/licenses/agpl-3.0.html',
  },
  {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: FAQ_ITEMS.map(({ q, a }) => ({
      '@type': 'Question',
      name: q,
      acceptedAnswer: { '@type': 'Answer', text: a },
    })),
  },
  {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Velxio', item: 'https://velxio.dev/' },
      {
        '@type': 'ListItem',
        position: 2,
        name: 'Arduino Simulator',
        item: 'https://velxio.dev/arduino-simulator',
      },
    ],
  },
];

export const ArduinoSimulatorPage: React.FC = () => {
  useSEO({ ...META, jsonLd: JSON_LD });

  return (
    <div className="seo-page">
      <AppHeader />
      <main>
        {/* Hero */}
        <section className="seo-hero">
          <h1>
            Free Online Arduino Simulator
            <br />
            <span className="accent">Run Sketches in Your Browser</span>
          </h1>
          <p className="subtitle">
            Write Arduino code and simulate it instantly — real AVR8 emulation at 16 MHz with 48+
            interactive electronic components. No install, no cloud, no account required.
          </p>
          <div className="seo-cta-group">
            <Link
              to="/editor"
              className="seo-btn-primary"
              onClick={() => trackClickCTA('arduino-simulator', '/editor')}
            >
              Open Arduino Simulator →
            </Link>
            <Link to="/examples" className="seo-btn-secondary">
              Browse Examples
            </Link>
          </div>
          <p className="seo-trust">
            Free &amp; open-source · No signup required · Runs 100% in your browser
          </p>
        </section>

        {/* What you can simulate */}
        <section className="seo-section">
          <h2>What can you simulate?</h2>
          <p className="lead">
            Velxio simulates Arduino programs with full AVR8 CPU accuracy — including GPIO ports,
            hardware timers, USART, ADC, PWM, SPI, and I2C. No approximations, no shortcuts.
          </p>
          <div className="seo-grid">
            <div className="seo-card">
              <h3>Arduino Uno &amp; Nano</h3>
              <p>
                Full ATmega328P simulation at 16 MHz. PORTB, PORTC, PORTD register emulation. All 14
                digital and 6 analog pins.
              </p>
            </div>
            <div className="seo-card">
              <h3>Arduino Mega 2560</h3>
              <p>
                ATmega2560 with 256 KB flash, 54 digital pins, 16 analog inputs, and 4 hardware
                USART channels.
              </p>
            </div>
            <div className="seo-card">
              <h3>48+ Electronic Components</h3>
              <p>
                LEDs, resistors, buttons, buzzer, servo, ultrasonic sensor, ILI9341 TFT, 16×2 LCD,
                NeoPixel, DHT22, and more.
              </p>
            </div>
            <div className="seo-card">
              <h3>Serial Monitor</h3>
              <p>
                Real-time TX/RX with auto baud-rate detection. Send commands and view{' '}
                <code>Serial.print()</code> output live.
              </p>
            </div>
            <div className="seo-card">
              <h3>Multi-file Sketches</h3>
              <p>
                Write .ino, .h, and .cpp files in a VS Code-style Monaco editor — full multi-file
                Arduino project support.
              </p>
            </div>
            <div className="seo-card">
              <h3>Library Manager</h3>
              <p>
                Search and install any library from the full Arduino library index directly inside
                the simulator.
              </p>
            </div>
          </div>
        </section>

        {/* How it works */}
        <section className="seo-section">
          <h2>How the simulator works</h2>
          <p className="lead">
            Velxio uses <strong style={{ color: '#e6edf3' }}>avr8js</strong> — the battle-tested
            open-source AVR8 emulation library — to execute your compiled firmware byte-for-byte,
            exactly as it would run on physical hardware.
          </p>
          <div className="seo-grid">
            <div className="seo-card">
              <h3>1. Write</h3>
              <p>
                Write your Arduino sketch in the Monaco editor with C++ syntax highlighting and
                autocomplete.
              </p>
            </div>
            <div className="seo-card">
              <h3>2. Compile</h3>
              <p>
                Click Compile. arduino-cli produces a real .hex file — the same output as the
                Arduino IDE.
              </p>
            </div>
            <div className="seo-card">
              <h3>3. Simulate</h3>
              <p>
                The .hex is loaded into the AVR8 emulator. Your program executes at 16 MHz and
                drives the visual components.
              </p>
            </div>
          </div>
        </section>

        {/* FAQ */}
        <section className="seo-section">
          <h2>Frequently Asked Questions</h2>
          <dl className="seo-faq">
            {FAQ_ITEMS.map(({ q, a }) => (
              <React.Fragment key={q}>
                <dt>{q}</dt>
                <dd>{a}</dd>
              </React.Fragment>
            ))}
          </dl>
        </section>

        {/* Bottom CTA */}
        <div className="seo-bottom">
          <h2>Ready to simulate your Arduino?</h2>
          <p>
            Open the editor and start coding in seconds — no setup, no install, no account needed.
          </p>
          <Link
            to="/editor"
            className="seo-btn-primary"
            onClick={() => trackClickCTA('arduino-simulator', '/editor')}
          >
            Launch Arduino Simulator →
          </Link>
          <div className="seo-internal-links">
            <Link to="/examples">Example Projects</Link>
            <Link to="/arduino-emulator">Arduino Emulator</Link>
            <Link to="/atmega328p-simulator">ATmega328P Simulator</Link>
            <Link to="/arduino-mega-simulator">Mega 2560 Simulator</Link>
            <Link to="/esp32-simulator">ESP32 Simulator</Link>
            <Link to="/raspberry-pi-pico-simulator">RP2040 Simulator</Link>
          </div>
        </div>
      </main>
    </div>
  );
};
