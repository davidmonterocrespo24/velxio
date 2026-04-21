import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useEditorStore } from '../../store/useEditorStore';
import { useSimulatorStore } from '../../store/useSimulatorStore';
import type { BoardKind } from '../../types/board';
import { BOARD_KIND_LABELS } from '../../types/board';
import './FileExplorer.css';

// SVG icons — same style as EditorToolbar (stroke-based, 16x16)
const IcoFile = () => (
  <svg
    width="22"
    height="22"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <polyline points="14 2 14 8 20 8" />
  </svg>
);

const IcoHeader = () => (
  <svg
    width="22"
    height="22"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <polyline points="14 2 14 8 20 8" />
    <line x1="9" y1="13" x2="15" y2="13" />
    <line x1="9" y1="17" x2="13" y2="17" />
  </svg>
);

const IcoNewFile = () => (
  <svg
    width="22"
    height="22"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <polyline points="14 2 14 8 20 8" />
    <line x1="12" y1="18" x2="12" y2="12" />
    <line x1="9" y1="15" x2="15" y2="15" />
  </svg>
);

const IcoSave = () => (
  <svg
    width="22"
    height="22"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
    <polyline points="17 21 17 13 7 13 7 21" />
    <polyline points="7 3 7 8 15 8" />
  </svg>
);

const IcoChevron = ({ open }: { open: boolean }) => (
  <svg
    width="12"
    height="12"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    style={{ transform: open ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 0.15s' }}
  >
    <polyline points="9 18 15 12 9 6" />
  </svg>
);

// Board emoji icons — mirrors BoardPickerModal
const BOARD_ICON: Record<BoardKind, string> = {
  'arduino-uno': '⬤',
  'arduino-nano': '▪',
  'arduino-mega': '▬',
  'raspberry-pi-pico': '◆',
  'raspberry-pi-3': '⬛',
  esp32: '⬡',
  'esp32-s3': '⬡',
  'esp32-c3': '⬡',
};

// Color accent per board family
const BOARD_COLOR: Record<BoardKind, string> = {
  'arduino-uno': '#4fc3f7',
  'arduino-nano': '#4fc3f7',
  'arduino-mega': '#4fc3f7',
  'raspberry-pi-pico': '#ce93d8',
  'raspberry-pi-3': '#ef9a9a',
  esp32: '#a5d6a7',
  'esp32-s3': '#a5d6a7',
  'esp32-c3': '#a5d6a7',
};

function FileIcon({ name }: { name: string }) {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (['h', 'hpp'].includes(ext)) return <IcoHeader />;
  return <IcoFile />;
}

interface ContextMenu {
  fileId: string;
  boardGroupId: string;
  x: number;
  y: number;
}

interface FileExplorerProps {
  onSaveClick: () => void;
}

export const FileExplorer: React.FC<FileExplorerProps> = ({ onSaveClick }) => {
  const {
    fileGroups,
    activeFileId,
    activeGroupId,
    openFile,
    createFile,
    deleteFile,
    renameFile,
    setActiveGroup,
  } = useEditorStore();
  const boards = useSimulatorStore((s) => s.boards);
  const activeBoardId = useSimulatorStore((s) => s.activeBoardId);
  const setActiveBoardId = useSimulatorStore((s) => s.setActiveBoardId);

  const [contextMenu, setContextMenu] = useState<ContextMenu | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  // Track which board group is creating a file: boardGroupId or null
  const [creatingInGroup, setCreatingInGroup] = useState<string | null>(null);
  const [newFileName, setNewFileName] = useState('');
  // Collapsed state per board ID
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const renameInputRef = useRef<HTMLInputElement>(null);
  const newFileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (renamingId && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [renamingId]);

  useEffect(() => {
    if (creatingInGroup && newFileInputRef.current) {
      newFileInputRef.current.focus();
    }
  }, [creatingInGroup]);

  // Close context menu on click outside
  useEffect(() => {
    if (!contextMenu) return;
    const handler = () => setContextMenu(null);
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, [contextMenu]);

  const switchToBoard = useCallback(
    (boardId: string, groupId: string) => {
      setActiveBoardId(boardId);
      // setActiveBoardId already calls setActiveGroup internally via the store
      // but we make sure the editor group is also in sync
      setActiveGroup(groupId);
    },
    [setActiveBoardId, setActiveGroup],
  );

  const handleFileClick = useCallback(
    (fileId: string, boardId: string, groupId: string) => {
      if (boardId !== activeBoardId) {
        switchToBoard(boardId, groupId);
      }
      openFile(fileId);
    },
    [activeBoardId, switchToBoard, openFile],
  );

  const handleContextMenu = (e: React.MouseEvent, fileId: string, boardGroupId: string) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ fileId, boardGroupId, x: e.clientX, y: e.clientY });
  };

  const startRename = (fileId: string, groupId: string) => {
    const files = fileGroups[groupId] ?? [];
    const file = files.find((f) => f.id === fileId);
    if (!file) return;
    setRenamingId(fileId);
    setRenameValue(file.name);
    setContextMenu(null);
  };

  const commitRename = useCallback(() => {
    if (renamingId && renameValue.trim()) {
      renameFile(renamingId, renameValue.trim());
    }
    setRenamingId(null);
  }, [renamingId, renameValue, renameFile]);

  const handleDelete = (fileId: string, groupId: string) => {
    setContextMenu(null);
    const files = fileGroups[groupId] ?? [];
    if (files.length <= 1) return;
    if (!window.confirm('Delete this file?')) return;
    deleteFile(fileId);
  };

  const startCreateFile = (boardId: string, groupId: string) => {
    // Switch to this board first so createFile targets the right group
    switchToBoard(boardId, groupId);
    setCreatingInGroup(groupId);
    setNewFileName('');
    setContextMenu(null);
  };

  const commitCreateFile = useCallback(() => {
    const name = newFileName.trim();
    if (name) createFile(name);
    setCreatingInGroup(null);
    setNewFileName('');
  }, [newFileName, createFile]);

  const toggleCollapse = (boardId: string) => {
    setCollapsed((prev) => ({ ...prev, [boardId]: !prev[boardId] }));
  };

  return (
    <div className="file-explorer">
      <div className="file-explorer-header">
        <span className="file-explorer-title">WORKSPACE</span>
        <div className="file-explorer-header-actions">
          <button
            className="file-explorer-save-btn"
            title="Save project (Ctrl+S)"
            onClick={onSaveClick}
          >
            <IcoSave />
          </button>
        </div>
      </div>

      <div className="file-explorer-list">
        {boards.map((board) => {
          const groupId = board.activeFileGroupId;
          const groupFiles = fileGroups[groupId] ?? [];
          const isActiveBoard = board.id === activeBoardId;
          const isOpen = !collapsed[board.id];
          const color = BOARD_COLOR[board.boardKind];

          // Status dot color
          const statusColor = board.running
            ? '#22c55e'
            : board.compiledProgram
              ? '#f59e0b'
              : '#6b7280';

          return (
            <div key={board.id} className="fe-board-section">
              {/* Board section header */}
              <div
                className={`fe-board-header${isActiveBoard ? ' fe-board-header-active' : ''}`}
                onClick={() => {
                  switchToBoard(board.id, groupId);
                  if (!isOpen) toggleCollapse(board.id);
                }}
                title={`${BOARD_KIND_LABELS[board.boardKind]} — click to edit`}
              >
                <button
                  className="fe-collapse-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleCollapse(board.id);
                  }}
                  title={isOpen ? 'Collapse' : 'Expand'}
                >
                  <IcoChevron open={isOpen} />
                </button>

                <span className="fe-board-icon" style={{ color }}>
                  {BOARD_ICON[board.boardKind]}
                </span>

                <span className="fe-board-label">{BOARD_KIND_LABELS[board.boardKind]}</span>

                <span
                  className="fe-status-dot"
                  style={{ background: statusColor }}
                  title={board.running ? 'Running' : board.compiledProgram ? 'Compiled' : 'Idle'}
                />

                {/* New file button — visible on hover */}
                <button
                  className="fe-board-new-btn"
                  title="New file in this board"
                  onClick={(e) => {
                    e.stopPropagation();
                    startCreateFile(board.id, groupId);
                  }}
                >
                  <IcoNewFile />
                </button>
              </div>

              {/* Files under this board */}
              {isOpen && (
                <div className="fe-board-files">
                  {groupFiles.map((file) => {
                    const isActiveFile = isActiveBoard && file.id === activeFileId;
                    return (
                      <div
                        key={file.id}
                        className={`file-explorer-item fe-file-item${isActiveFile ? ' file-explorer-item-active' : ''}`}
                        onClick={() => handleFileClick(file.id, board.id, groupId)}
                        onContextMenu={(e) => handleContextMenu(e, file.id, groupId)}
                        onDoubleClick={() => {
                          switchToBoard(board.id, groupId);
                          startRename(file.id, groupId);
                        }}
                        title={`${file.name}${file.modified ? ' (unsaved)' : ''}`}
                      >
                        <span className="file-explorer-icon">
                          <FileIcon name={file.name} />
                        </span>

                        {renamingId === file.id ? (
                          <input
                            ref={renameInputRef}
                            className="file-explorer-rename-input"
                            value={renameValue}
                            onChange={(e) => setRenameValue(e.target.value)}
                            onBlur={commitRename}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') commitRename();
                              if (e.key === 'Escape') setRenamingId(null);
                            }}
                            onClick={(e) => e.stopPropagation()}
                          />
                        ) : (
                          <span className="file-explorer-name">{file.name}</span>
                        )}

                        {file.modified && (
                          <span className="file-explorer-dot" title="Unsaved changes" />
                        )}
                      </div>
                    );
                  })}

                  {/* Inline new-file input for this group */}
                  {creatingInGroup === groupId && (
                    <div className="file-explorer-item file-explorer-item-new fe-file-item">
                      <span className="file-explorer-icon">
                        <IcoFile />
                      </span>
                      <input
                        ref={newFileInputRef}
                        className="file-explorer-rename-input"
                        value={newFileName}
                        placeholder="filename.ino"
                        onChange={(e) => setNewFileName(e.target.value)}
                        onBlur={commitCreateFile}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') commitCreateFile();
                          if (e.key === 'Escape') {
                            setCreatingInGroup(null);
                            setNewFileName('');
                          }
                        }}
                        onClick={(e) => e.stopPropagation()}
                      />
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}

        {/* Fallback: no boards yet */}
        {boards.length === 0 && (
          <div style={{ color: '#666', fontSize: 11, padding: '12px 12px', lineHeight: 1.5 }}>
            Add a board to the canvas to start editing code.
          </div>
        )}
      </div>

      {contextMenu && (
        <div
          className="file-explorer-context-menu"
          style={{ top: contextMenu.y, left: contextMenu.x }}
          onClick={(e) => e.stopPropagation()}
        >
          <button onClick={() => startRename(contextMenu.fileId, contextMenu.boardGroupId)}>
            Rename
          </button>
          <button
            className="ctx-delete"
            onClick={() => handleDelete(contextMenu.fileId, contextMenu.boardGroupId)}
            disabled={(fileGroups[contextMenu.boardGroupId] ?? []).length <= 1}
          >
            Delete
          </button>
        </div>
      )}
    </div>
  );
};
