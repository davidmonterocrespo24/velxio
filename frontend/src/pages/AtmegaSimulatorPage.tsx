/**
 * /atmega328p-simulator — SEO landing page
 * Target keywords: "atmega328p", "atmega", "atmega 328p", "atmega328p arduino"
 */

import React from 'react';
import { Link } from 'react-router-dom';
import { AppHeader } from '../components/layout/AppHeader';
import { useSEO } from '../utils/useSEO';
import { getSeoMeta } from '../seoRoutes';
import { trackClickCTA } from '../utils/analytics';
import './SEOPage.css';

const META = getSeoMeta('/atmega328p-simulator')!;

const FAQ_ITEMS = [
  {
    q: 'What is the ATmega328P?',
    a: 'The ATmega328P is an 8-bit AVR microcontroller by Microchip (formerly Atmel). It is the heart of the Arduino Uno and Arduino Nano, running at 16 MHz with 32 KB flash, 2 KB SRAM, and 1 KB EEPROM.',
  },
  {
    q: 'Can I simulate ATmega328P register-level code?',
    a: "Yes. Velxio's AVR8 emulation faithfully executes all ATmega328P registers: DDRB/C/D, PORTB/C/D, PINB/C/D, TCCR0/1/2, OCR0/1/2, UBRR, UDR, ADCL/ADCH, and all interrupt vectors — including direct register manipulation without the Arduino abstraction layer.",
  },
  {
    q: 'Does it emulate ATmega328P timers correctly?',
    a: 'Timer0 (8-bit), Timer1 (16-bit), and Timer2 (8-bit) are all emulated with full prescaler support, PWM modes, overflow interrupts, and Output Compare Match interrupts. millis(), delay(), analogWrite(), and tone() all work correctly.',
  },
  {
    q: 'Can I use analogRead() and analogWrite() in the simulator?',
    a: 'Yes. The 10-bit ADC (analogRead) and PWM output (analogWrite on pins 3, 5, 6, 9, 10, 11) are fully emulated. You can connect simulated sensors, potentiometers, and any wokwi-elements analog component.',
  },
  {
    q: 'Can I simulate USART / Serial on ATmega328P?',
    a: 'Yes. USART0 is fully emulated. Serial.begin(), Serial.print(), Serial.println(), and Serial.read() all work. The built-in Serial Monitor shows TX output and lets you send RX data to the running program.',
  },
];

const JSON_LD: object[] = [
  {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: 'ATmega328P Simulator — Velxio',
    applicationCategory: 'DeveloperApplication',
    operatingSystem: 'Any (browser-based)',
    description:
      'Free browser-based ATmega328P simulator. Full AVR8 emulation at 16 MHz — PORTB, PORTC, PORTD, Timer0/1/2, ADC, USART, PWM — with 48+ interactive components. No install required.',
    url: 'https://velxio.dev/atmega328p-simulator',
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
        name: 'ATmega328P Simulator',
        item: 'https://velxio.dev/atmega328p-simulator',
      },
    ],
  },
];

export const AtmegaSimulatorPage: React.FC = () => {
  useSEO({ ...META, jsonLd: JSON_LD });

  return (
    <div className="seo-page">
      <AppHeader />
      <main>
        {/* Hero */}
        <section className="seo-hero">
          <h1>
            ATmega328P Simulator
            <br />
            <span className="accent">Free AVR8 Emulation in Your Browser</span>
          </h1>
          <p className="subtitle">
            Simulate ATmega328P firmware exactly as it runs on Arduino Uno and Nano — real AVR8
            instruction execution at 16 MHz with full GPIO, timer, ADC, and USART emulation. No
            hardware, no install.
          </p>
          <div className="seo-cta-group">
            <Link
              to="/editor"
              className="seo-btn-primary"
              onClick={() => trackClickCTA('atmega-simulator', '/editor')}
            >
              Open ATmega328P Simulator →
            </Link>
            <Link to="/docs/emulator" className="seo-btn-secondary">
              Technical Details
            </Link>
          </div>
          <p className="seo-trust">
            Free &amp; open-source · Genuine AVR8 emulation · Runs 100% in your browser
          </p>
        </section>

        {/* ATmega328P specs */}
        <section className="seo-section">
          <h2>ATmega328P specification — fully emulated</h2>
          <p className="lead">
            Everything about the ATmega328P is emulated: registers, peripherals, interrupts, and
            timing. Write bare-metal firmware or use the Arduino core library — both work
            identically in the simulator.
          </p>
          <div className="seo-grid">
            <div className="seo-card">
              <h3>CPU Core</h3>
              <p>
                AVR8 (8-bit RISC), 16 MHz, 135 instructions, 32 general-purpose registers, 2-stage
                pipeline.
              </p>
            </div>
            <div className="seo-card">
              <h3>Flash Memory</h3>
              <p>
                32 KB program flash. Upload any sketch compiled by arduino-cli. Supports
                self-programming via SPM instruction.
              </p>
            </div>
            <div className="seo-card">
              <h3>GPIO Ports</h3>
              <p>
                PORTB (pins 8–13), PORTC (A0–A5), PORTD (0–7). DDR, PORT, PIN registers all
                emulated. Interrupt-on-change via PCINT.
              </p>
            </div>
            <div className="seo-card">
              <h3>Timers 0 / 1 / 2</h3>
              <p>
                8-bit Timer0 &amp; Timer2, 16-bit Timer1. All PWM modes. Prescaler 1–1024. CTC, Fast
                PWM, Phase-correct PWM.
              </p>
            </div>
            <div className="seo-card">
              <h3>10-bit ADC</h3>
              <p>
                6 analog input channels (A0–A5). Single conversion and free-running modes. Analog
                voltage from simulated components.
              </p>
            </div>
            <div className="seo-card">
              <h3>USART0</h3>
              <p>
                Full duplex serial with configurable baud rate. TX, RX, and UDRE interrupts. Works
                with the built-in Serial Monitor.
              </p>
            </div>
          </div>
        </section>

        {/* Compatible boards */}
        <section className="seo-section">
          <h2>ATmega328P boards in Velxio</h2>
          <p className="lead">
            The ATmega328P powers several popular Arduino boards — all selectable in Velxio. The
            broader AVR8 family also includes ATmega2560 (Mega) and ATtiny85.
          </p>
          <div className="seo-grid">
            <div className="seo-card">
              <h3>Arduino Uno R3</h3>
              <p>
                The classic board. 14 digital I/O pins (6 PWM), 6 analog inputs, 32 KB flash. The
                most widely used ATmega328P board.
              </p>
            </div>
            <div className="seo-card">
              <h3>Arduino Nano</h3>
              <p>
                Same ATmega328P in a compact 45×18mm form factor with mini-USB. Same pin count as
                Uno.
              </p>
            </div>
            <div className="seo-card">
              <h3>Arduino Pro Mini</h3>
              <p>
                Bare-bones ATmega328P without USB chip. Available at 3.3 V/8 MHz and 5 V/16 MHz
                variants.
              </p>
            </div>
            <div className="seo-card">
              <h3>ATtiny85</h3>
              <p>
                Ultra-compact 8-pin AVR. 8 KB flash, 6 I/O pins (PB0–PB5), USI (Wire), Timer0/1,
                10-bit ADC. Ideal for embedded minimal projects.
              </p>
            </div>
            <div className="seo-card">
              <h3>Arduino Mega 2560</h3>
              <p>
                ATmega2560 with 256 KB flash, 54 digital pins, 16 analog inputs, and 4 hardware
                USART channels.
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
          <h2>Simulate your ATmega328P code now</h2>
          <p>
            Open the editor, paste your sketch, and click Simulate — no setup, no hardware purchase
            required.
          </p>
          <Link
            to="/editor"
            className="seo-btn-primary"
            onClick={() => trackClickCTA('atmega-simulator', '/editor')}
          >
            Launch ATmega328P Simulator →
          </Link>
          <div className="seo-internal-links">
            <Link to="/arduino-simulator">Arduino Simulator</Link>
            <Link to="/arduino-emulator">Arduino Emulator</Link>
            <Link to="/esp32-simulator">ESP32 Simulator</Link>
            <Link to="/raspberry-pi-pico-simulator">RP2040 Simulator</Link>
            <Link to="/examples">Example Sketches</Link>
          </div>
        </div>
      </main>
    </div>
  );
};
