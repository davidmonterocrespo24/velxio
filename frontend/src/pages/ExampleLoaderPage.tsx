/**
 * ExampleLoaderPage — loads an example by ID from the URL and redirects to the editor.
 *
 * Route: /examples/:exampleId
 * Example: /examples/blink-led
 */

import React, { useEffect, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { exampleProjects } from '../data/examples';
import { loadExample, type LibraryInstallProgress } from '../utils/loadExample';
import { AppHeader } from '../components/layout/AppHeader';

export const ExampleLoaderPage: React.FC = () => {
  const { exampleId } = useParams<{ exampleId: string }>();
  const navigate = useNavigate();
  const [error, setError] = useState(false);
  const [installing, setInstalling] = useState<LibraryInstallProgress | null>(null);

  useEffect(() => {
    if (!exampleId) { setError(true); return; }

    const example = exampleProjects.find((e) => e.id === exampleId);
    if (!example) { setError(true); return; }

    let cancelled = false;
    (async () => {
      await loadExample(example, setInstalling);
      if (!cancelled) navigate('/editor', { replace: true });
    })();

    return () => { cancelled = true; };
  }, [exampleId, navigate]);

  if (error) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh', background: '#1e1e1e' }}>
        <AppHeader />
        <div style={{
          flex: 1, display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center', gap: 16,
        }}>
          <div style={{ fontSize: 48, color: '#555' }}>404</div>
          <div style={{ fontSize: 16, color: '#999' }}>
            Example "{exampleId}" not found.
          </div>
          <Link
            to="/examples"
            style={{
              color: '#4fc3f7', textDecoration: 'none',
              border: '1px solid #4fc3f7', borderRadius: 4,
              padding: '8px 20px', fontSize: 14,
            }}
          >
            Browse all examples
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', minHeight: '100vh',
      background: '#1e1e1e', alignItems: 'center', justifyContent: 'center',
    }}>
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontSize: 16, color: '#ccc', marginBottom: 12 }}>
          Loading example...
        </div>
        {installing && (
          <div style={{ maxWidth: 300, margin: '0 auto' }}>
            <div style={{ fontSize: 13, color: '#999', marginBottom: 8 }}>
              Installing libraries ({installing.done + 1}/{installing.total})
            </div>
            <div style={{ fontSize: 14, color: '#00e5ff', fontWeight: 600, marginBottom: 12 }}>
              {installing.current}
            </div>
            <div style={{ height: 4, borderRadius: 2, background: '#333', overflow: 'hidden' }}>
              <div style={{
                height: '100%', borderRadius: 2, background: '#00b8d4',
                width: `${((installing.done + 1) / installing.total) * 100}%`,
                transition: 'width 0.3s ease',
              }} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
