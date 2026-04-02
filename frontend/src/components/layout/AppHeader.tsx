import { useState, useEffect } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { trackVisitGitHub, trackVisitDiscord } from '../../utils/analytics';
import { useChatStore } from '../../store/useChatStore';
import '../../components/chat/ChatWidget.css';

const GITHUB_URL = 'https://github.com/davidmonterocrespo24/velxio';
const DISCORD_URL = 'https://discord.gg/3mARjJrh4E';

interface AppHeaderProps {}

export const AppHeader: React.FC<AppHeaderProps> = () => {
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const { toggle: toggleChat, isOpen: chatOpen } = useChatStore();

  // Close mobile menu on route change
  useEffect(() => {
    setMenuOpen(false);
  }, [location.pathname]);

  const isActive = (path: string) =>
    location.pathname === path ? ' header-nav-link-active' : '';

  return (
    <header className="app-header">
      <div className="header-content">

        <div className="header-left">
          {/* Brand */}
          <div className="header-brand">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#0071e3" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="5" y="5" width="14" height="14" rx="2" />
              <rect x="9" y="9" width="6" height="6" />
              <path d="M9 1v4M15 1v4M9 19v4M15 19v4M1 9h4M1 15h4M19 9h4M19 15h4" />
            </svg>
            <Link to="/" style={{ textDecoration: 'none', color: 'inherit' }}>
              <span className="header-title">Velxio</span>
            </Link>
          </div>

          {/* Main nav links (desktop) */}
          <nav className={'header-nav-links' + (menuOpen ? ' header-nav-open' : '')}>
            <Link to="/" className={'header-nav-link' + isActive('/')}>Home</Link>
          <Link to="/docs" className={'header-nav-link' + isActive('/docs')}>Documentation</Link>
          <Link to="/examples" className={'header-nav-link' + isActive('/examples')}>Examples</Link>
          <Link to="/editor" className={'header-nav-link' + isActive('/editor')}>Editor</Link>
          <Link to="/projects" className={'header-nav-link' + isActive('/projects')}>My Projects</Link>
          <Link to="/about" className={'header-nav-link' + isActive('/about')}>About</Link>
          <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer" className="header-nav-link" onClick={trackVisitGitHub}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" style={{ flexShrink: 0 }}>
              <path d="M12 2C6.477 2 2 6.484 2 12.021c0 4.428 2.865 8.185 6.839 9.504.5.092.682-.217.682-.482 0-.237-.009-.868-.013-1.703-2.782.605-3.369-1.342-3.369-1.342-.454-1.154-1.11-1.462-1.11-1.462-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0 1 12 6.844a9.59 9.59 0 0 1 2.504.337c1.909-1.296 2.747-1.026 2.747-1.026.546 1.378.202 2.397.1 2.65.64.7 1.028 1.595 1.028 2.688 0 3.848-2.338 4.695-4.566 4.944.359.309.678.919.678 1.852 0 1.336-.012 2.415-.012 2.743 0 .267.18.578.688.48C19.138 20.203 22 16.447 22 12.021 22 6.484 17.523 2 12 2z" />
            </svg>
            GitHub
          </a>
          <a href={DISCORD_URL} target="_blank" rel="noopener noreferrer" className="header-nav-link header-nav-discord" onClick={trackVisitDiscord}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" style={{ flexShrink: 0 }}>
              <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057c.002.022.015.043.032.053a19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/>
            </svg>
            Discord
          </a>
          <button
            className={`header-ai-btn${chatOpen ? ' header-ai-btn-active' : ''}`}
            onClick={toggleChat}
            title="AI Code Generator"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 2a10 10 0 0 1 10 10c0 5.52-4.48 10-10 10S2 17.52 2 12 6.48 2 12 2z"/>
              <path d="M8 12h8M12 8v8"/>
            </svg>
            AI
          </button>
          </nav>
        </div>

        {/* Right: mobile hamburger */}
        <div className="header-right">
          <button className="header-hamburger" onClick={() => setMenuOpen((v) => !v)} aria-label="Toggle menu">
            <span />
            <span />
            <span />
          </button>
        </div>

      </div>
    </header>
  );
};
