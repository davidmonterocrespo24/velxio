import { create } from 'zustand';
import type { ProjectVisibility } from '../services/projectService';

interface CurrentProject {
  id: string;
  slug: string;
  ownerUsername: string;
  isPublic: boolean;
  // Phase 1 D1.3 — three-level visibility. Kept in sync with isPublic
  // (which legacy callers still read) by setVisibility().
  visibility?: ProjectVisibility;
}

interface ProjectState {
  currentProject: CurrentProject | null;
  workspaceVersion: number;
  /**
   * Gallery example currently loaded in the editor (null when the workspace
   * came from a project, a file or scratch). Set by loadExample, cleared
   * whenever a project takes over — analytics only: compiles/runs stamp it
   * so "which examples get compiled most" is answerable.
   */
  currentExampleId: string | null;
  setCurrentProject: (project: CurrentProject) => void;
  clearCurrentProject: () => void;
  setCurrentExampleId: (id: string | null) => void;
  // Updated to accept either the legacy boolean OR the new enum so the
  // ShareModal callsite and any older callers keep working uniformly.
  setVisibility: (next: boolean | ProjectVisibility) => void;
}

export const useProjectStore = create<ProjectState>((set) => ({
  currentProject: null,
  workspaceVersion: 0,
  currentExampleId: null,
  // Loading a real project supersedes the example context.
  setCurrentProject: (project) => set((state) => ({
    currentProject: project,
    currentExampleId: null,
    workspaceVersion: state.workspaceVersion + Number(state.currentProject?.id !== project.id),
  })),
  // Also drops the example context: every caller (new project, blank
  // workspace, logout cleanup) means "this workspace is no longer that".
  // loadExample re-stamps its id right after calling this.
  clearCurrentProject: () => set((state) => ({
    currentProject: null,
    currentExampleId: null,
    workspaceVersion: state.workspaceVersion + 1,
  })),
  setCurrentExampleId: (id) => set({ currentExampleId: id }),
  setVisibility: (next) =>
    set((s) => {
      if (!s.currentProject) return s;
      // Translate boolean → enum and vice versa so both fields are
      // always coherent.
      let isPublic: boolean;
      let visibility: ProjectVisibility;
      if (typeof next === 'boolean') {
        isPublic = next;
        visibility = next ? 'public' : 'private';
      } else {
        visibility = next;
        isPublic = next === 'public';
      }
      return {
        currentProject: { ...s.currentProject, isPublic, visibility },
      };
    }),
}));
