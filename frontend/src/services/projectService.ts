import axios from 'axios';

const API_BASE = import.meta.env.VITE_API_BASE || '/api';

const api = axios.create({ baseURL: API_BASE, withCredentials: true });

export interface SketchFile {
  name: string;
  content: string;
}

export interface FileGroup {
  groupId: string;
  files: SketchFile[];
}

export interface ProjectResponse {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  is_public: boolean;
  board_type: string;
  files: SketchFile[]; // active board's files (legacy)
  file_groups: FileGroup[]; // all boards' file groups
  code: string; // legacy fallback
  components_json: string;
  wires_json: string;
  boards_json: string; // serialized BoardInstance[]
  owner_username: string;
  created_at: string;
  updated_at: string;
}

export interface ProjectSaveData {
  name: string;
  description?: string;
  is_public: boolean;
  board_type: string;
  files: SketchFile[]; // legacy: active board's files
  file_groups?: FileGroup[]; // multi-board: all groups
  code?: string; // legacy fallback
  components_json: string;
  wires_json: string;
  boards_json?: string; // serialized BoardInstance[]
}

export async function getMyProjects(): Promise<ProjectResponse[]> {
  const { data } = await api.get<ProjectResponse[]>('/projects/me');
  return data;
}

export async function getUserProjects(username: string): Promise<ProjectResponse[]> {
  const { data } = await api.get<ProjectResponse[]>(`/user/${username}`);
  return data;
}

export async function getProjectById(id: string): Promise<ProjectResponse> {
  const { data } = await api.get<ProjectResponse>(`/projects/${id}`);
  return data;
}

export async function getProject(username: string, slug: string): Promise<ProjectResponse> {
  const { data } = await api.get<ProjectResponse>(`/user/${username}/${slug}`);
  return data;
}

export async function createProject(data: ProjectSaveData): Promise<ProjectResponse> {
  const { data: result } = await api.post<ProjectResponse>('/projects/', data);
  return result;
}

export async function updateProject(
  id: string,
  data: Partial<ProjectSaveData>,
): Promise<ProjectResponse> {
  const { data: result } = await api.put<ProjectResponse>(`/projects/${id}`, data);
  return result;
}

export async function deleteProject(id: string): Promise<void> {
  await api.delete(`/projects/${id}`);
}
