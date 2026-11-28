import { create } from 'zustand';
import { generateUUID } from '../utils/uuid';
import { isPiBoardKind } from '../types/board';
import { getProBoard } from '../lib/proBoardRegistry';

export interface WorkspaceFile {
  id: string;
  name: string;
  content: string;
  modified: boolean;
}

const MAIN_ID = 'main-sketch';

/** Trim, collapse slashes/backslashes, strip leading/trailing '/' and any
 *  '.'/'..' segments — folder paths are always workspace-relative. */
export function normalizeFolderPath(path: string): string {
  return path
    .trim()
    .replace(/\\/g, '/')
    .split('/')
    .map((seg) => seg.trim())
    .filter((seg) => seg && seg !== '.' && seg !== '..')
    .join('/');
}

const DEFAULT_INO_CONTENT = `// Arduino Blink Example
void setup() {
  pinMode(LED_BUILTIN, OUTPUT);
}

void loop() {
  digitalWrite(LED_BUILTIN, HIGH);
  delay(1000);
  digitalWrite(LED_BUILTIN, LOW);
  delay(1000);
}`;

const DEFAULT_MICROPYTHON_CONTENT = `# MicroPython Blink for Raspberry Pi Pico
from machine import Pin
import time

led = Pin(25, Pin.OUT)

while True:
    led.toggle()
    time.sleep(1)
`;

// The shipped ESP32-family MicroPython is v1.28.0 (IDF 5.x drivers — the
// same generation the compile pipeline and the JS engines are validated
// against), so Pin.toggle() and friends exist now; this seed just stays on
// the lowest-common API. History: #122 (v1.20 had no Pin.toggle).
const DEFAULT_ESP32_MICROPYTHON_CONTENT = `# MicroPython Blink for ESP32
from machine import Pin
import time

led = Pin(2, Pin.OUT)  # Built-in LED on GPIO 2
state = False

while True:
    state = not state
    led.value(state)
    time.sleep(1)
`;

// Pure ESP-IDF mode (issue #139): the user's own app_main(), compiled by the
// backend's ESP-IDF toolchain WITHOUT the arduino-esp32 component. GPIO 2 is
// the built-in LED on most ESP32 dev boards.
const DEFAULT_ESPIDF_CONTENT = `// ESP-IDF Blink Example
#include <stdio.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "driver/gpio.h"

#define LED_PIN GPIO_NUM_2

void app_main(void)
{
    gpio_reset_pin(LED_PIN);
    gpio_set_direction(LED_PIN, GPIO_MODE_OUTPUT);

    while (1) {
        gpio_set_level(LED_PIN, 1);
        vTaskDelay(pdMS_TO_TICKS(1000));
        gpio_set_level(LED_PIN, 0);
        vTaskDelay(pdMS_TO_TICKS(1000));
    }
}
`;

const DEFAULT_PY_CONTENT = `import RPi.GPIO as GPIO
import time

LED_PIN = 17

GPIO.setmode(GPIO.BCM)
GPIO.setup(LED_PIN, GPIO.OUT)

try:
    while True:
        GPIO.output(LED_PIN, GPIO.HIGH)
        time.sleep(1)
        GPIO.output(LED_PIN, GPIO.LOW)
        time.sleep(1)
except KeyboardInterrupt:
    GPIO.cleanup()
`;

const DEFAULT_FILE: WorkspaceFile = {
  id: MAIN_ID,
  name: 'sketch.ino',
  content: DEFAULT_INO_CONTENT,
  modified: false,
};

/** Default file group for the initial Arduino Uno board */
const DEFAULT_GROUP_ID = 'group-arduino-uno';

/**
 * Editor file group id for a programmable custom-chip's program.
 *
 * A custom chip that loads a ROM / runs a user program (a CPU emulator such
 * as the Z80 or 8080) keeps that program (`larson.s`, `chaser.c`, …) in its
 * OWN file group, exactly like each board owns one. The file explorer renders
 * it as a separate collapsible section, so the chip's program never gets
 * mixed into the board's sketch. Behaviour/driver chips (a servo driver, a
 * sensor) and predefined chips carry no program file and get no group — they
 * are edited in the chip designer instead.
 */
export const chipFileGroupId = (chipId: string): string => `group-chip-${chipId}`;
/** Prefix shared by every chip program group — used to sweep stale ones. */
export const CHIP_GROUP_PREFIX = 'group-chip-';

/**
 * Editor view layout. Lets the user collapse either pane to give the chat
 * (right-docked) more breathing room, or to focus on one half of the
 * workflow.
 */
export type EditorViewMode = 'code' | 'circuit' | 'both';

interface RevealLocation {
  groupId: string;
  fileId: string;
  position: { lineNumber: number; column: number };
}

interface EditorState {
  files: WorkspaceFile[];
  activeFileId: string;
  openFileIds: string[];
  /** When set, the editor shows a READ-ONLY `libraries.json` view of this
   *  board's library manifest (board.libraries) instead of the active file.
   *  Cleared whenever a real file is opened/activated. Managed by the explorer's
   *  libraries.json entry; the Library Manager modal is what edits the manifest. */
  manifestViewBoardId: string | null;
  setManifestView: (boardId: string | null) => void;
  revealLocation: RevealLocation | null;
  setRevealLocation: (location: RevealLocation | null) => void;
  fontSize: number;
  viewMode: EditorViewMode;
  setViewMode: (mode: EditorViewMode) => void;
  /** Desktop file-explorer pane. Lives in the store (not EditorPage state) so
   *  the header's View menu can show its checkmark and toggle it — the
   *  toolbar's own segmented toggle hides on narrow bars. */
  explorerOpen: boolean;
  setExplorerOpen: (open: boolean) => void;
  toggleExplorer: () => void;

  // ── File groups (one per board) ──────────────────────────────────────────
  /** Map of groupId → WorkspaceFile[]. Stored as plain object for Zustand. */
  fileGroups: Record<string, WorkspaceFile[]>;
  /** Active group (determines which board's files are shown in the editor). */
  activeGroupId: string;
  /** Active file within the active group */
  activeGroupFileId: Record<string, string>;
  /** Open file IDs within each group */
  openGroupFileIds: Record<string, string[]>;

  // ── Folders ──────────────────────────────────────────────────────────────
  /**
   * Folders exist implicitly through file names containing '/'
   * ("apps/badge/__init__.py" lives in apps/badge). This map only tracks
   * EMPTY folders per group (created but not yet holding a file) so they
   * survive in the explorer until a file lands in them. Paths are
   * '/'-separated with no leading/trailing slash.
   */
  folderGroups: Record<string, string[]>;
  /** Create a folder (in the active group). No-op if it already exists. */
  createFolder: (path: string) => void;
  /** Delete a folder (active group): removes every file under it and any
   *  tracked empty subfolders. */
  deleteFolder: (path: string) => void;

  // File operations (operate on active group)
  createFile: (name: string) => string;
  deleteFile: (id: string) => void;
  renameFile: (id: string, newName: string) => void;
  setFileContent: (id: string, content: string) => void;
  markFileSaved: (id: string) => void;
  openFile: (id: string) => void;
  closeFile: (id: string) => void;
  setActiveFile: (id: string) => void;
  /** Load a full set of files (e.g. when loading a saved project) */
  loadFiles: (files: { name: string; content: string }[]) => void;

  // File group management
  createFileGroup: (
    groupId: string,
    languageModeOrFiles?: string | { name: string; content: string }[],
  ) => void;
  deleteFileGroup: (groupId: string) => void;
  setActiveGroup: (groupId: string) => void;
  getGroupFiles: (groupId: string) => WorkspaceFile[];
  updateGroupFile: (groupId: string, fileId: string, content: string) => void;
  /** Append a file to an existing group (no-op if the group doesn't exist
   *  or already has a file with that name). Mirrors into `files` when the
   *  group is active. */
  addFileToGroup: (groupId: string, file: { name: string; content: string }) => void;
  /** Set a group file's content WITHOUT marking it modified (programmatic
   *  sync, e.g. chip properties -> chip.c), mirroring into `files`/Monaco
   *  when the group is active — unlike updateGroupFile, which is a user
   *  edit that only touches the group copy. */
  setGroupFileContent: (groupId: string, fileId: string, content: string) => void;
  /** Remove one file from a specific group (any group, not just the active
   *  one — deleteFile above is active-group-scoped). Used by the chip image
   *  sync when the image is cleared. */
  removeFileFromGroup: (groupId: string, fileId: string) => void;
  /** Replace ALL file groups atomically (used when loading a saved project).
   *  `folders` restores the tracked EMPTY folders per group (optional —
   *  folders holding files rebuild themselves from the file name prefixes). */
  replaceFileGroups: (
    groups: Record<string, { name: string; content: string }[]>,
    folders?: Record<string, string[]>,
  ) => void;

  // Settings.
  // Light/dark is NOT here: it is a whole-app preference shared with the
  // blog and the docs portal, so it lives in src/lib/theme.ts.
  setFontSize: (size: number) => void;

  // Dirty flag — tracks whether code changed since last compilation
  codeChangedSinceLastCompile: boolean;
  markCompiled: () => void;

  // Legacy compat — sets content of the active file
  setCode: (code: string) => void;
}

export const useEditorStore = create<EditorState>((set, get) => ({
  files: [DEFAULT_FILE],
  activeFileId: MAIN_ID,
  openFileIds: [MAIN_ID],
  manifestViewBoardId: null,
  setManifestView: (boardId: string | null) => set({ manifestViewBoardId: boardId }),
  revealLocation: null,
  setRevealLocation: (revealLocation) => set({ revealLocation }),
  fontSize: 14,
  viewMode: 'both',
  setViewMode: (mode) => set({ viewMode: mode }),
  explorerOpen: true,
  setExplorerOpen: (open) => set({ explorerOpen: open }),
  toggleExplorer: () => set((s) => ({ explorerOpen: !s.explorerOpen })),

  // File groups — initial state has one group for the default Arduino Uno board
  fileGroups: {
    [DEFAULT_GROUP_ID]: [DEFAULT_FILE],
  },
  folderGroups: {},
  activeGroupId: DEFAULT_GROUP_ID,
  activeGroupFileId: { [DEFAULT_GROUP_ID]: MAIN_ID },
  openGroupFileIds: { [DEFAULT_GROUP_ID]: [MAIN_ID] },

  codeChangedSinceLastCompile: true,
  markCompiled: () => set({ codeChangedSinceLastCompile: false }),

  // ── Folder operations (operate on active group) ─────────────────────────

  createFolder: (path: string) => {
    const clean = normalizeFolderPath(path);
    if (!clean) return;
    set((s) => {
      const groupId = s.activeGroupId;
      const folders = s.folderGroups[groupId] ?? [];
      const files = s.fileGroups[groupId] ?? [];
      const exists =
        folders.includes(clean) || files.some((f) => f.name.startsWith(clean + '/'));
      if (exists) return {};
      return { folderGroups: { ...s.folderGroups, [groupId]: [...folders, clean] } };
    });
  },

  deleteFolder: (path: string) => {
    const clean = normalizeFolderPath(path);
    if (!clean) return;
    set((s) => {
      const groupId = s.activeGroupId;
      const prefix = clean + '/';
      const doomed = new Set(
        (s.fileGroups[groupId] ?? []).filter((f) => f.name.startsWith(prefix)).map((f) => f.id),
      );
      const files = s.files.filter((f) => !doomed.has(f.id));
      const openFileIds = s.openFileIds.filter((fid) => !doomed.has(fid));
      let activeFileId = s.activeFileId;
      if (doomed.has(activeFileId)) activeFileId = openFileIds[0] ?? files[0]?.id ?? '';
      const groupFiles = (s.fileGroups[groupId] ?? []).filter((f) => !doomed.has(f.id));
      const groupOpenIds = (s.openGroupFileIds[groupId] ?? []).filter((fid) => !doomed.has(fid));
      const folders = (s.folderGroups[groupId] ?? []).filter(
        (p) => p !== clean && !p.startsWith(prefix),
      );
      return {
        files,
        openFileIds,
        activeFileId,
        fileGroups: { ...s.fileGroups, [groupId]: groupFiles },
        openGroupFileIds: { ...s.openGroupFileIds, [groupId]: groupOpenIds },
        activeGroupFileId: { ...s.activeGroupFileId, [groupId]: activeFileId },
        folderGroups: { ...s.folderGroups, [groupId]: folders },
      };
    });
  },

  // ── File operations (legacy API — operate on active group) ──────────────

  createFile: (name: string) => {
    const id = generateUUID();
    const newFile: WorkspaceFile = { id, name, content: '', modified: false };
    set((s) => {
      const groupId = s.activeGroupId;
      const groupFiles = [...(s.fileGroups[groupId] ?? []), newFile];
      // A file landing inside a tracked empty folder materialises it — the
      // folder now exists through the file's path prefix.
      const folders = (s.folderGroups[groupId] ?? []).filter((p) => !name.startsWith(p + '/'));
      return {
        // Legacy flat list (mirrors active group)
        files: [...s.files, newFile],
        openFileIds: [...s.openFileIds, id],
        activeFileId: id,
        // Group-aware state
        fileGroups: { ...s.fileGroups, [groupId]: groupFiles },
        openGroupFileIds: {
          ...s.openGroupFileIds,
          [groupId]: [...(s.openGroupFileIds[groupId] ?? []), id],
        },
        activeGroupFileId: { ...s.activeGroupFileId, [groupId]: id },
        folderGroups: { ...s.folderGroups, [groupId]: folders },
      };
    });
    return id;
  },

  deleteFile: (id: string) => {
    set((s) => {
      const groupId = s.activeGroupId;
      const files = s.files.filter((f) => f.id !== id);
      const openFileIds = s.openFileIds.filter((fid) => fid !== id);
      let activeFileId = s.activeFileId;
      if (activeFileId === id) {
        const idx = s.openFileIds.indexOf(id);
        activeFileId =
          openFileIds[idx] ?? openFileIds[idx - 1] ?? openFileIds[0] ?? files[0]?.id ?? '';
      }
      const groupFiles = (s.fileGroups[groupId] ?? []).filter((f) => f.id !== id);
      const groupOpenIds = (s.openGroupFileIds[groupId] ?? []).filter((fid) => fid !== id);
      return {
        files,
        openFileIds,
        activeFileId,
        fileGroups: { ...s.fileGroups, [groupId]: groupFiles },
        openGroupFileIds: { ...s.openGroupFileIds, [groupId]: groupOpenIds },
        activeGroupFileId: { ...s.activeGroupFileId, [groupId]: activeFileId },
      };
    });
  },

  renameFile: (id: string, newName: string) => {
    set((s) => {
      const groupId = s.activeGroupId;
      const mapper = (f: WorkspaceFile) =>
        f.id === id ? { ...f, name: newName, modified: true } : f;
      return {
        files: s.files.map(mapper),
        fileGroups: { ...s.fileGroups, [groupId]: (s.fileGroups[groupId] ?? []).map(mapper) },
      };
    });
  },

  setFileContent: (id: string, content: string) => {
    set((s) => {
      const groupId = s.activeGroupId;
      const mapper = (f: WorkspaceFile) => (f.id === id ? { ...f, content, modified: true } : f);
      return {
        files: s.files.map(mapper),
        fileGroups: { ...s.fileGroups, [groupId]: (s.fileGroups[groupId] ?? []).map(mapper) },
        codeChangedSinceLastCompile: true,
      };
    });
  },

  markFileSaved: (id: string) => {
    set((s) => {
      const groupId = s.activeGroupId;
      const mapper = (f: WorkspaceFile) => (f.id === id ? { ...f, modified: false } : f);
      return {
        files: s.files.map(mapper),
        fileGroups: { ...s.fileGroups, [groupId]: (s.fileGroups[groupId] ?? []).map(mapper) },
      };
    });
  },

  openFile: (id: string) => {
    set((s) => {
      const groupId = s.activeGroupId;
      const groupOpenIds = s.openGroupFileIds[groupId] ?? [];
      return {
        openFileIds: s.openFileIds.includes(id) ? s.openFileIds : [...s.openFileIds, id],
        activeFileId: id,
        manifestViewBoardId: null, // opening a real file exits the libraries.json view
        openGroupFileIds: {
          ...s.openGroupFileIds,
          [groupId]: groupOpenIds.includes(id) ? groupOpenIds : [...groupOpenIds, id],
        },
        activeGroupFileId: { ...s.activeGroupFileId, [groupId]: id },
      };
    });
  },

  closeFile: (id: string) => {
    set((s) => {
      const groupId = s.activeGroupId;
      const openFileIds = s.openFileIds.filter((fid) => fid !== id);
      let activeFileId = s.activeFileId;
      if (activeFileId === id) {
        const idx = s.openFileIds.indexOf(id);
        activeFileId = openFileIds[idx] ?? openFileIds[idx - 1] ?? openFileIds[0] ?? '';
      }
      const groupOpenIds = (s.openGroupFileIds[groupId] ?? []).filter((fid) => fid !== id);
      return {
        openFileIds,
        activeFileId,
        openGroupFileIds: { ...s.openGroupFileIds, [groupId]: groupOpenIds },
        activeGroupFileId: { ...s.activeGroupFileId, [groupId]: activeFileId },
      };
    });
  },

  setActiveFile: (id: string) => {
    set((s) => {
      const groupId = s.activeGroupId;
      return {
        activeFileId: id,
        manifestViewBoardId: null, // activating a real file exits the libraries.json view
        activeGroupFileId: { ...s.activeGroupFileId, [groupId]: id },
      };
    });
  },

  loadFiles: (incoming: { name: string; content: string }[]) => {
    const files: WorkspaceFile[] = incoming.map((f, i) => ({
      id: i === 0 ? MAIN_ID : generateUUID(),
      name: f.name,
      content: f.content,
      modified: false,
    }));
    const firstId = files[0]?.id ?? MAIN_ID;
    set((s) => {
      const groupId = s.activeGroupId;
      return {
        files,
        activeFileId: firstId,
        openFileIds: [firstId],
        fileGroups: { ...s.fileGroups, [groupId]: files },
        activeGroupFileId: { ...s.activeGroupFileId, [groupId]: firstId },
        openGroupFileIds: { ...s.openGroupFileIds, [groupId]: [firstId] },
      };
    });
  },

  // ── File group management ─────────────────────────────────────────────────

  createFileGroup: (
    groupId: string,
    languageModeOrFiles?: string | { name: string; content: string }[],
  ) => {
    set((s) => {
      if (s.fileGroups[groupId]) return s; // already exists

      // Resolve overloaded parameter
      const initialFiles = Array.isArray(languageModeOrFiles) ? languageModeOrFiles : undefined;
      const languageMode =
        typeof languageModeOrFiles === 'string' ? languageModeOrFiles : undefined;

      let files: WorkspaceFile[];
      if (initialFiles && initialFiles.length > 0) {
        files = initialFiles.map((f, i) => ({
          id: i === 0 ? `${groupId}-main` : generateUUID(),
          name: f.name,
          content: f.content,
          modified: false,
        }));
      } else {
        // Determine default file by group name convention or language mode.
        // All QEMU-Linux boards (Pi Zero/1/2/3/4/5 plus overlay piFamily
        // kinds like the UNIHIKER) default to script.py. Group ids follow
        // `group-<boardId>`; the first board of a kind uses the kind as its
        // id, later instances append '-N'. Test the FULL id first — kinds
        // themselves end in digits ('raspberry-pi-3'), so stripping the
        // numeric suffix unconditionally would mangle them ('raspberry-pi'
        // matched nothing and Pis regressed to sketch.ino).
        const boardIdPart = groupId.replace(/^group-/, '');
        const isPi =
          isPiBoardKind(boardIdPart) || isPiBoardKind(boardIdPart.replace(/-\d+$/, ''));
        const isMicroPython = languageMode === 'micropython';
        const mainId = `${groupId}-main`;
        let fileName: string;
        let content: string;
        // ESP32 by id ('group-esp32-c3') or by the overlay board's declared
        // family — an overlay kind can be an ESP32 with no 'esp32' in its name
        // (m5stack-core, cardputer-adv), and those used to be seeded the Pico's
        // `Pin(25)` blink, a dead pin on both.
        const isEsp32 =
          groupId.includes('esp32') ||
          getProBoard(boardIdPart)?.esp32Family !== undefined ||
          getProBoard(boardIdPart.replace(/-\d+$/, ''))?.esp32Family !== undefined;
        if (languageMode === 'espidf') {
          fileName = 'main.c';
          content = DEFAULT_ESPIDF_CONTENT;
        } else if (isMicroPython && isEsp32) {
          fileName = 'main.py';
          content = DEFAULT_ESP32_MICROPYTHON_CONTENT;
        } else if (isMicroPython) {
          fileName = 'main.py';
          content = DEFAULT_MICROPYTHON_CONTENT;
        } else if (isPi) {
          fileName = 'script.py';
          content = DEFAULT_PY_CONTENT;
        } else {
          fileName = 'sketch.ino';
          content = DEFAULT_INO_CONTENT;
        }
        files = [{ id: mainId, name: fileName, content, modified: false }];
      }

      const firstId = files[0]?.id ?? `${groupId}-main`;
      return {
        fileGroups: { ...s.fileGroups, [groupId]: files },
        activeGroupFileId: { ...s.activeGroupFileId, [groupId]: firstId },
        openGroupFileIds: { ...s.openGroupFileIds, [groupId]: [firstId] },
      };
    });
  },

  deleteFileGroup: (groupId: string) => {
    set((s) => {
      const { [groupId]: _removed, ...rest } = s.fileGroups;
      const { [groupId]: _a, ...restActive } = s.activeGroupFileId;
      const { [groupId]: _o, ...restOpen } = s.openGroupFileIds;
      const { [groupId]: _f, ...restFolders } = s.folderGroups;
      // Never leave activeGroupId dangling at the deleted group: Monaco (and
      // every agent write_file) keeps targeting it, while compile reads the
      // board's group — two same-named sketch.ino files silently diverge and
      // the build ships the WRONG one (the "leftover template Blink compiled
      // instead of my code" class). Re-point at any surviving group.
      const nextActive =
        s.activeGroupId === groupId ? Object.keys(rest)[0] ?? '' : s.activeGroupId;
      return {
        fileGroups: rest,
        activeGroupFileId: restActive,
        openGroupFileIds: restOpen,
        folderGroups: restFolders,
        activeGroupId: nextActive,
      };
    });
  },

  setActiveGroup: (groupId: string) => {
    set((s) => {
      const groupFiles = s.fileGroups[groupId] ?? [];
      const activeFileId = s.activeGroupFileId[groupId] ?? groupFiles[0]?.id ?? '';
      const openFileIds = s.openGroupFileIds[groupId] ?? (groupFiles[0] ? [groupFiles[0].id] : []);
      return {
        activeGroupId: groupId,
        files: groupFiles,
        activeFileId,
        openFileIds,
      };
    });
  },

  getGroupFiles: (groupId: string) => {
    return get().fileGroups[groupId] ?? [];
  },

  updateGroupFile: (groupId: string, fileId: string, content: string) => {
    set((s) => {
      const groupFiles = (s.fileGroups[groupId] ?? []).map((f) =>
        f.id === fileId ? { ...f, content, modified: true } : f,
      );
      return { fileGroups: { ...s.fileGroups, [groupId]: groupFiles } };
    });
  },

  addFileToGroup: (groupId: string, file: { name: string; content: string }) => {
    set((s) => {
      const group = s.fileGroups[groupId];
      if (!group || group.some((f) => f.name === file.name)) return s;
      const wsFile: WorkspaceFile = {
        id: generateUUID(),
        name: file.name,
        content: file.content,
        modified: false,
      };
      const groupFiles = [...group, wsFile];
      return {
        fileGroups: { ...s.fileGroups, [groupId]: groupFiles },
        ...(s.activeGroupId === groupId ? { files: groupFiles } : {}),
      };
    });
  },

  removeFileFromGroup: (groupId: string, fileId: string) => {
    set((s) => ({
      fileGroups: {
        ...s.fileGroups,
        [groupId]: (s.fileGroups[groupId] ?? []).filter((f) => f.id !== fileId),
      },
      openGroupFileIds: {
        ...s.openGroupFileIds,
        [groupId]: (s.openGroupFileIds[groupId] ?? []).filter((fid) => fid !== fileId),
      },
    }));
  },

  setGroupFileContent: (groupId: string, fileId: string, content: string) => {
    set((s) => {
      const groupFiles = (s.fileGroups[groupId] ?? []).map((f) =>
        f.id === fileId ? { ...f, content, modified: false } : f,
      );
      return {
        fileGroups: { ...s.fileGroups, [groupId]: groupFiles },
        ...(s.activeGroupId === groupId ? { files: groupFiles } : {}),
      };
    });
  },

  replaceFileGroups: (groups, folders) => {
    const fileGroups: Record<string, WorkspaceFile[]> = {};
    const activeGroupFileId: Record<string, string> = {};
    const openGroupFileIds: Record<string, string[]> = {};
    for (const [gid, files] of Object.entries(groups)) {
      const wsFiles: WorkspaceFile[] = files.map((f, i) => ({
        id: i === 0 ? `${gid}-main` : generateUUID(),
        name: f.name,
        content: f.content,
        modified: false,
      }));
      fileGroups[gid] = wsFiles;
      const firstId = wsFiles[0]?.id ?? `${gid}-main`;
      activeGroupFileId[gid] = firstId;
      openGroupFileIds[gid] = wsFiles[0] ? [firstId] : [];
    }
    set((s) => {
      const activeGroupId = fileGroups[s.activeGroupId]
        ? s.activeGroupId
        : (Object.keys(fileGroups)[0] ?? s.activeGroupId);
      const groupFiles = fileGroups[activeGroupId] ?? [];
      return {
        fileGroups,
        activeGroupFileId,
        openGroupFileIds,
        activeGroupId,
        folderGroups: folders ?? {},
        // Mirror legacy flat fields to the active group
        files: groupFiles,
        activeFileId: activeGroupFileId[activeGroupId] ?? '',
        openFileIds: openGroupFileIds[activeGroupId] ?? [],
      };
    });
  },

  // ── Settings ──────────────────────────────────────────────────────────────

  setFontSize: (fontSize) => set({ fontSize }),

  // Legacy: sets content of active file
  setCode: (code: string) => {
    const { activeFileId, setFileContent } = get();
    if (activeFileId) setFileContent(activeFileId, code);
  },
}));
