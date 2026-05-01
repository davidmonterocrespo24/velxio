import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { getProjectById } from '../services/projectService';
import { useSimulatorStore } from '../store/useSimulatorStore';
import { useProjectStore } from '../store/useProjectStore';
import { useSEO } from '../utils/useSEO';
import { EditorPage } from './EditorPage';
import type { BoardInstance, BoardKind } from '../types/board';

const DOMAIN = 'https://velxio.dev';

interface ProjectMeta {
  name: string;
  description: string;
  ownerUsername: string;
  isPublic: boolean;
}

export const ProjectByIdPage: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const loadProjectState = useSimulatorStore((s) => s.loadProjectState);
  const setCurrentProject = useProjectStore((s) => s.setCurrentProject);
  const clearCurrentProject = useProjectStore((s) => s.clearCurrentProject);
  const currentProject = useProjectStore((s) => s.currentProject);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [projectMeta, setProjectMeta] = useState<ProjectMeta | null>(null);

  // SEO: update once we have real project data; use generic noindex fallback until then.
  useSEO(
    projectMeta && projectMeta.isPublic
      ? {
          title: `${projectMeta.name} by ${projectMeta.ownerUsername} | Velxio`,
          description: projectMeta.description
            ? `${projectMeta.description} — Simulate and remix this Arduino project on Velxio.`
            : `Arduino project by ${projectMeta.ownerUsername}. View and simulate it free on Velxio.`,
          url: `${DOMAIN}/project/${id}`,
        }
      : {
          title: 'Project — Velxio Arduino Emulator',
          description:
            'View and simulate this Arduino project on Velxio — free, open-source multi-board emulator.',
          url: `${DOMAIN}/editor`,
          noindex: true,
        },
  );

  useEffect(() => {
    if (!id) return;
    // If this project is already loaded in the store (e.g. navigated here
    // right after saving) skip the fetch to avoid overwriting unsaved state.
    if (currentProject?.id === id && ready) return;

    getProjectById(id)
      .then((project) => {
        const payload = buildLoadPayload(project);
        loadProjectState(payload);
        setCurrentProject({
          id: project.id,
          slug: project.slug,
          ownerUsername: project.owner_username,
          isPublic: project.is_public,
        });
        setProjectMeta({
          name: project.name ?? 'Untitled Project',
          description: project.description ?? '',
          ownerUsername: project.owner_username ?? '',
          isPublic: project.is_public ?? false,
        });
        setReady(true);
      })
      .catch((err) => {
        const s = err?.response?.status;
        if (s === 404) setError('Project not found.');
        else if (s === 403) setError('This project is private.');
        else setError('Failed to load project.');
        clearCurrentProject();
      });
  }, [id]);

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

// ── Helpers ─────────────────────────────────────────────────────────────────

interface RawProject {
  board_type: string;
  files: { name: string; content: string }[];
  file_groups?: { groupId: string; files: { name: string; content: string }[] }[];
  boards_json?: string;
  code: string;
  components_json: string;
  wires_json: string;
}

/** Build a loadProjectState payload from a server ProjectResponse. Falls back
 *  to a single default board when the project predates multi-board persistence. */
export function buildLoadPayload(project: RawProject) {
  // Boards
  let boards: BoardInstance[] = [];
  try {
    const parsed = JSON.parse(project.boards_json || '[]');
    if (Array.isArray(parsed) && parsed.length > 0) {
      boards = parsed.map((b: Partial<BoardInstance> & { id: string; boardKind: string }) => ({
        id: b.id,
        boardKind: b.boardKind as BoardKind,
        x: b.x ?? 50,
        y: b.y ?? 50,
        running: false,
        compiledProgram: b.compiledProgram ?? null,
        serialOutput: '',
        serialBaudRate: b.serialBaudRate ?? 0,
        serialMonitorOpen: false,
        activeFileGroupId: b.activeFileGroupId ?? `group-${b.id}`,
        languageMode: b.languageMode ?? 'arduino',
      }));
    }
  } catch {
    // ignore
  }
  if (boards.length === 0) {
    // Pre-backfill project: synthesise a single board from board_type.
    const kind = (project.board_type || 'arduino-uno') as BoardKind;
    boards = [
      {
        id: kind,
        boardKind: kind,
        x: 50,
        y: 50,
        running: false,
        compiledProgram: null,
        serialOutput: '',
        serialBaudRate: 0,
        serialMonitorOpen: false,
        activeFileGroupId: `group-${kind}`,
        languageMode: 'arduino',
      },
    ];
  }

  // File groups
  const fileGroups: Record<string, { name: string; content: string }[]> = {};
  if (project.file_groups && project.file_groups.length > 0) {
    for (const g of project.file_groups) {
      fileGroups[g.groupId] = g.files.map((f) => ({ name: f.name, content: f.content }));
    }
  }
  // Ensure every board has a file group: fall back to legacy `files` for the
  // active board, or to a synthesised sketch.ino from `code`.
  for (const b of boards) {
    if (!fileGroups[b.activeFileGroupId] || fileGroups[b.activeFileGroupId].length === 0) {
      const fallback =
        project.files && project.files.length > 0
          ? project.files
          : project.code
            ? [{ name: 'sketch.ino', content: project.code }]
            : [{ name: 'sketch.ino', content: '' }];
      fileGroups[b.activeFileGroupId] = fallback.map((f) => ({
        name: f.name,
        content: f.content,
      }));
    }
  }

  // Components and wires
  let components: unknown[] = [];
  let wires: unknown[] = [];
  try {
    components = JSON.parse(project.components_json || '[]');
  } catch {
    components = [];
  }
  try {
    wires = JSON.parse(project.wires_json || '[]');
  } catch {
    wires = [];
  }

  return {
    boards,
    fileGroups,
    components: components as never[],
    wires: wires as never[],
    activeBoardId: boards[0]?.id ?? null,
  };
}
