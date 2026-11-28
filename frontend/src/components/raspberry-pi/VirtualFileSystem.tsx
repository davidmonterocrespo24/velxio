/**
 * VirtualFileSystem — tree explorer for the Pi's VFS.
 * Supports expand/collapse, file selection, context menu (new/rename/delete),
 * and an "Upload to Pi" button.
 */

import { FileOutlineIcon } from '../ui/CustomIcons';
import { ChevronRight } from 'lucide-react';
import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useVfsStore } from '../../store/useVfsStore';
import type { VfsNode } from '../../store/useVfsStore';
import { getBoardBridge, useSimulatorStore } from '../../store/useSimulatorStore';
import { showConfirmDialog } from '../../store/useMessageDialogStore';
import { uploadFilesToPi } from '../../utils/piUpload';

/** Resolve true once the board's guest Linux has booted to a shell
 * (board.piBooted), or false after timeoutMs. Polls the store. */
function waitForPiBooted(boardId: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const check = (): void => {
      const b = useSimulatorStore.getState().boards.find((x) => x.id === boardId);
      if (b?.piBooted) return resolve(true);
      if (Date.now() > deadline) return resolve(false);
      setTimeout(check, 250);
    };
    check();
  });
}

// ── Icons ─────────────────────────────────────────

const IcoFolder = ({ open }: { open: boolean }) => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill={open ? '#f0c040' : '#c8a040'} stroke="none">
    {open ? (
      <path d="M2 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6z" />
    ) : (
      <path d="M2 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6z" />
    )}
  </svg>
);

const IcoFile = ({ name }: { name: string }) => {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  const color = ext === 'py' ? '#4fc3f7' : ext === 'sh' ? 'var(--color-feedback-success)' : 'var(--wb-11)';
  return (
    <FileOutlineIcon size={13} stroke={color} strokeLinecap="butt" strokeLinejoin="miter" />
  );
};

const IcoChevron = ({ open }: { open: boolean }) => (
  <ChevronRight
    size={10}
    strokeWidth={2.5}
    style={{
      transform: open ? 'rotate(90deg)' : 'none',
      transition: 'transform 0.12s',
      flexShrink: 0,
    }}
  />
);

const IcoUpload = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <polyline points="17 8 12 3 7 8" />
    <line x1="12" y1="3" x2="12" y2="15" />
  </svg>
);

// ── Context menu ───────────────────────────────────

interface CtxMenu {
  nodeId: string;
  x: number;
  y: number;
  isDir: boolean;
}

// ── Single node renderer ────────────────────────────

interface NodeRowProps {
  boardId: string;
  nodeId: string;
  depth: number;
  selectedNodeId: string | null;
  onSelect: (nodeId: string) => void;
  onContext: (e: React.MouseEvent, nodeId: string, isDir: boolean) => void;
  renamingId: string | null;
  renameValue: string;
  renameInputRef: React.RefObject<HTMLInputElement>;
  onRenameChange: (v: string) => void;
  onRenameCommit: () => void;
  onRenameCancel: () => void;
  creatingIn: string | null;
  newNodeName: string;
  newNodeType: 'file' | 'directory';
  newNodeInputRef: React.RefObject<HTMLInputElement>;
  onNewNameChange: (v: string) => void;
  onNewNameCommit: () => void;
  onNewNameCancel: () => void;
}

const NodeRow: React.FC<NodeRowProps> = ({
  boardId,
  nodeId,
  depth,
  selectedNodeId,
  onSelect,
  onContext,
  renamingId,
  renameValue,
  renameInputRef,
  onRenameChange,
  onRenameCommit,
  onRenameCancel,
  creatingIn,
  newNodeName,
  newNodeType,
  newNodeInputRef,
  onNewNameChange,
  onNewNameCommit,
  onNewNameCancel,
}) => {
  const node = useVfsStore((s) => s.getNode(boardId, nodeId));
  const [open, setOpen] = useState(true);

  if (!node) return null;

  const isSelected = nodeId === selectedNodeId;
  const isDir = node.type === 'directory';
  const isRoot = node.parentId === null;

  return (
    <>
      <div
        className={`vfs-row${isSelected ? ' vfs-row-selected' : ''}`}
        style={{ paddingLeft: depth * 14 + 6 }}
        onClick={() => {
          if (isDir) setOpen((v) => !v);
          onSelect(nodeId);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          onContext(e, nodeId, isDir);
        }}
        title={isRoot ? '/' : node.name}
      >
        {isDir && <IcoChevron open={open} />}
        {!isDir && <span style={{ width: 10, flexShrink: 0 }} />}
        <span style={{ marginLeft: 4, flexShrink: 0 }}>
          {isDir ? <IcoFolder open={open} /> : <IcoFile name={node.name} />}
        </span>

        {renamingId === nodeId ? (
          <input
            ref={renameInputRef}
            className="vfs-rename-input"
            value={renameValue}
            onChange={(e) => onRenameChange(e.target.value)}
            onBlur={onRenameCommit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onRenameCommit();
              if (e.key === 'Escape') onRenameCancel();
            }}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <span className="vfs-node-name">{isRoot ? '/' : node.name}</span>
        )}
      </div>

      {/* Children */}
      {isDir && open && (
        <>
          {(node.children ?? []).map((childId) => (
            <NodeRow
              key={childId}
              boardId={boardId}
              nodeId={childId}
              depth={depth + 1}
              selectedNodeId={selectedNodeId}
              onSelect={onSelect}
              onContext={onContext}
              renamingId={renamingId}
              renameValue={renameValue}
              renameInputRef={renameInputRef}
              onRenameChange={onRenameChange}
              onRenameCommit={onRenameCommit}
              onRenameCancel={onRenameCancel}
              creatingIn={creatingIn}
              newNodeName={newNodeName}
              newNodeType={newNodeType}
              newNodeInputRef={newNodeInputRef}
              onNewNameChange={onNewNameChange}
              onNewNameCommit={onNewNameCommit}
              onNewNameCancel={onNewNameCancel}
            />
          ))}
          {/* Inline new-node input */}
          {creatingIn === nodeId && (
            <div className="vfs-row" style={{ paddingLeft: (depth + 1) * 14 + 6 }}>
              <span style={{ width: 10, flexShrink: 0 }} />
              <span style={{ marginLeft: 4, flexShrink: 0 }}>
                {newNodeType === 'directory' ? (
                  <IcoFolder open={false} />
                ) : (
                  <IcoFile name={newNodeName || 'newfile'} />
                )}
              </span>
              <input
                ref={newNodeInputRef}
                className="vfs-rename-input"
                value={newNodeName}
                placeholder={newNodeType === 'directory' ? 'folder' : 'file.py'}
                onChange={(e) => onNewNameChange(e.target.value)}
                onBlur={onNewNameCommit}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') onNewNameCommit();
                  if (e.key === 'Escape') onNewNameCancel();
                }}
                onClick={(e) => e.stopPropagation()}
              />
            </div>
          )}
        </>
      )}
    </>
  );
};

// ── Main component ─────────────────────────────────

interface VirtualFileSystemProps {
  boardId: string;
  onFileSelect: (nodeId: string, content: string, filename: string) => void;
}

export const VirtualFileSystem: React.FC<VirtualFileSystemProps> = ({ boardId, onFileSelect }) => {
  const { t } = useTranslation();
  const {
    initBoardVfs,
    getRootId,
    getNode,
    setSelectedNode,
    selectedNodeId: selectedMap,
    createNode,
    deleteNode,
    renameNode,
    serializeForUpload,
  } = useVfsStore();

  useEffect(() => {
    initBoardVfs(boardId);
  }, [boardId, initBoardVfs]);

  const rootId = getRootId(boardId);
  const selectedNodeId = selectedMap[boardId] ?? null;

  const [ctxMenu, setCtxMenu] = useState<CtxMenu | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [creatingIn, setCreatingIn] = useState<string | null>(null);
  const [newNodeName, setNewNodeName] = useState('');
  const [newNodeType, setNewNodeType] = useState<'file' | 'directory'>('file');
  const [uploadStatus, setUploadStatus] = useState<'idle' | 'uploading' | 'done' | 'error'>('idle');

  const renameInputRef = useRef<HTMLInputElement>(null);
  const newNodeInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (renamingId && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [renamingId]);

  useEffect(() => {
    if (creatingIn && newNodeInputRef.current) newNodeInputRef.current.focus();
  }, [creatingIn]);

  // Close context menu on outside click
  useEffect(() => {
    if (!ctxMenu) return;
    const h = () => setCtxMenu(null);
    document.addEventListener('click', h);
    return () => document.removeEventListener('click', h);
  }, [ctxMenu]);

  const handleSelect = useCallback(
    (nodeId: string) => {
      setSelectedNode(boardId, nodeId);
      const node = getNode(boardId, nodeId);
      if (node?.type === 'file') {
        onFileSelect(nodeId, node.content ?? '', node.name);
      }
    },
    [boardId, setSelectedNode, getNode, onFileSelect],
  );

  const handleContext = useCallback((e: React.MouseEvent, nodeId: string, isDir: boolean) => {
    setCtxMenu({ nodeId, x: e.clientX, y: e.clientY, isDir });
  }, []);

  const startRename = (nodeId: string) => {
    const node = getNode(boardId, nodeId);
    if (!node || node.parentId === null) return;
    setRenameValue(node.name);
    setRenamingId(nodeId);
    setCtxMenu(null);
  };

  const commitRename = useCallback(() => {
    if (renamingId && renameValue.trim()) renameNode(boardId, renamingId, renameValue.trim());
    setRenamingId(null);
  }, [boardId, renamingId, renameValue, renameNode]);

  const startCreate = (parentId: string, type: 'file' | 'directory') => {
    setCreatingIn(parentId);
    setNewNodeType(type);
    setNewNodeName('');
    setCtxMenu(null);
  };

  const commitCreate = useCallback(() => {
    const name = newNodeName.trim();
    if (name && creatingIn) createNode(boardId, creatingIn, name, newNodeType);
    setCreatingIn(null);
    setNewNodeName('');
  }, [boardId, creatingIn, newNodeName, newNodeType, createNode]);

  const handleDelete = async (nodeId: string) => {
    setCtxMenu(null);
    const node = getNode(boardId, nodeId);
    if (!node || node.parentId === null) return;
    const confirmed = await showConfirmDialog(
      t('editor.pi.confirmDelete.message', { name: node.name }),
      {
        kind: 'error',
        title: t('editor.pi.confirmDelete.title'),
        confirmLabel: t('editor.pi.confirmDelete.confirm'),
        cancelLabel: t('editor.pi.confirmDelete.cancel'),
        danger: true,
      },
    );
    if (!confirmed) return;
    if (selectedNodeId === nodeId) setSelectedNode(boardId, null);
    deleteNode(boardId, nodeId);
  };

  const handleUpload = async () => {
    const sim = useSimulatorStore.getState();
    const board = sim.boards.find((b) => b.id === boardId);

    setUploadStatus('uploading');

    // Auto-start the Pi if it isn't running, then wait for the guest shell —
    // no more "Pi is not connected, start it first" dead-end. waitForPiBooted
    // resolves false on timeout so we surface an error instead of hanging.
    if (!board?.running) sim.startBoard(boardId);
    const ready = await waitForPiBooted(boardId, 75_000);
    const bridge = getBoardBridge(boardId);
    if (!ready || !bridge || !bridge.connected) {
      setUploadStatus('error');
      setTimeout(() => setUploadStatus('idle'), 3000);
      return;
    }

    const files = serializeForUpload(boardId);
    if (files.length === 0) {
      setUploadStatus('idle');
      return;
    }

    await uploadFilesToPi(bridge, files);

    setUploadStatus('done');
    setTimeout(() => setUploadStatus('idle'), 2500);
  };

  if (!rootId) return <div style={styles.empty}>Loading file system…</div>;

  return (
    <div style={styles.container}>
      {/* Header */}
      <div style={styles.header}>
        <span style={styles.title}>FILE SYSTEM</span>
        <div style={styles.headerBtns}>
          <button
            style={{
              ...styles.headerBtn,
              color:
                uploadStatus === 'done'
                  ? '#4caf50'
                  : uploadStatus === 'error'
                    ? '#ef5350'
                    : uploadStatus === 'uploading'
                      ? '#f59e0b'
                      : '#4fc3f7',
              opacity: uploadStatus === 'uploading' ? 0.7 : 1,
            }}
            onClick={handleUpload}
            disabled={uploadStatus === 'uploading'}
            title="Upload all files to the running Pi via serial"
          >
            <IcoUpload />
            <span style={{ marginLeft: 4, fontSize: 10 }}>
              {uploadStatus === 'done'
                ? 'Done!'
                : uploadStatus === 'error'
                  ? 'Failed'
                  : uploadStatus === 'uploading'
                    ? 'Sending…'
                    : 'Upload'}
            </span>
          </button>
        </div>
      </div>

      {/* Tree */}
      <div style={styles.tree}>
        <NodeRow
          boardId={boardId}
          nodeId={rootId}
          depth={0}
          selectedNodeId={selectedNodeId}
          onSelect={handleSelect}
          onContext={handleContext}
          renamingId={renamingId}
          renameValue={renameValue}
          renameInputRef={renameInputRef}
          onRenameChange={setRenameValue}
          onRenameCommit={commitRename}
          onRenameCancel={() => setRenamingId(null)}
          creatingIn={creatingIn}
          newNodeName={newNodeName}
          newNodeType={newNodeType}
          newNodeInputRef={newNodeInputRef}
          onNewNameChange={setNewNodeName}
          onNewNameCommit={commitCreate}
          onNewNameCancel={() => setCreatingIn(null)}
        />
      </div>

      {/* Context menu */}
      {ctxMenu && (
        <div
          style={{ ...styles.ctxMenu, top: ctxMenu.y, left: ctxMenu.x }}
          onClick={(e) => e.stopPropagation()}
        >
          {ctxMenu.isDir && (
            <>
              <button style={styles.ctxBtn} onClick={() => startCreate(ctxMenu.nodeId, 'file')}>
                New File
              </button>
              <button
                style={styles.ctxBtn}
                onClick={() => startCreate(ctxMenu.nodeId, 'directory')}
              >
                New Folder
              </button>
              <div style={styles.ctxSep} />
            </>
          )}
          {getNode(boardId, ctxMenu.nodeId)?.parentId !== null && (
            <>
              <button style={styles.ctxBtn} onClick={() => startRename(ctxMenu.nodeId)}>
                Rename
              </button>
              <button
                style={{ ...styles.ctxBtn, color: '#ef5350' }}
                onClick={() => handleDelete(ctxMenu.nodeId)}
              >
                Delete
              </button>
            </>
          )}
        </div>
      )}

      <style>{`
        .vfs-row {
          display: flex;
          align-items: center;
          gap: 3px;
          padding-top: 4px;
          padding-bottom: 4px;
          padding-right: 6px;
          cursor: pointer;
          color: #ccc;
          font-size: 12px;
          user-select: none;
          white-space: nowrap;
          overflow: hidden;
          border-radius: 3px;
          margin: 1px 3px;
        }
        .vfs-row:hover { background: rgba(255,255,255,0.06); }
        .vfs-row-selected { background: rgba(79,195,247,0.12); color: #e2e2e2; }
        .vfs-node-name { overflow: hidden; text-overflow: ellipsis; flex: 1; }
        .vfs-rename-input {
          flex: 1;
          background: #3c3c3c;
          border: 1px solid #4fc3f7;
          color: #fff;
          font-size: 12px;
          padding: 1px 4px;
          border-radius: 2px;
          outline: none;
          min-width: 0;
          font-family: inherit;
        }
      `}</style>
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  container: {
    width: '100%',
    height: '100%',
    background: 'var(--wb-3)',
    borderRight: '1px solid var(--wb-6)',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    fontSize: 12,
    fontFamily: 'Segoe UI, sans-serif',
    position: 'relative',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '0 8px',
    height: 36,
    borderBottom: '1px solid var(--wb-6)',
    flexShrink: 0,
  },
  title: {
    color: 'var(--wb-11)',
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: 0.5,
  },
  headerBtns: {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
  },
  headerBtn: {
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    padding: '2px 4px',
    borderRadius: 3,
    fontSize: 11,
    fontFamily: 'inherit',
  },
  tree: {
    flex: 1,
    overflowY: 'auto',
    padding: '4px 0',
    scrollbarWidth: 'thin',
    scrollbarColor: 'var(--wb-7) transparent',
  },
  empty: {
    color: 'var(--wb-9)',
    fontSize: 11,
    padding: 12,
  },
  ctxMenu: {
    position: 'fixed',
    background: 'var(--wb-5)',
    border: '1px solid var(--wb-7)',
    borderRadius: 4,
    zIndex: 2000,
    display: 'flex',
    flexDirection: 'column',
    minWidth: 140,
    boxShadow: '0 4px 14px rgba(0,0,0,0.5)',
    overflow: 'hidden',
  },
  ctxBtn: {
    background: 'none',
    border: 'none',
    color: 'var(--wb-12)',
    padding: '7px 14px',
    textAlign: 'left',
    cursor: 'pointer',
    fontSize: 12,
    fontFamily: 'inherit',
  },
  ctxSep: {
    height: 1,
    background: 'var(--wb-7)',
    margin: '2px 0',
  },
};
