/**
 * useVfsStore — Virtual File System state for Raspberry Pi 3B boards.
 *
 * Each Pi board gets its own VFS tree rooted at "/".
 * Files can be created, renamed, deleted, and edited.
 * The VFS can be uploaded to the running Pi via RaspberryPi3Bridge.
 */

import { create } from 'zustand';
import { nanoid } from 'nanoid';

export interface VfsNode {
  id: string;
  name: string;
  type: 'file' | 'directory';
  content?: string; // undefined for directories
  children?: string[]; // child node IDs, undefined for files
  parentId: string | null;
}

type VfsTree = Record<string, VfsNode>; // nodeId → VfsNode

const DEFAULT_PY_CONTENT = `#!/usr/bin/env python3
# Raspberry Pi script — runs on the emulated Pi
import time
import sys

print("Hello from Raspberry Pi!", flush=True)

while True:
    print("Running...", flush=True)
    time.sleep(1)
`;

const DEFAULT_SH_CONTENT = `#!/bin/bash
echo "Hello from Pi!"
`;

function makeDefaultTree(): { tree: VfsTree; rootId: string } {
  const rootId = nanoid(8);
  const homeId = nanoid(8);
  const piId = nanoid(8);
  const scriptId = nanoid(8);
  const shellId = nanoid(8);

  const tree: VfsTree = {
    [rootId]: { id: rootId, name: '/', type: 'directory', children: [homeId], parentId: null },
    [homeId]: { id: homeId, name: 'home', type: 'directory', children: [piId], parentId: rootId },
    [piId]: {
      id: piId,
      name: 'pi',
      type: 'directory',
      children: [scriptId, shellId],
      parentId: homeId,
    },
    [scriptId]: {
      id: scriptId,
      name: 'script.py',
      type: 'file',
      content: DEFAULT_PY_CONTENT,
      parentId: piId,
    },
    [shellId]: {
      id: shellId,
      name: 'hello.sh',
      type: 'file',
      content: DEFAULT_SH_CONTENT,
      parentId: piId,
    },
  };

  return { tree, rootId };
}

interface VfsState {
  // Per-board: boardId → { tree, rootId }
  boards: Record<string, { tree: VfsTree; rootId: string }>;
  // Per-board: boardId → selected nodeId (for editor focus)
  selectedNodeId: Record<string, string | null>;

  initBoardVfs: (boardId: string) => void;
  getTree: (boardId: string) => VfsTree;
  getRootId: (boardId: string) => string | null;
  getNode: (boardId: string, nodeId: string) => VfsNode | null;
  setSelectedNode: (boardId: string, nodeId: string | null) => void;
  getSelectedNode: (boardId: string) => VfsNode | null;

  createNode: (
    boardId: string,
    parentId: string,
    name: string,
    type: 'file' | 'directory',
  ) => string | null;
  deleteNode: (boardId: string, nodeId: string) => void;
  renameNode: (boardId: string, nodeId: string, newName: string) => void;
  setContent: (boardId: string, nodeId: string, content: string) => void;

  /** Serialize the VFS for a board as a flat list of { path, content } for upload */
  serializeForUpload: (boardId: string) => Array<{ path: string; content: string }>;
}

function buildPath(tree: VfsTree, nodeId: string): string {
  const parts: string[] = [];
  let current: VfsNode | undefined = tree[nodeId];
  while (current && current.parentId !== null) {
    parts.unshift(current.name);
    current = tree[current.parentId];
  }
  return '/' + parts.join('/');
}

function serializeTree(tree: VfsTree, rootId: string): Array<{ path: string; content: string }> {
  const result: Array<{ path: string; content: string }> = [];
  const visit = (nodeId: string) => {
    const node = tree[nodeId];
    if (!node) return;
    if (node.type === 'file' && node.parentId !== null) {
      result.push({ path: buildPath(tree, nodeId), content: node.content ?? '' });
    }
    if (node.type === 'directory') {
      for (const childId of node.children ?? []) {
        visit(childId);
      }
    }
  };
  visit(rootId);
  return result;
}

export const useVfsStore = create<VfsState>((set, get) => ({
  boards: {},
  selectedNodeId: {},

  initBoardVfs: (boardId) => {
    if (get().boards[boardId]) return; // already initialized
    const { tree, rootId } = makeDefaultTree();
    set((s) => ({
      boards: { ...s.boards, [boardId]: { tree, rootId } },
      selectedNodeId: { ...s.selectedNodeId, [boardId]: null },
    }));
  },

  getTree: (boardId) => get().boards[boardId]?.tree ?? {},

  getRootId: (boardId) => get().boards[boardId]?.rootId ?? null,

  getNode: (boardId, nodeId) => get().boards[boardId]?.tree[nodeId] ?? null,

  setSelectedNode: (boardId, nodeId) =>
    set((s) => ({ selectedNodeId: { ...s.selectedNodeId, [boardId]: nodeId } })),

  getSelectedNode: (boardId) => {
    const nodeId = get().selectedNodeId[boardId];
    if (!nodeId) return null;
    return get().boards[boardId]?.tree[nodeId] ?? null;
  },

  createNode: (boardId, parentId, name, type) => {
    const board = get().boards[boardId];
    if (!board) return null;
    const parent = board.tree[parentId];
    if (!parent || parent.type !== 'directory') return null;

    const newId = nanoid(8);
    const newNode: VfsNode = {
      id: newId,
      name,
      type,
      parentId,
      ...(type === 'file' ? { content: '' } : { children: [] }),
    };
    const updatedParent = { ...parent, children: [...(parent.children ?? []), newId] };
    const newTree = { ...board.tree, [newId]: newNode, [parentId]: updatedParent };

    set((s) => ({
      boards: { ...s.boards, [boardId]: { ...board, tree: newTree } },
    }));
    return newId;
  },

  deleteNode: (boardId, nodeId) => {
    const board = get().boards[boardId];
    if (!board) return;
    const node = board.tree[nodeId];
    if (!node || node.parentId === null) return; // can't delete root

    // Collect all node IDs to remove (node + all descendants)
    const toRemove = new Set<string>();
    const collect = (id: string) => {
      toRemove.add(id);
      const n = board.tree[id];
      if (n?.type === 'directory') {
        for (const childId of n.children ?? []) collect(childId);
      }
    };
    collect(nodeId);

    const parent = board.tree[node.parentId];
    const updatedParent = parent
      ? { ...parent, children: (parent.children ?? []).filter((c) => c !== nodeId) }
      : parent;

    const newTree = Object.fromEntries(
      Object.entries(board.tree)
        .filter(([id]) => !toRemove.has(id))
        .map(([id, n]) => (id === node.parentId ? [id, updatedParent] : [id, n])),
    ) as VfsTree;

    set((s) => ({
      boards: { ...s.boards, [boardId]: { ...board, tree: newTree } },
      selectedNodeId: toRemove.has(s.selectedNodeId[boardId] ?? '')
        ? { ...s.selectedNodeId, [boardId]: null }
        : s.selectedNodeId,
    }));
  },

  renameNode: (boardId, nodeId, newName) => {
    const board = get().boards[boardId];
    if (!board || !board.tree[nodeId]) return;
    const newTree = { ...board.tree, [nodeId]: { ...board.tree[nodeId], name: newName } };
    set((s) => ({ boards: { ...s.boards, [boardId]: { ...board, tree: newTree } } }));
  },

  setContent: (boardId, nodeId, content) => {
    const board = get().boards[boardId];
    if (!board || board.tree[nodeId]?.type !== 'file') return;
    const newTree = { ...board.tree, [nodeId]: { ...board.tree[nodeId], content } };
    set((s) => ({ boards: { ...s.boards, [boardId]: { ...board, tree: newTree } } }));
  },

  serializeForUpload: (boardId) => {
    const board = get().boards[boardId];
    if (!board) return [];
    return serializeTree(board.tree, board.rootId);
  },
}));
