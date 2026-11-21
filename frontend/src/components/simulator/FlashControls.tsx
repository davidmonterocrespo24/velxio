/** Hardware upload controls embedded in the workspace sidebar. */

import { DropdownSelect } from '../ui/DropdownSelect';
import { Usb } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { boardDisplayName, type BoardInstance } from '../../types/board';
import { useCompileLogsStore } from '../../store/useCompileLogsStore';
import type { CompilationLog } from '../../utils/compilationLogger';
import { useSimulatorStore } from '../../store/useSimulatorStore';
import { isTauri, listSerialPorts, type SerialPortInfo } from '../../desktop/tauriBridge';
import { UNO_UPLOAD_BAUD_RATE, UNO_UPLOAD_BAUD_RATES } from '../../lib/arduinoUnoWebFlash';
import { streamFlash } from '../../services/flashService';
import {
  getWebFlashImpl,
  webFlashMpyAvailable,
  webFlashBootloaderHint,
  webFlashHardwareRevisions,
  isNotInBootloaderError,
  hardwareFlashAllowed,
  hardwareFlashUpgradeUrl,
  type BootloaderHint,
  type HardwareRevision,
  type WebFlashRequest,
  type WebFlashImpl,
} from '../../lib/proWebFlash';
import { openExternal } from '../../desktop/tauriBridge';
import { isFlashPortSelectionCancelled } from '../../lib/flashRequest';
import { hasSelectedBrowserFlashPort } from '../../lib/browserFlashSerial';
import { withHardwareSerialFlash } from '../../lib/hardwareSerial';
import { useEditorStore } from '../../store/useEditorStore';
import { fingerprintSources } from '../../utils/sourceFingerprint';
import { useProjectStore } from '../../store/useProjectStore';
import {
  compileBoardForFlash,
  currentSourceFingerprint,
} from '../../utils/boardCompile';
import {
  canSaveToDrive,
  downloadUf2,
  fqbnUsesUf2,
  saveUf2ToDrive,
  uf2FileName,
} from '../../utils/uf2Download';

interface Props {
  board: BoardInstance;
  fqbn: string;
  hasSelectedPort: boolean;
  editingOptions: boolean;
  onBusyChange: (busy: boolean) => void;
  onShowOutput: () => void;
  children?: ReactNode;
}

type FlashState =
  | { kind: 'loading-ports' }
  | { kind: 'picking' }
  /** `downloaded`: the .uf2 just saved from this panel (RP2 boards); `drive` = onto the board's drive. */
  | { kind: 'web-ready'; downloaded?: string; drive?: string; portSelectionCancelled?: boolean }
  | { kind: 'choosing-web-port' }
  /** Web, no flasher for this kind, but a .uf2 to hand over (RP2 boards). */
  | { kind: 'download-only'; downloaded?: string; drive?: string }
  | { kind: 'compiling'; port: string | null }
  | { kind: 'flashing'; port: string; progress: number }
  | { kind: 'success'; port: string; elapsedMs: number }
  | {
      kind: 'error';
      port: string | null;
      message: string;
      stage: 'compile' | 'flash';
      /** The board was not in bootloader mode: show the bootloader panel. */
      notInBootloader?: boolean;
    };

/** Progress of the optional "reboot into bootloader" step. */
type BootStatus = { phase: 'idle' | 'busy' | 'done' | 'failed'; message?: string };

function hasCompiledSketch(board: BoardInstance, hash: string) {
  return !!board.compiledProgram && (!board.compiledSourceHash || board.compiledSourceHash === hash);
}

export const FlashControls = ({ board: boardProp, fqbn, hasSelectedPort, editingOptions, onBusyChange, onShowOutput, children }: Props) => {
  const { t } = useTranslation();
  // Read the board LIVE from the store: a compile inside this panel updates
  // compiledProgram / compiledSourceHash and the prop would go stale.
  const board =
    useSimulatorStore((s) => s.boards.find((b) => b.id === boardProp.id)) ?? boardProp;
  const [baudRate, setBaudRate] = useState(UNO_UPLOAD_BAUD_RATE);
  const baudRateId = useId();
  const workspaceVersion = useProjectStore((s) => s.workspaceVersion);
  const [state, setState] = useState<FlashState>({ kind: 'loading-ports' });
  const boardName = boardDisplayName(board);
  const writeOutput = useCallback((message: string, type: CompilationLog['type'] = 'info') => {
    if (useProjectStore.getState().workspaceVersion !== workspaceVersion) return;
    useCompileLogsStore.getState().appendLogs([{
      timestamp: new Date(),
      type,
      message,
      source: 'flash',
      target: { id: board.id, label: boardName, kind: 'board' },
    }]);
  }, [board.id, boardName, workspaceVersion]);
  const isDesktop = isTauri();
  const [ports, setPorts] = useState<SerialPortInfo[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [preparedPort, setPreparedPort] = useState<{ impl: WebFlashImpl; upload: WebFlashImpl['flash'] | void; tracked: boolean } | null>(null);
  const [bootStatus, setBootStatus] = useState<BootStatus>({ phase: 'idle' });
  const busy = state.kind === 'choosing-web-port' || state.kind === 'compiling' || state.kind === 'flashing' || bootStatus.phase === 'busy';
  const runningUpload = state.kind === 'compiling' || state.kind === 'flashing';
  const resultMessage = state.kind === 'error' ? state.message : state.kind === 'success'
    ? t('editor.flash.success', { seconds: (state.elapsedMs / 1000).toFixed(1) })
    : null;
  const resultType = state.kind === 'error' ? 'error' : 'success';
  useEffect(() => onBusyChange(busy), [busy, onBusyChange]);
  useEffect(() => {
    if (runningUpload) onShowOutput();
  }, [runningUpload, onShowOutput]);
  useEffect(() => {
    if (resultMessage) {
      writeOutput(resultMessage, resultType);
      onShowOutput();
    }
  }, [resultMessage, resultType, writeOutput, onShowOutput]);
  // Web Serial mode: the pro overlay's flasher handles this board in
  // this browser (the impl is installed before any modal can open).
  const webImpl = isDesktop ? null : getWebFlashImpl(board.boardKind);
  const isWebMode = !!webImpl;
  // MicroPython projects use the firmware-install + raw-REPL upload path.
  const isMpy = board.languageMode === 'micropython';
  const canConnect = !isMpy && !!webImpl?.preparePort;
  const connectedPort = preparedPort?.impl === webImpl && (!preparedPort.tracked || hasSelectedPort) ? preparedPort : null;
  const hasConnection = hasSelectedPort || !!connectedPort;
  const mpyWebOk = isMpy && !isTauri() && webFlashMpyAvailable(board.boardKind);
  // RP2040 / RP2350: picotool and the BOOTSEL drive take a .uf2, not the
  // raw .bin the emulator runs, so the flash needs `compiledUf2`.
  const usesUf2 = fqbnUsesUf2(fqbn);
  // Hardware revisions of this kind (a Unicorn with a Pico W vs a Pico 2 W
  // aboard). The first one is what the simulator runs; picking another
  // builds a second image for the flash only, never for the emulator.
  const revisions: HardwareRevision[] | null = webFlashHardwareRevisions(board.boardKind);
  const [revisionId, setRevisionId] = useState<string | null>(
    () => board.flashRevision ?? revisions?.[0]?.id ?? null,
  );
  const activeRevision = revisions?.find((r) => r.id === revisionId) ?? null;
  const hwFqbn = activeRevision?.fqbn ?? fqbn;
  const isAltRevision = hwFqbn !== fqbn;
  const hwUsesUf2 = fqbnUsesUf2(hwFqbn);
  const sourceHash = useEditorStore((store) => fingerprintSources(board, store.fileGroups[board.activeFileGroupId] ?? []));
  // The alternate-revision build lives here, not in the store: the emulator
  // must never pick up an RP2040 image for a board it runs as RP2350.
  const altBuildRef = useRef<{ fqbn: string; hash: string; program: string; uf2: string | null } | null>(null);
  const pickRevision = useCallback(
    (id: string) => {
      setRevisionId(id);
      useSimulatorStore.getState().updateBoard(board.id, { flashRevision: id });
    },
    [board.id],
  );
  // Bootloader step (RP2 BOOTSEL and the like), if the flasher wants one.
  const bootloaderHint: BootloaderHint | null = isWebMode
    ? webFlashBootloaderHint(board.boardKind)
    : null;
  // Abort handle for an in-flight web flash (the Cancel action stops the upload).
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => () => abortRef.current?.abort(), []);

  // ── Initial state: enumerate ports (desktop) or arm the web flow ──
  useEffect(() => {
    if (!isTauri()) {
      // Web Serial's requestPort() must run from a user gesture, so the
      // web flow can't start here — it waits on "Connect & Flash".
      setState(
        isWebMode
          ? { kind: 'web-ready' }
          : usesUf2 && !isMpy
            ? { kind: 'download-only' }
            : {
                kind: 'error',
                port: null,
                message: t('editor.flash.needsDesktop'),
                stage: 'flash',
              },
      );
      return;
    }
    let cancelled = false;
    void (async () => {
      const ports = await listSerialPorts();
      if (cancelled) return;
      setPorts(ports);
      setSelectedPath(ports[0]?.path ?? null);
      setState({ kind: 'picking' });
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isWebMode]);

  const readyProgram = useCallback((live: BoardInstance, hash: string) => {
    if (isAltRevision) {
      const build = altBuildRef.current;
      return build?.fqbn === hwFqbn && build.hash === hash && (!hwUsesUf2 || build.uf2) ? build.program : null;
    }
    if (!hasCompiledSketch(live, hash) || (hwUsesUf2 && !live.compiledUf2)) return null;
    return live.compiledProgram ?? null;
  }, [isAltRevision, hwFqbn, hwUsesUf2]);
  const getReadyProgram = useCallback(() => {
    const live = useSimulatorStore.getState().boards.find((item) => item.id === board.id);
    return live ? readyProgram(live, currentSourceFingerprint(live)) : null;
  }, [board.id, readyProgram]);
  const needsCompile = !isMpy && !hasCompiledSketch(board, sourceHash);

  const compileProgram = useCallback(
    async (port: string | null): Promise<string | null> => {
      const live = useSimulatorStore.getState().boards.find((item) => item.id === board.id);
      if (!live) return null;
      const hash = currentSourceFingerprint(live);
      setState({ kind: 'compiling', port });
      const push = (line: string) => {
        if (!abortRef.current?.signal.aborted) writeOutput(line);
      };
      push(
        isAltRevision
          ? t('editor.flash.log.compilingRevision', { revision: activeRevision?.label ?? hwFqbn })
          : live.compiledProgram
            ? t('editor.flash.log.rebuildStarted')
            : t('editor.flash.log.buildStarted'),
      );
      const outcome = await compileBoardForFlash(
        live,
        push,
        isAltRevision ? { fqbn: hwFqbn, record: false } : {},
      );
      if (abortRef.current?.signal.aborted) return null;
      if (!outcome.ok) {
        setState({
          kind: 'error',
          port,
          message: t('editor.flash.compileFailed', { error: outcome.error }),
          stage: 'compile',
        });
        return null;
      }
      if (hwUsesUf2 && !outcome.uf2) {
        setState({ kind: 'error', port, message: t('editor.flash.noUf2'), stage: 'compile' });
        return null;
      }
      push(t('editor.flash.log.buildSucceeded', { seconds: (outcome.elapsedMs / 1000).toFixed(1) }));
      if (isAltRevision) {
        altBuildRef.current = {
          fqbn: hwFqbn,
          hash,
          program: outcome.program,
          uf2: outcome.uf2,
        };
      }
      return outcome.program;
    },
    [board.id, t, isAltRevision, hwFqbn, hwUsesUf2, activeRevision, writeOutput],
  );

  /**
   * The bytes real hardware takes: the .uf2 for RP2 boards (null when the
   * build has none), the program itself for everyone else. An alternate
   * revision's build comes from the panel's own copy.
   */
  const hardwareProgram = useCallback(
    (program: string): string | null => {
      if (isAltRevision) {
        const alt = altBuildRef.current;
        if (!alt) return null;
        return hwUsesUf2 ? alt.uf2 : alt.program;
      }
      if (!usesUf2) return program;
      const live = useSimulatorStore.getState().boards.find((b) => b.id === board.id);
      return live?.compiledUf2 ?? null;
    },
    [board.id, usesUf2, isAltRevision, hwUsesUf2],
  );

  const refreshPorts = useCallback(async (preferredPort?: string | null) => {
    setState({ kind: 'loading-ports' });
    const ports = await listSerialPorts();
    setPorts(ports);
    setSelectedPath(ports.find((port) => port.path === preferredPort)?.path ?? ports[0]?.path ?? null);
    setState({ kind: 'picking' });
  }, []);

  const returnToSetup = useCallback((port?: string | null) => {
    setBootStatus({ phase: 'idle' });
    if (isTauri()) void refreshPorts(port);
    else setState(isWebMode ? { kind: 'web-ready' } : { kind: 'download-only' });
  }, [isWebMode, refreshPorts]);

  // The toolbar builds the sketch. A separate hardware revision or a legacy build
  // without a UF2 can still require an image specifically for the upload.
  const getUploadProgram = useCallback(async (port: string | null) => {
    const program = getReadyProgram();
    if (program || (!isAltRevision && !hwUsesUf2)) return program;
    const live = useSimulatorStore.getState().boards.find((item) => item.id === board.id);
    if (!live || !hasCompiledSketch(live, currentSourceFingerprint(live))) return null;
    return compileProgram(port);
  }, [getReadyProgram, isAltRevision, hwUsesUf2, board.id, compileProgram]);

  // ── Trigger the flash ────────────────────────────────────────────
  const doFlash = useCallback(
    async (port: string) => {
      const program = await getUploadProgram(port);
      if (!program) return;
      // picotool programs RP2 boards from the .uf2; handing it the raw .bin
      // under a .uf2 name is refused ("does not contain a valid RP2
      // executable image"), so a build without one stops here.
      const programData = hardwareProgram(program);
      if (!programData) {
        setState({
          kind: 'error',
          port,
          message: t('editor.flash.noUf2'),
          stage: 'flash',
        });
        return;
      }
      writeOutput(t('editor.flash.flashingOn', { port }));
      setState({ kind: 'flashing', port, progress: 0 });

      const fmt = formatForFqbn(hwFqbn);
      try {
        for await (const ev of streamFlash({
          boardId: board.id,
          port,
          fqbn: hwFqbn,
          programFormat: fmt,
          programData,
        })) {
          if (ev.phase === 'done') {
            if (ev.success) {
              setState({
                kind: 'success',
                port,
                elapsedMs: ev.elapsed_ms,
              });
            } else {
              setState({
                kind: 'error',
                port,
                message: ev.error,
                stage: 'flash',
              });
            }
            return;
          }
          if ('line' in ev) {
            writeOutput(ev.line);
          }
          setState((prev) => {
            if (prev.kind !== 'flashing') return prev;
            return {
              ...prev,
              progress: ev.phase === 'writing' && ev.progress !== undefined
                ? ev.progress
                : prev.progress,
            };
          });
        }
      } catch (err) {
        setState({
          kind: 'error',
          port,
          message: err instanceof Error ? err.message : String(err),
          stage: 'flash',
        });
      }
    },
    [board.id, hwFqbn, getUploadProgram, hardwareProgram, t, writeOutput],
  );

  // ── Download the .uf2 (RP2 boards; every browser) ────────────────
  // `toDrive`: write it onto the BOOTSEL drive through the File System
  // Access API instead of the downloads folder (Chromium only).
  const doDownload = useCallback(
    async (toDrive = false) => {
      const program = getReadyProgram();
      if (!program) {
        if (await getUploadProgram(null)) returnToSetup();
        return;
      }
      const uf2 = hardwareProgram(program);
      if (!uf2) {
        setState({
          kind: 'error',
          port: null,
          message: t('editor.flash.noUf2'),
          stage: 'flash',
        });
        return;
      }
      const fileName = uf2FileName(
        useProjectStore.getState().currentProject?.slug ?? board.name,
        board.boardKind,
      );
      let drive: string | undefined;
      if (toDrive) {
        try {
          drive = (await saveUf2ToDrive(uf2, fileName)).drive;
        } catch (err) {
          if (err instanceof DOMException && err.name === 'AbortError') {
            // The picker was dismissed: nothing happened.
            setState(isWebMode ? { kind: 'web-ready' } : { kind: 'download-only' });
            return;
          }
          setState({
            kind: 'error',
            port: null,
            message: err instanceof Error ? err.message : String(err),
            stage: 'flash',
          });
          return;
        }
      } else {
        downloadUf2(uf2, fileName);
      }
      // Back to the view this browser started from: a flasher-capable browser
      // keeps its Connect & flash button, the download-only one its copy.
      setState(
        isWebMode
          ? { kind: 'web-ready', downloaded: fileName, drive }
          : { kind: 'download-only', downloaded: fileName, drive },
      );
    },
    [board.boardKind, board.name, getReadyProgram, getUploadProgram, returnToSetup, hardwareProgram, isWebMode, t],
  );

  // ── Reboot into the bootloader (pro overlay backend, RP2 boards) ──
  const doEnterBootloader = useCallback(async () => {
    const impl = getWebFlashImpl(board.boardKind);
    const enterBootloader = impl?.enterBootloader;
    if (!enterBootloader) return;
    setBootStatus({ phase: 'busy', message: t('editor.flash.bootloader.rebooting') });
    try {
      await withHardwareSerialFlash(() => enterBootloader.call(impl, board.boardKind, (p) => {
        if (p.line) setBootStatus({ phase: 'busy', message: p.line });
      }));
      setBootStatus({ phase: 'done', message: t('editor.flash.bootloader.rebooted') });
    } catch (err) {
      if (isFlashPortSelectionCancelled(err)) {
        setBootStatus({ phase: 'idle' });
        return;
      }
      const error = err instanceof Error ? err.message : String(err);
      setBootStatus({ phase: 'failed', message: t('editor.flash.bootloader.failed', { error }) });
    }
  }, [board.boardKind, t]);

  const doConnect = async () => {
    if (!webImpl?.preparePort || busy || editingOptions || abortRef.current) return;
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const target = { boardId: board.id, workspaceVersion };
    setState({ kind: 'choosing-web-port' });
    try {
      const upload = await webImpl.preparePort(board.boardKind, target, hasConnection);
      if (ctrl.signal.aborted) return;
      setPreparedPort({ impl: webImpl, upload, tracked: hasSelectedBrowserFlashPort(target) });
      setState({ kind: 'web-ready' });
    } catch (err) {
      if (ctrl.signal.aborted) return;
      if (isFlashPortSelectionCancelled(err, true)) {
        setState({ kind: 'web-ready', portSelectionCancelled: true });
      } else {
        setState({ kind: 'error', port: null, message: err instanceof Error ? err.message : String(err), stage: 'flash' });
      }
    } finally {
      abortRef.current = null;
    }
  };

  // ── Trigger a Web Serial flash (pro overlay backend) ─────────────
  const doWebFlash = useCallback(async () => {
    const impl = webImpl;
    if (!impl || busy || editingOptions || abortRef.current || needsCompile || (canConnect && !hasConnection)) return;
    let program = isMpy ? null : getReadyProgram();
    if (!program && !isMpy && !canConnect) {
      // Uploaders with a built-in chooser need their own click after a hardware build.
      if (await getUploadProgram(null)) returnToSetup();
      return;
    }
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const onProgress = (p: { phase: string; pct: number; line?: string }) => {
      if (ctrl.signal.aborted) return;
      if (p.line) {
        writeOutput(p.line);
      }
      setState((prev) => {
        if (prev.kind !== 'flashing') return prev;
        return {
          ...prev,
          // Seam reports 0-100; the bar renders 0-1 like the SSE path.
          progress:
            p.phase === 'writing' || p.phase === 'uploading'
              ? p.pct / 100
              : prev.progress,
        };
      });
    };
    try {
      let preparedFlash = connectedPort?.upload;
      if (!isMpy) {
        if (!program) program = await getUploadProgram(null);
        if (!program || ctrl.signal.aborted) return;
        const target = { boardId: board.id, workspaceVersion };
        if (connectedPort?.tracked && !hasSelectedBrowserFlashPort(target)) {
          returnToSetup();
          return;
        }
        if (canConnect && !connectedPort) {
          if (!hasSelectedBrowserFlashPort(target)) {
            returnToSetup();
            return;
          }
          preparedFlash = await impl.preparePort?.(board.boardKind, target);
          if (ctrl.signal.aborted) return;
        }
      }
      const port = 'Web Serial';
      writeOutput(t('editor.flash.flashingOn', { port }));
      setState({ kind: 'flashing', port, progress: 0 });
      const flashRequest: WebFlashRequest = {
        boardId: board.id,
        boardKind: board.boardKind,
        fqbn: hwFqbn,
        // AVR boards carry Intel HEX text in the compiled-program field.
        binaryBase64: (program && hardwareProgram(program)) ?? program ?? '',
        ...(board.boardKind === 'arduino-uno' ? { baudRate } : {}),
        signal: ctrl.signal,
        onProgress,
      };
      const result = await withHardwareSerialFlash(() => {
        ctrl.signal.throwIfAborted();
        if (isMpy && impl.flashMicroPython) {
          return impl.flashMicroPython({
            boardId: board.id,
            boardKind: board.boardKind,
            // Match MicroPython Run by uploading the board's workspace group.
            files: useEditorStore
              .getState()
              .getGroupFiles(board.activeFileGroupId)
              .map((f) => ({ name: f.name, content: f.content })),
            signal: ctrl.signal,
            onProgress,
          });
        }
        return preparedFlash ? preparedFlash(flashRequest) : impl.flash(flashRequest);
      });
      if (ctrl.signal.aborted) return;
      setState({
        kind: 'success',
        port: result.chipName,
        elapsedMs: result.elapsedMs,
      });
    } catch (err) {
      if (ctrl.signal.aborted) return;
      if (isFlashPortSelectionCancelled(err)) {
        setState({ kind: 'web-ready', portSelectionCancelled: true });
        return;
      }
      setState({
        kind: 'error',
        port: null,
        message: err instanceof Error ? err.message : String(err),
        stage: 'flash',
        notInBootloader: isNotInBootloaderError(err),
      });
    } finally {
      abortRef.current = null;
      if (ctrl.signal.aborted) {
        setState({ kind: 'web-ready' });
        writeOutput(t('editor.flash.cancelled', 'Flash cancelled.'), 'warning');
      }
    }
  }, [webImpl, busy, editingOptions, needsCompile, canConnect, hasConnection, connectedPort, board.id, board.boardKind,
    board.activeFileGroupId, isMpy, getReadyProgram, getUploadProgram, returnToSetup, baudRate, hardwareProgram,
    hwFqbn, workspaceVersion, writeOutput, t]);

  // ── Render ──────────────────────────────────────────────────────
  // Entitlement (desktop: paid license only — see lib/proWebFlash.ts).
  const flashAllowed = hardwareFlashAllowed();
  const flashDisabled = busy || editingOptions || needsCompile || (canConnect && !hasConnection) ||
    (isDesktop && (!selectedPath || state.kind === 'loading-ports')) || (isWebMode && isMpy && !mpyWebOk);

  const unoWeb = flashAllowed && isWebMode && board.boardKind === 'arduino-uno';

  return (
    <div className="workspace-flash-controls">
      {unoWeb && (
        <p className="workspace-flash-transport">
          <Usb size={14} aria-hidden="true" />
          <span>{t('editor.flash.unoTransport', 'USB Serial · STK500v1 · {{baud}} baud', { baud: baudRate })}</span>
        </p>
      )}
      {!flashAllowed && <PaidGateView />}

      {flashAllowed &&
        revisions &&
        (state.kind === 'web-ready' ||
          state.kind === 'download-only' ||
          state.kind === 'picking') && (
          <div className="workspace-flash-field">
            <span>{t('editor.flash.revision')}</span>
            <DropdownSelect
              aria-label={t('editor.flash.revision')}
              value={revisionId ?? ''}
              onValueChange={(value) => pickRevision(value)}
              disabled={editingOptions}
            >
              {revisions.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label}
                </option>
              ))}
            </DropdownSelect>
          </div>
        )}

      {canConnect && hasConnection && flashAllowed && (
        <p className="workspace-flash-connection" role="status">{t('editor.flash.selectedPortHint')}</p>
      )}

      {flashAllowed && needsCompile && !busy && (
        <BuildNotice status={board.compiledProgram ? 'stale' : 'none'} />
      )}

      {flashAllowed && isDesktop && state.kind !== 'loading-ports' && (
        <PortPicker ports={ports} selected={selectedPath} disabled={busy || editingOptions} onSelect={setSelectedPath} />
      )}

      {flashAllowed && (isWebMode || isDesktop) && (
        <div className="workspace-flash-actions">
          {canConnect && (
            <button type="button" className="workspace-flash-button" disabled={busy || editingOptions} onClick={() => void doConnect()}>
              {hasConnection ? t('editor.flash.changePort') : t('editor.flash.connect')}
            </button>
          )}
          {isDesktop && (
            <button type="button" className="workspace-flash-button" disabled={busy || editingOptions || state.kind === 'loading-ports'}
              onClick={() => void refreshPorts(selectedPath)}>{t('editor.flash.refreshPorts')}</button>
          )}
          <button type="button" className="workspace-flash-button workspace-flash-button-primary" disabled={flashDisabled}
            onClick={() => isWebMode ? void doWebFlash() : selectedPath && void doFlash(selectedPath)}>
            {isWebMode && !canConnect ? t('editor.flash.connectFlash') : t('editor.flash.flash')}
          </button>
        </div>
      )}

      {unoWeb && (
        <details className="workspace-flash-advanced">
          <summary>{t('editor.flash.advancedOptions')}</summary>
          <div className="workspace-flash-advanced-fields">
            <dl>
              <dt>{t('editor.flash.uploadProtocol')}</dt><dd>STK500v1</dd>
            </dl>
            <div className="workspace-flash-field">
              <span id={baudRateId}>{t('editor.flash.uploadBaudRate')}</span>
              <DropdownSelect aria-labelledby={baudRateId} value={baudRate} disabled={busy}
                onValueChange={(value) => setBaudRate(Number(value))}>
                {UNO_UPLOAD_BAUD_RATES.map((rate) => (
                  <option key={rate} value={rate}>{t('editor.flash.baudRate', { baud: rate })}</option>
                ))}
              </DropdownSelect>
            </div>
            <button type="button" className="workspace-flash-button" disabled={busy || baudRate === UNO_UPLOAD_BAUD_RATE}
              onClick={() => setBaudRate(UNO_UPLOAD_BAUD_RATE)}>
              {t('editor.flash.resetDefaults')}
            </button>
          </div>
        </details>
      )}

      {flashAllowed && state.kind === 'loading-ports' && (
        <p role="status" className="workspace-flash-connection">
          {t('editor.flash.detectingPorts')}
        </p>
      )}

      {flashAllowed && state.kind === 'choosing-web-port' && (
        <p role="status">{t('editor.flash.choosingPort', 'Choose a USB port in the browser to continue…')}</p>
      )}

      {flashAllowed && state.kind === 'web-ready' && (
        <WebReadyView
          bootloader={editingOptions ? null : bootloaderHint}
          bootStatus={bootStatus}
          onEnterBootloader={() => void doEnterBootloader()}
          downloaded={state.downloaded}
          drive={state.drive}
          portSelectionCancelled={state.portSelectionCancelled}
        />
      )}

      {flashAllowed && state.kind === 'download-only' && (
        <DownloadOnlyView
          buildReady={!needsCompile}
          downloaded={state.downloaded}
          drive={state.drive}
          onDownload={() => void doDownload()}
          onSaveToDrive={canSaveToDrive() ? () => void doDownload(true) : undefined}
        />
      )}

      {flashAllowed &&
        hwUsesUf2 &&
        !needsCompile && !editingOptions && !busy &&
        !isMpy &&
        (state.kind === 'web-ready' ||
          state.kind === 'picking' ||
          state.kind === 'success' ||
          state.kind === 'error') && (
          <div style={{ fontSize: 12, color: 'var(--wb-9)', lineHeight: 1.5 }}>
            {t('editor.flash.downloadUf2Hint')}{' '}
            <button type="button" onClick={() => void doDownload()} style={linkBtnStyle}>
              {t('editor.flash.downloadUf2')}
            </button>
            {canSaveToDrive() && (
              <>
                {' '}
                <button type="button" onClick={() => void doDownload(true)} style={linkBtnStyle}>
                  {t('editor.flash.saveToDrive')}
                </button>
              </>
            )}
          </div>
        )}

      {children}

      {flashAllowed && (state.kind === 'compiling' ||
        state.kind === 'flashing' ||
        state.kind === 'success' ||
        state.kind === 'error') && (
        <div className="workspace-flash-footer">
          <ProgressView
            state={state}
            onCancel={isWebMode && state.kind === 'flashing' ? () => abortRef.current?.abort() : undefined}
            bootloader={!editingOptions && state.kind === 'error' && state.notInBootloader ? bootloaderHint : null}
            bootStatus={bootStatus}
            onEnterBootloader={() => void doEnterBootloader()}
          />
        </div>
      )}
    </div>
  );
};

// ── Bootloader panel (RP2 BOOTSEL and the like) ────────────────────

interface BootloaderPanelProps {
  hint: BootloaderHint;
  status: BootStatus;
  onEnter: () => void;
}

const BootloaderPanel = ({ hint, status, onEnter }: BootloaderPanelProps) => {
  const { t } = useTranslation();
  const tone =
    status.phase === 'failed'
      ? 'var(--color-feedback-error)'
      : status.phase === 'done'
        ? 'var(--color-feedback-success)'
        : 'var(--wb-10)';
  return (
    <div className="workspace-flash-stack" style={{ ...insetBoxStyle, padding: 10 }}>
      <strong>
        {t('editor.flash.bootloader.title')}
      </strong>
      <p className="workspace-flash-connection">
        {hint.manual ?? t('editor.flash.bootloader.manual')}
      </p>
      {hint.automatic && (
        <div className="workspace-flash-actions">
          <button
            type="button"
            className="workspace-flash-button"
            onClick={onEnter}
            disabled={status.phase === 'busy'}
          >
            {t('editor.flash.bootloader.automatic')}
          </button>
          {status.message && (
            <span style={{ fontSize: 11, color: tone }}>{status.message}</span>
          )}
        </div>
      )}
    </div>
  );
};

// ── Download-only subview (RP2 boards on a browser without a flasher) ──

interface DownloadOnlyProps {
  buildReady: boolean;
  downloaded?: string;
  /** Drive name when the file went straight onto the BOOTSEL drive. */
  drive?: string;
  onDownload: () => void;
  /** Present when the browser can write to the drive itself. */
  onSaveToDrive?: () => void;
}

const DownloadOnlyView = ({ buildReady, downloaded, drive, onDownload, onSaveToDrive }: DownloadOnlyProps) => {
  const { t } = useTranslation();
  return (
    <div className="workspace-flash-stack">
      <div style={{ ...insetBoxStyle, padding: 10 }}>
        <div style={{ color: 'var(--wb-11)', fontSize: 13, marginBottom: 8 }}>
          {t('editor.flash.downloadOnlyIntro')}
        </div>
        <div style={{ color: 'var(--wb-9)', fontSize: 12, lineHeight: 1.5 }}>
          {t('editor.flash.downloadOnlyHint')}
        </div>
      </div>

      {downloaded && (
        <div style={{ padding: 10, background: 'var(--color-feedback-success-soft)', color: 'var(--color-feedback-success)', borderRadius: 4, fontSize: 12, marginBottom: 12 }}>
          {drive
            ? t('editor.flash.savedToDrive', { file: downloaded, drive })
            : t('editor.flash.downloaded', { file: downloaded })}
        </div>
      )}

      <div className="workspace-flash-actions">
        {onSaveToDrive && (
          <button type="button" className="workspace-flash-button" onClick={onSaveToDrive} disabled={!buildReady}>
            {t('editor.flash.saveToDrive')}
          </button>
        )}
        <button type="button" className="workspace-flash-button workspace-flash-button-primary" onClick={onDownload} disabled={!buildReady}>
          {t('editor.flash.downloadUf2')}
        </button>
      </div>
    </div>
  );
};

// ── Paid-gate subview (desktop: flashing needs a paid license) ─────

const PaidGateView = () => {
  const { t } = useTranslation();
  const url = hardwareFlashUpgradeUrl();
  const openPlans = () => {
    if (isTauri()) {
      void openExternal(url);
    } else {
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  };
  return (
    <div>
      <div style={{ ...insetBoxStyle, padding: 16, marginBottom: 12 }}>
        <div style={{ color: 'var(--wb-13)', fontSize: 14, fontWeight: 600, marginBottom: 8 }}>
          {t('editor.flash.paidOnlyTitle')}
        </div>
        <div style={{ color: 'var(--wb-11)', fontSize: 12, lineHeight: 1.5 }}>
          {t('editor.flash.paidOnlyBody')}
        </div>
      </div>
      <div className="workspace-flash-actions">
        <button type="button" className="workspace-flash-button workspace-flash-button-primary" onClick={openPlans}>
          {t('editor.flash.seePlans')}
        </button>
      </div>
    </div>
  );
};

// ── Picker subview ──────────────────────────────────────────────────

const BuildNotice = ({ status }: { status: 'none' | 'stale' }) => {
  const { t } = useTranslation();
  return (
    <div className="workspace-flash-feedback workspace-flash-feedback--warning" role="status">
      {status === 'stale'
        ? t('editor.flash.recompileRequired')
        : t('editor.flash.compileRequired')}
    </div>
  );
};

function PortPicker({ ports, selected, disabled, onSelect }: {
  ports: SerialPortInfo[];
  selected: string | null;
  disabled: boolean;
  onSelect: (path: string) => void;
}) {
  const { t } = useTranslation();
  if (ports.length === 0) {
    return (
      <div className="workspace-flash-stack">
        <p role="status">{t('editor.flash.noPorts')}</p>
        <p className="workspace-flash-connection">
          {t('editor.flash.noPortsHint')}{' '}
          <code>sudo usermod -a -G dialout $USER</code>{' '}
          {t('editor.flash.noPortsHintLogout')}
        </p>
      </div>
    );
  }
  return (
    <div className="workspace-flash-field">
      <span>{t('editor.flash.serialPort')}</span>
      <DropdownSelect aria-label={t('editor.flash.serialPort')} value={selected ?? ''} disabled={disabled} onValueChange={onSelect}>
        {ports.map((port) => <option key={port.path} value={port.path}>{portLabel(port)}</option>)}
      </DropdownSelect>
    </div>
  );
}

// ── Web Serial subview ──────────────────────────────────────────────

function PortNotSelected() {
  const { t } = useTranslation();
  return (
    <p role="status" style={{ color: 'var(--wb-11)', fontSize: 12 }}>
      {t('editor.flash.portNotSelected', 'No USB port was selected. You can try again when your board is connected.')}
    </p>
  );
}

interface WebReadyProps {
  /** Bootloader step for this kind, or null when the family needs none. */
  bootloader: BootloaderHint | null;
  bootStatus: BootStatus;
  onEnterBootloader: () => void;
  /** File name of a .uf2 saved from this panel, if any. */
  downloaded?: string;
  /** Drive name when the file went straight onto the BOOTSEL drive. */
  drive?: string;
  portSelectionCancelled?: boolean;
}

const WebReadyView = ({
  bootloader,
  bootStatus,
  onEnterBootloader,
  downloaded,
  drive,
  portSelectionCancelled,
}: WebReadyProps) => {
  const { t } = useTranslation();
  if (!portSelectionCancelled && !bootloader && !downloaded) return null;
  return (
    <div className="workspace-flash-stack">
      {portSelectionCancelled && <PortNotSelected />}

      {bootloader && (
        <BootloaderPanel hint={bootloader} status={bootStatus} onEnter={onEnterBootloader} />
      )}

      {downloaded && (
        <div style={{ padding: 10, background: 'var(--color-feedback-success-soft)', color: 'var(--color-feedback-success)', borderRadius: 4, fontSize: 12, marginBottom: 12 }}>
          {drive
            ? t('editor.flash.savedToDrive', { file: downloaded, drive })
            : t('editor.flash.downloaded', { file: downloaded })}
        </div>
      )}

    </div>
  );
};

// ── Progress / success / error subview ──────────────────────────────

interface ProgressProps {
  state:
    | { kind: 'compiling'; port: string | null }
    | { kind: 'flashing'; port: string; progress: number }
    | { kind: 'success'; port: string; elapsedMs: number }
    | { kind: 'error'; port: string | null; message: string; stage: 'compile' | 'flash' };
  onCancel?: () => void;
  /** Shown under an error when the board was not in bootloader mode. */
  bootloader?: BootloaderHint | null;
  bootStatus?: BootStatus;
  onEnterBootloader?: () => void;
}

const ProgressView = ({
  state,
  onCancel,
  bootloader,
  bootStatus,
  onEnterBootloader,
}: ProgressProps) => {
  const { t } = useTranslation();
  const progress = state.kind === 'flashing' ? Math.round(state.progress * 100) : 0;
  return (
    <div className="workspace-flash-stack">
      {state.kind === 'compiling' && (
        <>
          <div role="status">
            {t('editor.flash.compiling')}
          </div>
          <div className="workspace-flash-progress-track" aria-hidden="true">
            <div className="flash-indeterminate" style={{ width: '35%' }} />
          </div>
        </>
      )}

      {state.kind === 'flashing' && (
        <>
          <div role="status">
            {t('editor.flash.flashingOn', { port: state.port })}
          </div>
          <div className="workspace-flash-progress-track" role="progressbar"
            aria-label={t('editor.flash.flashingOn', { port: state.port })} aria-valuenow={progress}>
            <div style={{ width: `${progress}%` }} />
          </div>
          <div className="workspace-flash-connection">
            {progress}%
          </div>
        </>
      )}

      {state.kind === 'success' && (
        <div role="status" className="workspace-flash-feedback workspace-flash-feedback--success">
          {t('editor.flash.success', { seconds: (state.elapsedMs / 1000).toFixed(1) })}
        </div>
      )}

      {state.kind === 'error' && (
        <div role="alert" className="workspace-flash-feedback workspace-flash-feedback--error">
          {state.message}
        </div>
      )}

      {state.kind === 'error' && bootloader && bootStatus && onEnterBootloader && (
        <BootloaderPanel hint={bootloader} status={bootStatus} onEnter={onEnterBootloader} />
      )}

      {state.kind === 'flashing' && <p>{t('editor.flash.dontUnplug')}</p>}
      {state.kind === 'compiling' && <p>{t('editor.flash.terminalBuildHint')}</p>}
      {onCancel && (
        <button type="button" className="workspace-flash-button" onClick={onCancel}>{t('editor.flash.cancel')}</button>
      )}
    </div>
  );
};

// ── Helpers + shared styles ─────────────────────────────────────────

function portLabel(p: SerialPortInfo): string {
  const parts: string[] = [p.path];
  if (p.product || p.manufacturer) {
    parts.push('-', p.product ?? p.manufacturer ?? '');
  }
  if (p.vid !== undefined && p.vid !== null && p.pid !== undefined && p.pid !== null) {
    parts.push(`(${hex4(p.vid)}:${hex4(p.pid)})`);
  }
  return parts.join(' ');
}

function hex4(n: number): string {
  return n.toString(16).padStart(4, '0');
}

/**
 * Decide the program file extension based on the FQBN. Mirrors the
 * formats arduino-cli expects per uploader (avrdude wants .hex, esptool
 * wants .bin, the rp2040 core's upload recipe is `picotool load X.uf2`,
 * so RP2 boards MUST send the real .uf2: see `hardwareProgram`).
 */
function formatForFqbn(fqbn: string): 'hex' | 'bin' | 'uf2' | 'elf' {
  if (fqbn.startsWith('arduino:avr') || fqbn.startsWith('ATTinyCore:avr')) {
    return 'hex';
  }
  if (fqbn.startsWith('esp32:esp32')) return 'bin';
  if (fqbn.startsWith('rp2040:rp2040')) return 'uf2';
  if (fqbn.startsWith('arduino:samd')) return 'bin';
  // Defensive fallback - arduino-cli's auto-detection should still
  // do the right thing in most cases.
  return 'bin';
}

const linkBtnStyle: React.CSSProperties = {
  background: 'none',
  border: 'none',
  padding: 0,
  color: 'var(--color-action-primary)',
  cursor: 'pointer',
  fontSize: 12,
  textDecoration: 'underline',
};

const insetBoxStyle: React.CSSProperties = {
  background: 'var(--wb-3)',
  border: '1px solid var(--wb-6)',
  borderRadius: 4,
};
