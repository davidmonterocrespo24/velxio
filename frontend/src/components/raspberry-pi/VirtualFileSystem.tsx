/**
 * VirtualFileSystem — tree explorer for the Pi's VFS.
 * Supports expand/collapse, file selection, context menu (new/rename/delete),
 * and an "Upload to Pi" button.
 */

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useVfsStore } from '../../store/useVfsStore';
import type { VfsNode } from '../../store/useVfsStore';
import { getBoardBridge } from '../../store/useSimulatorStore';

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
  const color = ext === 'py' ? '#4fc3f7' : ext === 'sh' ? '#a5d6a7' : '#aaa';
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  );
};

const IcoChevron = ({ open }: { open: boolean }) => (
  <svg
    width="10"
    height="10"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    style={{
      transform: open ? 'rotate(90deg)' : 'none',
      transition: 'transform 0.12s',
      flexShrink: 0,
    }}
  >
    <polyline points="9 18 15 12 9 6" />
  </svg>
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

  const handleDelete = (nodeId: string) => {
    setCtxMenu(null);
    const node = getNode(boardId, nodeId);
    if (!node || node.parentId === null) return;
    if (!window.confirm(`Delete "${node.name}"?`)) return;
    if (selectedNodeId === nodeId) setSelectedNode(boardId, null);
    deleteNode(boardId, nodeId);
  };

  const handleUpload = async () => {
    const bridge = getBoardBridge(boardId);
    if (!bridge || !bridge.connected) {
      alert('Pi is not connected. Start the simulation first.');
      return;
    }
    const files = serializeForUpload(boardId);
    if (files.length === 0) return;

    setUploadStatus('uploading');

    const enc = new TextEncoder();
    const send = (text: string) => bridge.sendSerialBytes(Array.from(enc.encode(text)));

    // Ensure clean prompt and root filesystem is mounted read-write
    // (init=/bin/sh boots with rootfs read-only; 'rw' in cmdline fixes it but
    //  we also send the remount just in case)
    send('\n');
    await new Promise((r) => setTimeout(r, 200));
    send('mount -o remount,rw / 2>/dev/null; true\n');
    await new Promise((r) => setTimeout(r, 400));

    for (const { path, content } of files) {
      // Create parent directory if needed
      const dir = path.substring(0, path.lastIndexOf('/'));
      if (dir) {
        send(`mkdir -p ${dir}\n`);
        await new Promise((r) => setTimeout(r, 150));
      }

      // Write file via shell heredoc.
      // Use a unique random delimiter so it never collides with file content.
      const delim = `VELXIO_${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
      const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      // Send the entire heredoc as one string so the shell receives it atomically
      send(`cat > ${path} << '${delim}'\n${normalized}\n${delim}\n`);
      await new Promise((r) => setTimeout(r, 400));

      // Make scripts executable
      if (path.endsWith('.py') || path.endsWith('.sh')) {
        send(`chmod +x ${path}\n`);
        await new Promise((r) => setTimeout(r, 100));
      }
    }

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
    background: '#252526',
    borderRight: '1px solid #333',
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
    borderBottom: '1px solid #333',
    flexShrink: 0,
  },
  title: {
    color: '#9d9d9d',
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
    scrollbarColor: '#3c3c3c transparent',
  },
  empty: {
    color: '#666',
    fontSize: 11,
    padding: 12,
  },
  ctxMenu: {
    position: 'fixed',
    background: '#2d2d2d',
    border: '1px solid #3c3c3c',
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
    color: '#ccc',
    padding: '7px 14px',
    textAlign: 'left',
    cursor: 'pointer',
    fontSize: 12,
    fontFamily: 'inherit',
  },
  ctxSep: {
    height: 1,
    background: '#3c3c3c',
    margin: '2px 0',
  },
};
