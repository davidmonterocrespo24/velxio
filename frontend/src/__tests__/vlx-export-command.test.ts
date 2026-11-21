// @vitest-environment jsdom
/**
 * Exporting a project as .vlx must be reachable, and what it produces must
 * be importable.
 *
 * Reported from velxio.dev: "It's not possible to export Project as .vlx".
 * It was true. The .vlx writer existed and was reachable from exactly two
 * places a web user never touches: the OSS save button (which the pro
 * overlay replaces with the server save modal at load time) and the desktop
 * app's native menu. The File menu's only project export produced a Wokwi
 * .zip. So the format could be imported (PROJECT_FILE_ACCEPT lists .vlx)
 * but never produced.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { useEditorStore } from '../store/useEditorStore';
import { useSimulatorStore } from '../store/useSimulatorStore';
import { buildVlxBlob, loadVlxPayload, parseVlxFile } from '../utils/vlxFile';
import { PROJECT_FILE_ACCEPT } from '../utils/importProject';

const here = dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(resolve(here, '..', p), 'utf8');

beforeEach(() => {
  useSimulatorStore.setState({
    components: [],
    wires: [],
    boards: [
      {
        id: 'arduino-uno',
        boardKind: 'arduino-uno',
        x: 0,
        y: 0,
        activeFileGroupId: 'group-arduino-uno',
        languageMode: 'arduino',
      } as never,
    ],
    activeBoardId: 'arduino-uno',
  } as never);
  useEditorStore.getState().createFileGroup('group-arduino-uno', [
    { name: 'sketch.ino', content: 'void setup(){}\nvoid loop(){}\n' },
  ]);
});

describe('the .vlx export command', () => {
  it('is wired end to end: type, menu item, handler, registration', () => {
    expect(read('lib/editorCommands.ts')).toContain("'project.exportVlx'");

    const menu = read('components/editor/EditorMenuBar.tsx');
    expect(menu).toContain("id: 'project.exportVlx'");
    // Next to the .zip one, not hidden somewhere else in the menu.
    expect(menu.indexOf("'project.exportVlx'")).toBeLessThan(menu.indexOf("'project.export'"));

    const toolbar = read('components/editor/EditorToolbar.tsx');
    expect(toolbar).toContain('handleExportVlx');
    expect(toolbar).toContain("registerEditorCommand('project.exportVlx'");
    // Chip files sync on a debounce; the handler must flush before reading.
    const handler = toolbar.slice(toolbar.indexOf('const handleExportVlx'));
    expect(handler.slice(0, 600)).toContain('flushChipFileSync()');
  });

  it('is offered in every locale', () => {
    for (const loc of ['en', 'es', 'pt-br', 'it', 'fr', 'zh-cn', 'de', 'ja', 'ru']) {
      const j = JSON.parse(read(`i18n/locales/${loc}/common2.json`));
      const label = j.editor.toolbar.exportVlxLabel;
      expect(label, `${loc} exportVlxLabel`).toBeTruthy();
      expect(label, `${loc} names the format`).toContain('.vlx');
    }
  });

  it('produces a payload the importer accepts', async () => {
    const groupId = 'group-arduino-uno';
    const [sketch] = useEditorStore.getState().getGroupFiles(groupId);
    const blob = buildVlxBlob({ name: 'my-project' });
    const file = new File([await blob.text()], 'my-project.vlx', { type: 'application/json' });
    const payload = await parseVlxFile(file);
    expect(payload.boards[0].boardKind).toBe('arduino-uno');
    expect(payload.fileGroups[groupId][0]).toMatchObject({ id: sketch.id, name: 'sketch.ino' });
    loadVlxPayload(payload);
    expect(useEditorStore.getState().getGroupFiles(groupId)[0].id).toBe(sketch.id);
  });

  it('the open dialog still accepts what the export writes', () => {
    expect(PROJECT_FILE_ACCEPT).toContain('.vlx');
  });
});
