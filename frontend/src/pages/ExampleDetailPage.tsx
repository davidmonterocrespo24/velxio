/**
 * ExampleDetailPage — SEO landing page for a single example.
 *
 * Route: /examples/:exampleId
 *
 * Shows example title, description, category, difficulty and board type with
 * a CTA to open the example in the simulator.  Fully prerenderable at build
 * time (no browser-only APIs on first render) so every example gets its own
 * statically-served HTML for search engines.
 */

import React, { useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { exampleProjects } from '../data/examples';
import { loadExample, type LibraryInstallProgress } from '../utils/loadExample';
import { AppHeader } from '../components/layout/AppHeader';
import { CircuitPreview } from '../components/examples/CircuitPreview';
import { useSEO } from '../utils/useSEO';

const DOMAIN = 'https://velxio.dev';

const BOARD_LABELS: Record<string, string> = {
  'arduino-uno': 'Arduino Uno',
  'arduino-nano': 'Arduino Nano',
  'arduino-mega': 'Arduino Mega',
  'raspberry-pi-pico': 'Raspberry Pi Pico (RP2040)',
  esp32: 'ESP32',
  'esp32-c3': 'ESP32-C3',
};

const CATEGORY_LABELS: Record<string, string> = {
  basics: 'Basics',
  sensors: 'Sensors',
  displays: 'Displays',
  communication: 'Communication',
  games: 'Games',
  robotics: 'Robotics',
};

const DIFFICULTY_COLOR: Record<string, string> = {
  beginner: '#4caf50',
  intermediate: '#ff9800',
  advanced: '#f44336',
};

export const ExampleDetailPage: React.FC = () => {
  const { exampleId } = useParams<{ exampleId: string }>();
  const navigate = useNavigate();
  const [installing, setInstalling] = useState<LibraryInstallProgress | null>(null);

  const example = exampleId ? exampleProjects.find((e) => e.id === exampleId) : null;

  // SEO — called unconditionally (hooks must not be inside conditionals).
  const seoTitle = example
    ? `${example.title} — Free Arduino Simulator Example | Velxio`
    : 'Example Not Found | Velxio';

  const boardLabel = example
    ? (BOARD_LABELS[example.boardType ?? 'arduino-uno'] ?? example.boardType ?? 'Arduino Uno')
    : '';

  const seoDescription = example
    ? `${example.description}. Run this ${boardLabel} example free in your browser — no install, no account required.`
    : 'This example was not found.';

  useSEO({
    title: seoTitle,
    description: seoDescription,
    url: `${DOMAIN}/examples/${exampleId ?? ''}`,
  });

  const handleOpen = async () => {
    if (!example) return;
    await loadExample(example, setInstalling);
    navigate('/editor');
  };

  // ── 404 state ───────────────────────────────────────────────────────────────
  if (!example) {
    return (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          minHeight: '100vh',
          background: '#1e1e1e',
        }}
      >
        <AppHeader />
        <div
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 16,
          }}
        >
          <div style={{ fontSize: 48, color: '#555' }}>404</div>
          <div style={{ fontSize: 16, color: '#999' }}>Example "{exampleId}" not found.</div>
          <Link
            to="/examples"
            style={{
              color: '#4fc3f7',
              textDecoration: 'none',
              border: '1px solid #4fc3f7',
              borderRadius: 4,
              padding: '8px 20px',
              fontSize: 14,
            }}
          >
            Browse all examples
          </Link>
        </div>
      </div>
    );
  }

  const diffColor = DIFFICULTY_COLOR[example.difficulty] ?? '#999';
  const categoryLabel = CATEGORY_LABELS[example.category] ?? example.category;

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        minHeight: '100vh',
        background: '#1e1e1e',
      }}
    >
      <AppHeader />

      <main
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          padding: '48px 24px 80px',
        }}
      >
        {/* Breadcrumb */}
        <nav
          style={{ width: '100%', maxWidth: 760, marginBottom: 32, fontSize: 13, color: '#666' }}
        >
          <Link to="/" style={{ color: '#666', textDecoration: 'none' }}>
            Velxio
          </Link>
          {' / '}
          <Link to="/examples" style={{ color: '#666', textDecoration: 'none' }}>
            Examples
          </Link>
          {' / '}
          <span style={{ color: '#aaa' }}>{example.title}</span>
        </nav>

        {/* Card */}
        <article
          style={{
            width: '100%',
            maxWidth: 760,
            background: '#252526',
            border: '1px solid #333',
            borderRadius: 12,
            padding: '40px 48px',
          }}
        >
          {/* Circuit preview */}
          <div
            style={{
              width: '100%',
              borderRadius: 8,
              overflow: 'hidden',
              marginBottom: 28,
              border: '1px solid #333',
            }}
          >
            <CircuitPreview
              example={example}
              width={760}
              height={240}
              background="#111"
              style={{ width: '100%', height: 240, borderRadius: 7 }}
            />
          </div>

          {/* Badges */}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 20 }}>
            <span
              style={{
                fontSize: 11,
                fontWeight: 600,
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
                padding: '3px 10px',
                borderRadius: 4,
                background: '#1a3a4a',
                color: '#4fc3f7',
              }}
            >
              {categoryLabel}
            </span>
            <span
              style={{
                fontSize: 11,
                fontWeight: 600,
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
                padding: '3px 10px',
                borderRadius: 4,
                background: `${diffColor}22`,
                color: diffColor,
              }}
            >
              {example.difficulty}
            </span>
            <span
              style={{
                fontSize: 11,
                fontWeight: 600,
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
                padding: '3px 10px',
                borderRadius: 4,
                background: '#2a2a2a',
                color: '#aaa',
              }}
            >
              {boardLabel}
            </span>
          </div>

          {/* Title */}
          <h1
            style={{
              fontSize: 28,
              fontWeight: 700,
              color: '#d4d4d4',
              margin: '0 0 16px',
              lineHeight: 1.3,
            }}
          >
            {example.title}
          </h1>

          {/* Description */}
          <p style={{ fontSize: 16, color: '#9d9d9d', lineHeight: 1.7, margin: '0 0 32px' }}>
            {example.description}
          </p>

          {/* What you'll learn section */}
          <section style={{ marginBottom: 36 }}>
            <h2
              style={{
                fontSize: 14,
                fontWeight: 600,
                color: '#858585',
                textTransform: 'uppercase',
                letterSpacing: '0.08em',
                margin: '0 0 12px',
              }}
            >
              What you'll simulate
            </h2>
            <ul
              style={{
                listStyle: 'none',
                padding: 0,
                margin: 0,
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
              }}
            >
              <li
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  color: '#c8c8c8',
                  fontSize: 14,
                }}
              >
                <span style={{ color: '#4fc3f7', fontWeight: 700 }}>✓</span>
                Real {boardLabel} emulation — cycle-accurate, no hardware needed
              </li>
              <li
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  color: '#c8c8c8',
                  fontSize: 14,
                }}
              >
                <span style={{ color: '#4fc3f7', fontWeight: 700 }}>✓</span>
                {example.components.length > 0
                  ? `${example.components.length} interactive component${example.components.length > 1 ? 's' : ''} on the canvas`
                  : 'Interactive simulation canvas'}
              </li>
              {example.libraries && example.libraries.length > 0 && (
                <li
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    color: '#c8c8c8',
                    fontSize: 14,
                  }}
                >
                  <span style={{ color: '#4fc3f7', fontWeight: 700 }}>✓</span>
                  Auto-installs: {example.libraries.join(', ')}
                </li>
              )}
              <li
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  color: '#c8c8c8',
                  fontSize: 14,
                }}
              >
                <span style={{ color: '#4fc3f7', fontWeight: 700 }}>✓</span>
                Serial Monitor included — see output in real time
              </li>
            </ul>
          </section>

          {/* CTA */}
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            <button
              onClick={handleOpen}
              style={{
                background: '#0e639c',
                border: 'none',
                borderRadius: 6,
                color: '#fff',
                fontSize: 15,
                fontWeight: 600,
                padding: '12px 28px',
                cursor: 'pointer',
                letterSpacing: '0.02em',
              }}
            >
              Open in Simulator
            </button>
            <Link to="/examples" style={{ color: '#666', textDecoration: 'none', fontSize: 14 }}>
              ← Back to examples
            </Link>
          </div>
        </article>

        {/* JSON-LD structured data */}
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify({
              '@context': 'https://schema.org',
              '@type': 'LearningResource',
              name: example.title,
              description: seoDescription,
              url: `${DOMAIN}/examples/${example.id}`,
              educationalLevel: example.difficulty,
              learningResourceType: 'Simulation',
              provider: { '@type': 'Organization', name: 'Velxio', url: DOMAIN },
              about: { '@type': 'Thing', name: boardLabel },
            }),
          }}
        />
      </main>

      {/* Library install overlay */}
      {installing && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 9999,
            background: 'rgba(0,0,0,0.7)',
            backdropFilter: 'blur(4px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <div
            style={{
              background: '#1e1e1e',
              border: '1px solid #333',
              borderRadius: 12,
              padding: '28px 36px',
              textAlign: 'center',
              maxWidth: 360,
            }}
          >
            <div style={{ fontSize: 14, color: '#ccc', marginBottom: 12 }}>
              Installing libraries ({installing.done + 1}/{installing.total})
            </div>
            <div style={{ fontSize: 16, color: '#00e5ff', fontWeight: 600, marginBottom: 16 }}>
              {installing.current}
            </div>
            <div style={{ height: 4, borderRadius: 2, background: '#333', overflow: 'hidden' }}>
              <div
                style={{
                  height: '100%',
                  borderRadius: 2,
                  background: '#00b8d4',
                  width: `${((installing.done + 1) / installing.total) * 100}%`,
                  transition: 'width 0.3s ease',
                }}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
