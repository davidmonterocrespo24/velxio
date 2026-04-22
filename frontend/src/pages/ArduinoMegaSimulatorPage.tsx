/**
 * /arduino-mega-simulator — SEO landing page
 * Target keywords: "arduino mega", "mega 2560", "arduino mega 2560"
 */

import React from 'react';
import { Link } from 'react-router-dom';
import { AppHeader } from '../components/layout/AppHeader';
import { useSEO } from '../utils/useSEO';
import { getSeoMeta } from '../seoRoutes';
import { trackClickCTA } from '../utils/analytics';
import './SEOPage.css';

const META = getSeoMeta('/arduino-mega-simulator')!;

const FAQ_ITEMS = [
  {
    q: 'What is the Arduino Mega 2560?',
    a: 'The Arduino Mega 2560 is a microcontroller board based on the ATmega2560. It offers 256 KB flash memory, 8 KB SRAM, 54 digital I/O pins (15 PWM), 16 analog inputs, and 4 hardware USART channels — making it the go-to board for large, complex Arduino projects.',
  },
  {
    q: 'Can I simulate Arduino Mega 2560 code in my browser?',
    a: 'Yes. Velxio provides full ATmega2560 AVR8 emulation. Select "Arduino Mega 2560" in the board picker, write your sketch, compile, and simulate — with all 54 digital pins and 16 analog inputs available.',
  },
  {
    q: 'Is the Arduino Mega 2560 emulation accurate?',
    a: 'Velxio uses avr8js for cycle-accurate AVR8 instruction emulation. The ATmega2560 shares the same AVR8 core as the ATmega328P but with extended memory, more ports (PORTA–PORTL), and additional timers (Timer3, Timer4, Timer5) — all emulated.',
  },
  {
    q: 'What additional features does the Mega have over Arduino Uno?',
    a: 'Arduino Mega 2560 adds: 8× more flash (256 KB vs 32 KB), 4× more SRAM (8 KB vs 2 KB), 40 extra digital pins, 10 extra analog inputs, 3 extra hardware serial ports (Serial1, Serial2, Serial3), and 3 extra 16-bit timers (Timer3, Timer4, Timer5).',
  },
  {
    q: 'Does the Mega simulator support multiple Serial ports?',
    a: 'Yes. Serial (USART0), Serial1 (USART1), Serial2 (USART2), and Serial3 (USART3) are all emulated. Each appears in the Serial Monitor tab so you can monitor multi-serial communication projects.',
  },
];

const JSON_LD: object[] = [
  {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: 'Arduino Mega 2560 Simulator — Velxio',
    applicationCategory: 'DeveloperApplication',
    operatingSystem: 'Any (browser-based)',
    description:
      'Free online Arduino Mega 2560 simulator. Emulate ATmega2560 with 256 KB flash, 54 digital pins, 16 analog inputs, and 4 serial ports — full AVR8 emulation in your browser.',
    url: 'https://velxio.dev/arduino-mega-simulator',
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
        name: 'Arduino Mega 2560 Simulator',
        item: 'https://velxio.dev/arduino-mega-simulator',
      },
    ],
  },
];

export const ArduinoMegaSimulatorPage: React.FC = () => {
  useSEO({ ...META, jsonLd: JSON_LD });

  return (
    <div className="seo-page">
      <AppHeader />
      <main>
        {/* Hero */}
        <section className="seo-hero">
          <h1>
            Arduino Mega 2560 Simulator
            <br />
            <span className="accent">Free Online AVR8 Emulation</span>
          </h1>
          <p className="subtitle">
            Simulate Arduino Mega 2560 sketches in your browser with full ATmega2560 emulation — 256
            KB flash, 54 digital pins, 16 analog inputs, 4 serial ports, and 6 timers. Free and
            open-source.
          </p>
          <div className="seo-cta-group">
            <Link
              to="/editor"
              className="seo-btn-primary"
              onClick={() => trackClickCTA('arduino-mega-simulator', '/editor')}
            >
              Open Mega 2560 Simulator →
            </Link>
            <Link to="/examples" className="seo-btn-secondary">
              Browse Examples
            </Link>
          </div>
          <p className="seo-trust">
            Free &amp; open-source · No signup required · Full ATmega2560 emulation
          </p>
        </section>

        {/* ATmega2560 specs */}
        <section className="seo-section">
          <h2>Arduino Mega 2560 — full spec emulation</h2>
          <p className="lead">
            The ATmega2560 is the most capable AVR8 microcontroller in the Arduino lineup. Velxio
            emulates its complete peripheral set so every Mega-specific feature works in the
            simulator.
          </p>
          <div className="seo-grid">
            <div className="seo-card">
              <h3>256 KB Flash</h3>
              <p>
                8× more program storage than Arduino Uno. Run large sketches, complex state
                machines, and data-heavy applications without storage constraints.
              </p>
            </div>
            <div className="seo-card">
              <h3>54 Digital Pins</h3>
              <p>
                Full PORTA through PORTL emulation. 40 extra I/O pins compared to the Uno — ideal
                for multiplexed displays, large button matrices, and multi-module projects.
              </p>
            </div>
            <div className="seo-card">
              <h3>16 Analog Inputs</h3>
              <p>
                10-bit ADC with 16 channels (A0–A15). Connect multiple sensors, potentiometers, and
                analog components simultaneously in the simulation.
              </p>
            </div>
            <div className="seo-card">
              <h3>4 Hardware Serial</h3>
              <p>
                Serial (USART0–3) all emulated. Serial1, Serial2, Serial3 appear in the Serial
                Monitor — test multi-device serial communication projects.
              </p>
            </div>
            <div className="seo-card">
              <h3>6 Hardware Timers</h3>
              <p>
                Timer0/1/2/3/4/5. Three extra 16-bit timers (Timer3, Timer4, Timer5) compared to Uno
                — more PWM outputs and precise timing channels.
              </p>
            </div>
            <div className="seo-card">
              <h3>15 PWM Outputs</h3>
              <p>
                15 pins with hardware PWM support via analogWrite(). Ideal for motor control, servo
                arrays, LED dimming, and audio output projects.
              </p>
            </div>
          </div>
        </section>

        {/* Use cases */}
        <section className="seo-section">
          <h2>What the Mega 2560 is used for</h2>
          <p className="lead">
            The Arduino Mega 2560 is the preferred board for complex makers projects. Simulate them
            all without hardware.
          </p>
          <div className="seo-grid">
            <div className="seo-card">
              <h3>3D Printer Firmware</h3>
              <p>
                Marlin and RAMPS 1.4 shields run on ATmega2560. Prototype and debug printer control
                logic in the simulator.
              </p>
            </div>
            <div className="seo-card">
              <h3>CNC &amp; Robotics</h3>
              <p>
                GRBL CNC controller and multi-servo robot arms benefit from the Mega's extra I/O
                pins and timers.
              </p>
            </div>
            <div className="seo-card">
              <h3>Large LED Matrices</h3>
              <p>
                Driving 8×8 or 16×16 LED matrices requires many pins. The Mega's 54 digital outputs
                make it ideal.
              </p>
            </div>
            <div className="seo-card">
              <h3>Multi-Sensor Systems</h3>
              <p>
                16 analog inputs allow simultaneous reading from temperature, pressure, humidity,
                and light sensors without multiplexing.
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
          <h2>Simulate your Arduino Mega project</h2>
          <p>
            Select the Mega 2560 board in the editor and start simulating — full ATmega2560
            emulation, no hardware purchase needed.
          </p>
          <Link
            to="/editor"
            className="seo-btn-primary"
            onClick={() => trackClickCTA('arduino-mega-simulator', '/editor')}
          >
            Launch Mega 2560 Simulator →
          </Link>
          <div className="seo-internal-links">
            <Link to="/arduino-simulator">Arduino Simulator</Link>
            <Link to="/arduino-emulator">Arduino Emulator</Link>
            <Link to="/esp32-simulator">ESP32 Simulator</Link>
            <Link to="/raspberry-pi-pico-simulator">RP2040 Simulator</Link>
            <Link to="/examples">Example Projects</Link>
          </div>
        </div>
      </main>
    </div>
  );
};
