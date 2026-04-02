import { create } from 'zustand';
import type { GeneratedFile } from '../services/chatService';

export interface ChatUIMessage {
  role: 'user' | 'assistant';
  text: string;
  files?: GeneratedFile[];
  error?: boolean;
}

interface ChatStore {
  isOpen: boolean;
  messages: ChatUIMessage[];
  loading: boolean;
  toggle: () => void;
  open: () => void;
  close: () => void;
  addMessage: (msg: ChatUIMessage) => void;
  setLoading: (v: boolean) => void;
}

export const useChatStore = create<ChatStore>((set) => ({
  isOpen: false,
  messages: [],
  loading: false,
  toggle: () => set((s) => ({ isOpen: !s.isOpen })),
  open: () => set({ isOpen: true }),
  close: () => set({ isOpen: false }),
  addMessage: (msg) => set((s) => ({ messages: [...s.messages, msg] })),
  setLoading: (v) => set({ loading: v }),
}));
