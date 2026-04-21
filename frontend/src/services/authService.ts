import axios from 'axios';
import type { UserResponse } from '../store/useAuthStore';

const API_BASE = import.meta.env.VITE_API_BASE || '/api';

const api = axios.create({ baseURL: API_BASE, withCredentials: true });

export async function register(
  username: string,
  email: string,
  password: string,
): Promise<UserResponse> {
  const { data } = await api.post<UserResponse>('/auth/register', { username, email, password });
  return data;
}

export async function login(email: string, password: string): Promise<UserResponse> {
  const { data } = await api.post<UserResponse>('/auth/login', { email, password });
  return data;
}

export async function getMe(): Promise<UserResponse> {
  const { data } = await api.get<UserResponse>('/auth/me');
  return data;
}

export async function logout(): Promise<void> {
  await api.post('/auth/logout');
}

export function initiateGoogleLogin(): void {
  window.location.href = `${API_BASE}/auth/google`;
}
