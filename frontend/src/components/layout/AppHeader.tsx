import { useState, useRef, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuthStore } from '../../store/useAuthStore';
import { trackVisitGitHub } from '../../utils/analytics';

interface AppHeaderProps {}

export const AppHeader: React.FC<AppHeaderProps> = () => {
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const navigate = useNavigate();
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const handleLogout = async () => {
    setDropdownOpen(false);
    await logout();
    navigate('/');
  };

  return (
    <header className="app-header">
      <div className="header-content">
        <div className="header-brand">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#007acc" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="5" y="5" width="14" height="14" rx="2" />
            <rect x="9" y="9" width="6" height="6" />
            <path d="M9 1v4M15 1v4M9 19v4M15 19v4M1 9h4M1 15h4M19 9h4M19 15h4" />
          </svg>
          <Link to="/" style={{ textDecoration: 'none', color: 'inherit' }}>
            <span className="header-title">Velxio</span>
          </Link>
        </div>

        <Link to="/examples" className="examples-link" title="Browse Examples">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
            <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
          </svg>
          <span>Examples</span>
        </Link>

        <a
          href="https://github.com/davidmonterocrespo24/velxio"
          target="_blank"
          rel="noopener noreferrer"
          title="GitHub — Velxio"
          onClick={trackVisitGitHub}
          style={{ display: 'flex', alignItems: 'center', gap: 5, color: '#ccc', textDecoration: 'none', fontSize: 13 }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 2C6.477 2 2 6.484 2 12.021c0 4.428 2.865 8.185 6.839 9.504.5.092.682-.217.682-.482 0-.237-.009-.868-.013-1.703-2.782.605-3.369-1.342-3.369-1.342-.454-1.154-1.11-1.462-1.11-1.462-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0 1 12 6.844a9.59 9.59 0 0 1 2.504.337c1.909-1.296 2.747-1.026 2.747-1.026.546 1.378.202 2.397.1 2.65.64.7 1.028 1.595 1.028 2.688 0 3.848-2.338 4.695-4.566 4.944.359.309.678.919.678 1.852 0 1.336-.012 2.415-.012 2.743 0 .267.18.578.688.48C19.138 20.203 22 16.447 22 12.021 22 6.484 17.523 2 12 2z" />
          </svg>
          <span className="header-github-text">GitHub</span>
        </a>

        {/* Auth UI */}
        {user ? (
          <div style={{ position: 'relative' }} ref={dropdownRef}>
            <button
              onClick={() => setDropdownOpen((v) => !v)}
              style={{ background: 'transparent', border: '1px solid #555', borderRadius: 20, padding: '3px 10px 3px 6px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, color: '#ccc', fontSize: 13 }}
            >
              {user.avatar_url ? (
                <img src={user.avatar_url} alt="" style={{ width: 22, height: 22, borderRadius: '50%' }} />
              ) : (
                <div style={{ width: 22, height: 22, borderRadius: '50%', background: '#0e639c', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, color: '#fff', fontWeight: 600 }}>
                  {user.username[0].toUpperCase()}
                </div>
              )}
              <span className="header-username-text">{user.username}</span>
            </button>

            {dropdownOpen && (
              <div style={{ position: 'absolute', right: 0, top: '110%', background: '#252526', border: '1px solid #3c3c3c', borderRadius: 6, minWidth: 150, zIndex: 100, boxShadow: '0 4px 12px rgba(0,0,0,.4)' }}>
                <Link
                  to={`/${user.username}`}
                  onClick={() => setDropdownOpen(false)}
                  style={{ display: 'block', padding: '9px 14px', color: '#ccc', textDecoration: 'none', fontSize: 13 }}
                >
                  My projects
                </Link>
                <div style={{ borderTop: '1px solid #3c3c3c' }} />
                <button
                  onClick={handleLogout}
                  style={{ width: '100%', background: 'none', border: 'none', padding: '9px 14px', color: '#ccc', textAlign: 'left', cursor: 'pointer', fontSize: 13 }}
                >
                  Sign out
                </button>
              </div>
            )}
          </div>
        ) : (
          <div style={{ display: 'flex', gap: 8 }}>
            <Link to="/login" style={{ color: '#ccc', padding: '4px 10px', fontSize: 13, textDecoration: 'none', border: '1px solid #555', borderRadius: 4 }}>
              Sign in
            </Link>
            <Link to="/register" style={{ color: '#fff', padding: '4px 10px', fontSize: 13, textDecoration: 'none', background: '#0e639c', borderRadius: 4 }}>
              Sign up
            </Link>
          </div>
        )}
      </div>
    </header>
  );
};
