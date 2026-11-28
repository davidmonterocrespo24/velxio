/**
 * FlashModal — hardware flash UI for a single board on the canvas.
 *
 * Opened from the board context menu's "Flash to real board" item.
 * Walks the user through:
 *   1. Picking a USB serial port (auto-enumerated)
 *   2. Triggering the flash (streams arduino-cli output live)
 *   3. Showing success / error with the option to retry
 *
 * Compile-before-flash: the dialog no longer requires a prior Compile.
 * If the board has no program, or its code changed since the last build
 * (stale fingerprint, see utils/boardCompile.ts), the flash step compiles
 * first — build output streams into the same console — and only flashes on
 * a green build; compiler errors land in the console with an error banner.
 * Web Serial's port picker needs a user gesture, so the web flow asks the
 * overlay to grant the port at the click (preparePort) BEFORE compiling.
 *
 * Two backends:
 *   - Desktop (Tauri): enumerates ports via the sidecar and streams
 *     arduino-cli output over SSE.
 *   - Web: if the pro overlay installed a Web Serial flasher for this
 *     board kind (see `lib/proWebFlash.ts`), the browser's own port
 *     picker replaces the dropdown — the modal opens on a single
 *     "Connect & Flash" button. Without an overlay (pure OSS web
 *     build), it shows the "requires Velxio Desktop" fallback.
 *
 * Plus one route that needs neither: RP2040 / RP2350 boards program from
 * a .uf2 dropped on their BOOTSEL USB drive, so for those the dialog
 * always offers "Download .uf2" (utils/uf2Download.ts), and on a browser
 * without a flasher that download IS the dialog. Families whose
 * bootloader is a separate USB personality also get a "bootloader" panel
 * (hold the button / reboot over USB) fed by the overlay's
 * `bootloaderHint` / `enterBootloader` seam methods.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { BoardInstance } from '../../store/useSimulatorStore';
import { useSimulatorStore } from '../../store/useSimulatorStore';
import { isTauri, listSerialPorts, type SerialPortInfo } from '../../desktop/tauriBridge';
import { streamFlash, type FlashEvent } from '../../services/flashService';
import {
  getWebFlashImpl,
  webFlashAvailable,
  webFlashMpyAvailable,
  webFlashBootloaderHint,
  webFlashHardwareRevisions,
  isNotInBootloaderError,
  hardwareFlashAllowed,
  hardwareFlashUpgradeUrl,
  type BootloaderHint,
  type HardwareRevision,
} from '../../lib/proWebFlash';
import { openExternal } from '../../desktop/tauriBridge';
import { useEditorStore } from '../../store/useEditorStore';
import { useProjectStore } from '../../store/useProjectStore';
import { boardDisplayName } from '../../types/board';
import {
  compileBoardForFlash,
  currentSourceFingerprint,
  isCompiledProgramStale,
  needsHardwareBuild,
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
  onClose: () => void;
}

type ModalState =
  | { kind: 'loading-ports' }
  | { kind: 'picking'; ports: SerialPortInfo[]; selectedPath: string | null }
  /** `downloaded`: the .uf2 just saved from this dialog (RP2 boards); `drive` = onto the board's drive. */
  | { kind: 'web-ready'; downloaded?: string; drive?: string }
  /** Web, no flasher for this kind, but a .uf2 to hand over (RP2 boards). */
  | { kind: 'download-only'; downloaded?: string; drive?: string }
  | { kind: 'compiling'; port: string | null; log: string[] }
  | { kind: 'flashing'; port: string; log: string[]; progress: number }
  | { kind: 'success'; port: string; elapsedMs: number; log: string[] }
  | {
      kind: 'error';
      port: string | null;
      message: string;
      log: string[];
      stage: 'compile' | 'flash';
      /** The board was not in bootloader mode: show the bootloader panel. */
      notInBootloader?: boolean;
    };

/** Progress of the optional "reboot into bootloader" step. */
type BootStatus = { phase: 'idle' | 'busy' | 'done' | 'failed'; message?: string };

export const FlashModal = ({ board: boardProp, fqbn, onClose }: Props) => {
  const { t } = useTranslation();
  // Read the board LIVE from the store: a compile inside this dialog updates
  // compiledProgram / compiledSourceHash and the prop would go stale.
  const board =
    useSimulatorStore((s) => s.boards.find((b) => b.id === boardProp.id)) ?? boardProp;
  const [state, setState] = useState<ModalState>({ kind: 'loading-ports' });
  // Keep the latest log in a ref so the flash generator's setState
  // calls aren't accumulating stale array copies.
  const logRef = useRef<string[]>([]);
  // Web Serial mode: the pro overlay's flasher handles this board in
  // this browser (the impl is installed before any modal can open).
  const isWebMode = !isTauri() && webFlashAvailable(board.boardKind);
  // MicroPython projects use the firmware-install + raw-REPL upload path.
  const isMpy = board.languageMode === 'micropython';
  const mpyWebOk = isMpy && !isTauri() && webFlashMpyAvailable(board.boardKind);
  // RP2040 / RP2350: picotool and the BOOTSEL drive take a .uf2, not the
  // raw .bin the emulator runs.
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
  // The flash builds an image of its own when the simulator's is not what
  // this board should run: another chip (a revision), or a build that only
  // serves the simulator (needsHardwareBuild: an RP2040's Serial on UART0,
  // an ESP32 Arduino sketch's loop() that sleeps a tick per pass, an ESP32's
  // WiFi credentials swapped for the simulated network). Everyone else is
  // flashed with the program the simulator runs. Asked of the board
  // as it is NOW: a compile inside the dialog can be what tells.
  const ownBuildFor = useCallback(
    (b: BoardInstance) => isAltRevision || needsHardwareBuild(b, hwFqbn),
    [isAltRevision, hwFqbn],
  );
  const needsOwnBuild = ownBuildFor(board);
  // That build lives here, not in the store: the emulator must never pick
  // up an RP2040 image for a board it runs as RP2350, firmware whose serial
  // monitor it cannot see, nor one that joins a network it does not beacon.
  const ownBuildRef = useRef<{ fqbn: string; hash: string; program: string; uf2: string | null } | null>(null);
  // What ownBuildRef holds, for the render (labels and notices).
  const [ownBuildKey, setOwnBuildKey] = useState<string | null>(null);
  const ownBuildReady =
    ownBuildKey !== null && ownBuildKey === `${hwFqbn}\n${currentSourceFingerprint(board)}`;
  const buildStatus = buildStatusOf(board, needsOwnBuild, ownBuildReady);
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
  const [bootStatus, setBootStatus] = useState<BootStatus>({ phase: 'idle' });
  // Abort handle for an in-flight web flash (closing the modal cancels).
  const abortRef = useRef<AbortController | null>(null);

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
                log: [],
                stage: 'flash',
              },
      );
      return;
    }
    let cancelled = false;
    void (async () => {
      const ports = await listSerialPorts();
      if (cancelled) return;
      setState({
        kind: 'picking',
        ports,
        selectedPath: ports[0]?.path ?? null,
      });
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isWebMode]);

  // ── Compile-before-flash ─────────────────────────────────────────
  // Resolves to the program to flash, compiling first when the board has
  // none or its sources changed since the last build. Build output goes to
  // the console; a red build ends in the error state (stage 'compile').
  const ensureProgram = useCallback(
    async (port: string | null): Promise<string | null> => {
      const live = useSimulatorStore.getState().boards.find((b) => b.id === board.id) ?? board;
      let ownBuild = ownBuildFor(live);
      if (ownBuild) {
        // Reused while the sources and the revision stay the same.
        const own = ownBuildRef.current;
        if (own && own.fqbn === hwFqbn && own.hash === currentSourceFingerprint(live)) {
          return own.program;
        }
      } else if (live.compiledProgram && !isCompiledProgramStale(live)) {
        return live.compiledProgram;
      }
      logRef.current = [];
      setState({ kind: 'compiling', port, log: [] });
      const push = (line: string) => {
        logRef.current = [...logRef.current, line];
        setState((prev) => (prev.kind === 'compiling' ? { ...prev, log: logRef.current } : prev));
      };
      const build = async (own: boolean) => {
        push(
          own
            ? t('editor.flash.log.compilingRevision', {
                revision: activeRevision?.label ?? boardDisplayName(live) ?? live.boardKind,
              })
            : live.compiledProgram
              ? t('editor.flash.log.recompiling')
              : t('editor.flash.log.compiling'),
        );
        const outcome = await compileBoardForFlash(
          live,
          push,
          own ? { fqbn: hwFqbn, record: false, forHardware: true } : {},
        );
        if (!outcome.ok) {
          setState({
            kind: 'error',
            port,
            message: t('editor.flash.compileFailed', { error: outcome.error }),
            log: [...logRef.current],
            stage: 'compile',
          });
          return null;
        }
        push(t('editor.flash.log.compiled', { seconds: (outcome.elapsedMs / 1000).toFixed(1) }));
        return outcome;
      };
      if (!ownBuild) {
        // The simulator's build, recorded on the board as the toolbar's is.
        const outcome = await build(false);
        if (!outcome) return null;
        // An ESP32 whose WiFi credentials the server rewrote for the
        // simulated network: that image is not for the board, which gets
        // its own below. Any other build is the one to flash.
        if (!outcome.wifiRewritten) return outcome.program;
        ownBuild = true;
      }
      // The fingerprint of what THIS build is made from, taken as it starts
      // (compileBoardForFlash reads the sources before its first await): a
      // build of the simulator's may have come first, and the code can have
      // changed while it ran.
      const hash = currentSourceFingerprint(live);
      const outcome = await build(true);
      if (!outcome) return null;
      ownBuildRef.current = { fqbn: hwFqbn, hash, program: outcome.program, uf2: outcome.uf2 };
      setOwnBuildKey(`${hwFqbn}\n${hash}`);
      return outcome.program;
    },
    [board, t, ownBuildFor, hwFqbn, activeRevision],
  );

  /**
   * The bytes real hardware takes: the .uf2 for RP2 boards (null when the
   * build has none), the program itself for everyone else. A build of the
   * flash's own comes from the dialog's copy.
   */
  const hardwareProgram = useCallback(
    (program: string): string | null => {
      // The board as the store holds it: ensureProgram may just have learnt
      // that its program is the simulator's alone.
      const live = useSimulatorStore.getState().boards.find((b) => b.id === board.id) ?? board;
      if (!ownBuildFor(live)) return program;
      const own = ownBuildRef.current;
      if (!own) return null;
      return hwUsesUf2 ? own.uf2 : own.program;
    },
    [board, ownBuildFor, hwUsesUf2],
  );

  const refreshPorts = useCallback(async () => {
    setState({ kind: 'loading-ports' });
    const ports = await listSerialPorts();
    setState({
      kind: 'picking',
      ports,
      selectedPath: ports[0]?.path ?? null,
    });
  }, []);

  // ── Trigger the flash ────────────────────────────────────────────
  const doFlash = useCallback(
    async (port: string) => {
      const program = await ensureProgram(port);
      if (!program) return; // compile failed — error state already shown
      // picotool programs RP2 boards from the .uf2; handing it the raw .bin
      // under a .uf2 name is refused ("does not contain a valid RP2
      // executable image"), so a build without one stops here.
      const programData = hardwareProgram(program);
      if (!programData) {
        setState({
          kind: 'error',
          port,
          message: t('editor.flash.noUf2'),
          log: [...logRef.current],
          stage: 'flash',
        });
        return;
      }
      // Keep the compile output above the flash output in the console.
      setState({ kind: 'flashing', port, log: logRef.current, progress: 0 });

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
                log: [...logRef.current],
              });
            } else {
              setState({
                kind: 'error',
                port,
                message: ev.error,
                log: [...logRef.current],
                stage: 'flash',
              });
            }
            return;
          }
          if ('line' in ev) {
            logRef.current = [...logRef.current, ev.line];
          }
          setState((prev) => {
            if (prev.kind !== 'flashing') return prev;
            return {
              ...prev,
              log: logRef.current,
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
          log: [...logRef.current],
          stage: 'flash',
        });
      }
    },
    [board.id, hwFqbn, ensureProgram, hardwareProgram, t],
  );

  // ── Download the .uf2 (RP2 boards; every browser) ────────────────
  // `toDrive`: write it onto the BOOTSEL drive through the File System
  // Access API instead of the downloads folder (Chromium only).
  const doDownload = useCallback(
    async (toDrive = false) => {
      const program = await ensureProgram(null);
      if (!program) return; // compile failed — error state already shown
      const uf2 = hardwareProgram(program);
      if (!uf2) {
        setState({
          kind: 'error',
          port: null,
          message: t('editor.flash.noUf2'),
          log: [...logRef.current],
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
            log: [...logRef.current],
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
    [board.boardKind, board.name, ensureProgram, hardwareProgram, isWebMode, t],
  );

  // ── Reboot into the bootloader (pro overlay backend, RP2 boards) ──
  const doEnterBootloader = useCallback(async () => {
    const impl = getWebFlashImpl();
    if (!impl?.enterBootloader) return;
    setBootStatus({ phase: 'busy', message: t('editor.flash.bootloader.rebooting') });
    try {
      await impl.enterBootloader(board.boardKind, (p) => {
        if (p.line) setBootStatus({ phase: 'busy', message: p.line });
      });
      setBootStatus({ phase: 'done', message: t('editor.flash.bootloader.rebooted') });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      setBootStatus({ phase: 'failed', message: t('editor.flash.bootloader.failed', { error }) });
    }
  }, [board.boardKind, t]);

  // ── Trigger a Web Serial flash (pro overlay backend) ─────────────
  const doWebFlash = useCallback(async () => {
    const impl = getWebFlashImpl();
    if (!impl) return;
    let program: string | null = null;
    if (!isMpy) {
      // Grant the port NOW, inside the click's gesture window: the compile
      // below may take minutes and Web Serial's picker would refuse to
      // open afterwards. The flasher reuses the grant without prompting.
      if (impl.preparePort) {
        try {
          await impl.preparePort(board.boardKind);
        } catch (err) {
          setState({
            kind: 'error',
            port: null,
            message: err instanceof Error ? err.message : String(err),
            log: [],
            stage: 'flash',
            notInBootloader: isNotInBootloaderError(err),
          });
          return;
        }
      }
      program = await ensureProgram(null);
      if (!program) return; // compile failed — error state already shown
    } else {
      logRef.current = [];
    }
    setState({ kind: 'flashing', port: 'Web Serial', log: logRef.current, progress: 0 });
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const onProgress = (p: { phase: string; pct: number; line?: string }) => {
      if (p.line) {
        logRef.current = [...logRef.current, p.line];
      }
      setState((prev) => {
        if (prev.kind !== 'flashing') return prev;
        return {
          ...prev,
          log: logRef.current,
          // Seam reports 0-100; the bar renders 0-1 like the SSE path.
          progress:
            p.phase === 'writing' || p.phase === 'uploading'
              ? p.pct / 100
              : prev.progress,
        };
      });
    };
    try {
      const result =
        isMpy && impl.flashMicroPython
          ? await impl.flashMicroPython({
              boardId: board.id,
              boardKind: board.boardKind,
              // Same file collection as the MicroPython Run path
              // (EditorToolbar): the board's workspace group.
              files: useEditorStore
                .getState()
                .getGroupFiles(board.activeFileGroupId)
                .map((f) => ({ name: f.name, content: f.content })),
              signal: ctrl.signal,
              onProgress,
            })
          : await impl.flash({
              boardId: board.id,
              boardKind: board.boardKind,
              fqbn: hwFqbn,
              binaryBase64: (program && hardwareProgram(program)) ?? program ?? '',
              signal: ctrl.signal,
              onProgress,
            });
      setState({
        kind: 'success',
        port: result.chipName,
        elapsedMs: result.elapsedMs,
        log: [...logRef.current],
      });
    } catch (err) {
      if (ctrl.signal.aborted) return; // user cancelled — modal is closing
      setState({
        kind: 'error',
        port: null,
        message: err instanceof Error ? err.message : String(err),
        log: [...logRef.current],
        stage: 'flash',
        notInBootloader: isNotInBootloaderError(err),
      });
    } finally {
      abortRef.current = null;
    }
  }, [board.id, board.boardKind, board.activeFileGroupId, isMpy, ensureProgram, hardwareProgram, hwFqbn]);

  const handleClose = useCallback(() => {
    abortRef.current?.abort();
    onClose();
  }, [onClose]);

  // ── Render ──────────────────────────────────────────────────────
  const boardLabel = board.boardKind;
  // Entitlement (desktop: paid license only — see lib/proWebFlash.ts).
  const flashAllowed = hardwareFlashAllowed();

  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'var(--color-bg-overlay)',
        backdropFilter: 'blur(4px)',
        zIndex: 9600,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <div
        style={{
          width: 560,
          maxWidth: 'calc(100vw - 32px)',
          maxHeight: 'calc(100vh - 64px)',
          background: 'var(--wb-5)',
          color: 'var(--wb-13)',
          border: '1px solid var(--wb-6)',
          borderRadius: 8,
          padding: 20,
          boxShadow: 'var(--shadow-4)',
          display: 'flex',
          flexDirection: 'column',
          gap: 14,
          fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>
            {t('editor.flash.title', { board: boardLabel })}
          </h2>
          <button
            type="button"
            onClick={handleClose}
            style={closeBtnStyle}
            aria-label={t('editor.flash.close')}
          >
            ×
          </button>
        </div>

        {!flashAllowed && <PaidGateView onClose={handleClose} />}

        {flashAllowed &&
          revisions &&
          (state.kind === 'web-ready' ||
            state.kind === 'download-only' ||
            state.kind === 'picking') && (
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--wb-11)' }}>
              {t('editor.flash.revision')}
              <select
                value={revisionId ?? ''}
                onChange={(e) => pickRevision(e.target.value)}
                style={{ ...selectStyle, flex: 1 }}
              >
                {revisions.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.label}
                  </option>
                ))}
              </select>
            </label>
          )}

        {flashAllowed && state.kind === 'loading-ports' && (
          <div style={{ padding: '24px 0', textAlign: 'center', color: 'var(--wb-10)' }}>
            {t('editor.flash.detectingPorts')}
          </div>
        )}

        {flashAllowed && state.kind === 'picking' && (
          <PickerView
            status={buildStatus}
            ports={state.ports}
            selected={state.selectedPath}
            onSelect={(p) => setState({ ...state, selectedPath: p })}
            onRefresh={() => void refreshPorts()}
            onFlash={(p) => void doFlash(p)}
          />
        )}

        {flashAllowed && state.kind === 'web-ready' && (
          <WebReadyView
            board={board}
            status={buildStatus}
            mpyWebOk={mpyWebOk}
            onFlash={() => void doWebFlash()}
            bootloader={bootloaderHint}
            bootStatus={bootStatus}
            onEnterBootloader={() => void doEnterBootloader()}
            downloaded={state.downloaded}
            drive={state.drive}
          />
        )}

        {flashAllowed && state.kind === 'download-only' && (
          <DownloadOnlyView
            status={buildStatus}
            downloaded={state.downloaded}
            drive={state.drive}
            onDownload={() => void doDownload()}
            onSaveToDrive={canSaveToDrive() ? () => void doDownload(true) : undefined}
          />
        )}

        {flashAllowed && (state.kind === 'compiling' ||
          state.kind === 'flashing' ||
          state.kind === 'success' ||
          state.kind === 'error') && (
          <ProgressView
            state={state}
            webMode={isWebMode}
            onRetry={() =>
              isWebMode
                ? void doWebFlash()
                : state.port && void doFlash(state.port)
            }
            onClose={handleClose}
            onBackToPicker={() =>
              isWebMode
                ? setState({ kind: 'web-ready' })
                : isTauri()
                  ? void refreshPorts()
                  : setState({ kind: 'download-only' })
            }
            bootloader={state.kind === 'error' && state.notInBootloader ? bootloaderHint : null}
            bootStatus={bootStatus}
            onEnterBootloader={() => void doEnterBootloader()}
          />
        )}

        {flashAllowed &&
          hwUsesUf2 &&
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
      </div>
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
    <div style={{ ...insetBoxStyle, padding: 12, marginBottom: 12 }}>
      <div style={{ color: 'var(--wb-12)', fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
        {t('editor.flash.bootloader.title')}
      </div>
      <div style={{ color: 'var(--wb-9)', fontSize: 12, lineHeight: 1.5 }}>
        {hint.manual ?? t('editor.flash.bootloader.manual')}
      </div>
      {hint.automatic && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8, flexWrap: 'wrap' }}>
          <button
            type="button"
            onClick={onEnter}
            disabled={status.phase === 'busy'}
            style={{ ...secondaryBtnStyle, opacity: status.phase === 'busy' ? 0.6 : 1 }}
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
  status: BuildStatus;
  downloaded?: string;
  /** Drive name when the file went straight onto the BOOTSEL drive. */
  drive?: string;
  onDownload: () => void;
  /** Present when the browser can write to the drive itself. */
  onSaveToDrive?: () => void;
}

const DownloadOnlyView = ({ status, downloaded, drive, onDownload, onSaveToDrive }: DownloadOnlyProps) => {
  const { t } = useTranslation();
  return (
    <div>
      <div style={{ ...insetBoxStyle, padding: 16, marginBottom: 12 }}>
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

      <div style={{ marginBottom: 12 }}>
        <BuildNotice status={status} />
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        {onSaveToDrive && (
          <button type="button" onClick={onSaveToDrive} style={secondaryBtnStyle}>
            {t('editor.flash.saveToDrive')}
          </button>
        )}
        <button type="button" onClick={onDownload} style={primaryBtnStyle}>
          {status === 'fresh' ? t('editor.flash.downloadUf2') : t('editor.flash.compileDownload')}
        </button>
      </div>
    </div>
  );
};

// ── Paid-gate subview (desktop: flashing needs a paid license) ─────

const PaidGateView = ({ onClose }: { onClose: () => void }) => {
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
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <button type="button" onClick={onClose} style={secondaryBtnStyle}>
          {t('editor.flash.close')}
        </button>
        <button type="button" onClick={openPlans} style={primaryBtnStyle}>
          {t('editor.flash.seePlans')}
        </button>
      </div>
    </div>
  );
};

// ── Picker subview ──────────────────────────────────────────────────

interface PickerProps {
  status: BuildStatus;
  ports: SerialPortInfo[];
  selected: string | null;
  onSelect: (path: string) => void;
  onRefresh: () => void;
  onFlash: (path: string) => void;
}

/**
 * Build status for the notices + button label: 'fresh' (flash as is),
 * 'stale' (code changed since the build: warn + rebuild), 'none' (compile
 * first), 'own' (the simulator's build is current, the board's own is yet to
 * be built: compile first, nothing to warn of). MicroPython never compiles.
 */
type BuildStatus = 'fresh' | 'stale' | 'none' | 'own' | 'mpy';

function buildStatusOf(
  board: BoardInstance,
  needsOwnBuild: boolean,
  ownBuildReady: boolean,
): BuildStatus {
  if (board.languageMode === 'micropython') return 'mpy';
  if (needsOwnBuild && ownBuildReady) return 'fresh';
  if (!board.compiledProgram) return 'none';
  if (isCompiledProgramStale(board)) return 'stale';
  return needsOwnBuild ? 'own' : 'fresh';
}

const BuildNotice = ({ status }: { status: BuildStatus }) => {
  const { t } = useTranslation();
  if (status === 'fresh' || status === 'own' || status === 'mpy') return null;
  return (
    <div
      style={{
        marginTop: 10,
        padding: 10,
        background: 'var(--color-feedback-warning-soft)',
        color: 'var(--color-feedback-warning)',
        borderRadius: 4,
        fontSize: 12,
        lineHeight: 1.45,
      }}
    >
      {status === 'stale' ? t('editor.flash.staleBuild') : t('editor.flash.noBuild')}
    </div>
  );
};

const flashButtonLabel = (t: (k: string) => string, status: BuildStatus, web: boolean) => {
  if (status === 'none' || status === 'stale' || status === 'own') {
    return web ? t('editor.flash.connectCompileFlash') : t('editor.flash.compileFlash');
  }
  return web ? t('editor.flash.connectFlash') : t('editor.flash.flash');
};

const PickerView = ({ status, ports, selected, onSelect, onRefresh, onFlash }: PickerProps) => {
  const { t } = useTranslation();

  if (ports.length === 0) {
    return (
      <div>
        <div style={{ ...insetBoxStyle, padding: 16, marginBottom: 12 }}>
          <div style={{ color: 'var(--wb-11)', fontSize: 13, marginBottom: 8 }}>
            {t('editor.flash.noPorts')}
          </div>
          <div style={{ color: 'var(--wb-9)', fontSize: 12, lineHeight: 1.5 }}>
            {t('editor.flash.noPortsHint')}
            <pre style={{ marginTop: 6, fontSize: 11 }}>
              sudo usermod -a -G dialout $USER
            </pre>
            {t('editor.flash.noPortsHintLogout')}
          </div>
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" onClick={onRefresh} style={primaryBtnStyle}>
            {t('editor.flash.refresh')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <label style={{ display: 'block', marginBottom: 6, fontSize: 12, color: 'var(--wb-11)' }}>
        {t('editor.flash.serialPort')}
      </label>
      <select
        value={selected ?? ''}
        onChange={(e) => onSelect(e.target.value)}
        style={selectStyle}
      >
        {ports.map((p) => (
          <option key={p.path} value={p.path}>
            {portLabel(p)}
          </option>
        ))}
      </select>

      <BuildNotice status={status} />

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 14 }}>
        <button type="button" onClick={onRefresh} style={secondaryBtnStyle}>
          {t('editor.flash.refreshPorts')}
        </button>
        <button
          type="button"
          disabled={!selected}
          onClick={() => selected && onFlash(selected)}
          style={{ ...primaryBtnStyle, opacity: !selected ? 0.5 : 1 }}
        >
          {flashButtonLabel(t, status, false)}
        </button>
      </div>
    </div>
  );
};

// ── Web Serial subview ──────────────────────────────────────────────

interface WebReadyProps {
  board: BoardInstance;
  status: BuildStatus;
  /** MicroPython path available (overlay implements firmware+upload). */
  mpyWebOk: boolean;
  onFlash: () => void;
  /** Bootloader step for this kind, or null when the family needs none. */
  bootloader: BootloaderHint | null;
  bootStatus: BootStatus;
  onEnterBootloader: () => void;
  /** File name of a .uf2 saved from this dialog, if any. */
  downloaded?: string;
  /** Drive name when the file went straight onto the BOOTSEL drive. */
  drive?: string;
}

const WebReadyView = ({
  board,
  status,
  mpyWebOk,
  onFlash,
  bootloader,
  bootStatus,
  onEnterBootloader,
  downloaded,
  drive,
}: WebReadyProps) => {
  const { t } = useTranslation();
  // MicroPython boards carry the 'micropython-loaded' sentinel instead of
  // a flash image — they flash only via the overlay's MicroPython path
  // (firmware install + raw-REPL file upload), which needs no compile.
  const isMpy = board.languageMode === 'micropython';
  const canFlash = isMpy ? mpyWebOk : true;
  return (
    <div>
      <div style={{ ...insetBoxStyle, padding: 16, marginBottom: 12 }}>
        <div style={{ color: 'var(--wb-11)', fontSize: 13, marginBottom: 8 }}>
          {t('editor.flash.webIntro')}
        </div>
        <div style={{ color: 'var(--wb-9)', fontSize: 12, lineHeight: 1.5 }}>
          {t('editor.flash.webHint')}
          {isMpy && mpyWebOk && <> {t('editor.flash.mpyTwoSteps')}</>}
        </div>
      </div>

      {isMpy && !mpyWebOk && (
        <div style={{ padding: 10, background: 'var(--color-feedback-warning-soft)', color: 'var(--color-feedback-warning)', borderRadius: 4, fontSize: 12, marginBottom: 12 }}>
          {t('editor.flash.mpyUnavailable')}
        </div>
      )}

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

      <div style={{ marginBottom: 12 }}>
        <BuildNotice status={status} />
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button
          type="button"
          disabled={!canFlash}
          onClick={onFlash}
          style={{ ...primaryBtnStyle, opacity: canFlash ? 1 : 0.5 }}
        >
          {flashButtonLabel(t, status, true)}
        </button>
      </div>
    </div>
  );
};

// ── Progress / success / error subview ──────────────────────────────

interface ProgressProps {
  state:
    | { kind: 'compiling'; port: string | null; log: string[] }
    | { kind: 'flashing'; port: string; log: string[]; progress: number }
    | { kind: 'success'; port: string; elapsedMs: number; log: string[] }
    | { kind: 'error'; port: string | null; message: string; log: string[]; stage: 'compile' | 'flash' };
  /** Web Serial backend: closing cancels the flash and there is no port picker. */
  webMode: boolean;
  onRetry: () => void;
  onClose: () => void;
  onBackToPicker: () => void;
  /** Shown under an error when the board was not in bootloader mode. */
  bootloader?: BootloaderHint | null;
  bootStatus?: BootStatus;
  onEnterBootloader?: () => void;
}

const ProgressView = ({
  state,
  webMode,
  onRetry,
  onClose,
  onBackToPicker,
  bootloader,
  bootStatus,
  onEnterBootloader,
}: ProgressProps) => {
  const { t } = useTranslation();
  const logRef = useRef<HTMLPreElement | null>(null);
  const busy = state.kind === 'compiling' || state.kind === 'flashing';
  // Auto-scroll the log to the bottom as new lines come in.
  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [state.log]);

  return (
    <div>
      {state.kind === 'compiling' && (
        <>
          <div style={{ fontSize: 13, color: 'var(--wb-12)', marginBottom: 8 }}>
            {t('editor.flash.compiling')}
          </div>
          <div style={{ height: 6, background: 'var(--wb-3)', borderRadius: 3, overflow: 'hidden', marginBottom: 12 }}>
            <div className="flash-indeterminate" style={{ height: '100%', width: '35%', background: 'var(--color-action-primary)' }} />
          </div>
        </>
      )}

      {state.kind === 'flashing' && (
        <>
          <div style={{ fontSize: 13, color: 'var(--wb-12)', marginBottom: 8 }}>
            {t('editor.flash.flashingOn', { port: state.port })}
          </div>
          <div style={{ height: 6, background: 'var(--wb-3)', borderRadius: 3, overflow: 'hidden', marginBottom: 6 }}>
            <div
              style={{
                height: '100%',
                width: `${Math.round(state.progress * 100)}%`,
                background: 'var(--color-action-primary)',
                transition: 'width 0.2s ease',
              }}
            />
          </div>
          <div style={{ fontSize: 11, color: 'var(--wb-10)', marginBottom: 12 }}>
            {Math.round(state.progress * 100)}%
          </div>
        </>
      )}

      {state.kind === 'success' && (
        <div style={{ padding: 12, background: 'var(--color-feedback-success-soft)', color: 'var(--color-feedback-success)', borderRadius: 4, marginBottom: 12, fontSize: 13 }}>
          {t('editor.flash.success', { seconds: (state.elapsedMs / 1000).toFixed(1) })}
        </div>
      )}

      {state.kind === 'error' && (
        <div style={{ padding: 12, background: 'var(--color-feedback-error-soft)', color: 'var(--color-feedback-error)', borderRadius: 4, marginBottom: 12, fontSize: 13 }}>
          {state.message}
        </div>
      )}

      {state.kind === 'error' && bootloader && bootStatus && onEnterBootloader && (
        <BootloaderPanel hint={bootloader} status={bootStatus} onEnter={onEnterBootloader} />
      )}

      <pre
        ref={logRef}
        style={{
          height: 240,
          margin: 0,
          padding: 10,
          background: 'var(--wb-0)',
          color: 'var(--wb-12)',
          border: '1px solid var(--wb-6)',
          borderRadius: 4,
          fontSize: 11,
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
          overflowY: 'auto',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-all',
        }}
      >
        {state.log.join('\n') || t('editor.flash.noOutput')}
      </pre>

      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 12 }}>
        {state.kind === 'flashing' ? (
          <span style={{ fontSize: 11, color: 'var(--wb-9)' }}>{t('editor.flash.dontUnplug')}</span>
        ) : state.kind === 'compiling' ? (
          <span style={{ fontSize: 11, color: 'var(--wb-9)' }}>{t('editor.flash.compilingHint')}</span>
        ) : (
          <button type="button" onClick={onBackToPicker} style={secondaryBtnStyle}>
            {webMode ? t('editor.flash.startOver') : t('editor.flash.pickAnotherPort')}
          </button>
        )}
        <div style={{ display: 'flex', gap: 8 }}>
          {state.kind === 'error' && (
            <button type="button" onClick={onRetry} style={primaryBtnStyle}>
              {state.stage === 'compile' ? t('editor.flash.retryCompile') : t('editor.flash.retry')}
            </button>
          )}
          <button type="button" onClick={onClose} style={secondaryBtnStyle}>
            {busy ? (webMode ? t('editor.flash.cancel') : t('editor.flash.hide')) : t('editor.flash.close')}
          </button>
        </div>
      </div>
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

const closeBtnStyle: React.CSSProperties = {
  width: 28,
  height: 28,
  padding: 0,
  background: 'transparent',
  border: '1px solid var(--wb-6)',
  borderRadius: 4,
  color: 'var(--wb-11)',
  fontSize: 18,
  cursor: 'pointer',
  lineHeight: 1,
};

const primaryBtnStyle: React.CSSProperties = {
  padding: '8px 17px',
  fontSize: 13,
  fontWeight: 600,
  color: 'var(--color-action-primary-fg)',
  background: 'var(--color-action-primary)',
  border: 'none',
  borderRadius: 4,
  cursor: 'pointer',
  fontFamily: 'inherit',
};

const secondaryBtnStyle: React.CSSProperties = {
  padding: '7px 14px',
  fontSize: 13,
  color: 'var(--wb-12)',
  background: 'transparent',
  border: '1px solid var(--wb-6)',
  borderRadius: 4,
  cursor: 'pointer',
  fontFamily: 'inherit',
};

const selectStyle: React.CSSProperties = {
  width: '100%',
  padding: '8px 10px',
  background: 'var(--wb-3)',
  color: 'var(--wb-13)',
  border: '1px solid var(--wb-6)',
  borderRadius: 4,
  fontSize: 13,
  fontFamily: 'inherit',
};

/**
 * Bed for the explanatory blocks inside the dialog: one ramp step deeper
 * than the --wb-5 panel, which is a step DOWN in both themes (#252526
 * under #2d2d2d, #eceef1 under white). The hairline keeps the edge from
 * disappearing where the two values sit close.
 */
const insetBoxStyle: React.CSSProperties = {
  background: 'var(--wb-3)',
  border: '1px solid var(--wb-6)',
  borderRadius: 4,
};
