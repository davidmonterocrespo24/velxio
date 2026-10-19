import React from 'react';
import { useTranslation } from 'react-i18next';
import './GitHubStarBanner.css';

const GITHUB_URL = 'https://github.com/davidmonterocrespo24/velxio';

interface Props {
  onClose: () => void;
  // Fired when the user clicks through to the repo (distinct from a plain
  // dismiss) — lets the caller never prompt that user again.
  onStarClick: () => void;
  // 1 = first ask; 2 = follow-up ask for someone who dismissed the first one.
  round?: 1 | 2;
}

export const GitHubStarBanner: React.FC<Props> = ({ onClose, onStarClick, round = 1 }) => {
  const { t } = useTranslation();
  const titleKey = round === 2 ? 'starBanner.title2' : 'starBanner.title';
  const bodyKey = round === 2 ? 'starBanner.body2' : 'starBanner.body';
  return (
    <div className="gh-star-banner" role="dialog" aria-label={t('starBanner.ariaLabel')}>
      <div className="gh-star-banner__icon">
        <svg width="30" height="30" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z" />
        </svg>
      </div>

      <div className="gh-star-banner__body">
        <strong>{t(titleKey)}</strong>
        <p>{t(bodyKey)}</p>
        <a
          href={GITHUB_URL}
          target="_blank"
          // No noreferrer: GitHub's traffic page counts these visits by
          // referrer, and without it every click shows up as "direct".
          rel="noopener"
          className="gh-star-banner__btn"
          onClick={onStarClick}
        >
          ⭐ {t('starBanner.cta')}
        </a>
      </div>

      <button className="gh-star-banner__close" onClick={onClose} aria-label={t('starBanner.dismiss')}>
        ✕
      </button>
    </div>
  );
};
