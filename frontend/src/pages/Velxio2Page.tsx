/**
 * /v2 — Velxio 2.0 Release Landing Page
 * Showcases all new features, supported boards, and community CTAs
 */

import React from 'react';
import { Link } from 'react-router-dom';
import { AppHeader } from '../components/layout/AppHeader';
import { useSEO } from '../utils/useSEO';
import raspberryPi3Svg from '../assets/Raspberry_Pi_3_illustration.svg';
import './SEOPage.css';
import './Velxio2Page.css';

const GITHUB_URL = 'https://github.com/davidmonterocrespo24/velxio';
const DISCORD_URL = 'https://discord.gg/rCScB9cG';

/* ── SVG Icons (no emojis) ─────────────────────────────── */
const IcoRocket = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z" />
    <path d="M12 15l-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z" />
    <path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0" />
    <path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5" />
  </svg>
);

const IcoChip = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="5" y="5" width="14" height="14" rx="2" />
    <rect x="9" y="9" width="6" height="6" />
    <path d="M9 1v4M15 1v4M9 19v4M15 19v4M1 9h4M1 15h4M19 9h4M19 15h4" />
  </svg>
);

const IcoCpu = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="4" y="4" width="16" height="16" rx="2" />
    <rect x="8" y="8" width="8" height="8" />
    <path d="M10 2v2M14 2v2M10 20v2M14 20v2M2 10h2M2 14h2M20 10h2M20 14h2" />
  </svg>
);

const IcoSensor = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);

const IcoTerminal = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="4 17 10 11 4 5" />
    <line x1="12" y1="19" x2="20" y2="19" />
  </svg>
);

const IcoTestTube = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14.5 2v17.5c0 1.4-1.1 2.5-2.5 2.5s-2.5-1.1-2.5-2.5V2" />
    <path d="M8.5 2h7" />
    <path d="M14.5 16h-5" />
  </svg>
);

const IcoPaintbrush = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M18.37 2.63L14 7l-1.59-1.59a2 2 0 0 0-2.82 0L8 7l9 9 1.59-1.59a2 2 0 0 0 0-2.82L17 10l4.37-4.37a2.12 2.12 0 1 0-3-3z" />
    <path d="M9 8c-2 3-4 3.5-7 4l8 10c2-1 6-5 6-7" />
  </svg>
);

const IcoBook = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
    <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
  </svg>
);

const IcoWrench = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
  </svg>
);

const IcoGitHub = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
    <path d="M12 0C5.37 0 0 5.37 0 12c0 5.3 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61-.546-1.385-1.335-1.755-1.335-1.755-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 21.795 24 17.295 24 12c0-6.63-5.37-12-12-12z" />
  </svg>
);

const IcoDiscord = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
    <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.095 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.095 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
  </svg>
);

const IcoStar = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
  </svg>
);

const IcoRefresh = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21.5 2v6h-6" />
    <path d="M2.5 22v-6h6" />
    <path d="M2 11.5a10 10 0 0 1 18.8-4.3" />
    <path d="M22 12.5a10 10 0 0 1-18.8 4.2" />
  </svg>
);

const JSON_LD: object[] = [
  {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: 'Velxio 2.0 — Multi-Board Embedded Systems Simulator',
    applicationCategory: 'DeveloperApplication',
    operatingSystem: 'Any (browser-based)',
    softwareVersion: '2.0.0',
    description:
      'Velxio 2.0 — a free, open-source multi-board embedded systems simulator. 19 boards, 5 CPU architectures, QEMU-based ESP32 emulation, sensor simulation, 68+ examples. Runs in your browser.',
    url: 'https://velxio.dev/v2',
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
    author: { '@type': 'Person', name: 'David Montero Crespo' },
    license: 'https://www.gnu.org/licenses/agpl-3.0.html',
  },
  {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Velxio', item: 'https://velxio.dev/' },
      { '@type': 'ListItem', position: 2, name: 'Velxio 2.0', item: 'https://velxio.dev/v2' },
    ],
  },
];

const CHANGE_SECTIONS = [
  {
    icon: <IcoChip />,
    title: 'Multi-Board Support',
    color: '#007acc',
    items: [
      'Raspberry Pi 3B — full Linux (ARM Cortex-A53 via QEMU raspi3b)',
      'ESP32 / ESP32-S3 / ESP32-CAM — Xtensa LX6/LX7 via QEMU',
      'ESP32-C3 / CH32V003 — RISC-V RV32IMC, browser-native',
      'RP2040 — Raspberry Pi Pico / Pico W (ARM Cortex-M0+)',
      'ATtiny85, ATmega2560, Leonardo, Pro Mini — AVR8 via avr8js',
      'Multi-board canvas — mix architectures on the same simulation',
    ],
  },
  {
    icon: <IcoCpu />,
    title: 'Advanced Emulation',
    color: '#c8701a',
    items: [
      'ESP32 emulation via QEMU (Xtensa) with GPIO, ADC, timers',
      'SYSTIMER, timer group, and SPI flash/EXTMEM stubs',
      'ROM function emulation for ESP32 boot sequence',
      'Enhanced RP2040 dual-core ARM simulation',
      'Virtual File System for Raspberry Pi 3 (full Linux OS)',
      'Real arduino-cli compilation producing .hex / .bin / .uf2 files',
    ],
  },
  {
    icon: <IcoSensor />,
    title: 'Sensor Simulation',
    color: '#4a9e6b',
    items: [
      'DHT22 — accurate timing and synchronous protocol handling',
      'HC-SR04 — ultrasonic distance measurement with trigger/echo',
      'Servo motor — configurable sweep with PWM emulation',
      'Potentiometer and analog sensor improvements',
      'Generic sensor registration system for extensibility',
      'Improved timing accuracy and component interactions',
    ],
  },
  {
    icon: <IcoTestTube />,
    title: 'Testing',
    color: '#a8304d',
    items: [
      'ESP32 test modules and integration test suites',
      'Multi-board integration tests across architectures',
      'Arduino serial communication integration testing',
    ],
  },
  {
    icon: <IcoPaintbrush />,
    title: 'UI/UX Improvements',
    color: '#8957e5',
    items: [
      'Enhanced simulator canvas — wire handling and segment dragging',
      'Improved z-index layering and component rendering',
      'Oscilloscope and multi-board picker enhancements',
      'Sensor Control Panel for interactive sensor adjustment',
      'New visual components for all supported board families',
      'Mobile-first responsive design with code/circuit tab switcher',
    ],
  },
  {
    icon: <IcoBook />,
    title: 'Documentation',
    color: '#1a7f37',
    items: [
      'Full documentation site with 10+ pages',
      'Board gallery with all 19 supported boards',
      'ESP32 emulation guide (Xtensa + RISC-V)',
      'RP2040 and Raspberry Pi 3 documentation',
      'CodeBlock component with syntax highlighting',
    ],
  },
  {
    icon: <IcoRefresh />,
    title: 'Refactoring & Cleanup',
    color: '#6e7681',
    items: [
      'Codebase refactors for readability and maintainability',
      'Removed deprecated scripts and unused code',
      'Simplified logging and internal data structures',
    ],
  },
  {
    icon: <IcoWrench />,
    title: 'Tooling & Integrations',
    color: '#b08800',
    items: [
      'Discord notification workflow for issues',
      'Wokwi elements integrated into Landing Page visuals',
      'Scripts for automated example generation',
      'Docker standalone image published to GHCR + Docker Hub',
    ],
  },
];

export const Velxio2Page: React.FC = () => {
  useSEO({
    title: 'Velxio 2.0 — Multi-Board Embedded Simulator | ESP32, Raspberry Pi, Arduino, RISC-V',
    description:
      'Velxio 2.0 is here. 19 boards, 5 CPU architectures, QEMU-based ESP32 emulation, realistic sensor simulation, 68+ examples. A free, open-source multi-platform embedded systems simulator.',
    url: 'https://velxio.dev/v2',
    jsonLd: JSON_LD,
  });

  return (
    <div className="seo-page">
      <AppHeader />
      <main>
        {/* ── Hero ── */}
        <section className="v2-hero">
          <div className="v2-version-badge">
            <IcoRocket /> Version 2.0
          </div>
          <h1>
            Velxio 2.0<br />
            <span className="accent">Multi-Platform Embedded Simulator</span>
          </h1>
          <p className="subtitle">
            19 boards across 5 CPU architectures — AVR8, RP2040, RISC-V, Xtensa, and ARM Linux.
            QEMU-based ESP32 emulation, realistic sensor simulation, 68+ ready-to-run examples.
            Free, open-source, runs in your browser.
          </p>
          <div className="seo-cta-group">
            <Link to="/editor" className="seo-btn-primary">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" /></svg>
              Try Velxio 2.0
            </Link>
            <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer" className="seo-btn-secondary">
              <IcoGitHub /> View on GitHub
            </a>
          </div>

          {/* Community CTAs */}
          <div className="v2-community-row">
            <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer" className="v2-community-btn v2-star-btn">
              <IcoStar />
              <span>Star on GitHub</span>
            </a>
            <a href={DISCORD_URL} target="_blank" rel="noopener noreferrer" className="v2-community-btn v2-discord-btn">
              <IcoDiscord />
              <span>Join Discord</span>
            </a>
          </div>
        </section>

        {/* ── Boards showcase ── */}
        <section className="seo-section">
          <h2>19 boards. 5 architectures. One tool.</h2>
          <p className="lead">
            From 8-bit AVR to quad-core ARM Linux — Velxio 2.0 emulates every major embedded platform in a single browser tab.
          </p>

          {/* AVR8 */}
          <div className="v2-arch-group">
            <div className="v2-arch-label" style={{ borderColor: '#0071e3' }}>
              <span className="v2-arch-engine">avr8js</span>
              AVR8 -- ATmega -- 16 MHz
            </div>
            <div className="v2-boards-row">
              <div className="v2-board-card">
                <img src="/boards/arduino-uno.svg" alt="Arduino Uno" />
                <span>Arduino Uno</span>
              </div>
              <div className="v2-board-card">
                <img src="/boards/arduino-nano.svg" alt="Arduino Nano" />
                <span>Arduino Nano</span>
              </div>
              <div className="v2-board-card">
                <img src="/boards/arduino-mega.svg" alt="Arduino Mega 2560" />
                <span>Mega 2560</span>
              </div>
            </div>
          </div>

          {/* RP2040 */}
          <div className="v2-arch-group">
            <div className="v2-arch-label" style={{ borderColor: '#a8192a' }}>
              <span className="v2-arch-engine">rp2040js</span>
              RP2040 -- ARM Cortex-M0+ -- 133 MHz
            </div>
            <div className="v2-boards-row">
              <div className="v2-board-card">
                <img src="/boards/pi-pico.svg" alt="Raspberry Pi Pico" />
                <span>Pi Pico</span>
              </div>
              <div className="v2-board-card">
                <img src="/boards/pi-pico-w.svg" alt="Raspberry Pi Pico W" />
                <span>Pi Pico W</span>
              </div>
            </div>
          </div>

          {/* RISC-V */}
          <div className="v2-arch-group">
            <div className="v2-arch-label" style={{ borderColor: '#4a9e6b' }}>
              <span className="v2-arch-engine">Browser-native</span>
              RISC-V -- RV32IMC -- 160 MHz
            </div>
            <div className="v2-boards-row">
              <div className="v2-board-card">
                <img src="/boards/esp32-c3.svg" alt="ESP32-C3" />
                <span>ESP32-C3</span>
              </div>
              <div className="v2-board-card">
                <img src="/boards/xiao-esp32-c3.svg" alt="XIAO ESP32-C3" />
                <span>XIAO C3</span>
              </div>
              <div className="v2-board-card">
                <img src="/boards/esp32c3-supermini.svg" alt="ESP32-C3 SuperMini" />
                <span>C3 SuperMini</span>
              </div>
            </div>
          </div>

          {/* Xtensa QEMU */}
          <div className="v2-arch-group">
            <div className="v2-arch-label" style={{ borderColor: '#c8701a' }}>
              <span className="v2-arch-engine">QEMU Xtensa</span>
              Xtensa LX6/LX7 -- 240 MHz
            </div>
            <div className="v2-boards-row">
              <div className="v2-board-card">
                <img src="/boards/esp32-devkit-c-v4.svg" alt="ESP32 DevKit" />
                <span>ESP32 DevKit</span>
              </div>
              <div className="v2-board-card">
                <img src="/boards/esp32-s3.svg" alt="ESP32-S3" />
                <span>ESP32-S3</span>
              </div>
              <div className="v2-board-card">
                <img src="/boards/esp32-cam.svg" alt="ESP32-CAM" />
                <span>ESP32-CAM</span>
              </div>
              <div className="v2-board-card">
                <img src="/boards/xiao-esp32-s3.svg" alt="XIAO ESP32-S3" />
                <span>XIAO S3</span>
              </div>
              <div className="v2-board-card">
                <img src="/boards/arduino-nano-esp32.svg" alt="Nano ESP32" />
                <span>Nano ESP32</span>
              </div>
            </div>
          </div>

          {/* ARM Linux */}
          <div className="v2-arch-group">
            <div className="v2-arch-label" style={{ borderColor: '#a8304d' }}>
              <span className="v2-arch-engine">QEMU ARM</span>
              ARM Cortex-A53 -- Linux -- 1.2 GHz
            </div>
            <div className="v2-boards-row">
              <div className="v2-board-card">
                <img src={raspberryPi3Svg} alt="Raspberry Pi 3B" />
                <span>Raspberry Pi 3B</span>
              </div>
            </div>
          </div>
        </section>

        {/* ── Changelog ── */}
        <section className="seo-section">
          <h2>What's new in 2.0</h2>
          <p className="lead">
            A complete transformation into a multi-platform embedded systems simulator — more boards, more accurate emulation, better developer experience.
          </p>

          <div className="v2-changelog">
            {CHANGE_SECTIONS.map((section) => (
              <div key={section.title} className="v2-change-block">
                <div className="v2-change-header" style={{ color: section.color }}>
                  {section.icon}
                  <h3>{section.title}</h3>
                </div>
                <ul className="v2-change-list">
                  {section.items.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </section>

        {/* ── Examples ── */}
        <section className="seo-section">
          <h2>68+ ready-to-run examples</h2>
          <p className="lead">
            From basic LED blink to multi-board communication — examples for every platform and skill level.
          </p>
          <div className="seo-grid">
            <div className="seo-card">
              <h3>Arduino (17 examples)</h3>
              <p>Blink, traffic light, button, fade, RGB LED, Simon Says game, TFT display, LCD, I2C scanner, SPI loopback, and more.</p>
            </div>
            <div className="seo-card">
              <h3>Raspberry Pi Pico (18 examples)</h3>
              <p>Blink, serial, I2C (scanner, RTC, EEPROM), SPI, ADC read, DHT22, HC-SR04, servo, joystick, NTC sensor.</p>
            </div>
            <div className="seo-card">
              <h3>ESP32 (9 examples)</h3>
              <p>Blink, serial echo, 7-segment, DHT22, HC-SR04, MPU6050 IMU, PIR motion, servo, joystick.</p>
            </div>
            <div className="seo-card">
              <h3>ESP32-C3 RISC-V (9 examples)</h3>
              <p>Blink, serial, RGB LED, button + LED, serial echo, DHT22, HC-SR04, PIR, servo.</p>
            </div>
            <div className="seo-card">
              <h3>Arduino Mega (5 examples)</h3>
              <p>Blink, LED chase, serial echo, serial control, 7-segment display.</p>
            </div>
            <div className="seo-card">
              <h3>Arduino Nano (4 examples)</h3>
              <p>Blink, button LED, fade, serial echo. Plus multi-board Pi-to-Arduino control.</p>
            </div>
          </div>
          <div style={{ textAlign: 'center', marginTop: 24 }}>
            <Link to="/examples" className="seo-btn-secondary">Browse All Examples</Link>
          </div>
        </section>

        {/* ── Outcome ── */}
        <section className="seo-section">
          <h2>The outcome</h2>
          <p className="lead">
            Velxio 2.0 transforms the project into a complete, scalable multi-platform embedded systems simulator.
          </p>
          <div className="seo-grid">
            <div className="seo-card">
              <h3>More realistic emulation</h3>
              <p>QEMU-based Xtensa and ARM emulation. Browser-native RISC-V. Cycle-accurate AVR8 via avr8js. Real firmware execution, not approximations.</p>
            </div>
            <div className="seo-card">
              <h3>Broader hardware support</h3>
              <p>19 boards across 5 CPU architectures. From 8-bit ATtiny85 to quad-core Raspberry Pi 3B running full Linux.</p>
            </div>
            <div className="seo-card">
              <h3>Better developer experience</h3>
              <p>Monaco editor, multi-file workspace, library manager, oscilloscope, sensor control panel, mobile-responsive design.</p>
            </div>
          </div>
        </section>

        {/* ── Bottom CTA ── */}
        <div className="seo-bottom">
          <h2>Try Velxio 2.0 now</h2>
          <p>Open the editor and start simulating — 19 boards, 68+ examples, zero setup.</p>
          <Link to="/editor" className="seo-btn-primary">Launch Simulator</Link>

          <div className="v2-bottom-community">
            <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer" className="v2-community-btn v2-star-btn">
              <IcoStar />
              <span>Star on GitHub</span>
            </a>
            <a href={DISCORD_URL} target="_blank" rel="noopener noreferrer" className="v2-community-btn v2-discord-btn">
              <IcoDiscord />
              <span>Join Discord</span>
            </a>
          </div>

          <div className="seo-internal-links">
            <Link to="/">Home</Link>
            <Link to="/examples">Examples</Link>
            <Link to="/docs/intro">Documentation</Link>
            <Link to="/arduino-simulator">Arduino Simulator</Link>
            <Link to="/esp32-simulator">ESP32 Simulator</Link>
            <Link to="/raspberry-pi-pico-simulator">RP2040 Simulator</Link>
            <Link to="/raspberry-pi-simulator">Pi 3 Simulator</Link>
          </div>
        </div>
      </main>
    </div>
  );
};
