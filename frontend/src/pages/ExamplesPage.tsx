/**
 * Examples Page Component
 *
 * Displays the examples gallery
 */

import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ExamplesGallery } from '../components/examples/ExamplesGallery';
import { AppHeader } from '../components/layout/AppHeader';
import { useSEO } from '../utils/useSEO';
import { useEditorStore } from '../store/useEditorStore';
import { useSimulatorStore } from '../store/useSimulatorStore';
import { useVfsStore } from '../store/useVfsStore';
import { isBoardComponent } from '../utils/boardPinMapping';
import { getInstalledLibraries, installLibrary } from '../services/libraryService';
import type { ExampleProject } from '../data/examples';
import type { BoardKind } from '../types/board';

export const ExamplesPage: React.FC = () => {
  useSEO({
    title: 'Arduino Simulator Examples — Run 18+ Sketches Instantly | Velxio',
    description:
      'Explore 18+ interactive Arduino examples with LEDs, sensors, displays, and games. Runs entirely in your browser — free, no install, no account required.',
    url: 'https://velxio.dev/examples',
  });

  const navigate = useNavigate();
  const { setCode } = useEditorStore();
  const { setComponents, setWires, setBoardType, activeBoardId, boards, addBoard, removeBoard, setActiveBoardId } = useSimulatorStore();
  const [installing, setInstalling] = useState<{ total: number; done: number; current: string } | null>(null);

  /** Install any missing libraries required by the example (non-blocking UI). */
  const ensureLibraries = async (libs: string[]): Promise<void> => {
    if (libs.length === 0) return;
    try {
      const installed = await getInstalledLibraries();
      const installedNames = new Set(
        installed.map((l) => (l.library?.name ?? l.name ?? '').toLowerCase())
      );
      const missing = libs.filter((l) => !installedNames.has(l.toLowerCase()));
      if (missing.length === 0) return;

      setInstalling({ total: missing.length, done: 0, current: missing[0] });
      for (let i = 0; i < missing.length; i++) {
        setInstalling({ total: missing.length, done: i, current: missing[i] });
        await installLibrary(missing[i]);
      }
      setInstalling(null);
    } catch {
      // If install fails (e.g. offline), continue anyway — compile will show the error
      setInstalling(null);
    }
  };

  const handleLoadExample = async (example: ExampleProject) => {
    // Auto-install required libraries before loading
    if (example.libraries && example.libraries.length > 0) {
      await ensureLibraries(example.libraries);
    }

    if (example.boards && example.boards.length > 0) {
      // ── Multi-board loading ───────────────────────────────────────────────
      // 1. Remove all current boards
      const currentIds = boards.map((b) => b.id);
      currentIds.forEach((id) => removeBoard(id));

      // 2. Add each board from the example; addBoard returns deterministic IDs
      example.boards.forEach((eb) => {
        addBoard(eb.boardKind as BoardKind, eb.x, eb.y);
      });

      // 3. Load code + VFS per board
      const { boards: newBoards } = useSimulatorStore.getState();
      example.boards.forEach((eb) => {
        const boardId = eb.boardKind; // predictable: first board of each kind = boardKind string
        const board = newBoards.find((b) => b.id === boardId);
        if (!board) return;

        if (eb.code) {
          const filename = boardId === 'arduino-uno' || boardId === 'arduino-nano' || boardId === 'arduino-mega'
            ? 'sketch.ino'
            : 'main.cpp';
          // loadFiles reads activeGroupId internally — switch to this board's group first
          useEditorStore.getState().setActiveGroup(board.activeFileGroupId);
          useEditorStore.getState().loadFiles([{ name: filename, content: eb.code }]);
        }

        if (eb.vfsFiles && boardId === 'raspberry-pi-3') {
          // Update VFS files by name (default tree has script.py and hello.sh)
          const vfsState = useVfsStore.getState();
          const tree = vfsState.getTree(boardId);
          for (const [nodeId, node] of Object.entries(tree)) {
            if (node.type === 'file' && eb.vfsFiles[node.name] !== undefined) {
              vfsState.setContent(boardId, nodeId, eb.vfsFiles[node.name]);
            }
          }
        }
      });

      // 4. Set active board to the first non-Pi board (so editor shows Arduino code)
      const firstArduino = example.boards.find((eb) =>
        eb.boardKind !== 'raspberry-pi-3' && eb.boardKind !== 'esp32' &&
        eb.boardKind !== 'esp32-s3' && eb.boardKind !== 'esp32-c3'
      );
      if (firstArduino) {
        setActiveBoardId(firstArduino.boardKind);
      }

      // 5. Load components (filter out board components — they're placed via boards[])
      const componentsWithoutBoard = example.components.filter(
        (comp) =>
          !comp.type.includes('arduino') &&
          !comp.type.includes('pico') &&
          !comp.type.includes('raspberry') &&
          !comp.type.includes('esp32')
      );
      setComponents(
        componentsWithoutBoard.map((comp) => ({
          id: comp.id,
          metadataId: comp.type.replace('wokwi-', ''),
          x: comp.x,
          y: comp.y,
          properties: comp.properties,
        }))
      );

      // 6. Load wires — componentIds already match board instance IDs
      setWires(
        example.wires.map((wire) => ({
          id: wire.id,
          start: { componentId: wire.start.componentId, pinName: wire.start.pinName, x: 0, y: 0 },
          end:   { componentId: wire.end.componentId,   pinName: wire.end.pinName,   x: 0, y: 0 },
          color: wire.color,
          waypoints: [],
        }))
      );
    } else {
      // ── Single-board loading (original behaviour) ─────────────────────────
      const targetBoard = example.boardType || 'arduino-uno';
      setBoardType(targetBoard);
      setCode(example.code);

      const componentsWithoutBoard = example.components.filter(
        (comp) =>
          !comp.type.includes('arduino') &&
          !comp.type.includes('pico') &&
          !comp.type.includes('esp32')
      );
      setComponents(
        componentsWithoutBoard.map((comp) => ({
          id: comp.id,
          metadataId: comp.type.replace('wokwi-', ''),
          x: comp.x,
          y: comp.y,
          properties: comp.properties,
        }))
      );

      const boardInstanceId = activeBoardId ?? 'arduino-uno';
      const remapBoardId = (id: string) => isBoardComponent(id) ? boardInstanceId : id;

      setWires(
        example.wires.map((wire) => ({
          id: wire.id,
          start: { componentId: remapBoardId(wire.start.componentId), pinName: wire.start.pinName, x: 0, y: 0 },
          end:   { componentId: remapBoardId(wire.end.componentId),   pinName: wire.end.pinName,   x: 0, y: 0 },
          color: wire.color,
          waypoints: [],
        }))
      );
    }

    navigate('/editor');
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh', background: '#1e1e1e' }}>
      <AppHeader />
      <ExamplesGallery onLoadExample={handleLoadExample} />

      {/* Library install overlay */}
      {installing && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 9999,
          background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(4px)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <div style={{
            background: '#1e1e1e', border: '1px solid #333', borderRadius: 12,
            padding: '28px 36px', textAlign: 'center', maxWidth: 360,
          }}>
            <div style={{ fontSize: 14, color: '#ccc', marginBottom: 12 }}>
              Installing libraries ({installing.done + 1}/{installing.total})
            </div>
            <div style={{ fontSize: 16, color: '#00e5ff', fontWeight: 600, marginBottom: 16 }}>
              {installing.current}
            </div>
            <div style={{
              height: 4, borderRadius: 2, background: '#333', overflow: 'hidden',
            }}>
              <div style={{
                height: '100%', borderRadius: 2, background: '#00b8d4',
                width: `${((installing.done + 1) / installing.total) * 100}%`,
                transition: 'width 0.3s ease',
              }} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
