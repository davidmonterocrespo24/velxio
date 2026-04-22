/**
 * /arduino-emulator — SEO landing page
 * Target keywords: "arduino emulator"
 */

import React from 'react';
import { Link } from 'react-router-dom';
import { AppHeader } from '../components/layout/AppHeader';
import { useSEO } from '../utils/useSEO';
import { getSeoMeta } from '../seoRoutes';
import { trackClickCTA } from '../utils/analytics';
import './SEOPage.css';

const META = getSeoMeta('/arduino-emulator')!;

const FAQ_ITEMS = [
  {
    q: 'What is an Arduino emulator?',
    a: 'An Arduino emulator reproduces the behavior of a physical Arduino microcontroller in software — CPU instruction execution, peripheral registers (GPIO, USART, ADC, timers, PWM), and interrupts — with no hardware required.',
  },
  {
    q: "How accurate is Velxio's Arduino emulation?",
    a: 'Velxio uses avr8js, which provides cycle-accurate AVR8 instruction emulation. Every AVR opcode is faithfully emulated at 16 MHz, making it reliable for developing and debugging real firmware before flashing to hardware.',
  },
  {
    q: 'Which Arduino boards can Velxio emulate?',
    a: 'Arduino Uno (ATmega328P), Arduino Nano, Arduino Mega 2560 (ATmega2560), ATtiny85 (AVR8), Arduino Leonardo (ATmega32u4), Arduino Pro Mini, Raspberry Pi Pico and Pico W (RP2040), and multiple ESP32/RISC-V boards. 19 boards across 5 CPU architectures.',
  },
  {
    q: 'What peripherals are emulated?',
    a: 'GPIO ports (PORTB, PORTC, PORTD), hardware timers (Timer0, Timer1, Timer2), 8/16-bit PWM, USART serial, 10-bit ADC (analog inputs), SPI, and I2C. All standard Arduino library functions work correctly.',
  },
  {
    q: 'How is Velxio different from Wokwi?',
    a: 'Velxio is fully self-hosted and open-source under GNU AGPLv3. It uses the same avr8js emulation library as Wokwi but runs entirely on your own machine — no cloud dependency, no registration, no subscription.',
  },
];

const JSON_LD: object[] = [
  {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: 'Velxio Arduino Emulator',
    applicationCategory: 'DeveloperApplication',
    operatingSystem: 'Any (browser-based)',
    description:
      'Free, open-source Arduino emulator with cycle-accurate AVR8 emulation at 16 MHz. Emulate Arduino Uno, Nano, Mega and Raspberry Pi Pico in your browser — no cloud, no install.',
    url: 'https://velxio.dev/arduino-emulator',
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
        name: 'Arduino Emulator',
        item: 'https://velxio.dev/arduino-emulator',
      },
    ],
  },
];

export const ArduinoEmulatorPage: React.FC = () => {
  useSEO({ ...META, jsonLd: JSON_LD });

  return (
    <div className="seo-page">
      <AppHeader />
      <main>
        {/* Hero */}
        <section className="seo-hero">
          <h1>
            Arduino Emulator
            <br />
            <span className="accent">Real AVR8 &amp; RP2040 Emulation, Free</span>
          </h1>
          <p className="subtitle">
            Velxio is a cycle-accurate Arduino emulator running entirely in your browser. Every AVR
            opcode is faithfully executed at 16 MHz — the same silicon behavior as real hardware,
            without buying hardware.
          </p>
          <div className="seo-cta-group">
            <Link
              to="/editor"
              className="seo-btn-primary"
              onClick={() => trackClickCTA('arduino-emulator', '/editor')}
            >
              Open Emulator →
            </Link>
            <Link to="/docs/emulator" className="seo-btn-secondary">
              Emulation Details
            </Link>
          </div>
          <p className="seo-trust">
            Free &amp; open-source · Built on avr8js &amp; rp2040js · No signup required
          </p>
        </section>

        {/* Emulation accuracy */}
        <section className="seo-section">
          <h2>Emulation accuracy</h2>
          <p className="lead">
            Velxio uses <strong style={{ color: '#e6edf3' }}>avr8js</strong> for AVR8 and{' '}
            <strong style={{ color: '#e6edf3' }}>rp2040js</strong> for RP2040 — open-source
            libraries developed by the Wokwi team that provide genuine hardware fidelity.
          </p>
          <div className="seo-grid">
            <div className="seo-card">
              <h3>AVR8 Instruction Set</h3>
              <p>
                All 135 AVR instructions emulated including MUL, MULSU, FMUL, LPM, SPM, and all
                branch/skip instructions. 16 MHz clock.
              </p>
            </div>
            <div className="seo-card">
              <h3>Hardware Timers</h3>
              <p>
                Timer0, Timer1, Timer2 with prescaler support, overflow interrupts, and Output
                Compare — enabling <code>delay()</code>, <code>millis()</code>, and PWM.
              </p>
            </div>
            <div className="seo-card">
              <h3>USART Serial</h3>
              <p>
                Full USART emulation with configurable baud rate and TX/RX interrupts.{' '}
                <code>Serial.print()</code> works exactly as on real Arduino hardware.
              </p>
            </div>
            <div className="seo-card">
              <h3>10-bit ADC</h3>
              <p>
                Analog-to-digital converter emulation with analog reference support.{' '}
                <code>analogRead()</code> returns accurate values from simulated sensors.
              </p>
            </div>
            <div className="seo-card">
              <h3>RP2040 Dual-Core ARM</h3>
              <p>
                Cortex-M0+ emulation via rp2040js. Runs Arduino-pico and PlatformIO sketches for
                Raspberry Pi Pico and Pico W.
              </p>
            </div>
            <div className="seo-card">
              <h3>RISC-V (ESP32-C3)</h3>
              <p>
                Browser-native RV32IMC emulation for ESP32-C3 — no backend server required, compiled
                to WebAssembly, runs at 160 MHz.
              </p>
            </div>
          </div>
        </section>

        {/* Supported boards */}
        <section className="seo-section">
          <h2>Supported boards</h2>
          <p className="lead">
            19 boards across 5 CPU architectures — AVR8, ARM Cortex-M0+, RISC-V, Xtensa LX6/LX7, and
            ARM Cortex-A53.
          </p>
          <div className="seo-grid">
            <div className="seo-card">
              <h3>AVR8 — avr8js</h3>
              <p>
                Arduino Uno (ATmega328P), Arduino Nano, Arduino Mega 2560 (ATmega2560), ATtiny85,
                Arduino Leonardo (ATmega32u4), Arduino Pro Mini.
              </p>
            </div>
            <div className="seo-card">
              <h3>RP2040 — rp2040js</h3>
              <p>Raspberry Pi Pico, Raspberry Pi Pico W — dual ARM Cortex-M0+ at 133 MHz.</p>
            </div>
            <div className="seo-card">
              <h3>RISC-V — Browser</h3>
              <p>
                ESP32-C3 DevKit, XIAO ESP32-C3, ESP32-C3 SuperMini, CH32V003 — RV32IMC at 160 MHz.
              </p>
            </div>
            <div className="seo-card">
              <h3>Xtensa — QEMU</h3>
              <p>
                ESP32 DevKit V1/C V4, ESP32-S3, ESP32-CAM, Seeed XIAO ESP32-S3, Arduino Nano ESP32 —
                Xtensa LX6/LX7 at 240 MHz.
              </p>
            </div>
            <div className="seo-card">
              <h3>ARM Cortex-A53 — QEMU</h3>
              <p>
                Raspberry Pi 3B — quad-core 1.2 GHz, full Linux, Python 3. Run real OS-level
                programs in the browser.
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
          <h2>Start emulating Arduino today</h2>
          <p>
            Open the editor and execute your firmware against a real emulated CPU — no hardware
            purchase, no cloud, no limits.
          </p>
          <Link
            to="/editor"
            className="seo-btn-primary"
            onClick={() => trackClickCTA('arduino-emulator', '/editor')}
          >
            Launch Emulator →
          </Link>
          <div className="seo-internal-links">
            <Link to="/arduino-simulator">Arduino Simulator</Link>
            <Link to="/atmega328p-simulator">ATmega328P Simulator</Link>
            <Link to="/esp32-simulator">ESP32 Simulator</Link>
            <Link to="/raspberry-pi-pico-simulator">RP2040 Simulator</Link>
            <Link to="/examples">Example Projects</Link>
          </div>
        </div>
      </main>
    </div>
  );
};
