import { Link } from 'react-router-dom';
import { AppHeader } from '../components/layout/AppHeader';
import { useSEO } from '../utils/useSEO';
import { getSeoMeta } from '../seoRoutes';
import './AboutPage.css';

const GITHUB_URL = 'https://github.com/davidmonterocrespo24/velxio';
const LINKEDIN_URL = 'https://www.linkedin.com/in/davidmonterocrespo24';
const GITHUB_PROFILE = 'https://github.com/davidmonterocrespo24';
const MEDIUM_URL = 'https://medium.com/@davidmonterocrespo24';
const MEDIUM_ARTICLE_URL =
  'https://medium.com/@davidmonterocrespo24/velxio-architecture-and-development-of-a-strictly-local-execution-microcontroller-emulator-62b4c1157a72';
const HN_THREAD_V2 = 'https://news.ycombinator.com/item?id=47548013';
const PRODUCT_HUNT_URL = 'https://www.producthunt.com/products/velxio';
const HACKADAY_URL = 'https://hackaday.io/project/205186-velxio-browser-based-arduino-emulator';
const REDDIT_URL =
  'https://www.reddit.com/r/esp32/comments/1s2naya/a_browserbased_esp32_emulator_using_qemu_supports/';

/* ── Icons ──────────────────────────────────────────── */
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

const IcoGitHub = () => (
  <svg viewBox="0 0 24 24" fill="currentColor">
    <path d="M12 0C5.37 0 0 5.37 0 12c0 5.3 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61-.546-1.385-1.335-1.755-1.335-1.755-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 21.795 24 17.295 24 12c0-6.63-5.37-12-12-12z" />
  </svg>
);

const IcoLinkedIn = () => (
  <svg viewBox="0 0 24 24" fill="currentColor">
    <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 0 1-2.063-2.065 2.064 2.064 0 1 1 2.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z" />
  </svg>
);

const IcoMedium = () => (
  <svg viewBox="0 0 24 24" fill="currentColor">
    <path d="M13.54 12a6.8 6.8 0 01-6.77 6.82A6.8 6.8 0 010 12a6.8 6.8 0 016.77-6.82A6.8 6.8 0 0113.54 12zM20.96 12c0 3.54-1.51 6.42-3.38 6.42-1.87 0-3.39-2.88-3.39-6.42s1.52-6.42 3.39-6.42 3.38 2.88 3.38 6.42M24 12c0 3.17-.53 5.75-1.19 5.75-.66 0-1.19-2.58-1.19-5.75s.53-5.75 1.19-5.75C23.47 6.25 24 8.83 24 12z" />
  </svg>
);

/* ── Component ──────────────────────────────────────── */
export const AboutPage: React.FC = () => {
  useSEO({
    ...getSeoMeta('/about')!,
    jsonLd: {
      '@context': 'https://schema.org',
      '@type': 'AboutPage',
      name: 'About Velxio',
      description: 'Learn about Velxio and its creator David Montero Crespo.',
      url: 'https://velxio.dev/about',
    },
  });

  return (
    <div className="about-page">
      <AppHeader />

      {/* Hero */}
      <section className="about-hero">
        <div className="about-hero-inner">
          <h1 className="about-hero-title">About Velxio</h1>
          <p className="about-hero-sub">
            A free, open-source embedded systems emulator — built by a single developer with a
            passion for hardware and open source.
          </p>
        </div>
      </section>

      {/* The Story */}
      <section className="about-section">
        <div className="about-container">
          <div className="about-story">
            <h2 className="about-heading">The Story</h2>
            <p>
              Velxio started as a personal exploration into how microcontroller emulators work
              internally — CPU instructions, memory management, peripheral timing, and low-level
              architecture. What began as a learning project during a vacation quickly grew into
              something bigger.
            </p>
            <p>
              The idea was simple:{' '}
              <strong>
                what if anyone could simulate Arduino, ESP32, and Raspberry Pi boards directly in
                the browser, without buying hardware, without installing toolchains, without cloud
                accounts?
              </strong>
            </p>
            <p>
              Velxio v1 launched on Product Hunt and Hacker News, supporting Arduino Uno and
              Raspberry Pi Pico. The feedback from the maker and embedded community was incredible —
              and it pushed the project forward.
            </p>
            <p>
              <strong>Velxio 2.0</strong> shipped with ESP32 emulation via QEMU (using the lcgamboa
              fork), a Raspberry Pi 3 running real Linux, RISC-V support for ESP32-C3 and CH32V003,
              realistic sensor simulation (DHT22, HC-SR04, WS2812B NeoPixel), and 19 boards across 5
              CPU architectures — all running real compiled code.
            </p>
            <p>
              The v2 launch hit the <strong>front page of Hacker News for over 20 hours</strong>,
              reaching nearly 600 GitHub stars and thousands of visitors in less than 24 hours. It's
              now being used by students, professors, and makers around the world.
            </p>
          </div>
        </div>
      </section>

      {/* Architecture overview */}
      <section className="about-section about-section-alt">
        <div className="about-container">
          <h2 className="about-heading">How It Works</h2>
          <div className="about-arch-grid">
            <div className="about-arch-card">
              <div className="about-arch-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <rect x="4" y="4" width="16" height="16" rx="2" />
                  <rect x="8" y="8" width="8" height="8" />
                  <path d="M10 2v2M14 2v2M10 20v2M14 20v2M2 10h2M2 14h2M20 10h2M20 14h2" />
                </svg>
              </div>
              <h3>AVR8 &amp; RP2040</h3>
              <p>
                Cycle-accurate emulation runs entirely in your browser using avr8js and rp2040js. No
                backend needed for simulation.
              </p>
            </div>
            <div className="about-arch-card">
              <div className="about-arch-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
                </svg>
              </div>
              <h3>ESP32 via QEMU</h3>
              <p>
                Xtensa ESP32 and ESP32-S3 run on backend QEMU (lcgamboa fork) with real flash
                images, GPIO, ADC, and timers.
              </p>
            </div>
            <div className="about-arch-card">
              <div className="about-arch-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <polyline points="16 18 22 12 16 6" />
                  <polyline points="8 6 2 12 8 18" />
                </svg>
              </div>
              <h3>RISC-V In-Browser</h3>
              <p>
                ESP32-C3 and CH32V003 run on a custom RV32IMC core written in TypeScript — entirely
                client-side, no QEMU.
              </p>
            </div>
            <div className="about-arch-card">
              <div className="about-arch-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <rect x="2" y="3" width="20" height="14" rx="2" />
                  <line x1="8" y1="21" x2="16" y2="21" />
                  <line x1="12" y1="17" x2="12" y2="21" />
                </svg>
              </div>
              <h3>Raspberry Pi 3</h3>
              <p>
                Full ARM Cortex-A53 Linux via QEMU raspi3b — boots real Raspberry Pi OS and runs
                Python with RPi.GPIO.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Open Source Philosophy */}
      <section className="about-section">
        <div className="about-container">
          <h2 className="about-heading">Open Source Philosophy</h2>
          <p>
            Velxio is <strong>100% open source</strong> under the AGPLv3 license. No cloud
            dependency, no student accounts, no data leaving your network. Universities and
            bootcamps can deploy it on their own servers with a single Docker command and give every
            student access to a complete embedded development environment — for free.
          </p>
          <p>The project builds on top of amazing open-source work from the community:</p>
          <ul className="about-credits-list">
            <li>
              <a href="https://github.com/wokwi/avr8js" target="_blank" rel="noopener noreferrer">
                avr8js
              </a>{' '}
              — AVR8 CPU emulation by Wokwi
            </li>
            <li>
              <a href="https://github.com/wokwi/rp2040js" target="_blank" rel="noopener noreferrer">
                rp2040js
              </a>{' '}
              — RP2040 emulation by Wokwi
            </li>
            <li>
              <a
                href="https://github.com/wokwi/wokwi-elements"
                target="_blank"
                rel="noopener noreferrer"
              >
                wokwi-elements
              </a>{' '}
              — 48+ visual electronic components by Wokwi
            </li>
            <li>
              <a href="https://github.com/lcgamboa/qemu" target="_blank" rel="noopener noreferrer">
                QEMU lcgamboa fork
              </a>{' '}
              — ESP32 and Raspberry Pi QEMU emulation
            </li>
            <li>
              <a
                href="https://arduino.github.io/arduino-cli/"
                target="_blank"
                rel="noopener noreferrer"
              >
                arduino-cli
              </a>{' '}
              — Arduino compilation toolchain
            </li>
          </ul>
          <p>
            Velxio was inspired by{' '}
            <a href="https://wokwi.com" target="_blank" rel="noopener noreferrer">
              Wokwi
            </a>
            , which is a fantastic tool. The goal of Velxio is to take a different path: fully open
            source, self-hostable, and supporting multiple heterogeneous boards in the same circuit.
          </p>
        </div>
      </section>

      {/* Creator */}
      <section className="about-section about-section-alt">
        <div className="about-container">
          <h2 className="about-heading">The Creator</h2>
          <div className="about-creator">
            <div className="about-creator-photo">
              <div className="about-creator-avatar">DMC</div>
            </div>
            <div className="about-creator-info">
              <h3 className="about-creator-name">David Montero Crespo</h3>
              <p className="about-creator-role">
                Application Architect @ IBM &middot; Montevideo, Uruguay
              </p>
              <p className="about-creator-bio">
                Application Architect with over 10 years of experience leading the development of
                large-scale enterprise ecosystems. Specialist in Generative AI (LLMs, RAG,
                LangChain), Cloud-Native architectures (OpenShift, Kubernetes), and certified Odoo
                ERP expert. Currently at IBM working on enterprise applications for the Uruguayan
                State Insurance Bank (BSE).
              </p>
              <p className="about-creator-bio">
                Studied Computer Science Engineering at Universidad de Oriente in Cuba (2012-2017),
                then moved to Uruguay where he built a career spanning roles at Quanam (Odoo
                implementations for government institutions), and IBM (enterprise architecture for
                BPS and BSE).
              </p>
              <p className="about-creator-bio">
                Programming and robotics enthusiast. Creator of other open-source projects including
                a{' '}
                <a
                  href="https://github.com/davidmonterocrespo24"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  3D racing game running on an ESP32
                </a>{' '}
                (viral on Reddit with 40K+ views) and an iPod Classic clone for Raspberry Pi.
              </p>

              <div className="about-creator-stack">
                <h4>Tech Stack</h4>
                <div className="about-tags">
                  <span className="about-tag">Java</span>
                  <span className="about-tag">Python</span>
                  <span className="about-tag">TypeScript</span>
                  <span className="about-tag">React</span>
                  <span className="about-tag">Angular</span>
                  <span className="about-tag">Node.js</span>
                  <span className="about-tag">FastAPI</span>
                  <span className="about-tag">Docker</span>
                  <span className="about-tag">Kubernetes</span>
                  <span className="about-tag">OpenShift</span>
                  <span className="about-tag">LangChain</span>
                  <span className="about-tag">watsonx.ai</span>
                  <span className="about-tag">Odoo</span>
                  <span className="about-tag">Arduino</span>
                  <span className="about-tag">ESP32</span>
                  <span className="about-tag">Raspberry Pi</span>
                </div>
              </div>

              <div className="about-creator-links">
                <a
                  href={LINKEDIN_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="about-social-link"
                >
                  <IcoLinkedIn /> LinkedIn
                </a>
                <a
                  href={GITHUB_PROFILE}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="about-social-link"
                >
                  <IcoGitHub /> GitHub
                </a>
                <a
                  href={MEDIUM_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="about-social-link"
                >
                  <IcoMedium /> Medium
                </a>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Personal story quote */}
      <section className="about-section">
        <div className="about-container">
          <blockquote className="about-quote">
            <p>
              "I studied Computer Science in Cuba from 2012 to 2017, and when I moved to Uruguay,
              the most common question was:{' '}
              <em>
                'How did you graduate as an engineer without internet, without a computer, without
                YouTube?'
              </em>
            </p>
            <p>
              I only had 4 words for the answer:{' '}
              <strong>Perseverance! Perseverance! Perseverance! Perseverance!</strong>
            </p>
            <p>There is no better motivation than not having a plan B."</p>
            <cite>— David Montero Crespo</cite>
          </blockquote>
        </div>
      </section>

      {/* Community & Press */}
      <section className="about-section about-section-alt">
        <div className="about-container">
          <h2 className="about-heading">Community &amp; Press</h2>
          <div className="about-stats-grid">
            <div className="about-stat">
              <span className="about-stat-number">600+</span>
              <span className="about-stat-label">GitHub Stars</span>
            </div>
            <div className="about-stat">
              <span className="about-stat-number">97+</span>
              <span className="about-stat-label">Countries</span>
            </div>
            <div className="about-stat">
              <span className="about-stat-number">19</span>
              <span className="about-stat-label">Supported Boards</span>
            </div>
            <div className="about-stat">
              <span className="about-stat-number">5</span>
              <span className="about-stat-label">CPU Architectures</span>
            </div>
          </div>
          <div className="about-press">
            <p>Featured on:</p>
            <div className="about-press-list">
              <a
                href={HN_THREAD_V2}
                target="_blank"
                rel="noopener noreferrer"
                className="about-press-badge"
              >
                Hacker News (Front Page)
              </a>
              <a
                href={PRODUCT_HUNT_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="about-press-badge"
              >
                Product Hunt
              </a>
              <a
                href={HACKADAY_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="about-press-badge"
              >
                Hackaday
              </a>
              <a
                href={REDDIT_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="about-press-badge"
              >
                Reddit r/esp32
              </a>
              <a
                href={MEDIUM_ARTICLE_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="about-press-badge"
              >
                Medium
              </a>
            </div>
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="about-cta">
        <div className="about-container">
          <h2>Ready to try Velxio?</h2>
          <p>No signup required. Runs 100% in your browser. Free and open source.</p>
          <div className="about-cta-btns">
            <Link to="/editor" className="about-btn-primary">
              Open Editor
            </Link>
            <a
              href={GITHUB_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="about-btn-secondary"
            >
              <IcoGitHub /> View on GitHub
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
          <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer">
            GitHub
          </a>
          <Link to="/docs">Docs</Link>
          <Link to="/examples">Examples</Link>
          <Link to="/editor">Editor</Link>
          <Link to="/about">About</Link>
        </div>
        <p className="footer-copy">
          MIT License &middot; Powered by{' '}
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
