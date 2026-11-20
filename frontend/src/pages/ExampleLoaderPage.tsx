/**
 * ExampleLoaderPage — loads an example by ID from the URL and redirects to the editor.
 *
 * Route: /examples/:exampleId
 * Example: /examples/blink-led
 */

import React, { useEffect, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { exampleProjects } from '../data/examples';
import { loadExample, type LibraryInstallProgress } from '../utils/loadExample';
import { keepWorkspaceLocationState } from '../lib/localWorkspace';
import { AppHeader } from '../components/layout/AppHeader';
import { useLocalizedHref } from '../i18n/useLocalizedNavigate';

export const ExampleLoaderPage: React.FC = () => {
  const { t } = useTranslation();
  const localize = useLocalizedHref();
  const { exampleId } = useParams<{ exampleId: string }>();
  const navigate = useNavigate();
  const [error, setError] = useState(false);
  const [installing, setInstalling] = useState<LibraryInstallProgress | null>(null);

  useEffect(() => {
    if (!exampleId) {
      setError(true);
      return;
    }

    const example = exampleProjects.find((e) => e.id === exampleId);
    if (!example) {
      setError(true);
      return;
    }

    let cancelled = false;
    (async () => {
      await loadExample(example, setInstalling);
      if (!cancelled) navigate(localize('/editor'), {
        replace: true,
        state: keepWorkspaceLocationState(),
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [exampleId, navigate]);

  if (error) {
    return (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          minHeight: '100vh',
          background: 'var(--wb-2)',
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
          <div style={{ fontSize: 48, color: 'var(--wb-8)' }}>404</div>
          <div style={{ fontSize: 16, color: 'var(--wb-11)' }}>{t('examples.notFound', { id: exampleId })}</div>
          <Link
            to={localize('/examples')}
            style={{
              color: '#4fc3f7',
              textDecoration: 'none',
              border: '1px solid #4fc3f7',
              borderRadius: 4,
              padding: '8px 20px',
              fontSize: 14,
            }}
          >
            {t('examples.browseAll')}
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        minHeight: '100vh',
        background: 'var(--wb-2)',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontSize: 16, color: 'var(--wb-12)', marginBottom: 12 }}>{t('examples.loadingExample')}</div>
        {installing && (
          <div style={{ maxWidth: 300, margin: '0 auto' }}>
            <div style={{ fontSize: 13, color: 'var(--wb-11)', marginBottom: 8 }}>
              {t('examples.installing', { done: installing.done + 1, total: installing.total })}
            </div>
            <div style={{ fontSize: 14, color: '#00e5ff', fontWeight: 600, marginBottom: 12 }}>
              {installing.current}
            </div>
            <div style={{ height: 4, borderRadius: 2, background: 'var(--wb-6)', overflow: 'hidden' }}>
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
        )}
      </div>
    </div>
  );
};
