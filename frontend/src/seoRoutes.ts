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
        'Velxio — Free Multi-Board Emulator | Arduino · ESP32 · RP2040 · RISC-V · Raspberry Pi',
      description:
        'Velxio is a free, open-source multi-board emulator. 19 boards across 5 CPU architectures: Arduino Uno/Mega/ATtiny (AVR8), ESP32/ESP32-S3 (Xtensa QEMU), ESP32-C3/CH32V003 (RISC-V), Raspberry Pi Pico (RP2040), Raspberry Pi 3 (Linux). 48+ components, no cloud.',
      url: `${DOMAIN}/`,
    },
  },
  { path: '/editor', priority: 0.9, changefreq: 'weekly' },
  {
    path: '/examples',
    priority: 0.8,
    changefreq: 'weekly',
    seoMeta: {
      title: 'Arduino Simulator Examples — Run 18+ Sketches Instantly | Velxio',
      description:
        'Explore 18+ interactive Arduino examples with LEDs, sensors, displays, and games. Runs entirely in your browser — free, no install, no account required.',
      url: `${DOMAIN}/examples`,
    },
  },

  // ── Documentation
  {
    path: '/docs',
    priority: 0.8,
    changefreq: 'monthly',
    seoMeta: {
      title: 'Introduction | Velxio Documentation',
      description:
        'Learn about Velxio, the free open-source Arduino emulator with real AVR8 and RP2040 CPU emulation and 48+ interactive electronic components.',
      url: `${DOMAIN}/docs`,
    },
  },
  {
    path: '/docs/intro',
    priority: 0.8,
    changefreq: 'monthly',
    seoMeta: {
      title: 'Introduction | Velxio Documentation',
      description:
        'Learn about Velxio, the free open-source Arduino emulator with real AVR8 and RP2040 CPU emulation and 48+ interactive electronic components.',
      url: `${DOMAIN}/docs/intro`,
    },
  },
  {
    path: '/docs/getting-started',
    priority: 0.8,
    changefreq: 'monthly',
    seoMeta: {
      title: 'Getting Started | Velxio Documentation',
      description:
        'Get started with Velxio: use the hosted editor, self-host with Docker, or set up a local development environment. Simulate your first Arduino sketch in minutes.',
      url: `${DOMAIN}/docs/getting-started`,
    },
  },
  {
    path: '/docs/emulator',
    priority: 0.7,
    changefreq: 'monthly',
    seoMeta: {
      title: 'Emulator Architecture | Velxio Documentation',
      description:
        'How Velxio emulates AVR8 (ATmega328p), RP2040, and RISC-V (ESP32-C3) CPUs. Covers execution loops, peripherals, and pin mapping for all supported boards.',
      url: `${DOMAIN}/docs/emulator`,
    },
  },
  {
    path: '/docs/esp32-emulation',
    priority: 0.7,
    changefreq: 'monthly',
    seoMeta: {
      title: 'ESP32 Emulation (Xtensa) | Velxio Documentation',
      description:
        'QEMU-based emulation for ESP32 and ESP32-S3 (Xtensa LX6/LX7). Covers the lcgamboa fork, libqemu-xtensa, GPIO, WiFi, I2C, SPI, RMT/NeoPixel, and LEDC/PWM.',
      url: `${DOMAIN}/docs/esp32-emulation`,
    },
  },
  {
    path: '/docs/riscv-emulation',
    priority: 0.7,
    changefreq: 'monthly',
    seoMeta: {
      title: 'RISC-V Emulation (ESP32-C3) | Velxio Documentation',
      description:
        'Browser-side RV32IMC emulator for ESP32-C3, XIAO ESP32-C3, and C3 SuperMini. Covers memory map, GPIO, UART0, the ESP32 image parser, RV32IMC ISA, and test suite.',
      url: `${DOMAIN}/docs/riscv-emulation`,
    },
  },
  {
    path: '/docs/rp2040-emulation',
    priority: 0.7,
    changefreq: 'monthly',
    seoMeta: {
      title: 'RP2040 Emulation (Raspberry Pi Pico) | Velxio Documentation',
      description:
        'How Velxio emulates the Raspberry Pi Pico and Pico W using rp2040js: ARM Cortex-M0+ at 133 MHz, GPIO, UART, ADC, I2C, SPI, PWM and WFI optimization.',
      url: `${DOMAIN}/docs/rp2040-emulation`,
    },
  },
  {
    path: '/docs/raspberry-pi3-emulation',
    priority: 0.7,
    changefreq: 'monthly',
    seoMeta: {
      title: 'Raspberry Pi 3 Emulation (QEMU) | Velxio Documentation',
      description:
        'How Velxio emulates a full Raspberry Pi 3B using QEMU raspi3b: real Raspberry Pi OS, Python + RPi.GPIO shim, dual-channel UART, VFS, and multi-board serial bridge.',
      url: `${DOMAIN}/docs/raspberry-pi3-emulation`,
    },
  },
  {
    path: '/docs/components',
    priority: 0.7,
    changefreq: 'monthly',
    seoMeta: {
      title: 'Components Reference | Velxio Documentation',
      description:
        'Full reference for all 48+ interactive electronic components in Velxio: LEDs, displays, sensors, buttons, potentiometers, and more. Includes wiring and property details.',
      url: `${DOMAIN}/docs/components`,
    },
  },
  {
    path: '/docs/architecture',
    priority: 0.7,
    changefreq: 'monthly',
    seoMeta: {
      title: 'Project Architecture | Velxio Documentation',
      description:
        'Detailed overview of the Velxio system architecture: frontend, backend, AVR8 emulation pipeline, data flows, Zustand stores, and wire system.',
      url: `${DOMAIN}/docs/architecture`,
    },
  },
  {
    path: '/docs/wokwi-libs',
    priority: 0.7,
    changefreq: 'monthly',
    seoMeta: {
      title: 'Wokwi Libraries | Velxio Documentation',
      description:
        'How Velxio integrates the official Wokwi open-source libraries: avr8js, wokwi-elements, and rp2040js. Covers configuration, updates, and the 48 available components.',
      url: `${DOMAIN}/docs/wokwi-libs`,
    },
  },
  {
    path: '/docs/mcp',
    priority: 0.7,
    changefreq: 'monthly',
    seoMeta: {
      title: 'MCP Server | Velxio Documentation',
      description:
        'Velxio MCP Server reference: integrate AI agents (Claude, Cursor) with Velxio via Model Context Protocol. Covers tools, transports, circuit format, and example walkthroughs.',
      url: `${DOMAIN}/docs/mcp`,
    },
  },
  {
    path: '/docs/setup',
    priority: 0.6,
    changefreq: 'monthly',
    seoMeta: {
      title: 'Project Status | Velxio Documentation',
      description:
        'Complete status of all implemented Velxio features: AVR emulation, component system, wire system, code editor, example projects, and next steps.',
      url: `${DOMAIN}/docs/setup`,
    },
  },
  {
    path: '/docs/roadmap',
    priority: 0.6,
    changefreq: 'monthly',
    seoMeta: {
      title: 'Roadmap | Velxio Documentation',
      description:
        "Velxio's feature roadmap: what's implemented, what's in progress, and what's planned for future releases.",
      url: `${DOMAIN}/docs/roadmap`,
    },
  },

  // ── SEO keyword landing pages
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
      title: 'Free ESP32-C3 & RISC-V Simulator — Browser-Native Emulation | Velxio',
      description:
        'Simulate ESP32-C3 RISC-V code directly in your browser — no backend needed. RV32IMC at 160 MHz, 48+ components, Serial Monitor. Also supports CH32V003. Free and open-source.',
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
      title: 'Free Raspberry Pi 3 Simulator — Full Linux Emulation in Your Browser | Velxio',
      description:
        'Simulate Raspberry Pi 3 for free. Full ARM Cortex-A53 Linux emulation via QEMU — run Python, bash, RPi.GPIO in your browser. No Raspberry Pi hardware needed.',
      url: `${DOMAIN}/raspberry-pi-simulator`,
    },
  },

  // ── Release pages
  {
    path: '/v2',
    priority: 0.9,
    changefreq: 'monthly',
    seoMeta: {
      title: 'Velxio 2.0 — Multi-Board Embedded Simulator | ESP32, Raspberry Pi, Arduino, RISC-V',
      description:
        'Velxio 2.0 is here. Simulate Arduino, ESP32, Raspberry Pi Pico, and Raspberry Pi 3 in your browser. 19 boards, 68+ examples, realistic sensor simulation. Free and open-source.',
      url: `${DOMAIN}/v2`,
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

  // ── Auth / admin (noindex)
  { path: '/login', noindex: true },
  { path: '/register', noindex: true },
  { path: '/admin', noindex: true },
];
