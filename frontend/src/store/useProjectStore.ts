import { create } from 'zustand';

interface CurrentProject {
  id: string;
  slug: string;
  ownerUsername: string;
  isPublic: boolean;
}

interface ProjectState {
  currentProject: CurrentProject | null;
  setCurrentProject: (project: CurrentProject) => void;
  clearCurrentProject: () => void;
  setVisibility: (isPublic: boolean) => void;
}

export const useProjectStore = create<ProjectState>((set) => ({
  currentProject: null,
  setCurrentProject: (project) => set({ currentProject: project }),
  clearCurrentProject: () => set({ currentProject: null }),
  setVisibility: (isPublic) =>
    set((s) =>
      s.currentProject ? { currentProject: { ...s.currentProject, isPublic } } : s,
    ),
}));
