import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { getProject } from '../services/projectService';
import { useEditorStore } from '../store/useEditorStore';
import { useSimulatorStore } from '../store/useSimulatorStore';
import { useProjectStore } from '../store/useProjectStore';
import { EditorPage } from './EditorPage';

/**
 * Legacy route: /:username/:projectName
 * Loads the project by slug then redirects to /project/:id so the canonical
 * URL is always the ID-based one.
 */
export const ProjectPage: React.FC = () => {
  const { username, projectName } = useParams<{ username: string; projectName: string }>();
  const navigate = useNavigate();
  const loadFiles = useEditorStore((s) => s.loadFiles);
  const { setComponents, setWires, setBoardType } = useSimulatorStore();
  const setCurrentProject = useProjectStore((s) => s.setCurrentProject);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!username || !projectName) return;
    getProject(username, projectName)
      .then((project) => {
        const files =
          project.files.length > 0
            ? project.files
            : [{ name: 'sketch.ino', content: project.code }];
        loadFiles(files);
        setBoardType(project.board_type as any);
        try {
          setComponents(JSON.parse(project.components_json));
          setWires(JSON.parse(project.wires_json));
        } catch {
          // keep defaults
        }
        setCurrentProject({
          id: project.id,
          slug: project.slug,
          ownerUsername: project.owner_username,
          isPublic: project.is_public,
        });
        // Redirect to canonical ID URL
        navigate(`/project/${project.id}`, { replace: true });
        setReady(true);
      })
      .catch((err) => {
        const s = err?.response?.status;
        if (s === 404) setError('Project not found.');
        else if (s === 403) setError('This project is private.');
        else setError('Failed to load project.');
      });
  }, [username, projectName]);

  if (error) {
    return (
      <div
        style={{
          minHeight: '100vh',
          background: '#1e1e1e',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <div style={{ color: '#f44747', fontSize: 16, textAlign: 'center' }}>
          <p>{error}</p>
          <button
            onClick={() => navigate('/')}
            style={{
              marginTop: 12,
              background: '#0e639c',
              border: 'none',
              color: '#fff',
              padding: '8px 16px',
              borderRadius: 4,
              cursor: 'pointer',
            }}
          >
            Go home
          </button>
        </div>
      </div>
    );
  }

  if (!ready) {
    return (
      <div
        style={{
          minHeight: '100vh',
          background: '#1e1e1e',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <p style={{ color: '#9d9d9d' }}>Loading project…</p>
      </div>
    );
  }

  return <EditorPage />;
};
