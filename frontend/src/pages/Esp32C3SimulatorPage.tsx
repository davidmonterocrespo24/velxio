/**
 * /esp32-c3-simulator — SEO landing page
 * Target keywords: "esp32-c3 simulator", "risc-v simulator", "esp32 c3 emulator"
 */

import React from 'react';
import { Link } from 'react-router-dom';
import { AppHeader } from '../components/layout/AppHeader';
import { useSEO } from '../utils/useSEO';
import { getSeoMeta } from '../seoRoutes';
import { trackClickCTA } from '../utils/analytics';
import esp32C3SvgUrl from '../../../wokwi-libs/wokwi-boards/boards/esp32-c3-devkitm-1/board.svg?url';
import './SEOPage.css';

const META = getSeoMeta('/esp32-c3-simulator')!;

const FAQ_ITEMS = [
  {
    q: 'What is the ESP32-C3?',
    a: 'The ESP32-C3 is a RISC-V single-core microcontroller by Espressif running at 160 MHz (RV32IMC instruction set). It has WiFi + Bluetooth 5.0, 22 GPIO pins, and is one of the first RISC-V MCUs with a mature Arduino ecosystem.',
  },
  {
    q: 'Does the ESP32-C3 simulator run in the browser?',
    a: 'Yes. Unlike the Xtensa-based ESP32, the ESP32-C3 RISC-V emulation runs entirely in the browser — no QEMU backend needed. This makes it the fastest ESP32 variant to simulate.',
  },
  {
    q: 'Is this also a RISC-V simulator?',
    a: 'Yes. The ESP32-C3 uses the RISC-V RV32IMC instruction set. Velxio also supports the CH32V003 (RV32EC at 48 MHz) — another popular RISC-V microcontroller.',
  },
  {
    q: 'Which ESP32-C3 boards are supported?',
    a: 'Velxio supports ESP32-C3 DevKitM-1, Seeed XIAO ESP32-C3, and ESP32-C3 SuperMini (Aitewinrobot). All three use the same RISC-V core.',
  },
  {
    q: 'Can I use Arduino code with ESP32-C3?',
    a: 'Yes. Velxio compiles your .ino sketch using the official ESP32 Arduino core with the ESP32-C3 board target. All standard Arduino functions work — Serial, GPIO, analogRead, etc.',
  },
];

const JSON_LD: object[] = [
  {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: 'Velxio — Free ESP32-C3 & RISC-V Simulator',
    applicationCategory: 'DeveloperApplication',
    operatingSystem: 'Any (browser-based)',
    description:
      'Free online ESP32-C3 RISC-V simulator. Browser-native RV32IMC emulation at 160 MHz — no backend, no install. Simulate ESP32-C3 DevKit, XIAO ESP32-C3, SuperMini, and CH32V003.',
    url: 'https://velxio.dev/esp32-c3-simulator',
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
      {
        '@type': 'ListItem',
        position: 2,
        name: 'ESP32-C3 Simulator',
        item: 'https://velxio.dev/esp32-c3-simulator',
      },
    ],
  },
];

export const Esp32C3SimulatorPage: React.FC = () => {
  useSEO({ ...META, jsonLd: JSON_LD });

  return (
    <div className="seo-page">
      <AppHeader />
      <main>
        <section className="seo-hero">
          <img
            src={esp32C3SvgUrl}
            alt="ESP32-C3 DevKitM-1 board"
            style={{ height: 120, marginBottom: 24 }}
          />
          <h1>
            Free ESP32-C3 Simulator
            <br />
            <span className="accent">RISC-V Emulation — Runs in Your Browser</span>
          </h1>
          <p className="subtitle">
            Simulate ESP32-C3 and CH32V003 RISC-V code directly in your browser — no QEMU backend,
            no install. RV32IMC at 160 MHz with 48+ interactive components.
          </p>
          <div className="seo-cta-group">
            <Link
              to="/editor"
              className="seo-btn-primary"
              onClick={() => trackClickCTA('esp32-c3-simulator', '/editor')}
            >
              Open ESP32-C3 Simulator →
            </Link>
            <Link to="/examples" className="seo-btn-secondary">
              C3 Examples
            </Link>
          </div>
          <p className="seo-trust">
            Free &amp; open-source · 100% browser-native · No backend required
          </p>
        </section>

        <section className="seo-section">
          <h2>Supported RISC-V boards</h2>
          <p className="lead">
            Velxio emulates RISC-V microcontrollers natively in the browser using WebAssembly — the
            fastest simulation path available, no server round-trip.
          </p>
          <div className="seo-grid">
            <div className="seo-card">
              <h3>ESP32-C3 DevKitM-1</h3>
              <p>
                RISC-V RV32IMC at 160 MHz. WiFi + BLE 5.0, 22 GPIO, 400 KB SRAM. The official
                Espressif dev board.
              </p>
            </div>
            <div className="seo-card">
              <h3>XIAO ESP32-C3</h3>
              <p>
                Seeed Studio compact RISC-V board. 11 GPIO, USB-C, battery charging IC. 21×17.5 mm.
              </p>
            </div>
            <div className="seo-card">
              <h3>ESP32-C3 SuperMini</h3>
              <p>
                Aitewinrobot ultra-compact board. Same RISC-V core, minimal form factor for embedded
                projects.
              </p>
            </div>
            <div className="seo-card">
              <h3>CH32V003</h3>
              <p>
                WCH RISC-V RV32EC at 48 MHz. Ultra-low-cost DIP-8 package, 2 KB SRAM, 16 KB flash.
                Just cents per chip.
              </p>
            </div>
          </div>
        </section>

        <section className="seo-section">
          <h2>ESP32-C3 example projects</h2>
          <p className="lead">
            Ready-to-run examples for ESP32-C3 — from basic GPIO to sensor integrations.
          </p>
          <div className="seo-grid">
            <div className="seo-card">
              <h3>C3 Blink LED</h3>
              <p>Toggle an LED on GPIO 8. Classic blink sketch running on RISC-V.</p>
            </div>
            <div className="seo-card">
              <h3>C3 RGB LED</h3>
              <p>Drive an RGB LED with three PWM channels — smooth color cycling on RISC-V.</p>
            </div>
            <div className="seo-card">
              <h3>C3 Button + LED</h3>
              <p>
                Read a pushbutton on GPIO 9 and toggle an LED — digital input/output on ESP32-C3.
              </p>
            </div>
            <div className="seo-card">
              <h3>C3 DHT22 Sensor</h3>
              <p>Read temperature and humidity from DHT22 on ESP32-C3. Serial Monitor output.</p>
            </div>
            <div className="seo-card">
              <h3>C3 HC-SR04 Ultrasonic</h3>
              <p>Measure distance with ultrasonic sensor. Trigger/echo timing on RISC-V GPIO.</p>
            </div>
            <div className="seo-card">
              <h3>C3 Servo Motor</h3>
              <p>Sweep a servo from 0° to 180° using ESP32-C3 PWM output.</p>
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
          <h2>Ready to simulate ESP32-C3?</h2>
          <p>
            Open the editor, pick an ESP32-C3 board, and start coding — runs instantly in your
            browser.
          </p>
          <Link
            to="/editor"
            className="seo-btn-primary"
            onClick={() => trackClickCTA('esp32-c3-simulator', '/editor')}
          >
            Launch ESP32-C3 Simulator →
          </Link>
          <div className="seo-internal-links">
            <Link to="/esp32-simulator">ESP32 Simulator</Link>
            <Link to="/esp32-s3-simulator">ESP32-S3 Simulator</Link>
            <Link to="/raspberry-pi-pico-simulator">RP2040 Simulator</Link>
            <Link to="/arduino-simulator">Arduino Simulator</Link>
            <Link to="/docs/riscv-emulation">RISC-V Docs</Link>
          </div>
        </div>
      </main>
    </div>
  );
};
