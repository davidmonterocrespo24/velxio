import { useState, useRef, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuthStore } from '../store/useAuthStore';
import { trackVisitGitHub, trackClickCTA } from '../utils/analytics';
import { AppHeader } from '../components/layout/AppHeader';
import { useSEO } from '../utils/useSEO';
import { getSeoMeta } from '../seoRoutes';
import raspberryPi3Svg from '../assets/Raspberry_Pi_3_illustration.svg';
import './LandingPage.css';

const GITHUB_URL = 'https://github.com/davidmonterocrespo24/velxio';
const PAYPAL_URL = 'https://paypal.me/odoonext';
const GITHUB_SPONSORS_URL = 'https://github.com/sponsors/davidmonterocrespo24';

/* ── Icons ───────────────────────────────────────────── */
const IcoChip = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <rect x="5" y="5" width="14" height="14" rx="2" />
    <rect x="9" y="9" width="6" height="6" />
    <path d="M9 1v4M15 1v4M9 19v4M15 19v4M1 9h4M1 15h4M19 9h4M19 15h4" />
  </svg>
);

const IcoCpu = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <rect x="4" y="4" width="16" height="16" rx="2" />
    <rect x="8" y="8" width="8" height="8" />
    <path d="M10 2v2M14 2v2M10 20v2M14 20v2M2 10h2M2 14h2M20 10h2M20 14h2" />
  </svg>
);

const IcoCode = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <polyline points="16 18 22 12 16 6" />
    <polyline points="8 6 2 12 8 18" />
  </svg>
);

const IcoZap = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
  </svg>
);

const IcoLayers = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <polygon points="12 2 2 7 12 12 22 7 12 2" />
    <polyline points="2 17 12 22 22 17" />
    <polyline points="2 12 12 17 22 12" />
  </svg>
);

const IcoMonitor = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <rect x="2" y="3" width="20" height="14" rx="2" />
    <line x1="8" y1="21" x2="16" y2="21" />
    <line x1="12" y1="17" x2="12" y2="21" />
  </svg>
);

const IcoBook = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
    <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
  </svg>
);

const IcoGitHub = () => (
  <svg viewBox="0 0 24 24" fill="currentColor">
    <path d="M12 0C5.37 0 0 5.37 0 12c0 5.3 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61-.546-1.385-1.335-1.755-1.335-1.755-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 21.795 24 17.295 24 12c0-6.63-5.37-12-12-12z" />
  </svg>
);

/* ── Circuit Schematic SVG (hero illustration) ───────── */
const CircuitSchematic = () => (
  <svg viewBox="0 0 400 270" className="schematic-svg" aria-hidden="true">
    <defs>
      <pattern id="schgrid" x="0" y="0" width="20" height="20" patternUnits="userSpaceOnUse">
        <circle cx="10" cy="10" r="0.65" fill="rgba(0,180,70,0.18)" />
      </pattern>
      <clipPath id="scope-clip">
        <rect x="290" y="200" width="100" height="60" />
      </clipPath>
    </defs>

    {/* PCB background */}
    <rect width="400" height="270" rx="4" fill="#040c06" />
    <rect width="400" height="270" rx="4" fill="url(#schgrid)" />
    {/* PCB edge cuts */}
    <rect
      x="1.5"
      y="1.5"
      width="397"
      height="267"
      rx="3.5"
      fill="none"
      stroke="#081808"
      strokeWidth="2"
    />

    {/* PCB corner marks */}
    <path d="M10,1.5 L1.5,1.5 L1.5,10" fill="none" stroke="#0d2a0d" strokeWidth="1" />
    <path d="M390,1.5 L398.5,1.5 L398.5,10" fill="none" stroke="#0d2a0d" strokeWidth="1" />
    <path d="M1.5,260 L1.5,268.5 L10,268.5" fill="none" stroke="#0d2a0d" strokeWidth="1" />
    <path d="M398.5,260 L398.5,268.5 L390,268.5" fill="none" stroke="#0d2a0d" strokeWidth="1" />

    {/* Silkscreen header */}
    <text x="12" y="14" fill="#092010" fontFamily="monospace" fontSize="6.5" letterSpacing="0.8">
      VELXIO BLINK DEMO
    </text>
    <text
      x="388"
      y="14"
      textAnchor="end"
      fill="#092010"
      fontFamily="monospace"
      fontSize="6.5"
      letterSpacing="0.5"
    >
      REV 1.0
    </text>

    {/* ── ARDUINO UNO BLOCK ── */}
    <rect
      x="20"
      y="45"
      width="88"
      height="165"
      rx="3"
      fill="#001400"
      stroke="#003810"
      strokeWidth="1.5"
    />
    {/* MCU (ATmega328P) */}
    <rect
      x="32"
      y="80"
      width="64"
      height="70"
      rx="2"
      fill="#0a0a0a"
      stroke="#1a1a1a"
      strokeWidth="1"
    />
    {/* MCU pins (left side of chip) */}
    {[0, 1, 2, 3, 4].map((i) => (
      <rect
        key={`cl${i}`}
        x="28"
        y={85 + i * 12}
        width="4"
        height="3"
        rx="0.5"
        fill="#111"
        stroke="#222"
        strokeWidth="0.5"
      />
    ))}
    {/* MCU pins (right side of chip) */}
    {[0, 1, 2, 3, 4].map((i) => (
      <rect
        key={`cr${i}`}
        x="64"
        y={85 + i * 12}
        width="4"
        height="3"
        rx="0.5"
        fill="#111"
        stroke="#222"
        strokeWidth="0.5"
      />
    ))}
    {/* MCU label */}
    <text x="64" y="113" textAnchor="middle" fill="#252525" fontFamily="monospace" fontSize="6">
      ATmega
    </text>
    <text x="64" y="123" textAnchor="middle" fill="#252525" fontFamily="monospace" fontSize="6">
      328P
    </text>
    {/* Board ref */}
    <text
      x="64"
      y="62"
      textAnchor="middle"
      fill="#003a14"
      fontFamily="monospace"
      fontSize="7"
      fontWeight="bold"
    >
      U1 ARDUINO UNO
    </text>
    {/* USB-B port (left edge) */}
    <rect
      x="9"
      y="90"
      width="13"
      height="22"
      rx="1.5"
      fill="#0f0f0f"
      stroke="#1a1a1a"
      strokeWidth="1"
    />
    <rect x="11" y="93" width="9" height="16" rx="1" fill="#090909" />
    {/* Status LED */}
    <circle cx="86" cy="57" r="3" fill="#00bb44" />
    <circle cx="86" cy="57" r="6" fill="rgba(0,180,60,0.08)" />
    {/* Reset button */}
    <rect
      x="38"
      y="48"
      width="10"
      height="10"
      rx="5"
      fill="#111"
      stroke="#1c1c1c"
      strokeWidth="1"
    />
    {/* Power connector */}
    <rect x="53" y="47" width="24" height="9" rx="1" fill="#111" stroke="#1a1a1a" strokeWidth="1" />
    {[0, 1, 2].map((i) => (
      <circle
        key={`pw${i}`}
        cx={57 + i * 8}
        cy="51.5"
        r="2"
        fill="#0a0a0a"
        stroke="#333"
        strokeWidth="0.5"
      />
    ))}
    {/* Header pins (bottom of board) */}
    {[0, 1, 2, 3, 4, 5].map((i) => (
      <rect key={`ph${i}`} x={26 + i * 10} y="207" width="5" height="4" rx="0.5" fill="#a07a00" />
    ))}

    {/* ── ARDUINO RIGHT-SIDE PIN STUBS ── */}
    {/* 5V */}
    <line x1="108" y1="68" x2="118" y2="68" stroke="#003810" strokeWidth="1" />
    <text x="107" y="66" textAnchor="end" fill="#004018" fontFamily="monospace" fontSize="5.5">
      5V
    </text>
    {/* D13 */}
    <line x1="108" y1="108" x2="118" y2="108" stroke="#003810" strokeWidth="1" />
    <text x="107" y="106" textAnchor="end" fill="#004018" fontFamily="monospace" fontSize="5.5">
      D13
    </text>
    {/* GND */}
    <line x1="108" y1="178" x2="118" y2="178" stroke="#003810" strokeWidth="1" />
    <text x="107" y="176" textAnchor="end" fill="#004018" fontFamily="monospace" fontSize="5.5">
      GND
    </text>
    {/* TX */}
    <line x1="108" y1="143" x2="118" y2="143" stroke="#003810" strokeWidth="1" />
    <text x="107" y="141" textAnchor="end" fill="#004018" fontFamily="monospace" fontSize="5.5">
      TX
    </text>

    {/* ── POWER RAILS ── */}
    {/* VCC rail */}
    <line
      x1="118"
      y1="68"
      x2="365"
      y2="68"
      stroke="#880000"
      strokeWidth="1"
      strokeDasharray="6 3"
      opacity="0.55"
    />
    <text x="367" y="71" fill="#440000" fontFamily="monospace" fontSize="6">
      +5V
    </text>
    {/* GND rail */}
    <line
      x1="118"
      y1="178"
      x2="348"
      y2="178"
      stroke="#003388"
      strokeWidth="1"
      strokeDasharray="6 3"
      opacity="0.55"
    />
    {/* GND symbol */}
    <line x1="348" y1="178" x2="363" y2="178" stroke="#001a44" strokeWidth="1" />
    <line x1="356" y1="173" x2="356" y2="183" stroke="#001a44" strokeWidth="1.5" />
    <line x1="351" y1="185" x2="361" y2="185" stroke="#001a44" strokeWidth="1" />
    <line x1="353" y1="188" x2="359" y2="188" stroke="#001a44" strokeWidth="0.8" />

    {/* ── DECOUPLING CAPACITOR C1 ── */}
    {/* Wire from VCC rail */}
    <line x1="315" y1="68" x2="315" y2="100" stroke="#007acc" strokeWidth="1.2" />
    {/* Top plate */}
    <line x1="309" y1="100" x2="321" y2="100" stroke="#007acc" strokeWidth="1.5" />
    {/* Bottom plate */}
    <line x1="309" y1="106" x2="321" y2="106" stroke="#007acc" strokeWidth="1.5" />
    {/* Wire to GND rail */}
    <line x1="315" y1="106" x2="315" y2="178" stroke="#007acc" strokeWidth="1.2" />
    {/* Junction dots */}
    <circle cx="315" cy="68" r="3" fill="#007acc" />
    <circle cx="315" cy="178" r="3" fill="#007acc" />
    {/* C1 label */}
    <text x="325" y="101" fill="#003a55" fontFamily="monospace" fontSize="5.5">
      C1
    </text>
    <text x="325" y="109" fill="#003a55" fontFamily="monospace" fontSize="5.5">
      100nF
    </text>

    {/* ── D13 SIGNAL TRACE ── */}
    <line x1="118" y1="108" x2="152" y2="108" stroke="#00aa44" strokeWidth="1.5" />

    {/* ── RESISTOR R1 (IEC rectangle) ── */}
    {/* Left stub */}
    <line x1="152" y1="108" x2="162" y2="108" stroke="#00aa44" strokeWidth="1.5" />
    {/* Body */}
    <rect
      x="162"
      y="100"
      width="44"
      height="16"
      rx="1"
      fill="none"
      stroke="#00aa44"
      strokeWidth="1.5"
    />
    {/* Right stub */}
    <line x1="206" y1="108" x2="220" y2="108" stroke="#00aa44" strokeWidth="1.5" />
    {/* Labels */}
    <text x="184" y="97" textAnchor="middle" fill="#00661a" fontFamily="monospace" fontSize="5.5">
      R1
    </text>
    <text x="184" y="124" textAnchor="middle" fill="#00661a" fontFamily="monospace" fontSize="5.5">
      330 Ω
    </text>

    {/* ── LED D1 (IEC triangle + bar) ── */}
    {/* Trace R1 to anode */}
    <line x1="220" y1="108" x2="230" y2="108" stroke="#00aa44" strokeWidth="1.5" />
    {/* Triangle (pointing right) */}
    <polygon
      points="230,99 230,117 258,108"
      fill="rgba(0,255,100,0.08)"
      stroke="#00aa44"
      strokeWidth="1.5"
    />
    {/* Cathode bar */}
    <line x1="258" y1="99" x2="258" y2="117" stroke="#00aa44" strokeWidth="2" />
    {/* Trace cathode → right */}
    <line x1="258" y1="108" x2="280" y2="108" stroke="#00aa44" strokeWidth="1.5" />
    {/* LED glow */}
    <circle cx="244" cy="108" r="20" fill="rgba(0,255,90,0.04)" />
    {/* Light emission rays */}
    <line x1="264" y1="96" x2="272" y2="90" stroke="rgba(0,220,80,0.22)" strokeWidth="1" />
    <line x1="267" y1="108" x2="276" y2="108" stroke="rgba(0,220,80,0.22)" strokeWidth="1" />
    <line x1="264" y1="120" x2="272" y2="126" stroke="rgba(0,220,80,0.22)" strokeWidth="1" />
    {/* D1 label */}
    <text x="244" y="95" textAnchor="middle" fill="#00661a" fontFamily="monospace" fontSize="5.5">
      D1
    </text>
    <text x="244" y="126" textAnchor="middle" fill="#00661a" fontFamily="monospace" fontSize="5.5">
      GREEN
    </text>

    {/* ── TRACE: cathode → GND rail ── */}
    <line x1="280" y1="108" x2="280" y2="178" stroke="#00aa44" strokeWidth="1.5" />
    {/* Junction dot on GND rail */}
    <circle cx="280" cy="178" r="3.5" fill="#00aa44" />

    {/* ── OSCILLOSCOPE WINDOW ── */}
    <rect
      x="288"
      y="192"
      width="100"
      height="66"
      rx="2"
      fill="#000c03"
      stroke="#0a2010"
      strokeWidth="1"
    />
    {/* Scope header bg */}
    <rect x="288" y="192" width="100" height="14" rx="2" fill="#000" />
    <text x="291" y="202" fill="#005522" fontFamily="monospace" fontSize="5.5">
      CH1 D13
    </text>
    <text x="385" y="202" textAnchor="end" fill="#003314" fontFamily="monospace" fontSize="5.5">
      5V/div
    </text>
    {/* Scope grid lines */}
    <line x1="288" y1="218" x2="388" y2="218" stroke="#051405" strokeWidth="0.5" />
    <line x1="288" y1="234" x2="388" y2="234" stroke="#051405" strokeWidth="0.5" />
    <line x1="288" y1="250" x2="388" y2="250" stroke="#051405" strokeWidth="0.5" />
    <line x1="313" y1="206" x2="313" y2="258" stroke="#051405" strokeWidth="0.5" />
    <line x1="338" y1="206" x2="338" y2="258" stroke="#051405" strokeWidth="0.5" />
    <line x1="363" y1="206" x2="363" y2="258" stroke="#051405" strokeWidth="0.5" />
    {/* Square wave trace (clipped) */}
    <polyline
      clipPath="url(#scope-clip)"
      points="290,250 290,214 303,214 303,250 316,250 316,214 329,214 329,250 342,250 342,214 355,214 355,250 368,250 368,214 381,214 381,250 388,250"
      fill="none"
      stroke="#00dd55"
      strokeWidth="1.5"
      strokeLinejoin="miter"
    />
    <text x="291" y="258" fill="#003314" fontFamily="monospace" fontSize="5">
      1s/div
    </text>

    {/* ── TX trace decorative ── */}
    <line
      x1="118"
      y1="143"
      x2="148"
      y2="143"
      stroke="#007acc"
      strokeWidth="1"
      strokeDasharray="4 2"
      opacity="0.4"
    />
    <text x="152" y="146" fill="#003a55" fontFamily="monospace" fontSize="5.5">
      Serial TX →
    </text>

    {/* Bottom silkscreen */}
    <text x="12" y="263" fill="#092010" fontFamily="monospace" fontSize="6" letterSpacing="0.5">
      MIT LICENSE
    </text>
    <text x="388" y="263" textAnchor="end" fill="#092010" fontFamily="monospace" fontSize="6">
      velxio.dev
    </text>
  </svg>
);

/* ── Board SVGs ───────────────────────────────────────── */

const BoardATtiny85 = () => (
  <svg viewBox="0 0 60 50" className="board-svg" style={{ maxWidth: '100px' }}>
    {/* PCB - small square DIP board */}
    <rect
      x="2"
      y="2"
      width="56"
      height="46"
      rx="2"
      fill="#1a3a1a"
      stroke="#0d2a0d"
      strokeWidth="1.5"
    />
    {/* ATtiny85 DIP-8 chip center */}
    <rect
      x="18"
      y="12"
      width="24"
      height="28"
      rx="1"
      fill="#111"
      stroke="#2a2a2a"
      strokeWidth="1"
    />
    {/* Notch */}
    <path d="M28 12 Q30 9 32 12" fill="#222" stroke="#333" strokeWidth="0.5" />
    {/* DIP pins left */}
    {[0, 1, 2, 3].map((i) => (
      <rect key={`l${i}`} x="8" y={15 + i * 6} width="10" height="3.5" rx="0.5" fill="#d4a017" />
    ))}
    {/* DIP pins right */}
    {[0, 1, 2, 3].map((i) => (
      <rect key={`r${i}`} x="42" y={15 + i * 6} width="10" height="3.5" rx="0.5" fill="#d4a017" />
    ))}
    {/* Chip label */}
    <text x="30" y="26" textAnchor="middle" fill="#333" fontFamily="monospace" fontSize="4">
      ATtiny
    </text>
    <text x="30" y="32" textAnchor="middle" fill="#333" fontFamily="monospace" fontSize="4">
      85
    </text>
    {/* Status LED */}
    <circle cx="50" cy="8" r="2" fill="#00ff88" opacity="0.85" />
    <text x="30" y="46" textAnchor="middle" fill="#00aa55" fontFamily="monospace" fontSize="3.5">
      AVR · 8KB · DIP-8
    </text>
  </svg>
);

const BoardCH32V003 = () => (
  <svg viewBox="0 0 60 80" className="board-svg" style={{ maxWidth: '90px' }}>
    {/* PCB */}
    <rect
      x="2"
      y="2"
      width="56"
      height="76"
      rx="2"
      fill="#0a2a0a"
      stroke="#061a06"
      strokeWidth="1.5"
    />
    {/* CH32V003 chip */}
    <rect
      x="18"
      y="22"
      width="24"
      height="22"
      rx="1"
      fill="#1a1a1a"
      stroke="#2a2a2a"
      strokeWidth="1"
    />
    {[0, 1, 2, 3].map((i) => (
      <rect key={`cl${i}`} x="14" y={25 + i * 4.5} width="4" height="2.5" rx="0.4" fill="#888" />
    ))}
    {[0, 1, 2, 3].map((i) => (
      <rect key={`cr${i}`} x="42" y={25 + i * 4.5} width="4" height="2.5" rx="0.4" fill="#888" />
    ))}
    <text x="30" y="31" textAnchor="middle" fill="#363636" fontFamily="monospace" fontSize="3.5">
      CH32
    </text>
    <text x="30" y="37" textAnchor="middle" fill="#363636" fontFamily="monospace" fontSize="3.5">
      V003
    </text>
    {/* Pins left */}
    {[0, 1, 2, 3, 4, 5, 6].map((i) => (
      <rect key={`pl${i}`} x="0" y={8 + i * 9} width="4" height="5" rx="0.5" fill="#d4a017" />
    ))}
    {/* Pins right */}
    {[0, 1, 2, 3, 4, 5, 6].map((i) => (
      <rect key={`pr${i}`} x="56" y={8 + i * 9} width="4" height="5" rx="0.5" fill="#d4a017" />
    ))}
    {/* USB */}
    <rect x="20" y="70" width="20" height="7" rx="2" fill="#555" stroke="#444" strokeWidth="1" />
    {/* LED */}
    <circle cx="48" cy="14" r="2" fill="#00ff44" opacity="0.85" />
    <text x="30" y="79" textAnchor="middle" fill="#00aa44" fontFamily="monospace" fontSize="3.5">
      RV32EC · 48 MHz
    </text>
  </svg>
);

const BoardEsp32C3 = () => (
  <svg viewBox="0 0 60 104" className="board-svg" style={{ maxWidth: '110px' }}>
    {/* PCB */}
    <rect
      x="2"
      y="2"
      width="56"
      height="100"
      rx="3"
      fill="#0d5e27"
      stroke="#084d1f"
      strokeWidth="1.5"
    />
    {/* Antenna tab */}
    <rect
      x="19"
      y="0"
      width="22"
      height="10"
      rx="2"
      fill="#0d5e27"
      stroke="#084d1f"
      strokeWidth="1"
    />
    <rect x="25" y="1" width="10" height="6" rx="1" fill="#aaa" />
    {/* ESP32-C3 chip */}
    <rect
      x="16"
      y="35"
      width="28"
      height="28"
      rx="2"
      fill="#1a1a1a"
      stroke="#2a2a2a"
      strokeWidth="1"
    />
    {[0, 1, 2, 3, 4].map((i) => (
      <rect key={`cl${i}`} x="12" y={39 + i * 4.5} width="4" height="2.5" rx="0.4" fill="#888" />
    ))}
    {[0, 1, 2, 3, 4].map((i) => (
      <rect key={`cr${i}`} x="44" y={39 + i * 4.5} width="4" height="2.5" rx="0.4" fill="#888" />
    ))}
    <text x="30" y="48" textAnchor="middle" fill="#363636" fontFamily="monospace" fontSize="4">
      ESP32
    </text>
    <text x="30" y="54" textAnchor="middle" fill="#363636" fontFamily="monospace" fontSize="4">
      -C3
    </text>
    {/* Left header pins */}
    {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((i) => (
      <rect key={`pl${i}`} x="0" y={10 + i * 8} width="5" height="4" rx="0.5" fill="#d4a017" />
    ))}
    {/* Right header pins */}
    {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((i) => (
      <rect key={`pr${i}`} x="55" y={10 + i * 8} width="5" height="4" rx="0.5" fill="#d4a017" />
    ))}
    {/* USB-C */}
    <rect x="20" y="95" width="20" height="7" rx="2.5" fill="#555" stroke="#444" strokeWidth="1" />
    <rect x="23" y="97" width="14" height="3" rx="1" fill="#333" />
    {/* WS2812B RGB LED */}
    <rect
      x="21"
      y="22"
      width="7"
      height="7"
      rx="0.5"
      fill="#111"
      stroke="#2a2a2a"
      strokeWidth="0.5"
    />
    <circle cx="24.5" cy="25.5" r="2" fill="#22ff66" opacity="0.75" />
    {/* Power LED */}
    <circle cx="40" cy="24" r="2" fill="#ff4444" opacity="0.9" />
    <circle cx="40" cy="24" r="4" fill="rgba(255,68,68,0.08)" />
    {/* Board label */}
    <text x="30" y="102" textAnchor="middle" fill="#00cc55" fontFamily="monospace" fontSize="4">
      ESP32-C3 DevKit
    </text>
  </svg>
);

/* ── Features ─────────────────────────────────────────── */
const features = [
  {
    icon: <IcoCpu />,
    title: '5 Emulation Engines',
    desc: 'AVR8 (ATmega), RP2040 (ARM Cortex-M0+), RV32IMC (ESP32-C3 in-browser), Xtensa LX6/LX7 (ESP32 via QEMU), and ARM Cortex-A53 (Raspberry Pi 3 Linux).',
  },
  {
    icon: <IcoLayers />,
    title: '48+ Visual Components',
    desc: 'LEDs, LCDs, ILI9341 TFT displays, servos, buzzers, ultrasonic sensors, keypads, and more from wokwi-elements.',
  },
  {
    icon: <IcoCode />,
    title: 'Monaco Editor',
    desc: 'VS Code-grade C++ editor with full syntax highlighting, IntelliSense-style autocomplete, minimap, and multi-file workspace.',
  },
  {
    icon: <IcoZap />,
    title: 'Local arduino-cli Compiler',
    desc: 'Compile and flash sketches locally in seconds. No cloud, no latency, no account required. Full offline support.',
  },
  {
    icon: <IcoMonitor />,
    title: 'Serial Monitor',
    desc: 'Real-time TX/RX with auto baud-rate detection, message history, send commands, and autoscroll.',
  },
  {
    icon: <IcoBook />,
    title: 'Library Manager',
    desc: 'Search and install any library from the full Arduino library index — directly inside the editor, no terminal needed.',
  },
];

/* ── Sponsor SVG icon ─────────────────────────────────── */
const IcoSponsor = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <circle cx="12" cy="12" r="10" />
    <path d="M12 6v6l4 2" />
    <path d="M8 14h.01M12 18h.01M16 14h.01" />
  </svg>
);

/* ── User nav dropdown ────────────────────────────────── */
const UserMenu: React.FC = () => {
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  if (!user) return null;

  const initials = user.username[0].toUpperCase();

  return (
    <div className="user-menu" ref={ref}>
      <button className="user-menu-trigger" onClick={() => setOpen((v) => !v)}>
        {user.avatar_url ? (
          <img src={user.avatar_url} alt="" className="user-avatar" />
        ) : (
          <span className="user-avatar user-avatar-initials">{initials}</span>
        )}
        <span className="user-menu-name">{user.username}</span>
        <svg
          viewBox="0 0 16 16"
          fill="currentColor"
          width="10"
          height="10"
          style={{ opacity: 0.5 }}
        >
          <path
            d="M4 6l4 4 4-4"
            stroke="currentColor"
            strokeWidth="1.5"
            fill="none"
            strokeLinecap="round"
          />
        </svg>
      </button>
      {open && (
        <div className="user-menu-dropdown">
          <div className="user-menu-header">
            {user.avatar_url ? (
              <img src={user.avatar_url} alt="" className="user-avatar user-avatar-lg" />
            ) : (
              <span className="user-avatar user-avatar-initials user-avatar-lg">{initials}</span>
            )}
            <div>
              <div className="user-menu-uname">{user.username}</div>
              <div className="user-menu-email">{user.email}</div>
            </div>
          </div>
          <div className="user-menu-divider" />
          <Link to="/editor" className="user-menu-item" onClick={() => setOpen(false)}>
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              width="15"
              height="15"
            >
              <polyline points="16 18 22 12 16 6" />
              <polyline points="8 6 2 12 8 18" />
            </svg>
            Open Editor
          </Link>
          <Link to={`/${user.username}`} className="user-menu-item" onClick={() => setOpen(false)}>
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              width="15"
              height="15"
            >
              <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
              <polyline points="9 22 9 12 15 12 15 22" />
            </svg>
            My Projects
          </Link>
          <div className="user-menu-divider" />
          <button
            className="user-menu-item user-menu-signout"
            onClick={async () => {
              setOpen(false);
              await logout();
              navigate('/');
            }}
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              width="15"
              height="15"
            >
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
              <polyline points="16 17 21 12 16 7" />
              <line x1="21" y1="12" x2="9" y2="12" />
            </svg>
            Sign out
          </button>
        </div>
      )}
    </div>
  );
};

/* ── Component ────────────────────────────────────────── */
export const LandingPage: React.FC = () => {
  useSEO({
    ...getSeoMeta('/')!,
    jsonLd: {
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: [
        {
          '@type': 'Question',
          name: 'Is Velxio free?',
          acceptedAnswer: {
            '@type': 'Answer',
            text: 'Yes. Velxio is completely free and open-source under the GNU AGPLv3 license. No account required, no cloud subscription. Run it at velxio.dev or self-host with one Docker command.',
          },
        },
        {
          '@type': 'Question',
          name: 'Does Velxio work offline?',
          acceptedAnswer: {
            '@type': 'Answer',
            text: 'Velxio can be self-hosted via Docker. Once running, the simulation engine works fully offline in the browser. Compilation requires the local arduino-cli backend.',
          },
        },
        {
          '@type': 'Question',
          name: 'What boards does Velxio support?',
          acceptedAnswer: {
            '@type': 'Answer',
            text: 'Velxio supports 19 boards across 5 CPU architectures: AVR8 (Arduino Uno, Nano, Mega 2560, ATtiny85, Leonardo, Pro Mini), RP2040 (Raspberry Pi Pico, Pico W), RISC-V (ESP32-C3, XIAO ESP32-C3, CH32V003), Xtensa QEMU (ESP32, ESP32-S3, ESP32-CAM, Nano ESP32), and ARM Cortex-A53 QEMU (Raspberry Pi 3B running Linux).',
          },
        },
        {
          '@type': 'Question',
          name: 'Is Velxio a Wokwi alternative?',
          acceptedAnswer: {
            '@type': 'Answer',
            text: 'Yes. Velxio is a free, self-hosted alternative to Wokwi. It uses the same avr8js and wokwi-elements open-source libraries but runs entirely on your machine with no cloud dependency.',
          },
        },
      ],
    },
  });

  return (
    <div className="landing">
      <AppHeader />

      {/* Hero */}
      <section className="landing-hero">
        <div className="hero-left">
          <h1 className="hero-title">
            Emulate Arduino,
            <br />
            ESP32 &amp; Raspberry Pi.
            <br />
            <span className="hero-accent">in your browser.</span>
          </h1>
          <p className="hero-subtitle">
            Write code, compile, and run on 19 real boards — Arduino Uno, ESP32, ESP32-C3, Raspberry
            Pi Pico, Raspberry Pi 3, and more. No hardware, no cloud, no limits.
          </p>
          <div className="hero-ctas">
            <Link
              to="/editor"
              className="cta-primary"
              onClick={() => trackClickCTA('landing', '/editor')}
            >
              <IcoZap />
              Try Simulator Free →
            </Link>
            <a
              href={GITHUB_URL}
              target="_blank"
              rel="noopener noreferrer"
              onClick={trackVisitGitHub}
              className="cta-secondary"
            >
              <IcoGitHub />
              View on GitHub
            </a>
          </div>
          <p className="hero-trust-line">
            No signup required · Runs 100% in your browser · Free &amp; open-source
          </p>
        </div>
        <div className="hero-right">
          <picture>
            <source srcSet="/image.webp" type="image/webp" />
            <img
              src="/image.png"
              alt="Velxio simulator preview"
              className="hero-preview-img"
              loading="lazy"
            />
          </picture>
        </div>
      </section>

      {/* Boards */}
      <section className="landing-section">
        <div className="section-header">
          <span className="section-label">Supported Hardware</span>
          <h2 className="section-title">
            Every architecture.
            <br />
            One tool.
          </h2>
          <p className="section-sub">
            19 boards across 5 CPU architectures — AVR8, ARM Cortex-M0+, RISC-V, Xtensa, and Linux.
            All running locally, no cloud needed.
          </p>
        </div>

        {/* ── AVR8 · avr8js ────────────────────────────────────────── */}
        <div className="board-group">
          <div
            className="board-group-header"
            style={{ '--grp-color': '#0071e3' } as React.CSSProperties}
          >
            <span className="board-group-engine">avr8js</span>
            <span className="board-group-label">AVR8 · ATmega · 16 MHz</span>
          </div>
          <div className="boards-row">
            <div className="board-card-sm">
              <div className="board-img-box">
                <img src="/boards/arduino-uno.svg" alt="Arduino Uno" className="board-img-sm" />
              </div>
              <span className="board-name-sm">Arduino Uno</span>
              <span className="board-chip-sm">ATmega328p · 32 KB</span>
            </div>
            <div className="board-card-sm">
              <div className="board-img-box">
                <img src="/boards/arduino-nano.svg" alt="Arduino Nano" className="board-img-sm" />
              </div>
              <span className="board-name-sm">Arduino Nano</span>
              <span className="board-chip-sm">ATmega328p · 32 KB</span>
            </div>
            <div className="board-card-sm">
              <div className="board-img-box">
                <img
                  src="/boards/arduino-mega.svg"
                  alt="Arduino Mega 2560"
                  className="board-img-sm"
                />
              </div>
              <span className="board-name-sm">Arduino Mega 2560</span>
              <span className="board-chip-sm">ATmega2560 · 256 KB</span>
            </div>
            <div className="board-card-sm">
              <div className="board-img-box">
                <BoardATtiny85 />
              </div>
              <span className="board-name-sm">ATtiny85</span>
              <span className="board-chip-sm">AVR · 8 KB · DIP-8</span>
            </div>
          </div>
        </div>

        {/* ── RP2040 · rp2040js ────────────────────────────────────── */}
        <div className="board-group">
          <div
            className="board-group-header"
            style={{ '--grp-color': '#a8192a' } as React.CSSProperties}
          >
            <span className="board-group-engine">rp2040js</span>
            <span className="board-group-label">RP2040 · Dual ARM Cortex-M0+ · 133 MHz</span>
          </div>
          <div className="boards-row">
            <div className="board-card-sm">
              <div className="board-img-box">
                <img src="/boards/pi-pico.svg" alt="Raspberry Pi Pico" className="board-img-sm" />
              </div>
              <span className="board-name-sm">Raspberry Pi Pico</span>
              <span className="board-chip-sm">RP2040 · 264 KB RAM</span>
            </div>
            <div className="board-card-sm">
              <div className="board-img-box">
                <img
                  src="/boards/pi-pico-w.svg"
                  alt="Raspberry Pi Pico W"
                  className="board-img-sm"
                />
              </div>
              <span className="board-name-sm">Raspberry Pi Pico W</span>
              <span className="board-chip-sm">RP2040 + WiFi</span>
            </div>
          </div>
        </div>

        {/* ── RISC-V · RV32IMC · Browser ───────────────────────────── */}
        <div className="board-group">
          <div
            className="board-group-header"
            style={{ '--grp-color': '#4a9e6b' } as React.CSSProperties}
          >
            <span className="board-group-engine">RV32IMC · Browser</span>
            <span className="board-group-label">RISC-V · 160 MHz · no backend needed</span>
          </div>
          <div className="boards-row">
            <div className="board-card-sm">
              <div className="board-img-box">
                <img src="/boards/esp32-c3.svg" alt="ESP32-C3" className="board-img-sm" />
              </div>
              <span className="board-name-sm">ESP32-C3 DevKit</span>
              <span className="board-chip-sm">RV32IMC · 4 MB flash</span>
            </div>
            <div className="board-card-sm">
              <div className="board-img-box">
                <img src="/boards/xiao-esp32-c3.svg" alt="XIAO ESP32-C3" className="board-img-sm" />
              </div>
              <span className="board-name-sm">XIAO ESP32-C3</span>
              <span className="board-chip-sm">RV32IMC · compact</span>
            </div>
            <div className="board-card-sm">
              <div className="board-img-box">
                <img
                  src="/boards/esp32c3-supermini.svg"
                  alt="ESP32-C3 SuperMini"
                  className="board-img-sm"
                />
              </div>
              <span className="board-name-sm">ESP32-C3 SuperMini</span>
              <span className="board-chip-sm">RV32IMC · mini form</span>
            </div>
            <div className="board-card-sm">
              <div className="board-img-box">
                <BoardCH32V003 />
              </div>
              <span className="board-name-sm">CH32V003 (RISC-V)</span>
              <span className="board-chip-sm">RV32EC · 48 MHz</span>
            </div>
          </div>
        </div>

        {/* ── Xtensa LX6/LX7 · QEMU ────────────────────────────────── */}
        <div className="board-group">
          <div
            className="board-group-header"
            style={{ '--grp-color': '#c8701a' } as React.CSSProperties}
          >
            <span className="board-group-engine">QEMU · Xtensa</span>
            <span className="board-group-label">Xtensa LX6/LX7 · 240 MHz · backend required</span>
          </div>
          <div className="boards-row">
            <div className="board-card-sm">
              <div className="board-img-box">
                <img
                  src="/boards/esp32-devkit-c-v4.svg"
                  alt="ESP32 DevKit V1"
                  className="board-img-sm"
                />
              </div>
              <span className="board-name-sm">ESP32 DevKit V1</span>
              <span className="board-chip-sm">LX6 · 4 MB flash</span>
            </div>
            <div className="board-card-sm">
              <div className="board-img-box">
                <img
                  src="/boards/esp32-devkit-c-v4.svg"
                  alt="ESP32 DevKit C V4"
                  className="board-img-sm"
                />
              </div>
              <span className="board-name-sm">ESP32 DevKit C V4</span>
              <span className="board-chip-sm">LX6 · 4 MB flash</span>
            </div>
            <div className="board-card-sm">
              <div className="board-img-box">
                <img src="/boards/esp32-cam.svg" alt="ESP32-CAM" className="board-img-sm" />
              </div>
              <span className="board-name-sm">ESP32-CAM</span>
              <span className="board-chip-sm">LX6 · camera module</span>
            </div>
            <div className="board-card-sm">
              <div className="board-img-box">
                <img src="/boards/esp32-s3.svg" alt="ESP32-S3" className="board-img-sm" />
              </div>
              <span className="board-name-sm">ESP32-S3 DevKit</span>
              <span className="board-chip-sm">LX7 · 4 MB flash</span>
            </div>
            <div className="board-card-sm">
              <div className="board-img-box">
                <img src="/boards/xiao-esp32-s3.svg" alt="XIAO ESP32-S3" className="board-img-sm" />
              </div>
              <span className="board-name-sm">XIAO ESP32-S3</span>
              <span className="board-chip-sm">LX7 · compact</span>
            </div>
            <div className="board-card-sm">
              <div className="board-img-box">
                <img
                  src="/boards/arduino-nano-esp32.svg"
                  alt="Arduino Nano ESP32"
                  className="board-img-sm"
                />
              </div>
              <span className="board-name-sm">Arduino Nano ESP32</span>
              <span className="board-chip-sm">LX7 · Nano form</span>
            </div>
          </div>
        </div>

        {/* ── ARM · Linux · QEMU ───────────────────────────────────── */}
        <div className="board-group">
          <div
            className="board-group-header"
            style={{ '--grp-color': '#a8304d' } as React.CSSProperties}
          >
            <span className="board-group-engine">QEMU · ARM</span>
            <span className="board-group-label">ARM Cortex-A53 · Linux · backend required</span>
          </div>
          <div className="boards-row">
            <div className="board-card-sm">
              <div className="board-img-box">
                <img src={raspberryPi3Svg} alt="Raspberry Pi 3B" className="board-img-sm" />
              </div>
              <span className="board-name-sm">Raspberry Pi 3B</span>
              <span className="board-chip-sm">Cortex-A53 · 1.2 GHz · Linux</span>
            </div>
          </div>
        </div>
      </section>

      {/* Features */}
      <section className="landing-section landing-section-alt">
        <div className="section-header">
          <span className="section-label">Features</span>
          <h2 className="section-title">Everything you need.</h2>
          <p className="section-sub">
            A complete IDE, compiler, and multi-architecture simulator — running locally with no
            external services required.
          </p>
        </div>
        <div className="features-grid">
          {features.map((f) => (
            <div key={f.title} className="feature-card">
              <div className="feature-icon">{f.icon}</div>
              <h3 className="feature-title">{f.title}</h3>
              <p className="feature-desc">{f.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Support */}
      <section className="landing-support">
        <div className="support-content">
          <div className="support-icon">
            <IcoSponsor />
          </div>
          <h2 className="support-title">Support the project</h2>
          <p className="support-sub">
            Velxio is free and open source. If it saves you time, consider supporting its
            development.
          </p>
          <div className="support-btns">
            <a
              href={GITHUB_SPONSORS_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="support-btn support-btn-gh"
            >
              <IcoGitHub /> GitHub Sponsors
            </a>
            <a
              href={PAYPAL_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="support-btn support-btn-pp"
            >
              <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16">
                <path d="M7.076 21.337H2.47a.641.641 0 0 1-.633-.74L4.944.901C5.026.382 5.474 0 5.998 0h7.46c2.57 0 4.578.543 5.69 1.81 1.01 1.15 1.304 2.42 1.012 4.287-.023.143-.047.288-.077.437-.983 5.05-4.349 6.797-8.647 6.797h-2.19c-.524 0-.968.382-1.05.9l-1.12 7.106zm14.146-14.42a3.35 3.35 0 0 0-.607-.541c-.013.076-.026.175-.041.254-.93 4.778-4.005 7.201-9.138 7.201h-2.19a.563.563 0 0 0-.556.479l-1.187 7.527h-.506l-.24 1.516a.56.56 0 0 0 .554.647h3.882c.46 0 .85-.334.922-.788.06-.26.76-4.852.816-5.09a.932.932 0 0 1 .923-.788h.58c3.76 0 6.705-1.528 7.565-5.946.36-1.847.174-3.388-.777-4.471z" />
              </svg>
              Donate via PayPal
            </a>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="landing-footer">
        <div className="footer-brand">
          <IcoChip />
          <span>Velxio</span>
        </div>
        <div className="footer-links">
          <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer" onClick={trackVisitGitHub}>
            GitHub
          </a>
          <Link to="/docs">Docs</Link>
          <Link to="/examples">Examples</Link>
          <Link to="/editor">Editor</Link>
          <Link to="/about">About</Link>
        </div>
        <p className="footer-copy">
          MIT License · Powered by{' '}
          <a href="https://github.com/wokwi/avr8js" target="_blank" rel="noopener noreferrer">
            avr8js
          </a>{' '}
          &amp;{' '}
          <a
            href="https://github.com/wokwi/wokwi-elements"
            target="_blank"
            rel="noopener noreferrer"
          >
            wokwi-elements
          </a>
        </p>
      </footer>
    </div>
  );
};
