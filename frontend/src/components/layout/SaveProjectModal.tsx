import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useEditorStore } from '../../store/useEditorStore';
import { useSimulatorStore } from '../../store/useSimulatorStore';
import { useProjectStore } from '../../store/useProjectStore';
import { createProject, updateProject } from '../../services/projectService';
import { trackCreateProject } from '../../utils/analytics';

interface SaveProjectModalProps {
  onClose: () => void;
}

export const SaveProjectModal: React.FC<SaveProjectModalProps> = ({ onClose }) => {
  const navigate = useNavigate();
  const files = useEditorStore((s) => s.files);
  // Legacy: save primary .ino content for the project code field
  const code = files.find((f) => f.name === 'sketch.ino')?.content ?? files[0]?.content ?? '';
  const { boardType, components, wires } = useSimulatorStore();
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
    if (!name.trim()) { setError('Project name is required.'); return; }
    setSaving(true);
    setError('');

    const payload = {
      name: name.trim(),
      description: description.trim() || undefined,
      is_public: isPublic,
      board_type: boardType,
      files: files.map((f) => ({ name: f.name, content: f.content })),
      code,
      components_json: JSON.stringify(components),
      wires_json: JSON.stringify(wires),
    };

    try {
      let saved;
      if (isUpdate && currentProject) {
        saved = await updateProject(currentProject.id, payload);
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
      setError(err?.response?.data?.detail || 'Save failed.');
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

          <label style={styles.checkboxRow}>
            <input
              type="checkbox"
              checked={isPublic}
              onChange={(e) => setIsPublic(e.target.checked)}
            />
            <span style={{ color: '#ccc', fontSize: 13 }}>Public</span>
          </label>

          <div style={styles.actions}>
            <button type="submit" disabled={saving} style={styles.saveBtn}>
              {saving ? 'Saving…' : isUpdate ? 'Update' : 'Save'}
            </button>
            <button type="button" onClick={onClose} style={styles.cancelBtn}>Cancel</button>
          </div>
        </form>
      </div>
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 },
  modal: { background: '#252526', border: '1px solid #3c3c3c', borderRadius: 8, padding: '1.75rem', width: 380, display: 'flex', flexDirection: 'column', gap: 14 },
  title: { color: '#ccc', margin: 0, fontSize: 18, fontWeight: 600 },
  form: { display: 'flex', flexDirection: 'column', gap: 10 },
  label: { color: '#9d9d9d', fontSize: 13 },
  input: { background: '#3c3c3c', border: '1px solid #555', borderRadius: 4, padding: '8px 10px', color: '#ccc', fontSize: 14, outline: 'none' },
  checkboxRow: { display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' },
  actions: { display: 'flex', gap: 8, marginTop: 4 },
  saveBtn: { flex: 1, background: '#0e639c', border: 'none', borderRadius: 4, color: '#fff', padding: '9px', fontSize: 14, cursor: 'pointer', fontWeight: 500 },
  cancelBtn: { background: 'transparent', border: '1px solid #555', borderRadius: 4, color: '#ccc', padding: '9px 16px', fontSize: 14, cursor: 'pointer' },
  error: { background: '#5a1d1d', border: '1px solid #f44747', borderRadius: 4, color: '#f44747', padding: '8px 12px', fontSize: 13 },
};
