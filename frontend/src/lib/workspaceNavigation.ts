import { useEditorStore } from '../store/useEditorStore';
import { useSimulatorStore } from '../store/useSimulatorStore';

export function revealWorkspaceFile(
  groupId: string,
  fileId: string,
  position: { lineNumber: number; column: number },
): boolean {
  const editor = useEditorStore.getState();
  if (!editor.getGroupFiles(groupId).some((file) => file.id === fileId)) return false;
  const simulator = useSimulatorStore.getState();
  const board = simulator.boards.find((item) => item.activeFileGroupId === groupId);
  if (board && simulator.activeBoardId !== board.id) simulator.setActiveBoardId(board.id);
  editor.setActiveGroup(groupId);
  useEditorStore.getState().openFile(fileId);
  editor.setRevealLocation({ groupId, fileId, position });
  return true;
}
