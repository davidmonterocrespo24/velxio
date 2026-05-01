import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useProjectStore } from '../../store/useProjectStore';
import { createProject, updateProject } from '../../services/projectService';
import { trackCreateProject, trackSaveProject } from '../../utils/analytics';
import { buildSavePayload } from '../../utils/projectPayload';

interface SaveProjectModalProps {
  onClose: () => void;
}

export const SaveProjectModal: React.FC<SaveProjectModalProps> = ({ onClose }) => {
  const navigate = useNavigate();
  const currentProject = useProjectStore((s) => s.currentProject);
  const setCurrentProject = useProjectStore((s) => s.setCurrentProject);

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [isPublic, setIsPublic] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const isUpdate = !!currentProject;

  useEffect(() => {
    if (isUpdate) {
      setName(currentProject.slug); // will be overridden if we load proper name
      setIsPublic(currentProject.isPublic);
    }
  }, [isUpdate]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setError('Project name is required.');
      return;
    }
    setSaving(true);
    setError('');

    const payload = buildSavePayload({
      name: name.trim(),
      description: description.trim() || undefined,
      isPublic,
    });

    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const isValidUpdate = isUpdate && currentProject && UUID_RE.test(currentProject.id);

    try {
      let saved;
      if (isValidUpdate) {
        saved = await updateProject(currentProject!.id, payload);
        trackSaveProject();
      } else {
        saved = await createProject(payload);
        trackCreateProject();
      }

      setCurrentProject({
        id: saved.id,
        slug: saved.slug,
        ownerUsername: saved.owner_username,
        isPublic: saved.is_public,
      });
      navigate(`/project/${saved.id}`, { replace: true });
      onClose();
    } catch (err: any) {
      if (!err?.response) {
        setError('Server unreachable. Check your connection and try again.');
      } else if (err.response.status === 401) {
        setError('Not authenticated. Please log in and try again.');
      } else {
        setError(err.response?.data?.detail || `Save failed (${err.response.status}).`);
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={styles.overlay} onClick={onClose}>
      <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
        <h2 style={styles.title}>{isUpdate ? 'Update project' : 'Save project'}</h2>

        {error && <div style={styles.error}>{error}</div>}

        <form onSubmit={handleSave} style={styles.form}>
          <label style={styles.label}>Project name *</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            style={styles.input}
            autoFocus
            placeholder="My awesome project"
          />

          <label style={styles.label}>Description</label>
          <input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            style={styles.input}
            placeholder="Optional"
          />

          <div
            style={styles.visibilityToggle}
            onClick={() => setIsPublic(!isPublic)}
            role="button"
            tabIndex={0}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {isPublic ? (
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="#4ade80"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <circle cx="12" cy="12" r="10" />
                  <line x1="2" y1="12" x2="22" y2="12" />
                  <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
                </svg>
              ) : (
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="#f59e0b"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                  <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                </svg>
              )}
              <div>
                <div
                  style={{ color: isPublic ? '#4ade80' : '#f59e0b', fontSize: 13, fontWeight: 600 }}
                >
                  {isPublic ? 'Public' : 'Private'}
                </div>
                <div style={{ color: '#888', fontSize: 11 }}>
                  {isPublic ? 'Anyone with the link can view' : 'Only you can see this'}
                </div>
              </div>
            </div>
          </div>

          <div style={styles.actions}>
            <button type="submit" disabled={saving} style={styles.saveBtn}>
              {saving ? 'Saving…' : isUpdate ? 'Update' : 'Save'}
            </button>
            <button type="button" onClick={onClose} style={styles.cancelBtn}>
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0,0,0,.6)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000,
  },
  modal: {
    background: '#252526',
    border: '1px solid #3c3c3c',
    borderRadius: 8,
    padding: '1.75rem',
    width: 380,
    display: 'flex',
    flexDirection: 'column',
    gap: 14,
  },
  title: { color: '#ccc', margin: 0, fontSize: 18, fontWeight: 600 },
  form: { display: 'flex', flexDirection: 'column', gap: 10 },
  label: { color: '#9d9d9d', fontSize: 13 },
  input: {
    background: '#3c3c3c',
    border: '1px solid #555',
    borderRadius: 4,
    padding: '8px 10px',
    color: '#ccc',
    fontSize: 14,
    outline: 'none',
  },
  checkboxRow: { display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' },
  visibilityToggle: {
    display: 'flex',
    alignItems: 'center',
    padding: '8px 10px',
    background: '#1e1e1e',
    border: '1px solid #444',
    borderRadius: 6,
    cursor: 'pointer',
    transition: 'border-color 0.15s',
  },
  actions: { display: 'flex', gap: 8, marginTop: 4 },
  saveBtn: {
    flex: 1,
    background: '#0e639c',
    border: 'none',
    borderRadius: 4,
    color: '#fff',
    padding: '9px',
    fontSize: 14,
    cursor: 'pointer',
    fontWeight: 500,
  },
  cancelBtn: {
    background: 'transparent',
    border: '1px solid #555',
    borderRadius: 4,
    color: '#ccc',
    padding: '9px 16px',
    fontSize: 14,
    cursor: 'pointer',
  },
  error: {
    background: '#5a1d1d',
    border: '1px solid #f44747',
    borderRadius: 4,
    color: '#f44747',
    padding: '8px 12px',
    fontSize: 13,
  },
};
