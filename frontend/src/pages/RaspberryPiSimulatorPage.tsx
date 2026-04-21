/**
 * /raspberry-pi-simulator — SEO landing page
 * Target keywords: "raspberry pi simulator", "raspberry pi 3 emulator", "raspberry pi emulator online"
 */

import React from 'react';
import { Link } from 'react-router-dom';
import { AppHeader } from '../components/layout/AppHeader';
import { useSEO } from '../utils/useSEO';
import { getSeoMeta } from '../seoRoutes';
import { trackClickCTA } from '../utils/analytics';
import raspberryPi3Svg from '../assets/Raspberry_Pi_3_illustration.svg';
import './SEOPage.css';

const META = getSeoMeta('/raspberry-pi-simulator')!;

const FAQ_ITEMS = [
  {
    q: 'Can I simulate a Raspberry Pi 3 in my browser?',
    a: 'Yes. Velxio emulates a full Raspberry Pi 3B using QEMU raspi3b — ARM Cortex-A53 quad-core at 1.2 GHz running Raspberry Pi OS (Linux). You get a real terminal to run Python, bash, and system commands.',
  },
  {
    q: 'Is this Raspberry Pi simulator free?',
    a: 'Yes. Velxio is 100% free and open-source (GNU AGPLv3). No account, no subscription — simulate Raspberry Pi 3 code in your browser or self-host with Docker.',
  },
  {
    q: 'Can I run Python scripts on the Raspberry Pi simulator?',
    a: 'Yes. The emulated Raspberry Pi 3 runs full Raspberry Pi OS with Python 3 pre-installed. You can run Python scripts, use RPi.GPIO for GPIO control, install pip packages, and more.',
  },
  {
    q: 'What is the difference between Pi Pico and Pi 3 simulation?',
    a: 'Raspberry Pi Pico (RP2040) is a microcontroller — runs Arduino C++ code, no OS. Raspberry Pi 3 is a full Linux computer — runs Python, bash, and system services. Velxio supports both.',
  },
  {
    q: 'Does it support GPIO on Raspberry Pi 3?',
    a: 'Yes. The QEMU-emulated Raspberry Pi 3 supports GPIO via RPi.GPIO and gpiozero Python libraries. Control LEDs, read buttons, and interface with sensors from Python.',
  },
];

const JSON_LD: object[] = [
  {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: 'Velxio — Free Raspberry Pi 3 Simulator',
    applicationCategory: 'DeveloperApplication',
    operatingSystem: 'Any (browser-based)',
    description:
      'Free online Raspberry Pi 3 simulator with full ARM Cortex-A53 Linux emulation via QEMU. Run Python, bash, and RPi.GPIO in your browser — no Raspberry Pi hardware needed.',
    url: 'https://velxio.dev/raspberry-pi-simulator',
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
        name: 'Raspberry Pi Simulator',
        item: 'https://velxio.dev/raspberry-pi-simulator',
      },
    ],
  },
];

export const RaspberryPiSimulatorPage: React.FC = () => {
  useSEO({ ...META, jsonLd: JSON_LD });

  return (
    <div className="seo-page">
      <AppHeader />
      <main>
        <section className="seo-hero">
          <img
            src={raspberryPi3Svg}
            alt="Raspberry Pi 3 board illustration"
            style={{ height: 140, marginBottom: 24 }}
          />
          <h1>
            Free Raspberry Pi 3 Simulator
            <br />
            <span className="accent">Full Linux · Python · GPIO — In Your Browser</span>
          </h1>
          <p className="subtitle">
            Run a full Raspberry Pi 3B with Raspberry Pi OS directly in your browser — ARM
            Cortex-A53 quad-core emulation via QEMU. Write Python, control GPIO, install packages.
            No hardware needed.
          </p>
          <div className="seo-cta-group">
            <Link
              to="/editor"
              className="seo-btn-primary"
              onClick={() => trackClickCTA('rpi-simulator', '/editor')}
            >
              Open Pi 3 Simulator →
            </Link>
            <Link to="/docs/raspberry-pi3-emulation" className="seo-btn-secondary">
              Read the Docs
            </Link>
          </div>
          <p className="seo-trust">Free &amp; open-source · QEMU ARM64 · Full Raspberry Pi OS</p>
        </section>

        <section className="seo-section">
          <h2>What can you do with the Pi 3 simulator?</h2>
          <p className="lead">
            Velxio emulates a complete Raspberry Pi 3B — not just GPIO pins, but the entire Linux
            operating system. It's a full computer in your browser.
          </p>
          <div className="seo-grid">
            <div className="seo-card">
              <h3>Run Python Scripts</h3>
              <p>
                Python 3 pre-installed on Raspberry Pi OS. Run scripts, use pip, import libraries —
                full Python environment.
              </p>
            </div>
            <div className="seo-card">
              <h3>GPIO Control</h3>
              <p>
                Use RPi.GPIO or gpiozero to control LEDs, read buttons, drive motors — real GPIO
                emulation in QEMU.
              </p>
            </div>
            <div className="seo-card">
              <h3>Linux Terminal</h3>
              <p>
                Full bash terminal with apt, nano, git, and all standard Linux tools. Install
                packages, edit files, run services.
              </p>
            </div>
            <div className="seo-card">
              <h3>ARM Cortex-A53</h3>
              <p>
                Quad-core 64-bit ARM CPU at 1.2 GHz via QEMU raspi3b machine. Runs the official
                Raspberry Pi OS image.
              </p>
            </div>
            <div className="seo-card">
              <h3>No SD Card Needed</h3>
              <p>
                The OS image is pre-loaded. No flashing, no SD card, no power supply — just open the
                browser and start coding.
              </p>
            </div>
            <div className="seo-card">
              <h3>Multi-Board Canvas</h3>
              <p>
                Mix Raspberry Pi 3 with Arduino and ESP32 on the same simulation canvas. Control
                Arduino from Pi via serial.
              </p>
            </div>
          </div>
        </section>

        <section className="seo-section">
          <h2>Raspberry Pi Pico vs Pi 3 — which to choose?</h2>
          <div className="seo-grid">
            <div className="seo-card">
              <h3>Raspberry Pi Pico (RP2040)</h3>
              <p>
                Microcontroller. ARM Cortex-M0+ at 133 MHz. Runs Arduino C++ code. No OS,
                bare-metal. Best for embedded, IoT, sensors.{' '}
                <Link to="/raspberry-pi-pico-simulator">Try Pico Simulator →</Link>
              </p>
            </div>
            <div className="seo-card">
              <h3>Raspberry Pi 3 (ARM Cortex-A53)</h3>
              <p>
                Full Linux computer. Quad-core at 1.2 GHz. Runs Python, Node.js, bash. Best for
                automation, servers, GPIO scripting, education.
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
          <h2>Ready to simulate Raspberry Pi 3?</h2>
          <p>
            Open the editor, select Raspberry Pi 3, and boot into Linux — right in your browser.
          </p>
          <Link
            to="/editor"
            className="seo-btn-primary"
            onClick={() => trackClickCTA('rpi-simulator', '/editor')}
          >
            Launch Pi 3 Simulator →
          </Link>
          <div className="seo-internal-links">
            <Link to="/raspberry-pi-pico-simulator">Pico Simulator</Link>
            <Link to="/esp32-simulator">ESP32 Simulator</Link>
            <Link to="/arduino-simulator">Arduino Simulator</Link>
            <Link to="/docs/raspberry-pi3-emulation">Pi 3 Docs</Link>
            <Link to="/examples">Examples</Link>
          </div>
        </div>
      </main>
    </div>
  );
};
