/**
 * Examples Page Component
 *
 * Displays the examples gallery
 */

import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ExamplesGallery } from '../components/examples/ExamplesGallery';
import { AppHeader } from '../components/layout/AppHeader';
import { useSEO } from '../utils/useSEO';
import { getSeoMeta } from '../seoRoutes';
import { loadExample, type LibraryInstallProgress } from '../utils/loadExample';
import type { ExampleProject } from '../data/examples';

export const ExamplesPage: React.FC = () => {
  useSEO(getSeoMeta('/examples')!);

  const navigate = useNavigate();
  const [installing, setInstalling] = useState<LibraryInstallProgress | null>(null);

  const handleLoadExample = async (example: ExampleProject) => {
    await loadExample(example, setInstalling);
    navigate('/editor');
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh', background: '#1e1e1e' }}>
      <AppHeader />
      <ExamplesGallery onLoadExample={handleLoadExample} />

      {/* Library install overlay */}
      {installing && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 9999,
          background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(4px)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <div style={{
            background: '#1e1e1e', border: '1px solid #333', borderRadius: 12,
            padding: '28px 36px', textAlign: 'center', maxWidth: 360,
          }}>
            <div style={{ fontSize: 14, color: '#ccc', marginBottom: 12 }}>
              Installing libraries ({installing.done + 1}/{installing.total})
            </div>
            <div style={{ fontSize: 16, color: '#00e5ff', fontWeight: 600, marginBottom: 16 }}>
              {installing.current}
            </div>
            <div style={{
              height: 4, borderRadius: 2, background: '#333', overflow: 'hidden',
            }}>
              <div style={{
                height: '100%', borderRadius: 2, background: '#00b8d4',
                width: `${((installing.done + 1) / installing.total) * 100}%`,
                transition: 'width 0.3s ease',
              }} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
