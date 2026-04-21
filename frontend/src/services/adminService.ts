import axios from 'axios';

const API_BASE = import.meta.env.VITE_API_BASE || '/api';

const api = axios.create({ baseURL: API_BASE, withCredentials: true });

export interface AdminUserResponse {
  id: string;
  username: string;
  email: string;
  avatar_url: string | null;
  is_active: boolean;
  is_admin: boolean;
  created_at: string;
  project_count: number;
}

export interface AdminUserUpdateRequest {
  username?: string;
  email?: string;
  password?: string;
  is_active?: boolean;
  is_admin?: boolean;
}

export interface AdminProjectResponse {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  is_public: boolean;
  board_type: string;
  owner_username: string;
  owner_id: string;
  created_at: string;
  updated_at: string;
}

export async function getAdminSetupStatus(): Promise<{ has_admin: boolean }> {
  const { data } = await api.get('/admin/setup/status');
  return data;
}

export async function createFirstAdmin(
  username: string,
  email: string,
  password: string,
): Promise<AdminUserResponse> {
  const { data } = await api.post('/admin/setup', { username, email, password });
  return data;
}

export async function adminListUsers(): Promise<AdminUserResponse[]> {
  const { data } = await api.get('/admin/users');
  return data;
}

export async function adminGetUser(userId: string): Promise<AdminUserResponse> {
  const { data } = await api.get(`/admin/users/${userId}`);
  return data;
}

export async function adminUpdateUser(
  userId: string,
  body: AdminUserUpdateRequest,
): Promise<AdminUserResponse> {
  const { data } = await api.put(`/admin/users/${userId}`, body);
  return data;
}

export async function adminDeleteUser(userId: string): Promise<void> {
  await api.delete(`/admin/users/${userId}`);
}

export async function adminListProjects(): Promise<AdminProjectResponse[]> {
  const { data } = await api.get('/admin/projects');
  return data;
}

export async function adminDeleteProject(projectId: string): Promise<void> {
  await api.delete(`/admin/projects/${projectId}`);
}
