/**
 * NewProjectDialog — starter-template picker.
 *
 * Shown (a) on a pristine `/editor` visit (over an emptied canvas), and
 * (b) from the "New workspace" button / File menu entry. Offers a blank
 * workspace plus a ready-to-run Blink starter per board family — Arduino,
 * ESP32 (one card per chip generation, XIAO variant preferred), M5Stack
 * (overlay-registered all-in-ones, listed ahead of STM32), STM32, Raspberry
 * Pi — each card carrying the same circuit thumbnail the examples gallery
 * uses (/examples-thumbs/<id>.webp, CircuitPreview fallback).
 *
 * Selecting a board loads its gallery Blink example when one exists (full
 * wiring: 220Ω resistor + LED); boards without one get a fresh board whose
 * default sketch blinks the on-board LED. Pro-gated boards (STM32 + QEMU
 * Raspberry Pi) carry the same PRO pill as the component picker and go
 * through the same board-gate seam ('add' action) before anything is created.
 */
import React, { useEffect, useMemo, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import type { BoardKind } from '../../types/board';
import { BOARD_KIND_LABELS } from '../../types/board';
import { blockedByBoardGate, isProBoardKind } from '../../lib/proBoardGate';
import {
  listProBoards,
  subscribeProBoards,
  getProBoardsVersion,
  type ProBoardDef,
} from '../../lib/proBoardRegistry';
import { useSimulatorStore, DEFAULT_BOARD_POSITION } from '../../store/useSimulatorStore';
import { useProjectStore } from '../../store/useProjectStore';
import { useEditorStore } from '../../store/useEditorStore';
import { useOscilloscopeStore } from '../../store/useOscilloscopeStore';
import { getLocaleFromPath, localizedPath } from '../../i18n/path';
import { loadExample } from '../../utils/loadExample';
import type { ExampleProject } from '../../data/examples';
import { ExampleThumbnail } from '../examples/ExampleThumbnail';
import { trackSelectBoard } from '../../utils/analytics';
import './NewProjectDialog.css';

interface NewProjectDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

/** Card blurbs (same voice as the component picker's board descriptions). */
const BOARD_BLURBS: Record<string, string> = {
  'arduino-uno': '8-bit AVR, 32KB flash, 14 digital I/O',
  'arduino-mega': '8-bit AVR, 256KB flash, 54 digital I/O',
  'arduino-nano': '8-bit AVR, 32KB flash, breadboard-size Uno',
  'arduino-nano-esp32': 'ESP32-S3 in the Nano footprint, WiFi+BT (QEMU)',
  esp32: 'Xtensa LX6 dual-core, WiFi+BT, 34 GPIO (QEMU)',
  'esp32-cam': 'ESP32 + OV2640 camera, streams to LCD (QEMU)',
  'xiao-esp32-s3': 'Seeed XIAO tiny form, 8MB flash+PSRAM (QEMU)',
  'xiao-esp32-c3': 'Seeed XIAO ESP32-C3 mini board (QEMU)',
  'stm32-bluepill': 'STM32F103C8 Cortex-M3, 64KB flash, 37 GPIO (QEMU)',
  'stm32-blackpill': 'STM32F411CE Cortex-M4, 512KB flash, 50 GPIO (QEMU)',
  'stm32-bluepill-f103cb': 'STM32F103CB Cortex-M3, 128KB flash, 37 GPIO (QEMU)',
  'stm32-blackpill-f401': 'STM32F401CE Cortex-M4, 512KB flash, 50 GPIO (QEMU)',
  'stm32-f4-discovery': 'STM32F407VG Cortex-M4, 1MB flash, 4 onboard LEDs (QEMU)',
  'stm32-olimex-h405': 'Olimex STM32-H405, F405RG Cortex-M4, 1MB flash (QEMU)',
  'stm32-netduino-plus2': 'Netduino Plus 2, STM32F405 Cortex-M4 (QEMU)',
  'stm32-netduino2': 'Netduino 2, STM32F205 Cortex-M3 (QEMU, serial)',
  'raspberry-pi-pico': 'RP2040 dual-core Cortex-M0+',
  'raspberry-pi-3': 'ARM64 Cortex-A53 quad-core, Linux/Python (QEMU)',
  'raspberry-pi-4': 'ARM64 Cortex-A72 quad-core, Linux/Python (QEMU)',
  'raspberry-pi-5': 'ARM64 Cortex-A76 quad-core + RP1 I/O, Linux/Python (QEMU)',
};

const STM32_BOARDS: BoardKind[] = [
  'stm32-bluepill',
  'stm32-blackpill',
  'stm32-bluepill-f103cb',
  'stm32-blackpill-f401',
  'stm32-f4-discovery',
  'stm32-olimex-h405',
  'stm32-netduino-plus2',
  'stm32-netduino2',
];

/**
 * Starter-card thumbnail: reuse the gallery's convention-based thumbs
 * (/examples-thumbs/<id>.webp, CircuitPreview SVG fallback). Kinds with a
 * Blink example use that example's thumb; the rest use a captured
 * `starter-<kind>` shot living in the same folder.
 */
function thumbStubFor(kind: string, label: string): ExampleProject {
  return {
    id: PREFERRED_BLINK_EXAMPLE[kind] ?? `starter-${kind}`,
    title: label,
    description: '',
    category: 'basics',
    difficulty: 'beginner',
    boardType: kind,
    code: '',
    components: [],
    wires: [],
  };
}

/**
 * Empty the whole workspace: boards, components, wires, current project and
 * every editor file group. Removing the LAST board leaves the editor's
 * files/activeFileId mirror pointing at the deleted group (removeBoard only
 * re-points when another board remains), so Monaco kept showing the dead
 * sketch — pointing the editor at a nonexistent group blanks it.
 */
export function clearWorkspaceForStarter(): void {
  // currentProject FIRST — same auto-save hazard loadExample documents:
  // mutating the stores while a saved project is still "current" lets the
  // debounced PUT overwrite that project with the emptied content.
  useProjectStore.getState().clearCurrentProject();
  const sim = useSimulatorStore.getState();
  sim.boards.forEach((b) => sim.stopBoard(b.id));
  sim.boards.map((b) => b.id).forEach((id) => sim.removeBoard(id));
  sim.setComponents([]);
  sim.setWires([]);
  // An empty canvas has nothing for the old scope channels to watch
  // (velxio/velxio-prod#119).
  useOscilloscopeStore.getState().resetChannels();
  const editor = useEditorStore.getState();
  Object.keys(editor.fileGroups).forEach((g) => editor.deleteFileGroup(g));
  editor.setActiveGroup('');
}

/**
 * Gallery Blink example per board kind, when one exists. Preferred ids first
 * (some kinds have several blink-ish examples — e.g. esp32 also has the
 * ESP-IDF variant); a generic single-board "blink" search covers overlay
 * examples registered at runtime.
 */
const PREFERRED_BLINK_EXAMPLE: Record<string, string> = {
  'arduino-uno': 'blink-led',
  'arduino-mega': 'mega-blink',
  'arduino-nano': 'nano-blink',
  // Camera board: the webcam demo IS its "blink" — the board exists to
  // show the sensor, a bare LED sketch would be a misleading first run.
  'esp32-cam': 'esp32cam-webcam-demo',
  esp32: 'esp32-blink-led',
  'esp32-s3': 'esp32s3-blink-led',
  'esp32-c3': 'c3-blink',
  'esp32-c6': 'c6-blink',
  'raspberry-pi-pico': 'pico-blink',
  'raspberry-pi-3': 'pi3-blink-led',
  'xiao-rp2040': 'xiao-rp2040-blink',
  'xiao-esp32c6': 'xiao-esp32c6-blink',
  'stm32-bluepill': 'stm32-bluepill-blink',
  'stm32-blackpill': 'stm32-blackpill-blink',
  'stm32-bluepill-f103cb': 'stm32-bluepill-f103cb-blink',
  'stm32-blackpill-f401': 'stm32-blackpill-f401-blink',
  'stm32-f4-discovery': 'stm32-f4-discovery-blink',
  'stm32-olimex-h405': 'stm32-olimex-h405-blink',
  'stm32-netduino-plus2': 'stm32-netduino-plus2-blink',
  // M5Stack all-in-ones (overlay kinds): no LED to blink — the on-LCD hello
  // is the first run. Both ids carry a captured gallery thumb.
  'cardputer-adv': 'cardputer-adv-hello',
  'm5stack-core': 'm5stack-core-m5-helloworld',
  // Partner boards (overlay kinds), one representative first-run each. The
  // Stellar/Badger entries are REQUIRED, not just preferred: their gallery
  // examples use `boards[]` + boardFilter, which the generic single-board
  // search above never matches.
  'xiao-esp32s3-sense': 'xiao-esp32s3-sense-hello',
  'unihiker-m10': 'unihiker-blink-p2',
  'pimoroni-pico-plus-2w': 'pimoroni-pico-plus-2w-blink',
  'badger-2350': 'badger-2350-badgeos',
  'stellar-unicorn': 'stellar-unicorn-rainbow',
  // Espressif devkits — launch-embargoed; cards appear when the boards do.
  'esp32-c3-lcdkit': 'esp32-c3-lcdkit-knob-dial',
  'esp32-s3-eye': 'esp32-s3-eye-camera-lcd',
  'esp-vocat': 'esp-vocat-face',
  'esp-sensairshuttle': 'esp-sensair-lcd-dash',
  'esp32-p4': 'esp32-p4-blink',
  'esp32-p4-preview': 'esp32-p4-preview-blink',
};

/** Dynamic import keeps the (large) gallery data out of the editor bundle
 *  until a starter is actually picked. */
async function findBlinkExample(kind: string): Promise<ExampleProject | undefined> {
  const { exampleProjects } = await import('../../data/examples');
  const preferredId = PREFERRED_BLINK_EXAMPLE[kind];
  if (preferredId) {
    const preferred = exampleProjects.find((e) => e.id === preferredId);
    if (preferred) return preferred;
  }
  return exampleProjects.find(
    (e) => !e.boards && e.boardType === kind && /blink/i.test(`${e.id} ${e.title}`),
  );
}

/**
 * Replace the workspace with the chosen starter. 'blank' leaves an empty
 * canvas (boards are optional — the board-less analog examples rely on the
 * same state). Board kinds load their gallery Blink example when one exists;
 * otherwise a fresh board whose default sketch already blinks the on-board
 * LED (createFileGroup picks the per-board/language blink content).
 */
async function applyStarter(kind: string | 'blank'): Promise<void> {
  clearWorkspaceForStarter();

  if (kind !== 'blank') {
    let example: ExampleProject | undefined;
    try {
      example = await findBlinkExample(kind);
    } catch {
      example = undefined;
    }
    if (example) {
      await loadExample(example);
    } else {
      const fresh = useSimulatorStore.getState();
      const newId = fresh.addBoard(
        kind as BoardKind,
        DEFAULT_BOARD_POSITION.x,
        DEFAULT_BOARD_POSITION.y,
      );
      fresh.setActiveBoardId(newId);
    }
  }

  // The workspace no longer belongs to whatever project URL we were on —
  // leaving it would silently reload the OLD project over this fresh
  // workspace on refresh. replaceState, not pushState (a back-entry at the
  // stale project URL would remount the project route and reload it).
  const locale = getLocaleFromPath(window.location.pathname);
  const editorPath = localizedPath('/editor', locale);
  if (window.location.pathname !== editorPath) {
    window.history.replaceState(null, '', editorPath);
  }
}

export interface StarterSection {
  title: string;
  entries: Array<{ kind: string; blurb: string }>;
}

/**
 * The card sections, in display order. Overlay-registered kinds only exist
 * when the private overlay mounted — an OSS build simply doesn't show those
 * cards, and a section left with no entries is not rendered at all.
 */
export function buildStarterSections(defs: ProBoardDef[]): StarterSection[] {
  const oss = (k: BoardKind) => ({ kind: k as string, blurb: BOARD_BLURBS[k] ?? '' });
  const pro = (k: string) => {
    const d = defs.find((x) => x.kind === k);
    return d ? [{ kind: d.kind, blurb: d.description }] : [];
  };
  return [
    {
      title: 'Arduino',
      entries: [
        oss('arduino-uno'),
        oss('arduino-mega'),
        oss('arduino-nano'),
        oss('arduino-nano-esp32'),
      ],
    },
    // One card per ESP32 chip generation, XIAO variant preferred where
    // Seeed makes one: classic → DevKit V1, S3/C3 → XIAO, C6 → XIAO (overlay).
    // The S3 Sense sits here next to its sibling — a separate Seeed section
    // would repeat a brand this section already carries (operator call,
    // 2026-08-28).
    {
      title: 'ESP32',
      entries: [
        oss('esp32'),
        oss('esp32-cam'),
        oss('xiao-esp32-s3'),
        ...pro('xiao-esp32s3-sense'),
        oss('xiao-esp32-c3'),
        ...pro('xiao-esp32c6'),
      ],
    },
    // M5Stack all-in-ones (overlay): ahead of STM32 by operator request —
    // they run on Free and are a friendlier first pick than the Pro-gated
    // STM32 family. Cardputer first, then the Core.
    { title: 'M5Stack', entries: [...pro('cardputer-adv'), ...pro('m5stack-core')] },
    // Hardware partners (overlay kinds, same shape as M5Stack): each section
    // lists only the boards the overlay actually registered, so an OSS build
    // and launch-embargoed items simply render nothing. Seeed gets no section
    // of its own — its boards live in the chip-family sections above.
    { title: 'DFRobot', entries: [...pro('unihiker-m10')] },
    {
      title: 'Pimoroni',
      entries: [
        ...pro('pimoroni-pico-plus-2w'),
        ...pro('badger-2350'),
        ...pro('stellar-unicorn'),
      ],
    },
    {
      title: 'Espressif',
      entries: [
        ...pro('esp32-c3-lcdkit'),
        ...pro('esp32-s3-eye'),
        ...pro('esp-vocat'),
        ...pro('esp32-p4'),
        ...pro('esp32-p4-preview'),
        ...pro('esp-sensairshuttle'),
      ],
    },
    { title: 'STM32', entries: STM32_BOARDS.map(oss) },
    {
      title: 'Raspberry Pi',
      entries: [
        oss('raspberry-pi-pico'),
        ...pro('xiao-rp2040'),
        oss('raspberry-pi-3'),
        oss('raspberry-pi-4'),
        oss('raspberry-pi-5'),
      ],
    },
  ];
}

const ProPill: React.FC = () => (
  <span className="new-project-pro" title="Pro board — you can place and wire it; running it depends on your plan">
    PRO
  </span>
);

export const NewProjectDialog: React.FC<NewProjectDialogProps> = ({ isOpen, onClose }) => {
  const { t } = useTranslation();

  // Late-overlay registrations (the @pro import is dynamic) must re-render an
  // already-mounted dialog — same contract as the component picker.
  const proBoardsVersion = useSyncExternalStore(
    subscribeProBoards,
    getProBoardsVersion,
    getProBoardsVersion,
  );

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const sections = useMemo(() => buildStarterSections(listProBoards()), [proBoardsVersion]);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const handleSelect = (kind: string | 'blank') => {
    if (kind !== 'blank' && blockedByBoardGate(kind as BoardKind, 'add')) {
      // Same gate as adding the board from the picker ('add' action): the
      // prompt is already up; close and create nothing. Both land in the
      // same render, so the order does not show.
      onClose();
      return;
    }
    if (kind !== 'blank') trackSelectBoard(kind);
    onClose();
    applyStarter(kind).catch((err) => {
      // eslint-disable-next-line no-console
      console.warn('[editor] starter template failed to load:', err);
    });
  };

  // Portal to <body>: escape the canvas subtree so no ancestor stacking
  // context can pin the dialog below floating panels (e.g. the AI chat).
  return createPortal(
    <div className="new-project-overlay" onClick={onClose}>
      <div
        className="new-project-dialog"
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="new-project-head">
          <h3 className="new-project-title">{t('editor.newProject.title')}</h3>
          <p className="new-project-sub">{t('editor.newProject.subtitle')}</p>
        </div>

        <div className="new-project-body">
          <div className="new-project-grid">
            <button
              className="new-project-card new-project-card-blank"
              onClick={() => handleSelect('blank')}
            >
              <span className="new-project-card-thumb new-project-card-thumb-blank">+</span>
              <span className="new-project-card-info">
                <span className="new-project-card-name">
                  {t('editor.newProject.blankTitle')}
                </span>
                <span className="new-project-card-desc">
                  {t('editor.newProject.blankDesc')}
                </span>
              </span>
            </button>
          </div>

          {sections.map((section) =>
            section.entries.length === 0 ? null : (
              <React.Fragment key={section.title}>
                <div className="new-project-section-title">{section.title}</div>
                <div className="new-project-grid">
                  {section.entries.map(({ kind, blurb }) => {
                    const label = BOARD_KIND_LABELS[kind as BoardKind] ?? kind;
                    return (
                      <button
                        key={kind}
                        className="new-project-card"
                        onClick={() => handleSelect(kind)}
                      >
                        <span className="new-project-card-thumb">
                          <ExampleThumbnail
                            example={thumbStubFor(kind, label)}
                            width={300}
                            height={180}
                          />
                        </span>
                        {isProBoardKind(kind) && <ProPill />}
                        <span className="new-project-card-info">
                          <span className="new-project-card-name">{label}</span>
                          <span className="new-project-card-desc">{blurb}</span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              </React.Fragment>
            ),
          )}
        </div>

        <div className="new-project-foot">
          <button className="new-project-cancel" onClick={onClose}>
            {t('editor.newProject.cancel')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
};
