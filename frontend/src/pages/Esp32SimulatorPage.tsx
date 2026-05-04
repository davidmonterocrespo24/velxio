/**
 * /esp32-simulator — SEO landing page
 * Target keywords: "esp32 simulator", "esp32 emulator", "esp32 emulator online"
 */

import React from 'react';
import { Link } from 'react-router-dom';
import { AppHeader } from '../components/layout/AppHeader';
import { useSEO } from '../utils/useSEO';
import { getSeoMeta } from '../seoRoutes';
import { trackClickCTA } from '../utils/analytics';
const esp32SvgUrl = '/boards/esp32-devkit-v1.svg';
import './SEOPage.css';

const META = getSeoMeta('/esp32-simulator')!;

const FAQ_ITEMS = [
  {
    q: 'Is this ESP32 simulator free?',
    a: 'Yes. Velxio is completely free and open-source (GNU AGPLv3). Simulate ESP32 code in your browser or self-host the entire platform with one Docker command — no account, no payment.',
  },
  {
    q: 'How does the ESP32 emulation work?',
    a: 'Velxio uses QEMU (lcgamboa fork) to emulate the Xtensa LX6 CPU at 240 MHz. Your Arduino sketch is compiled with the official ESP32 Arduino core and the resulting firmware runs on the emulated hardware — same as real silicon.',
  },
  {
    q: 'Which ESP32 boards are supported?',
    a: 'Velxio supports ESP32 DevKit V1, ESP32 DevKit C V4, ESP32-CAM, Arduino Nano ESP32, ESP32-S3 DevKitC, XIAO ESP32-S3, ESP32-C3 DevKit, XIAO ESP32-C3, and ESP32-C3 SuperMini.',
  },
  {
    q: 'Can I simulate ESP32 with sensors and displays?',
    a: 'Yes. Connect 48+ interactive components: DHT22, HC-SR04 ultrasonic, MPU6050 IMU, servo motors, ILI9341 TFT display, LEDs, buttons, 7-segment displays, and more.',
  },
  {
    q: 'Does it support Serial Monitor for ESP32?',
    a: 'Yes. The Serial Monitor works with ESP32 just like Arduino — auto baud-rate detection, real-time TX/RX output, and send commands back to your running sketch.',
  },
];

const JSON_LD: object[] = [
  {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: 'Velxio — Free ESP32 Simulator & Emulator',
    applicationCategory: 'DeveloperApplication',
    operatingSystem: 'Any (browser-based)',
    description:
      'Free online ESP32 simulator with real Xtensa LX6 emulation via QEMU. Simulate ESP32, ESP32-S3, and ESP32-CAM code with 48+ interactive components — no install, no account.',
    url: 'https://velxio.dev/esp32-simulator',
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
        name: 'ESP32 Simulator',
        item: 'https://velxio.dev/esp32-simulator',
      },
    ],
  },
];

export const Esp32SimulatorPage: React.FC = () => {
  useSEO({ ...META, jsonLd: JSON_LD });

  return (
    <div className="seo-page">
      <AppHeader />
      <main>
        {/* Hero */}
        <section className="seo-hero">
          <img
            src={esp32SvgUrl}
            alt="ESP32 DevKit V1 board"
            style={{ height: 120, marginBottom: 24 }}
          />
          <h1>
            Free ESP32 Simulator
            <br />
            <span className="accent">Xtensa LX6 Emulation in Your Browser</span>
          </h1>
          <p className="subtitle">
            Write Arduino code for ESP32 and simulate it instantly — real Xtensa LX6 emulation at
            240 MHz via QEMU. 48+ interactive components, Serial Monitor, no install required.
          </p>
          <div className="seo-cta-group">
            <Link
              to="/editor"
              className="seo-btn-primary"
              onClick={() => trackClickCTA('esp32-simulator', '/editor')}
            >
              Open ESP32 Simulator →
            </Link>
            <Link to="/examples" className="seo-btn-secondary">
              ESP32 Examples
            </Link>
          </div>
          <p className="seo-trust">Free &amp; open-source · No signup · QEMU-powered emulation</p>
        </section>

        {/* Supported ESP32 boards */}
        <section className="seo-section">
          <h2>Supported ESP32 boards</h2>
          <p className="lead">
            Velxio emulates the full ESP32 family — Xtensa LX6 (ESP32), Xtensa LX7 (ESP32-S3), and
            RISC-V (ESP32-C3). Each board runs with real CPU emulation, not approximations.
          </p>
          <div className="seo-grid">
            <div className="seo-card">
              <h3>ESP32 DevKit V1 / C V4</h3>
              <p>
                Xtensa LX6 dual-core at 240 MHz. WiFi + Bluetooth. 34 GPIO pins, 12-bit ADC, 2× DAC,
                SPI, I2C, UART.
              </p>
            </div>
            <div className="seo-card">
              <h3>ESP32-S3 DevKitC</h3>
              <p>Xtensa LX7 dual-core at 240 MHz. USB OTG, vector instructions, 45 GPIO pins.</p>
            </div>
            <div className="seo-card">
              <h3>ESP32-CAM</h3>
              <p>ESP32 with OV2640 camera module. 240 MHz Xtensa LX6, onboard microSD slot.</p>
            </div>
            <div className="seo-card">
              <h3>Arduino Nano ESP32</h3>
              <p>
                ESP32-S3 in Arduino Nano form factor. USB-C, 14 digital + 8 analog pins, compatible
                with Arduino shields.
              </p>
            </div>
            <div className="seo-card">
              <h3>XIAO ESP32-S3</h3>
              <p>
                Seeed Studio compact board. Xtensa LX7, 11 GPIO, ultra-small 21×17.5 mm form factor.
              </p>
            </div>
            <div className="seo-card">
              <h3>ESP32-C3 (RISC-V)</h3>
              <p>
                Single-core RISC-V RV32IMC at 160 MHz. Browser-native emulation — no QEMU needed.{' '}
                <Link to="/esp32-c3-simulator">Learn more →</Link>
              </p>
            </div>
          </div>
        </section>

        {/* Example projects */}
        <section className="seo-section">
          <h2>ESP32 example projects</h2>
          <p className="lead">
            Jump straight into simulation with ready-to-run ESP32 examples — from basic LED blink to
            sensor integrations.
          </p>
          <div className="seo-grid">
            <div className="seo-card">
              <h3>ESP32 Blink LED</h3>
              <p>Classic blink sketch adapted for ESP32 GPIO. Toggle an LED on pin 2 at 1 Hz.</p>
            </div>
            <div className="seo-card">
              <h3>ESP32 Serial Echo</h3>
              <p>
                Read input from Serial Monitor and echo it back — test UART communication at 115200
                baud.
              </p>
            </div>
            <div className="seo-card">
              <h3>ESP32 DHT22 Sensor</h3>
              <p>
                Read temperature and humidity from a DHT22 sensor and display values in the Serial
                Monitor.
              </p>
            </div>
            <div className="seo-card">
              <h3>ESP32 HC-SR04 Ultrasonic</h3>
              <p>
                Measure distance with an ultrasonic sensor. Trigger/echo timing with real GPIO
                emulation.
              </p>
            </div>
            <div className="seo-card">
              <h3>ESP32 Servo Motor</h3>
              <p>
                Sweep a servo motor from 0° to 180° using ESP32 PWM — uses the ESP32Servo library.
              </p>
            </div>
            <div className="seo-card">
              <h3>ESP32 7-Segment Display</h3>
              <p>
                Drive a 7-segment display counting 0–9. Demonstrates digital output pin mapping on
                ESP32.
              </p>
            </div>
          </div>
          <div style={{ textAlign: 'center', marginTop: 24 }}>
            <Link to="/examples" className="seo-btn-secondary">
              View All 68+ Examples →
            </Link>
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
          <h2>Ready to simulate your ESP32?</h2>
          <p>
            Open the editor, select an ESP32 board, and start coding — no setup, no install, no
            account needed.
          </p>
          <Link
            to="/editor"
            className="seo-btn-primary"
            onClick={() => trackClickCTA('esp32-simulator', '/editor')}
          >
            Launch ESP32 Simulator →
          </Link>
          <div className="seo-internal-links">
            <Link to="/examples">Example Projects</Link>
            <Link to="/docs/esp32-emulation">ESP32 Docs</Link>
            <Link to="/esp32-c3-simulator">ESP32-C3 Simulator</Link>
            <Link to="/raspberry-pi-pico-simulator">RP2040 Simulator</Link>
            <Link to="/arduino-simulator">Arduino Simulator</Link>
          </div>
        </div>
      </main>
    </div>
  );
};
