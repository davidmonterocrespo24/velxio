import axios from 'axios';

const API_BASE = import.meta.env.VITE_API_BASE || '/api';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface GeneratedFile {
  name: string;
  content: string;
}

export interface ChatResponse {
  explanation: string;
  files: GeneratedFile[];
}

export async function generateSketch(messages: ChatMessage[]): Promise<ChatResponse> {
  const res = await axios.post(`${API_BASE}/chat/generate`, { messages });
  return res.data;
}
