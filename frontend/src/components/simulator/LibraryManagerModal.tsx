import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  searchLibraries,
  installLibrary,
  getInstalledLibraries,
  uninstallLibrary,
} from '../../services/libraryService';
import type { ArduinoLibrary, InstalledLibrary } from '../../services/libraryService';
import { trackInstallLibrary } from '../../utils/analytics';
import './LibraryManagerModal.css';

interface LibraryManagerModalProps {
  isOpen: boolean;
  onClose: () => void;
}

type Tab = 'search' | 'installed';

export const LibraryManagerModal: React.FC<LibraryManagerModalProps> = ({ isOpen, onClose }) => {
  const [activeTab, setActiveTab] = useState<Tab>('search');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<ArduinoLibrary[]>([]);
  const [installedLibraries, setInstalledLibraries] = useState<InstalledLibrary[]>([]);
  const [loadingSearch, setLoadingSearch] = useState(false);
  const [loadingInstalled, setLoadingInstalled] = useState(false);
  const [installingLib, setInstallingLib] = useState<string | null>(null);
  const [uninstallingLib, setUninstallingLib] = useState<string | null>(null);
  /** Track user-selected version per library name */
  const [selectedVersions, setSelectedVersions] = useState<Record<string, string>>({});
  const [statusMsg, setStatusMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(
    null,
  );
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchInstalled = useCallback(async () => {
    setLoadingInstalled(true);
    try {
      const libs = await getInstalledLibraries();
      setInstalledLibraries(libs);
    } catch (e: unknown) {
      setStatusMsg({
        type: 'error',
        text: e instanceof Error ? e.message : 'Failed to load installed libraries',
      });
    } finally {
      setLoadingInstalled(false);
    }
  }, []);

  // Reset state when modal closes
  useEffect(() => {
    if (!isOpen) {
      setSearchQuery('');
      setSearchResults([]);
      setStatusMsg(null);
    }
  }, [isOpen]);

  // Fetch installed list when modal opens or switching to installed tab
  useEffect(() => {
    if (isOpen && activeTab === 'installed') fetchInstalled();
  }, [isOpen, activeTab, fetchInstalled]);

  useEffect(() => {
    if (isOpen) fetchInstalled();
  }, [isOpen, fetchInstalled]);

  // Search: immediate on open (empty query), debounced when typing
  useEffect(() => {
    if (!isOpen) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const delay = searchQuery ? 400 : 0;
    debounceRef.current = setTimeout(async () => {
      setLoadingSearch(true);
      setStatusMsg(null);
      try {
        const results = await searchLibraries(searchQuery);
        setSearchResults(results);
      } catch (e: unknown) {
        setStatusMsg({ type: 'error', text: e instanceof Error ? e.message : 'Search failed' });
        setSearchResults([]);
      } finally {
        setLoadingSearch(false);
      }
    }, delay);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [searchQuery, isOpen]);

  const handleInstall = async (libName: string) => {
    setInstallingLib(libName);
    setStatusMsg(null);
    try {
      const version = selectedVersions[libName];
      const result = await installLibrary(libName, version);
      if (result.success) {
        trackInstallLibrary(libName);
        if (result.fallback) {
          setStatusMsg({ type: 'success', text: `"${libName}" installed (latest — requested @${result.requested_version} was not available)` });
        } else {
          setStatusMsg({ type: 'success', text: `"${libName}${version ? ' @' + version : ''}" installed successfully!` });
        }
        fetchInstalled();
      } else {
        setStatusMsg({ type: 'error', text: result.error || `Failed to install "${libName}"` });
      }
    } catch (e: unknown) {
      setStatusMsg({ type: 'error', text: e instanceof Error ? e.message : 'Installation failed' });
    } finally {
      setInstallingLib(null);
    }
  };

  const handleUninstall = async (libName: string) => {
    setUninstallingLib(libName);
    setStatusMsg(null);
    try {
      const result = await uninstallLibrary(libName);
      if (result.success) {
        setStatusMsg({ type: 'success', text: `"${libName}" uninstalled successfully!` });
        fetchInstalled();
      } else {
        setStatusMsg({ type: 'error', text: result.error || `Failed to uninstall "${libName}"` });
      }
    } catch (e: unknown) {
      setStatusMsg({ type: 'error', text: e instanceof Error ? e.message : 'Uninstall failed' });
    } finally {
      setUninstallingLib(null);
    }
  };

  const handleClose = () => {
    onClose();
  };

  if (!isOpen) return null;

  const isInstalled = (libName: string): boolean =>
    installedLibraries.some(
      (il) => (il.library?.name || il.name || '').toLowerCase() === libName.toLowerCase(),
    );

  const getLibName = (lib: ArduinoLibrary): string => lib.name || 'Unknown';
  const getLibVersion = (lib: ArduinoLibrary): string => lib.latest?.version || lib.version || '';
  const getLibAuthor = (lib: ArduinoLibrary): string => lib.latest?.author || lib.author || '';
  const getLibDesc = (lib: ArduinoLibrary): string => lib.latest?.sentence || lib.sentence || '';

  const getInstalledName = (lib: InstalledLibrary): string =>
    lib.library?.name || lib.name || 'Unknown';
  const getInstalledVersion = (lib: InstalledLibrary): string =>
    lib.library?.version || lib.version || '';
  const getInstalledAuthor = (lib: InstalledLibrary): string =>
    lib.library?.author || lib.author || '';
  const getInstalledDesc = (lib: InstalledLibrary): string =>
    lib.library?.sentence || lib.sentence || '';

  return (
    <div className="lib-modal-overlay" onClick={handleClose}>
      <div className="lib-modal" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="lib-modal-header">
          <div className="lib-modal-title">
            <svg
              className="lib-icon"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" />
              <path d="m3.3 7 8.7 5 8.7-5" />
              <path d="M12 22V12" />
            </svg>
            <span>LIBRARY MANAGER</span>
          </div>
          <button className="lib-close-btn" onClick={handleClose}>
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Tabs */}
        <div className="lib-tabs">
          <button
            className={`lib-tab ${activeTab === 'search' ? 'active' : ''}`}
            onClick={() => setActiveTab('search')}
          >
            Search
          </button>
          <button
            className={`lib-tab ${activeTab === 'installed' ? 'active' : ''}`}
            onClick={() => setActiveTab('installed')}
          >
            Installed
          </button>
        </div>

        {/* Status bar */}
        {statusMsg && (
          <div className={`lib-status ${statusMsg.type}`}>
            {statusMsg.type === 'success' ? (
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{ flexShrink: 0 }}
              >
                <polyline points="20 6 9 17 4 12" />
              </svg>
            ) : (
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{ flexShrink: 0 }}
              >
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            )}
            {statusMsg.text}
          </div>
        )}

        {/* Search Tab */}
        {activeTab === 'search' && (
          <div className="lib-content">
            <div className="lib-search-bar">
              <svg
                className="lib-search-icon"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="11" cy="11" r="8" />
                <path d="m21 21-4.3-4.3" />
              </svg>
              <input
                type="text"
                placeholder="Filter your search..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                autoFocus
              />
              {loadingSearch && (
                <svg
                  className="lib-spinner"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                >
                  <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                </svg>
              )}
            </div>

            <div className="lib-list">
              {loadingSearch && (
                <div className="lib-empty">
                  <svg
                    className="lib-spinner lib-spinner-center"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                  >
                    <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                  </svg>
                  <p className="lib-empty-sub">
                    {searchQuery ? `Searching "${searchQuery}"…` : 'Loading libraries…'}
                  </p>
                </div>
              )}
              {!loadingSearch && searchResults.length === 0 && (
                <div className="lib-empty">
                  <p>
                    {searchQuery
                      ? `No libraries found for "${searchQuery}"`
                      : 'No libraries available'}
                  </p>
                </div>
              )}
              {!loadingSearch &&
                searchResults.map((lib, i) => (
                  <div key={i} className="lib-item">
                    <div className="lib-item-info">
                      <div className="lib-item-header">
                        <span className="lib-item-name">{getLibName(lib)}</span>
                        {getLibAuthor(lib) && (
                          <span className="lib-item-author">by {getLibAuthor(lib)}</span>
                        )}
                      </div>
                      {getLibDesc(lib) && <p className="lib-item-desc">{getLibDesc(lib)}</p>}
                    </div>
                    <div className="lib-item-actions">
                      {isInstalled(getLibName(lib)) ? (
                        <>
                          <span className="lib-item-version lib-installed-badge">
                            {selectedVersions[lib.name] ?? lib.latest?.version ?? ''}
                            <svg style={{ display: 'inline', marginLeft: '4px', verticalAlign: 'middle' }} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
                          </span>
                          <button
                            className="lib-uninstall-btn"
                            onClick={() => handleUninstall(getLibName(lib))}
                            disabled={uninstallingLib !== null}
                          >
                            {uninstallingLib === getLibName(lib) ? 'Uninstalling...' : 'UNINSTALL'}
                          </button>
                        </>
                      ) : (
                        <>
                          {lib.releases && Object.keys(lib.releases).length > 1 && (
                            <select
                              className="lib-version-select"
                              value={selectedVersions[lib.name] ?? lib.latest?.version ?? ''}
                              onChange={(e) => setSelectedVersions((prev) => ({ ...prev, [lib.name]: e.target.value }))}
                            >
                              {Object.entries(lib.releases).map(([ver]) => (
                                <option key={ver} value={ver}>{ver}</option>
                              ))}
                            </select>
                          )}
                          <button
                            className="lib-install-btn"
                            onClick={() => handleInstall(getLibName(lib))}
                            disabled={installingLib !== null}
                          >
                            {installingLib === getLibName(lib) ? (
                              <span className="lib-installing">Installing...</span>
                            ) : (
                              'INSTALL'
                            )}
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                ))}
            </div>
          </div>
        )}

        {/* Installed Tab */}
        {activeTab === 'installed' && (
          <div className="lib-content">
            <div className="lib-list">
              {loadingInstalled && (
                <div className="lib-empty">
                  <p>Loading installed libraries...</p>
                </div>
              )}
              {!loadingInstalled && installedLibraries.length === 0 && (
                <div className="lib-empty">
                  <p>No libraries installed yet.</p>
                  <p className="lib-empty-sub">Use the Search tab to install libraries.</p>
                </div>
              )}
              {installedLibraries.map((lib, i) => (
                <div key={i} className="lib-item">
                  <div className="lib-item-info">
                    <div className="lib-item-header">
                      <span className="lib-item-name">{getInstalledName(lib)}</span>
                      {getInstalledAuthor(lib) && (
                        <span className="lib-item-author">by {getInstalledAuthor(lib)}</span>
                      )}
                    </div>
                    {getInstalledDesc(lib) && (
                      <p className="lib-item-desc">{getInstalledDesc(lib)}</p>
                    )}
                  </div>
                  <div className="lib-item-actions">
                    {getInstalledVersion(lib) && (
                      <span className="lib-item-version lib-installed-badge">
                        {getInstalledVersion(lib)}
                        <svg
                          style={{ display: 'inline', marginLeft: '4px', verticalAlign: 'middle' }}
                          width="12"
                          height="12"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="3"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <polyline points="20 6 9 17 4 12" />
                        </svg>
                      </span>
                    )}
                    <button
                      className="lib-uninstall-btn"
                      onClick={() => handleUninstall(getInstalledName(lib))}
                      disabled={uninstallingLib !== null}
                    >
                      {uninstallingLib === getInstalledName(lib) ? 'Uninstalling...' : 'UNINSTALL'}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
