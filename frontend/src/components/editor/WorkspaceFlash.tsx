import { useCallback, useEffect, useId, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { boardFlashSupport, OPEN_FLASH_EVENT, type OpenFlashDetail } from '../../lib/flashRequest';
import { hardwareFlashAllowed, onWebFlashImplChange } from '../../lib/proWebFlash';
import { hasSelectedBrowserFlashPort, subscribeBrowserFlashSelection } from '../../lib/browserFlashSerial';
import { useProjectStore } from '../../store/useProjectStore';
import { useSimulatorStore } from '../../store/useSimulatorStore';
import { boardDisplayName, fqbnForLanguage, type BoardInstance } from '../../types/board';
import { isEsp32Family } from '../../types/boardOptions';
import { currentSourceFingerprint } from '../../utils/boardCompile';
import { BoardOptionsModal } from '../simulator/BoardOptionsModal';
import { FlashControls } from '../simulator/FlashControls';
import { DropdownSelect } from '../ui/DropdownSelect';

export function WorkspaceFlash({ active, onOpen, onShowOutput }: {
  active: boolean;
  onOpen: () => void;
  onShowOutput: () => void;
}) {
  const { t } = useTranslation();
  const boardLabelId = useId();
  const boards = useSimulatorStore((s) => s.boards);
  const activeBoardId = useSimulatorStore((s) => s.activeBoardId);
  const updateBoard = useSimulatorStore((s) => s.updateBoard);
  const [targetId, setTargetId] = useState<string | null>(null);
  const [visited, setVisited] = useState(active);
  const [busy, setBusy] = useState(false);
  const [editingOptions, setEditingOptions] = useState(false);
  const [, setFlasherVersion] = useState(0);
  useEffect(() => onWebFlashImplChange(() => setFlasherVersion((version) => version + 1)), []);
  useEffect(() => { if (active) setVisited(true); }, [active]);

  useEffect(() => {
    const open = (event: Event) => {
      const id = (event as CustomEvent<OpenFlashDetail>).detail?.boardId ?? useSimulatorStore.getState().activeBoardId;
      if (!busy) {
        setTargetId(id);
        setEditingOptions(false);
      }
      onOpen();
    };
    window.addEventListener(OPEN_FLASH_EVENT, open);
    return () => window.removeEventListener(OPEN_FLASH_EVENT, open);
  }, [busy, onOpen]);

  const supportedBoards = boards.filter((board) => !boardFlashSupport(board).disabled);
  const activeBoard = boards.find((item) => item.id === activeBoardId);
  const board = boards.find((item) => item.id === targetId)
    ?? supportedBoards.find((item) => item.id === activeBoardId)
    ?? supportedBoards[0]
    ?? activeBoard
    ?? boards[0];
  const support = boardFlashSupport(board);
  const fqbn = board && fqbnForLanguage(board.boardKind, board.languageMode);
  const boardId = board?.id;
  const workspaceVersion = useProjectStore((s) => s.workspaceVersion);
  const portSelected = useSyncExternalStore(
    subscribeBrowserFlashSelection,
    () => !!boardId && hasSelectedBrowserFlashPort({ boardId, workspaceVersion }),
    () => false,
  );
  const allowed = hardwareFlashAllowed();
  const reportBusy = useCallback((running: boolean) => {
    if (running && boardId) setTargetId(boardId);
    setBusy(running);
  }, [boardId]);
  useEffect(() => {
    if (!board || support.disabled) setBusy(false);
  }, [board, support.disabled]);

  if (!active && !visited) return null;

  const boardLabel = (item: BoardInstance) => {
    const name = boardDisplayName(item);
    return boards.some((other) => other.id !== item.id && boardDisplayName(other) === name)
      ? `${name} (${item.id})`
      : name;
  };

  return (
    <section className={`workspace-sidebar-view workspace-flash${board ? ' workspace-flash--has-board' : ''}`} hidden={!active}>
      <div className="workspace-flash-header">
        <header className="workspace-sidebar-header">
          <h2 className="workspace-sidebar-title">{t('editor.toolbar.flash.label', 'Flash')}</h2>
        </header>
        {allowed && support.route === 'web' && !support.disabled && (
          <div className="workspace-flash-notice" role="status">
            <strong>{t('editor.flash.webIntro')}</strong>
            <p>{t('editor.flash.browserPortInstructions')}</p>
            {support.micropython && <p>{t('editor.flash.mpyTwoSteps')}</p>}
          </div>
        )}
        {allowed && support.route === 'web' && !support.disabled && <hr className="workspace-flash-divider" />}
      </div>
      {board ? (
        <>
          <div className="workspace-flash-field">
            <span id={boardLabelId}>{t('editor.flash.targetBoard', 'Board')}</span>
            <DropdownSelect aria-labelledby={boardLabelId} value={board.id} disabled={busy}
              onValueChange={(id) => { setTargetId(id); setEditingOptions(false); }}>
              {boards.map((item) => <option key={item.id} value={item.id}>{boardLabel(item)}</option>)}
            </DropdownSelect>
          </div>
          {activeBoard && activeBoard.id !== board.id && (
            <div className="workspace-flash-feedback workspace-flash-feedback--warning" role="status">
              {t('editor.flash.differentActiveBoard', 'Toolbar Compile targets {{activeBoard}}. Flash targets {{targetBoard}}.', {
                activeBoard: boardLabel(activeBoard), targetBoard: boardLabel(board),
              })}
            </div>
          )}
          {fqbn && !support.disabled ? (
            <FlashControls key={board.id} board={board} fqbn={fqbn} hasSelectedPort={portSelected}
              editingOptions={editingOptions} onBusyChange={reportBusy} onShowOutput={onShowOutput}>
              {allowed && isEsp32Family(board.boardKind) && !support.micropython && !busy && (
                editingOptions ? (
                  <BoardOptionsModal key={board.id} isOpen inline boardId={board.id} boardKind={board.boardKind}
                    currentOptions={board.boardOptions} spiffsFiles={board.spiffsFiles ?? []}
                    onClose={() => setEditingOptions(false)}
                    onApply={(boardOptions) => updateBoard(board.id, {
                      boardOptions,
                      compiledSourceHash: board.compiledSourceHash ?? currentSourceFingerprint(board),
                    })}
                    onSpiffsChange={(spiffsFiles) => updateBoard(board.id, { spiffsFiles })} />
                ) : (
                  <button type="button" className="workspace-flash-button" onClick={() => setEditingOptions(true)}>
                    {t('editor.flash.advancedOptions', 'Advanced settings')}
                  </button>
                )
              )}
            </FlashControls>
          ) : (
            <p>{support.micropython && support.route === 'web'
              ? t('editor.flash.mpyUnavailable')
              : t('editor.toolbar.flash.unavailable', 'Flashing is unavailable for this board in this browser')}</p>
          )}
        </>
      ) : (
        <p className="workspace-sidebar-empty">{t('editor.toolbar.flash.noBoard', 'Add a board to use Flash')}</p>
      )}
    </section>
  );
}
