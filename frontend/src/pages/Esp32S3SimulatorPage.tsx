/**
 * /esp32-s3-simulator — SEO landing page
 * Target keywords: "esp32-s3 simulator", "esp32 s3 emulator"
 */

import React from 'react';
import { Link } from 'react-router-dom';
import { AppHeader } from '../components/layout/AppHeader';
import { useSEO } from '../utils/useSEO';
import { getSeoMeta } from '../seoRoutes';
import { trackClickCTA } from '../utils/analytics';
const esp32S3SvgUrl = '/boards/esp32-s3.svg';
import './SEOPage.css';

const META = getSeoMeta('/esp32-s3-simulator')!;

const FAQ_ITEMS = [
  {
    q: 'What is the ESP32-S3?',
    a: 'The ESP32-S3 is an Xtensa LX7 dual-core microcontroller by Espressif running at 240 MHz. It adds USB OTG, vector instructions for AI/ML, and up to 45 GPIO pins compared to the original ESP32.',
  },
  {
    q: 'Is the ESP32-S3 simulator free?',
    a: 'Yes. Velxio is 100% free and open-source. Simulate ESP32-S3 code in your browser with real Xtensa LX7 emulation via QEMU — no cloud, no subscription.',
  },
  {
    q: 'Which ESP32-S3 boards are supported?',
    a: 'Velxio supports ESP32-S3 DevKitC-1, Seeed XIAO ESP32-S3, and Arduino Nano ESP32 (which uses the ESP32-S3 chip).',
  },
  {
    q: 'Can I use Arduino libraries with ESP32-S3?',
    a: 'Yes. Velxio compiles your sketch with the official ESP32 Arduino core. Install any library from the Arduino Library Manager and use it in your ESP32-S3 project.',
  },
  {
    q: 'What is the difference between ESP32 and ESP32-S3?',
    a: 'The ESP32-S3 uses the newer Xtensa LX7 architecture (vs LX6), adds USB OTG for native USB device support, includes vector instructions for AI workloads, and has more GPIO pins (45 vs 34).',
  },
];

const JSON_LD: object[] = [
  {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: 'Velxio — Free ESP32-S3 Simulator',
    applicationCategory: 'DeveloperApplication',
    operatingSystem: 'Any (browser-based)',
    description:
      'Free online ESP32-S3 simulator with real Xtensa LX7 emulation via QEMU at 240 MHz. Simulate ESP32-S3 DevKitC, XIAO ESP32-S3, and Arduino Nano ESP32.',
    url: 'https://velxio.dev/esp32-s3-simulator',
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
        name: 'ESP32-S3 Simulator',
        item: 'https://velxio.dev/esp32-s3-simulator',
      },
    ],
  },
];

export const Esp32S3SimulatorPage: React.FC = () => {
  useSEO({ ...META, jsonLd: JSON_LD });

  return (
    <div className="seo-page">
      <AppHeader />
      <main>
        <section className="seo-hero">
          <img
            src={esp32S3SvgUrl}
            alt="ESP32-S3 DevKitC-1 board"
            style={{ height: 120, marginBottom: 24 }}
          />
          <h1>
            Free ESP32-S3 Simulator
            <br />
            <span className="accent">Xtensa LX7 · Dual-Core · 240 MHz</span>
          </h1>
          <p className="subtitle">
            Simulate ESP32-S3 firmware in your browser — real Xtensa LX7 dual-core emulation via
            QEMU. USB OTG, vector extensions, 45 GPIOs. Write, compile, and run in seconds.
          </p>
          <div className="seo-cta-group">
            <Link
              to="/editor"
              className="seo-btn-primary"
              onClick={() => trackClickCTA('esp32-s3-simulator', '/editor')}
            >
              Open ESP32-S3 Simulator →
            </Link>
            <Link to="/examples" className="seo-btn-secondary">
              Browse Examples
            </Link>
          </div>
          <p className="seo-trust">Free &amp; open-source · QEMU Xtensa LX7 · No account needed</p>
        </section>

        <section className="seo-section">
          <h2>Supported ESP32-S3 boards</h2>
          <p className="lead">
            Velxio emulates three ESP32-S3 boards. Each runs the official ESP32 Arduino core
            compiled via arduino-cli.
          </p>
          <div className="seo-grid">
            <div className="seo-card">
              <h3>ESP32-S3 DevKitC-1</h3>
              <p>
                Official Espressif development board. Dual-core Xtensa LX7 at 240 MHz, 45 GPIO, USB
                OTG, 512 KB SRAM.
              </p>
            </div>
            <div className="seo-card">
              <h3>XIAO ESP32-S3</h3>
              <p>
                Seeed Studio ultra-compact board (21×17.5 mm). 11 GPIO, USB-C, ideal for wearables
                and IoT.
              </p>
            </div>
            <div className="seo-card">
              <h3>Arduino Nano ESP32</h3>
              <p>
                ESP32-S3 in Arduino Nano form factor. USB-C, 14 digital + 8 analog pins, Arduino
                ecosystem compatibility.
              </p>
            </div>
          </div>
        </section>

        <section className="seo-section">
          <h2>ESP32-S3 vs ESP32 — What's new?</h2>
          <div className="seo-grid">
            <div className="seo-card">
              <h3>Xtensa LX7 CPU</h3>
              <p>
                Newer architecture with improved performance per clock. Same 240 MHz dual-core, but
                more efficient instruction pipeline.
              </p>
            </div>
            <div className="seo-card">
              <h3>USB OTG</h3>
              <p>
                Native USB device and host support — no external USB-to-UART chip needed. HID, CDC,
                MSC device classes.
              </p>
            </div>
            <div className="seo-card">
              <h3>Vector Instructions</h3>
              <p>
                Hardware-accelerated vector operations for AI/ML inference at the edge. TensorFlow
                Lite Micro optimized.
              </p>
            </div>
            <div className="seo-card">
              <h3>More GPIO</h3>
              <p>
                45 programmable GPIOs (vs 34 on ESP32). More ADC channels, touch pins, and
                peripheral options.
              </p>
            </div>
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
          <h2>Ready to simulate ESP32-S3?</h2>
          <p>Open the editor, select an ESP32-S3 board, and run your code instantly.</p>
          <Link
            to="/editor"
            className="seo-btn-primary"
            onClick={() => trackClickCTA('esp32-s3-simulator', '/editor')}
          >
            Launch ESP32-S3 Simulator →
          </Link>
          <div className="seo-internal-links">
            <Link to="/esp32-simulator">ESP32 Simulator</Link>
            <Link to="/esp32-c3-simulator">ESP32-C3 Simulator</Link>
            <Link to="/raspberry-pi-pico-simulator">RP2040 Simulator</Link>
            <Link to="/arduino-simulator">Arduino Simulator</Link>
            <Link to="/docs/esp32-emulation">ESP32 Docs</Link>
          </div>
        </div>
      </main>
    </div>
  );
};
