/**
 * /raspberry-pi-pico-simulator — SEO landing page
 * Target keywords: "raspberry pi pico simulator", "rp2040 emulator", "rp2040 simulator"
 */

import React from 'react';
import { Link } from 'react-router-dom';
import { AppHeader } from '../components/layout/AppHeader';
import { useSEO } from '../utils/useSEO';
import { getSeoMeta } from '../seoRoutes';
import { trackClickCTA } from '../utils/analytics';
import piPicoSvgUrl from '../../../wokwi-libs/wokwi-boards/boards/pi-pico/board.svg?url';
import './SEOPage.css';

const META = getSeoMeta('/raspberry-pi-pico-simulator')!;

const FAQ_ITEMS = [
  {
    q: 'Is this Raspberry Pi Pico simulator free?',
    a: 'Yes. Velxio is completely free and open-source (GNU AGPLv3). Simulate RP2040 code in your browser — no Raspberry Pi hardware needed, no account, no payment.',
  },
  {
    q: 'How does the RP2040 emulation work?',
    a: 'Velxio uses rp2040js — the open-source RP2040 emulator — to simulate the ARM Cortex-M0+ CPU at 133 MHz. Your code is compiled with the official Arduino-Pico core by Earle Philhower.',
  },
  {
    q: 'Does it support Raspberry Pi Pico W?',
    a: 'Yes. Both Raspberry Pi Pico and Pico W are supported. The RP2040 core emulation is identical — WiFi features are planned for a future update.',
  },
  {
    q: 'Can I use Arduino code with Raspberry Pi Pico?',
    a: 'Yes. Velxio compiles your .ino sketch using the arduino-pico core (by Earle Philhower). Standard Arduino functions like Serial, digitalWrite, analogRead, and I2C/SPI work out of the box.',
  },
  {
    q: 'What components work with Pico simulation?',
    a: 'All 48+ components: LEDs, resistors, buttons, DHT22, HC-SR04, servo motors, 7-segment displays, RGB LEDs, NTC sensors, joysticks, and more. Wire them to any of the 26 GPIO pins.',
  },
];

const JSON_LD: object[] = [
  {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: META.title.split(' | ')[0],
    applicationCategory: 'DeveloperApplication',
    operatingSystem: 'Any (browser-based)',
    description: META.description,
    url: META.url,
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
    author: { '@type': 'Person', name: 'David Montero Crespo' },
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
      { '@type': 'ListItem', position: 2, name: 'Raspberry Pi Pico Simulator', item: META.url },
    ],
  },
];

export const RaspberryPiPicoSimulatorPage: React.FC = () => {
  useSEO({ ...META, jsonLd: JSON_LD });

  return (
    <div className="seo-page">
      <AppHeader />
      <main>
        <section className="seo-hero">
          <img
            src={piPicoSvgUrl}
            alt="Raspberry Pi Pico board"
            style={{ height: 120, marginBottom: 24 }}
          />
          <h1>
            Free Raspberry Pi Pico Simulator
            <br />
            <span className="accent">RP2040 ARM Cortex-M0+ Emulation</span>
          </h1>
          <p className="subtitle">
            Write Arduino code for Raspberry Pi Pico and simulate it in your browser — real RP2040
            ARM Cortex-M0+ emulation at 133 MHz. 26 GPIO pins, I2C, SPI, UART, ADC. No hardware
            needed.
          </p>
          <div className="seo-cta-group">
            <Link
              to="/editor"
              className="seo-btn-primary"
              onClick={() => trackClickCTA('rpi-pico-simulator', '/editor')}
            >
              Open Pico Simulator →
            </Link>
            <Link to="/examples" className="seo-btn-secondary">
              Pico Examples
            </Link>
          </div>
          <p className="seo-trust">
            Free &amp; open-source · rp2040js emulation · No account needed
          </p>
        </section>

        <section className="seo-section">
          <h2>Supported RP2040 boards</h2>
          <p className="lead">
            Both official Raspberry Pi Pico boards are supported with full RP2040 CPU emulation via
            rp2040js.
          </p>
          <div className="seo-grid">
            <div className="seo-card">
              <h3>Raspberry Pi Pico</h3>
              <p>
                RP2040 dual-core ARM Cortex-M0+ at 133 MHz. 264 KB SRAM, 2 MB flash. 26 GPIO, 3 ADC,
                2× SPI, 2× I2C, 2× UART.
              </p>
            </div>
            <div className="seo-card">
              <h3>Raspberry Pi Pico W</h3>
              <p>
                Same RP2040 chip plus Infineon CYW43439 for WiFi 4 and Bluetooth 5.2. Pin-compatible
                with Pico.
              </p>
            </div>
            <div className="seo-card">
              <h3>RP2040 specs</h3>
              <p>
                Dual-core Cortex-M0+ at 133 MHz, 264 KB SRAM, hardware interpolators, 8 PIO state
                machines, DMA controller.
              </p>
            </div>
          </div>
        </section>

        <section className="seo-section">
          <h2>Pico example projects</h2>
          <p className="lead">
            18+ ready-to-run Raspberry Pi Pico examples — from LED blink to I2C, SPI, and sensor
            integrations.
          </p>
          <div className="seo-grid">
            <div className="seo-card">
              <h3>Pico Blink</h3>
              <p>Toggle the onboard LED (GP25). The simplest starting point for RP2040.</p>
            </div>
            <div className="seo-card">
              <h3>Pico Serial Echo</h3>
              <p>Read from Serial and echo it back. Test UART communication on RP2040.</p>
            </div>
            <div className="seo-card">
              <h3>Pico I2C Scanner</h3>
              <p>Scan the I2C bus and report connected devices. Foundation for sensor projects.</p>
            </div>
            <div className="seo-card">
              <h3>Pico ADC Read</h3>
              <p>
                Read the 12-bit ADC — measure analog voltage, temperature sensor, or potentiometer.
              </p>
            </div>
            <div className="seo-card">
              <h3>Pico DHT22 Sensor</h3>
              <p>
                Read temperature and humidity from DHT22. Serial output with formatted readings.
              </p>
            </div>
            <div className="seo-card">
              <h3>Pico Servo Motor</h3>
              <p>
                Sweep a servo from 0° to 180° using RP2040 PWM. Smooth motion with configurable
                range.
              </p>
            </div>
          </div>
          <div style={{ textAlign: 'center', marginTop: 24 }}>
            <Link to="/examples" className="seo-btn-secondary">
              View All 68+ Examples →
            </Link>
          </div>
        </section>

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

        <div className="seo-bottom">
          <h2>Ready to simulate Raspberry Pi Pico?</h2>
          <p>
            Open the editor, select a Pico board, and start coding — no Raspberry Pi hardware
            required.
          </p>
          <Link
            to="/editor"
            className="seo-btn-primary"
            onClick={() => trackClickCTA('rpi-pico-simulator', '/editor')}
          >
            Launch Pico Simulator →
          </Link>
          <div className="seo-internal-links">
            <Link to="/examples">Example Projects</Link>
            <Link to="/docs/rp2040-emulation">RP2040 Docs</Link>
            <Link to="/raspberry-pi-simulator">Raspberry Pi 3 Simulator</Link>
            <Link to="/esp32-simulator">ESP32 Simulator</Link>
            <Link to="/arduino-simulator">Arduino Simulator</Link>
          </div>
        </div>
      </main>
    </div>
  );
};
