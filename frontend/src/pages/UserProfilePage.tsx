import { useEffect, useState, useCallback } from 'react';
import { Link, useParams } from 'react-router-dom';
import { getUserProjects, type ProjectResponse } from '../services/projectService';
import { useAuthStore } from '../store/useAuthStore';
import { AppHeader } from '../components/layout/AppHeader';
import { useSEO } from '../utils/useSEO';
import './UserProfilePage.css';

export const UserProfilePage: React.FC = () => {
  const { username } = useParams<{ username: string }>();

  useSEO({
    title: `${username ?? 'User'} — Velxio Profile`,
    description: `View Arduino and ESP32 projects by ${username ?? 'this user'} on Velxio.`,
    url: `https://velxio.dev/${username ?? ''}`,
    noindex: true,
  });
  const user = useAuthStore((s) => s.user);
  const [projects, setProjects] = useState<ProjectResponse[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!username) return;
    setLoading(true);
    getUserProjects(username)
      .then(setProjects)
      .catch(() => setError('User not found.'))
      .finally(() => setLoading(false));
  }, [username]);

  const isOwn = user?.username === username;
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const handleCopyLink = useCallback((e: React.MouseEvent, projectId: string) => {
    e.preventDefault(); // Don't navigate via the <Link>
    e.stopPropagation();
    const url = `${window.location.origin}/project/${projectId}`;
    navigator.clipboard.writeText(url).then(() => {
      setCopiedId(projectId);
      setTimeout(() => setCopiedId(null), 2000);
    });
  }, []);

  return (
    <div className="profile-page">
      <AppHeader />
      <div className="profile-container">
        <div className="profile-header">
          <div className="profile-avatar">{username?.[0]?.toUpperCase()}</div>
          <h1 className="profile-username">{username}</h1>
          {isOwn && (
            <Link to="/editor" className="profile-new-btn">+ New project</Link>
          )}
        </div>

        {loading && <p className="profile-muted">Loading…</p>}
        {error && <p className="profile-error">{error}</p>}
        {!loading && !error && projects.length === 0 && (
          <p className="profile-muted">No public projects yet.</p>
        )}

        <div className="profile-grid">
          {projects.map((p) => (
            <Link key={p.id} to={`/${username}/${p.slug}`} className="profile-card">
              <div className="profile-card-title">{p.name}</div>
              {p.description && <div className="profile-card-desc">{p.description}</div>}
              <div className="profile-card-meta">
                <span className="profile-badge">{p.board_type}</span>
                {!p.is_public && <span className="profile-badge profile-badge-private">Private</span>}
                <span className="profile-date">{new Date(p.updated_at).toLocaleDateString()}</span>
                {p.is_public && (
                  <button
                    className="profile-share-btn"
                    onClick={(e) => handleCopyLink(e, p.id)}
                    title="Copy shareable link"
                  >
                    {copiedId === p.id ? (
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#4ade80" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    ) : (
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                        <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                      </svg>
                    )}
                  </button>
                )}
              </div>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
};
