/**
 * Single source of truth for all public, indexable routes and their SEO metadata.
 * Used by:
 *  1. scripts/generate-sitemap.mjs  → builds sitemap.xml at build time
 *  2. scripts/prerender-seo.mjs     → generates prerendered HTML per route
 *  3. Page components (via getSeoMeta) → useSEO() hook
 *
 * Routes with `noindex: true` are excluded from the sitemap.
 * Routes with `seoMeta` get prerendered HTML at build time.
 */

const DOMAIN = 'https://velxio.dev';

export interface SeoMeta {
  title: string;
  description: string;
  url: string;
}

export interface SeoRoute {
  path: string;
  /** 0.0 – 1.0 (default 0.5) */
  priority?: number;
  changefreq?: 'daily' | 'weekly' | 'monthly' | 'yearly';
  /** If true, excluded from sitemap */
  noindex?: boolean;
  /** SEO metadata — if present, this route gets a prerendered HTML page at build time. */
  seoMeta?: SeoMeta;
}

/** Look up the SEO metadata for a given path. */
export function getSeoMeta(path: string): SeoMeta | undefined {
  return SEO_ROUTES.find((r) => r.path === path)?.seoMeta;
}

export const SEO_ROUTES: SeoRoute[] = [
  // ── Main pages
  {
    path: '/',
    priority: 1.0,
    changefreq: 'weekly',
    seoMeta: {
      title:
        'Velxio — Free Online Circuit & Arduino Simulator | SPICE · ESP32 · RP2040 · ATtiny85 · Custom Chips',
      description:
        'Velxio is a free, open-source online circuit simulator. Real-time SPICE analog simulation (ngspice-WASM) wired to 19 boards: Arduino Uno/Mega/ATtiny85 (AVR8), ESP32 (Xtensa QEMU), ESP32-C3/CH32V003 (RISC-V via QEMU libqemu-riscv32), Raspberry Pi Pico (RP2040), Raspberry Pi 3 (Linux). Build custom chips in C/Rust. 100+ components, oscilloscope, voltmeter, ammeter — no cloud.',
      url: `${DOMAIN}/`,
    },
  },
  {
    path: '/editor',
    priority: 0.9,
    changefreq: 'weekly',
    // With seoMeta the route is prerendered, so nginx serves /editor/ as a
    // real page and 301s /editor to it. Without it both forms answered 200
    // with the homepage head, and Google indexed /editor AND /editor/ as
    // two pages with different impressions.
    seoMeta: {
      title: 'Multi-Board Simulator Editor — Arduino, ESP32, RP2040, RISC-V | Velxio',
      description:
        'Write, compile and simulate Arduino, ESP32, Raspberry Pi Pico, ESP32-C3, and Raspberry Pi 3 code in your browser. 19 boards, 5 CPU architectures, 48+ components. Free and open-source.',
      url: `${DOMAIN}/editor`,
    },
  },
  {
    path: '/examples',
    priority: 0.8,
    changefreq: 'weekly',
    seoMeta: {
      title: 'Circuit & Arduino Simulator Examples — 100+ Sketches & Analog Projects | Velxio',
      description:
        'Browse 100+ interactive examples — Arduino, ESP32, RP2040, ATtiny85 sketches plus 40+ analog SPICE circuits (op-amp amplifiers, RC filters, transistor switches, full-wave rectifiers). Runs in your browser — free, no install.',
      url: `${DOMAIN}/examples`,
    },
  },
  {
    path: '/tools/image-to-code',
    priority: 0.7,
    changefreq: 'monthly',
    seoMeta: {
      title: 'Image to C Array Converter for OLED Displays (SSD1306) | Velxio',
      description:
        'Free image2cpp-style converter: drop a picture and get a monochrome C byte array for SSD1306 and other 1-bit OLEDs. Threshold, dithering, invert, flip, Adafruit GFX or page-buffer layout, previewed live on a simulated 128x64 panel.',
      url: `${DOMAIN}/tools/image-to-code`,
    },
  },

  // ── Documentation

  // ── SEO keyword landing pages
  {
    path: '/circuit-simulator',
    priority: 0.95,
    changefreq: 'weekly',
    seoMeta: {
      title: 'Free Online Circuit Simulator — SPICE Analog Simulation in Your Browser | Velxio',
      description:
        'Velxio is a free online circuit simulator with real-time SPICE analog simulation via ngspice-WASM. 100+ components — resistors, capacitors, op-amps, transistors, regulators, diodes — wired to Arduino, ESP32, RP2040 firmware. Live oscilloscope, voltmeter, ammeter. No install, no account.',
      url: `${DOMAIN}/circuit-simulator`,
    },
  },
  {
    path: '/spice-simulator',
    priority: 0.9,
    changefreq: 'weekly',
    seoMeta: {
      title: 'Free Online SPICE Simulator — ngspice in Your Browser | Velxio',
      description:
        'Run SPICE simulations directly in your browser. Velxio uses ngspice compiled to WebAssembly via eecircuit-engine — full transient analysis, real device models (BJTs, MOSFETs, op-amps, diodes), Modified Nodal Analysis. Free and open-source.',
      url: `${DOMAIN}/spice-simulator`,
    },
  },
  {
    path: '/electronics-simulator',
    priority: 0.85,
    changefreq: 'monthly',
    seoMeta: {
      title: 'Free Online Electronics Simulator — Build & Test Circuits in Your Browser | Velxio',
      description:
        'Velxio is a free online electronics simulator with SPICE-accurate analog parts and 19 simulated microcontrollers. Build, wire, and test electronic circuits — Arduino, ESP32, RP2040, ATtiny85 — in your browser. 100+ components, no install, no account.',
      url: `${DOMAIN}/electronics-simulator`,
    },
  },
  {
    path: '/custom-chip-simulator',
    priority: 0.85,
    changefreq: 'monthly',
    seoMeta: {
      title: 'Custom Chip Simulator — Build Your Own ICs in C, Rust & AssemblyScript | Velxio',
      description:
        'Define your own integrated circuits in C, Rust, or AssemblyScript with the Wokwi-compatible Custom Chips API. Compile to WebAssembly and drive pins, attributes, timers, I²C and SPI from your simulated chip. Free and open-source.',
      url: `${DOMAIN}/custom-chip-simulator`,
    },
  },
  {
    path: '/attiny85-simulator',
    priority: 0.85,
    changefreq: 'monthly',
    seoMeta: {
      title: 'Free ATtiny85 Simulator — Cycle-Accurate AVR Emulation Online | Velxio',
      description:
        'Simulate ATtiny85 firmware in your browser with cycle-accurate AVR8 emulation. Full DIP-8 pinout, 8 KB flash, 6 GPIOs, USI (I²C/SPI), Timer0/Timer1 PWM, 10-bit ADC, watchdog. Wire it to LEDs, sensors, or SPICE analog parts. Free, no install.',
      url: `${DOMAIN}/attiny85-simulator`,
    },
  },
  {
    path: '/arduino-simulator',
    priority: 0.9,
    changefreq: 'monthly',
    seoMeta: {
      title: 'Free Online Arduino Simulator — Run Sketches in Your Browser | Velxio',
      description:
        'A free online Arduino simulator with real AVR8 emulation. Write and simulate Arduino code with LEDs, sensors, and 48+ components — no install, no account, instant results.',
      url: `${DOMAIN}/arduino-simulator`,
    },
  },
  {
    path: '/arduino-emulator',
    priority: 0.9,
    changefreq: 'monthly',
    seoMeta: {
      title: 'Arduino Emulator — Real AVR8 & RP2040 Emulation, Free | Velxio',
      description:
        'Free, open-source Arduino emulator with cycle-accurate AVR8 emulation at 16 MHz. Emulate Arduino Uno, Nano, Mega and Raspberry Pi Pico in your browser — no cloud, no install.',
      url: `${DOMAIN}/arduino-emulator`,
    },
  },
  {
    path: '/atmega328p-simulator',
    priority: 0.85,
    changefreq: 'monthly',
    seoMeta: {
      title: 'ATmega328P Simulator — Free Browser-Based AVR8 Emulation | Velxio',
      description:
        'Simulate ATmega328P code in your browser. Full AVR8 emulation at 16 MHz — PORTB, PORTC, PORTD, Timer0/1/2, ADC, USART — with 48+ interactive components. Free & open-source.',
      url: `${DOMAIN}/atmega328p-simulator`,
    },
  },
  {
    path: '/arduino-mega-simulator',
    priority: 0.85,
    changefreq: 'monthly',
    seoMeta: {
      title: 'Arduino Mega 2560 Simulator — Free Online AVR8 Emulator | Velxio',
      description:
        'Simulate Arduino Mega 2560 (ATmega2560) code for free in your browser. 256 KB flash, 54 digital pins, 16 analog inputs, 4 serial ports — full AVR8 emulation with 48+ components.',
      url: `${DOMAIN}/arduino-mega-simulator`,
    },
  },
  {
    path: '/esp32-simulator',
    priority: 0.9,
    changefreq: 'monthly',
    seoMeta: {
      title: 'Free ESP32 Simulator Online — Xtensa LX6 Emulation | Velxio',
      description:
        'Simulate ESP32 code in your browser for free. Real Xtensa LX6 emulation at 240 MHz via QEMU — ESP32 DevKit, ESP32-S3, ESP32-CAM. 48+ components, Serial Monitor, no install.',
      url: `${DOMAIN}/esp32-simulator`,
    },
  },
  {
    path: '/esp32-s3-simulator',
    priority: 0.85,
    changefreq: 'monthly',
    seoMeta: {
      title: 'Free ESP32-S3 Simulator — Xtensa LX7 Emulation Online | Velxio',
      description:
        'Simulate ESP32-S3 code for free. Real Xtensa LX7 dual-core emulation at 240 MHz via QEMU — DevKitC, XIAO ESP32-S3, Arduino Nano ESP32. 48+ components, no install.',
      url: `${DOMAIN}/esp32-s3-simulator`,
    },
  },
  {
    path: '/esp32-c3-simulator',
    priority: 0.85,
    changefreq: 'monthly',
    seoMeta: {
      title: 'Free ESP32-C3 & RISC-V Simulator — QEMU Emulation | Velxio',
      description:
        'Simulate ESP32-C3 RISC-V code via the QEMU lcgamboa backend (libqemu-riscv32) at 160 MHz. 48+ components, Serial Monitor. Also supports CH32V003. Free and open-source.',
      url: `${DOMAIN}/esp32-c3-simulator`,
    },
  },
  {
    path: '/raspberry-pi-pico-simulator',
    priority: 0.9,
    changefreq: 'monthly',
    seoMeta: {
      title: 'Free Raspberry Pi Pico Simulator — RP2040 ARM Cortex-M0+ Emulation | Velxio',
      description:
        'Simulate Raspberry Pi Pico and Pico W code for free. Real RP2040 ARM Cortex-M0+ emulation at 133 MHz via rp2040js. 48+ components, Serial Monitor, Arduino-Pico core. No install.',
      url: `${DOMAIN}/raspberry-pi-pico-simulator`,
    },
  },
  {
    path: '/raspberry-pi-simulator',
    priority: 0.85,
    changefreq: 'monthly',
    seoMeta: {
      // Not "free": Raspberry Pi Linux emulation is a paid feature of
      // velxio.dev and Velxio Desktop (2026-09-06). The page still targets
      // the same query, it just stops promising a price it does not have.
      title: 'Raspberry Pi 3 Simulator — Full Linux Emulation in Your Browser | Velxio',
      description:
        'Simulate a Raspberry Pi 3 online. Full ARM Cortex-A53 Linux emulation via QEMU — run Python, bash and RPi.GPIO in your browser. No Raspberry Pi hardware needed.',
      url: `${DOMAIN}/raspberry-pi-simulator`,
    },
  },

  // ── Release pages
  {
    path: '/v2',
    priority: 0.9,
    // Superseded release page. Canonical points at the home (seoMeta.url)
    // and noindex keeps it out of the sitemap: /v2 and /v2-5 were taking
    // two brand sitelink slots (5.9k impressions, 29 clicks) that the
    // editor and the simulator landings should hold. The page still
    // renders for old links.
    noindex: true,
    changefreq: 'monthly',
    seoMeta: {
      title: 'Velxio 2.0 — Multi-Board Embedded Simulator | ESP32, Raspberry Pi, Arduino, RISC-V',
      description:
        'Velxio 2.0 is here. Simulate Arduino, ESP32, Raspberry Pi Pico, and Raspberry Pi 3 in your browser. 19 boards, 68+ examples, realistic sensor simulation. Free and open-source.',
      url: `${DOMAIN}/`,
    },
  },
  {
    path: '/v2-5',
    priority: 0.9,
    noindex: true, // see /v2
    changefreq: 'monthly',
    seoMeta: {
      title:
        'Velxio 2.5 — Arduino + SPICE Analog Circuit Simulator in Your Browser | ngspice-WASM',
      description:
        'Velxio 2.5 brings real-time analog circuit simulation via ngspice-WASM. Hybrid digital + analog co-simulation: resistors, capacitors, inductors, op-amps, transistors, voltmeters, ammeters — wired to Arduino, ESP32, RP2040 GPIO/ADC. 40+ circuit examples. Free and open-source.',
      url: `${DOMAIN}/`,
    },
  },
  {
    path: '/v3',
    priority: 0.95,
    changefreq: 'weekly',
    seoMeta: {
      title:
        'Velxio 3.0 — Retro CPUs, MicroSD, ePaper & Multi-Board Embedded Simulator',
      description:
        'Velxio 3.0 adds programmable retro CPUs (Z80, 8080, 4004, 4040, 8086), MicroSD card emulation, ePaper displays, true multi-board UART/I2C/SPI interconnect, full undo/redo and 100+ new examples. Free, open-source, browser-based — Arduino, ESP32, RP2040, STM32, Raspberry Pi and more.',
      url: `${DOMAIN}/v3`,
    },
  },

  // ── About
  {
    path: '/about',
    priority: 0.7,
    changefreq: 'monthly',
    seoMeta: {
      title: 'About Velxio — Open Source Embedded Emulator by David Montero Crespo',
      description:
        'Learn about Velxio, the free open-source multi-board embedded emulator, and its creator David Montero Crespo — Application Architect at IBM, programming and robotics enthusiast.',
      url: `${DOMAIN}/about`,
    },
  },

  // ── Classroom (institutional sales landing) — Phase 3 D3.7
  {
    path: '/classroom',
    priority: 0.85,
    changefreq: 'monthly',
    seoMeta: {
      title: 'Velxio for educators — full Pro features for your classroom',
      description:
        'Velxio for Classroom gives every student in your course Pro-tier access (private projects, GitHub Sync, BOM and schematic exports, offline desktop) under a single institution contract. From $40/student/year with volume discounts.',
      url: `${DOMAIN}/classroom`,
    },
  },

  // ── GitHub Sync docs — Phase 3 D3.5 companion

  // ── Auth / admin (noindex)
  { path: '/login', noindex: true },
  { path: '/register', noindex: true },
  { path: '/admin', noindex: true },
];
