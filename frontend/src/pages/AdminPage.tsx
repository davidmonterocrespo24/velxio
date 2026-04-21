import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuthStore } from '../store/useAuthStore';
import { useSEO } from '../utils/useSEO';
import {
  getAdminSetupStatus,
  createFirstAdmin,
  adminListUsers,
  adminUpdateUser,
  adminDeleteUser,
  adminListProjects,
  adminDeleteProject,
  type AdminUserResponse,
  type AdminProjectResponse,
  type AdminUserUpdateRequest,
} from '../services/adminService';

type Tab = 'users' | 'projects';

// ── Edit User Modal ───────────────────────────────────────────────────────────

function EditUserModal({
  user,
  onClose,
  onSave,
}: {
  user: AdminUserResponse;
  onClose: () => void;
  onSave: (id: string, body: AdminUserUpdateRequest) => Promise<void>;
}) {
  const [username, setUsername] = useState(user.username);
  const [email, setEmail] = useState(user.email);
  const [password, setPassword] = useState('');
  const [isAdmin, setIsAdmin] = useState(user.is_admin);
  const [isActive, setIsActive] = useState(user.is_active);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const handleSave = async () => {
    setSaving(true);
    setError('');
    const body: AdminUserUpdateRequest = {};
    if (username !== user.username) body.username = username;
    if (email !== user.email) body.email = email;
    if (password) body.password = password;
    if (isAdmin !== user.is_admin) body.is_admin = isAdmin;
    if (isActive !== user.is_active) body.is_active = isActive;
    try {
      await onSave(user.id, body);
      onClose();
    } catch (err: any) {
      setError(err?.response?.data?.detail || 'Failed to save.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={modalStyles.overlay} onClick={onClose}>
      <div style={modalStyles.box} onClick={(e) => e.stopPropagation()}>
        <h2 style={modalStyles.title}>Edit user</h2>
        {error && <div style={modalStyles.error}>{error}</div>}

        <label style={modalStyles.label}>Username</label>
        <input
          style={modalStyles.input}
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />

        <label style={modalStyles.label}>Email</label>
        <input style={modalStyles.input} value={email} onChange={(e) => setEmail(e.target.value)} />

        <label style={modalStyles.label}>New password (leave blank to keep)</label>
        <input
          style={modalStyles.input}
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Min. 8 characters"
        />

        <div style={modalStyles.checkRow}>
          <input
            id="is_admin"
            type="checkbox"
            checked={isAdmin}
            onChange={(e) => setIsAdmin(e.target.checked)}
          />
          <label htmlFor="is_admin" style={modalStyles.checkLabel}>
            Admin
          </label>
        </div>

        <div style={modalStyles.checkRow}>
          <input
            id="is_active"
            type="checkbox"
            checked={isActive}
            onChange={(e) => setIsActive(e.target.checked)}
          />
          <label htmlFor="is_active" style={modalStyles.checkLabel}>
            Active
          </label>
        </div>

        <div style={modalStyles.actions}>
          <button style={modalStyles.cancelBtn} onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button style={modalStyles.saveBtn} onClick={handleSave} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

const modalStyles: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0,0,0,0.6)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 100,
  },
  box: {
    background: '#252526',
    border: '1px solid #3c3c3c',
    borderRadius: 8,
    padding: '1.5rem',
    width: 400,
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
  },
  title: { color: '#ccc', margin: 0, fontSize: 18, fontWeight: 600 },
  label: { color: '#9d9d9d', fontSize: 13 },
  input: {
    background: '#3c3c3c',
    border: '1px solid #555',
    borderRadius: 4,
    padding: '7px 10px',
    color: '#ccc',
    fontSize: 14,
    outline: 'none',
  },
  checkRow: { display: 'flex', alignItems: 'center', gap: 8 },
  checkLabel: { color: '#ccc', fontSize: 14 },
  actions: { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 },
  cancelBtn: {
    background: '#3c3c3c',
    border: 'none',
    borderRadius: 4,
    color: '#ccc',
    padding: '7px 16px',
    fontSize: 14,
    cursor: 'pointer',
  },
  saveBtn: {
    background: '#0e639c',
    border: 'none',
    borderRadius: 4,
    color: '#fff',
    padding: '7px 16px',
    fontSize: 14,
    cursor: 'pointer',
  },
  error: {
    background: '#5a1d1d',
    border: '1px solid #f44747',
    borderRadius: 4,
    color: '#f44747',
    padding: '7px 12px',
    fontSize: 13,
  },
};

// ── Setup screen ──────────────────────────────────────────────────────────────

function SetupScreen({ onDone }: { onDone: () => void }) {
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }
    setLoading(true);
    try {
      await createFirstAdmin(username, email, password);
      onDone();
      navigate('/login?redirect=/admin');
    } catch (err: any) {
      setError(err?.response?.data?.detail || 'Failed to create admin.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={s.page}>
      <div style={s.card}>
        <h1 style={s.cardTitle}>Admin setup</h1>
        <p style={s.muted}>No admin account exists yet. Create the first admin user to proceed.</p>
        {error && <div style={s.error}>{error}</div>}
        <form onSubmit={handleCreate} style={s.form}>
          <label style={s.label}>Username</label>
          <input
            style={s.input}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
            autoFocus
            placeholder="admin"
          />
          <label style={s.label}>Email</label>
          <input
            style={s.input}
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            placeholder="admin@example.com"
          />
          <label style={s.label}>Password</label>
          <input
            style={s.input}
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            placeholder="Min. 8 characters"
          />
          <label style={s.label}>Confirm password</label>
          <input
            style={s.input}
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            required
          />
          <button type="submit" disabled={loading} style={s.primaryBtn}>
            {loading ? 'Creating…' : 'Create admin'}
          </button>
        </form>
      </div>
    </div>
  );
}

// ── Not-admin screen ──────────────────────────────────────────────────────────

function NotAdminScreen() {
  return (
    <div style={s.page}>
      <div style={s.card}>
        <h1 style={s.cardTitle}>Admin access required</h1>
        <p style={s.muted}>You must be logged in as an admin to access this panel.</p>
        <Link to="/login?redirect=/admin" style={s.primaryBtn}>
          Go to login
        </Link>
      </div>
    </div>
  );
}

// ── Users tab ─────────────────────────────────────────────────────────────────

function UsersTab({ currentUserId }: { currentUserId: string }) {
  const [users, setUsers] = useState<AdminUserResponse[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [editUser, setEditUser] = useState<AdminUserResponse | null>(null);
  const [error, setError] = useState('');

  const load = () => {
    setLoading(true);
    adminListUsers()
      .then(setUsers)
      .catch(() => setError('Failed to load users.'))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  const handleSave = async (id: string, body: AdminUserUpdateRequest) => {
    const updated = await adminUpdateUser(id, body);
    setUsers((prev) => prev.map((u) => (u.id === id ? updated : u)));
  };

  const handleDelete = async (user: AdminUserResponse) => {
    if (!confirm(`Delete user "${user.username}" and all their projects? This cannot be undone.`))
      return;
    try {
      await adminDeleteUser(user.id);
      setUsers((prev) => prev.filter((u) => u.id !== user.id));
    } catch (err: any) {
      alert(err?.response?.data?.detail || 'Failed to delete user.');
    }
  };

  const filtered = users.filter(
    (u) =>
      u.username.toLowerCase().includes(search.toLowerCase()) ||
      u.email.toLowerCase().includes(search.toLowerCase()),
  );

  return (
    <div style={s.tabContent}>
      {error && <div style={s.error}>{error}</div>}
      <div style={s.searchRow}>
        <input
          style={s.searchInput}
          placeholder="Search by username or email…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <span style={s.muted}>
          {filtered.length} user{filtered.length !== 1 ? 's' : ''}
        </span>
      </div>

      {loading ? (
        <p style={s.muted}>Loading…</p>
      ) : (
        <div style={s.tableWrap}>
          <table style={s.table}>
            <thead>
              <tr>
                <th style={s.th}>Username</th>
                <th style={s.th}>Email</th>
                <th style={s.th}>Role</th>
                <th style={s.th}>Status</th>
                <th style={s.th}>Projects</th>
                <th style={s.th}>Joined</th>
                <th style={s.th}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((u) => (
                <tr key={u.id} style={s.tr}>
                  <td style={s.td}>
                    <span style={s.username}>{u.username}</span>
                    {u.id === currentUserId && <span style={s.youBadge}>you</span>}
                  </td>
                  <td style={s.td}>{u.email}</td>
                  <td style={s.td}>
                    <span style={u.is_admin ? s.adminBadge : s.userBadge}>
                      {u.is_admin ? 'admin' : 'user'}
                    </span>
                  </td>
                  <td style={s.td}>
                    <span style={u.is_active ? s.activeBadge : s.inactiveBadge}>
                      {u.is_active ? 'active' : 'disabled'}
                    </span>
                  </td>
                  <td style={s.td}>{u.project_count}</td>
                  <td style={s.td}>{new Date(u.created_at).toLocaleDateString()}</td>
                  <td style={s.td}>
                    <button style={s.editBtn} onClick={() => setEditUser(u)}>
                      Edit
                    </button>
                    {u.id !== currentUserId && (
                      <button style={s.deleteBtn} onClick={() => handleDelete(u)}>
                        Delete
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={7} style={{ ...s.td, textAlign: 'center', color: '#666' }}>
                    No users found.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {editUser && (
        <EditUserModal user={editUser} onClose={() => setEditUser(null)} onSave={handleSave} />
      )}
    </div>
  );
}

// ── Projects tab ──────────────────────────────────────────────────────────────

function ProjectsTab() {
  const [projects, setProjects] = useState<AdminProjectResponse[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    adminListProjects()
      .then(setProjects)
      .catch(() => setError('Failed to load projects.'))
      .finally(() => setLoading(false));
  }, []);

  const handleDelete = async (project: AdminProjectResponse) => {
    if (!confirm(`Delete project "${project.name}"? This cannot be undone.`)) return;
    try {
      await adminDeleteProject(project.id);
      setProjects((prev) => prev.filter((p) => p.id !== project.id));
    } catch (err: any) {
      alert(err?.response?.data?.detail || 'Failed to delete project.');
    }
  };

  const filtered = projects.filter(
    (p) =>
      p.name.toLowerCase().includes(search.toLowerCase()) ||
      p.owner_username.toLowerCase().includes(search.toLowerCase()),
  );

  return (
    <div style={s.tabContent}>
      {error && <div style={s.error}>{error}</div>}
      <div style={s.searchRow}>
        <input
          style={s.searchInput}
          placeholder="Search by name or owner…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <span style={s.muted}>
          {filtered.length} project{filtered.length !== 1 ? 's' : ''}
        </span>
      </div>

      {loading ? (
        <p style={s.muted}>Loading…</p>
      ) : (
        <div style={s.tableWrap}>
          <table style={s.table}>
            <thead>
              <tr>
                <th style={s.th}>Name</th>
                <th style={s.th}>Owner</th>
                <th style={s.th}>Board</th>
                <th style={s.th}>Visibility</th>
                <th style={s.th}>Updated</th>
                <th style={s.th}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((p) => (
                <tr key={p.id} style={s.tr}>
                  <td style={s.td}>
                    <Link
                      to={`/project/${p.id}`}
                      style={{ color: '#4fc3f7', textDecoration: 'none' }}
                      target="_blank"
                    >
                      {p.name}
                    </Link>
                  </td>
                  <td style={s.td}>
                    <Link
                      to={`/${p.owner_username}`}
                      style={{ color: '#9d9d9d', textDecoration: 'none' }}
                      target="_blank"
                    >
                      {p.owner_username}
                    </Link>
                  </td>
                  <td style={s.td}>{p.board_type}</td>
                  <td style={s.td}>
                    <span style={p.is_public ? s.activeBadge : s.inactiveBadge}>
                      {p.is_public ? 'public' : 'private'}
                    </span>
                  </td>
                  <td style={s.td}>{new Date(p.updated_at).toLocaleDateString()}</td>
                  <td style={s.td}>
                    <button style={s.deleteBtn} onClick={() => handleDelete(p)}>
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={6} style={{ ...s.td, textAlign: 'center', color: '#666' }}>
                    No projects found.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Admin dashboard ───────────────────────────────────────────────────────────

function AdminDashboard() {
  const [tab, setTab] = useState<Tab>('users');
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const navigate = useNavigate();

  const handleLogout = async () => {
    await logout();
    navigate('/');
  };

  return (
    <div style={s.dashboard}>
      <div style={s.header}>
        <div style={s.headerLeft}>
          <Link to="/" style={s.backLink}>
            Velxio
          </Link>
          <span style={s.headerSep}>/</span>
          <span style={s.headerTitle}>Admin panel</span>
        </div>
        <div style={s.headerRight}>
          <span style={s.adminLabel}>{user?.username}</span>
          <button style={s.logoutBtn} onClick={handleLogout}>
            Logout
          </button>
        </div>
      </div>

      <div style={s.tabs}>
        <button style={tab === 'users' ? s.tabActive : s.tabBtn} onClick={() => setTab('users')}>
          Users
        </button>
        <button
          style={tab === 'projects' ? s.tabActive : s.tabBtn}
          onClick={() => setTab('projects')}
        >
          Projects
        </button>
      </div>

      {tab === 'users' && <UsersTab currentUserId={user?.id || ''} />}
      {tab === 'projects' && <ProjectsTab />}
    </div>
  );
}

// ── Main AdminPage ────────────────────────────────────────────────────────────

type AdminPageState = 'loading' | 'setup' | 'not-admin' | 'dashboard';

export const AdminPage: React.FC = () => {
  useSEO({
    title: 'Admin — Velxio',
    description: 'Velxio administration panel.',
    url: 'https://velxio.dev/admin',
    noindex: true,
  });

  const user = useAuthStore((s) => s.user);
  const [pageState, setPageState] = useState<AdminPageState>('loading');

  useEffect(() => {
    getAdminSetupStatus()
      .then(({ has_admin }) => {
        if (!has_admin) {
          setPageState('setup');
          return;
        }
        if (!user || !user.is_admin) {
          setPageState('not-admin');
          return;
        }
        setPageState('dashboard');
      })
      .catch(() => setPageState('not-admin'));
  }, [user]);

  if (pageState === 'loading') {
    return (
      <div style={{ ...s.page, alignItems: 'center', justifyContent: 'center' }}>
        <p style={s.muted}>Loading…</p>
      </div>
    );
  }

  if (pageState === 'setup') {
    return <SetupScreen onDone={() => setPageState('not-admin')} />;
  }

  if (pageState === 'not-admin') {
    return <NotAdminScreen />;
  }

  return <AdminDashboard />;
};

// ── Styles ────────────────────────────────────────────────────────────────────

const s: Record<string, React.CSSProperties> = {
  page: {
    minHeight: '100vh',
    background: '#1e1e1e',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '2rem',
  },
  card: {
    background: '#252526',
    border: '1px solid #3c3c3c',
    borderRadius: 8,
    padding: '2rem',
    width: 380,
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
  },
  cardTitle: { color: '#ccc', margin: 0, fontSize: 22, fontWeight: 600 },
  muted: { color: '#777', fontSize: 13, margin: 0 },
  form: { display: 'flex', flexDirection: 'column', gap: 8 },
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
  primaryBtn: {
    display: 'block',
    textAlign: 'center',
    textDecoration: 'none',
    marginTop: 8,
    background: '#0e639c',
    border: 'none',
    borderRadius: 4,
    color: '#fff',
    padding: '9px',
    fontSize: 14,
    cursor: 'pointer',
    fontWeight: 500,
  },
  error: {
    background: '#5a1d1d',
    border: '1px solid #f44747',
    borderRadius: 4,
    color: '#f44747',
    padding: '8px 12px',
    fontSize: 13,
  },
  // Dashboard
  dashboard: {
    minHeight: '100vh',
    background: '#1e1e1e',
    display: 'flex',
    flexDirection: 'column',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    background: '#252526',
    borderBottom: '1px solid #3c3c3c',
    padding: '0 1.5rem',
    height: 48,
  },
  headerLeft: { display: 'flex', alignItems: 'center', gap: 8 },
  backLink: { color: '#4fc3f7', textDecoration: 'none', fontSize: 14, fontWeight: 600 },
  headerSep: { color: '#555', fontSize: 14 },
  headerTitle: { color: '#ccc', fontSize: 14 },
  headerRight: { display: 'flex', alignItems: 'center', gap: 12 },
  adminLabel: { color: '#9d9d9d', fontSize: 13 },
  logoutBtn: {
    background: 'transparent',
    border: '1px solid #555',
    borderRadius: 4,
    color: '#ccc',
    padding: '4px 12px',
    fontSize: 13,
    cursor: 'pointer',
  },
  tabs: { display: 'flex', gap: 0, borderBottom: '1px solid #3c3c3c', padding: '0 1.5rem' },
  tabBtn: {
    background: 'transparent',
    border: 'none',
    borderBottom: '2px solid transparent',
    color: '#9d9d9d',
    padding: '10px 16px',
    fontSize: 14,
    cursor: 'pointer',
  },
  tabActive: {
    background: 'transparent',
    border: 'none',
    borderBottom: '2px solid #0e639c',
    color: '#fff',
    padding: '10px 16px',
    fontSize: 14,
    cursor: 'pointer',
  },
  tabContent: { padding: '1.5rem', flex: 1 },
  searchRow: { display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 },
  searchInput: {
    background: '#3c3c3c',
    border: '1px solid #555',
    borderRadius: 4,
    padding: '7px 10px',
    color: '#ccc',
    fontSize: 14,
    outline: 'none',
    width: 300,
  },
  tableWrap: { overflowX: 'auto' },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 13 },
  th: {
    textAlign: 'left',
    color: '#9d9d9d',
    padding: '8px 12px',
    borderBottom: '1px solid #3c3c3c',
    fontWeight: 500,
    whiteSpace: 'nowrap',
  },
  tr: { borderBottom: '1px solid #2d2d2d' },
  td: { color: '#ccc', padding: '10px 12px', verticalAlign: 'middle' },
  username: { fontWeight: 500 },
  youBadge: {
    marginLeft: 6,
    background: '#2d4a2d',
    color: '#73c991',
    border: '1px solid #4a7a4a',
    borderRadius: 4,
    padding: '1px 6px',
    fontSize: 11,
  },
  adminBadge: {
    background: '#2d3a5a',
    color: '#9cdcfe',
    border: '1px solid #4a6a9a',
    borderRadius: 4,
    padding: '2px 8px',
    fontSize: 11,
  },
  userBadge: {
    background: '#3a3a3a',
    color: '#9d9d9d',
    border: '1px solid #555',
    borderRadius: 4,
    padding: '2px 8px',
    fontSize: 11,
  },
  activeBadge: {
    background: '#2d4a2d',
    color: '#73c991',
    border: '1px solid #4a7a4a',
    borderRadius: 4,
    padding: '2px 8px',
    fontSize: 11,
  },
  inactiveBadge: {
    background: '#4a2d2d',
    color: '#f14c4c',
    border: '1px solid #7a4a4a',
    borderRadius: 4,
    padding: '2px 8px',
    fontSize: 11,
  },
  editBtn: {
    background: '#3c3c3c',
    border: 'none',
    borderRadius: 4,
    color: '#ccc',
    padding: '4px 10px',
    fontSize: 12,
    cursor: 'pointer',
    marginRight: 4,
  },
  deleteBtn: {
    background: '#5a1d1d',
    border: 'none',
    borderRadius: 4,
    color: '#f44747',
    padding: '4px 10px',
    fontSize: 12,
    cursor: 'pointer',
  },
};
